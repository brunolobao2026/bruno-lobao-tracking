// -----------------------------------------------------------------------------
// Respondi webhook adapter.
//
// URL shape: /webhook/respondi/<RESPONDI_WEBHOOK_SLUG>
// The per-recipient UUID stored in env.RESPONDI_WEBHOOK_SLUG gates the endpoint.
//
// Expected Respondi payload shape:
//   { respondent: { raw_answers, score, respondent_utms } }
//
// What this adapter does:
//   - Hashes email and phone with SHA-256 (same normalization as tracker.js)
//   - Fires a Lead event to Meta CAPI with score as `value`
//   - If score >= RESPONDI_MIN_SCORE (env), also fires RespondiConversion to Meta CAPI
//   - Fires a generate_lead event to GA4 with score as `value`
//   - Forwards raw payload to Clint CRM (CLINT_WEBHOOK_URL)
//   - Logs to event_log in D1
// -----------------------------------------------------------------------------

import { guardSlug } from '../_utils.js';

// Respondi may verify the webhook URL with a GET before sending POSTs.
export async function onRequestGet(context) {
  const { env, params } = context;
  const slugFailure = guardSlug(params.slug, env.RESPONDI_WEBHOOK_SLUG);
  if (slugFailure) return slugFailure;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env, params } = context;

  const slugFailure = guardSlug(params.slug, env.RESPONDI_WEBHOOK_SLUG);
  if (slugFailure) return slugFailure;

  try {
    const body = await request.json();

    const clientIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
    const userAgent = request.headers.get('user-agent') || '';

    const respondent = body.respondent || {};

    // Skip partial submissions — only fire events for fully completed quizzes.
    if (respondent.status && respondent.status !== 'completed') {
      return new Response(JSON.stringify({ ok: true, skipped: `status=${respondent.status}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const rawAnswers = respondent.raw_answers || [];

    // Extract fields from raw_answers by question_type
    let rawName = '', rawEmail = '', rawPhone = '';
    for (const entry of rawAnswers) {
      const type = entry.question?.question_type;
      const ans  = entry.answer;
      if (type === 'name'  && !rawName)  rawName  = typeof ans === 'string' ? ans : '';
      if (type === 'email' && !rawEmail) rawEmail = typeof ans === 'string' ? ans : '';
      if (type === 'phone' && !rawPhone) {
        // Respondi sends phone as { country: "55", phone: "37992829829" } or plain string
        if (ans && typeof ans === 'object') {
          rawPhone = (ans.country || '') + (ans.phone || '');
        } else if (typeof ans === 'string') {
          rawPhone = ans;
        }
      }
    }

    const score = typeof respondent.score === 'number' ? respondent.score : parseFloat(respondent.score) || 0;
    const utms  = respondent.respondent_utms || {};
    // respondent_id used as external_id for Meta Advanced Matching (stable per-respondent UUID)
    const respondentId = respondent.respondent_id || '';

    // Determine if this lead qualifies for the RespondiConversion event.
    // Set RESPONDI_MIN_SCORE env var to the minimum qualifying score.
    // If unset, RespondiConversion is never fired.
    const minScoreRaw = env.RESPONDI_MIN_SCORE;
    const minScore = (minScoreRaw !== undefined && minScoreRaw !== '') ? parseFloat(minScoreRaw) : null;
    const fireConversion = minScore !== null && !isNaN(minScore) && score >= minScore;

    // Split name into first/last on the first space
    const nameParts = rawName.trim().split(/\s+/);
    const fn = nameParts[0] || '';
    const ln = nameParts.slice(1).join(' ') || '';

    // --- SHA-256 helpers (mirrors tracker.js) ---
    async function sha256(value) {
      if (!value) return '';
      const normalized = value.toLowerCase().trim();
      const encoded = new TextEncoder().encode(normalized);
      const buffer = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    function normalizePhone(ph, countryCode) {
      if (!ph) return '';
      const cc = String(countryCode || '55');
      const digits = ph.replace(/\D/g, '').replace(/^0+/, '');
      if (!digits) return '';
      if (digits.startsWith(cc) && digits.length >= cc.length + 8 && digits.length <= cc.length + 11) {
        return digits;
      }
      if (digits.length >= 8 && digits.length <= 11) {
        return cc + digits;
      }
      return digits;
    }

    const [hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId] = await Promise.all([
      sha256(rawEmail),
      sha256(fn.toLowerCase()),
      sha256(ln.toLowerCase()),
      sha256(normalizePhone(rawPhone, env.DEFAULT_COUNTRY_CODE)),
      sha256(respondentId),
    ]);

    const eventId     = crypto.randomUUID();
    const convEventId = crypto.randomUUID();
    const eventTime   = Math.floor(Date.now() / 1000);

    const metaArgs = { clientIp, userAgent, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, score, eventTime, utms, env };

    // --- Fan out ---
    const results = await Promise.allSettled([
      Promise.resolve({ skipped: 'Lead handled by browser pixel', payload: null, response: null }),
      fireConversion
        ? sendToMeta({ ...metaArgs, eventName: 'RespondiConversion', eventId: convEventId })
        : Promise.resolve({ skipped: `score ${score} below min ${minScore}`, payload: null, response: null }),
      sendToGA4({ score, eventId, env }),
      forwardToClint({ rawBody: body, env }),
    ]);

    // --- Parse Meta Lead result ---
    let metaStatusCode = 0, metaResponseOk = 0, metaResponseBody = '', metaPayloadSent = null;
    if (results[0]?.status === 'fulfilled' && results[0].value) {
      const v = results[0].value;
      metaPayloadSent = v.payload;
      if (v.skipped) {
        metaResponseBody = `lead: skipped: ${v.skipped}`;
      } else if (v.response) {
        metaStatusCode = v.response.status;
        metaResponseOk = v.response.ok ? 1 : 0;
        try { metaResponseBody = `lead: ${await v.response.text()}`; } catch (e) { metaResponseBody = `lead: Read error: ${e.message}`; }
      }
    } else if (results[0]?.status === 'rejected') {
      metaResponseBody = `lead: Fetch error: ${results[0].reason?.message || 'unknown'}`;
    }

    // Append RespondiConversion result to metaResponseBody
    if (results[1]?.status === 'fulfilled' && results[1].value) {
      const v = results[1].value;
      if (v.skipped) {
        metaResponseBody += ` | conv: skipped: ${v.skipped}`;
      } else if (v.response) {
        try { metaResponseBody += ` | conv: ${await v.response.text()}`; } catch (e) { metaResponseBody += ` | conv: Read error: ${e.message}`; }
      }
    } else if (results[1]?.status === 'rejected') {
      metaResponseBody += ` | conv: Fetch error: ${results[1].reason?.message || 'unknown'}`;
    }

    // --- Parse GA4 result ---
    let ga4StatusCode = 0, ga4ResponseOk = 0, ga4ResponseBody = '', ga4PayloadSent = null;
    if (results[2]?.status === 'fulfilled' && results[2].value) {
      const v = results[2].value;
      ga4PayloadSent = v.payload;
      if (v.skipped) {
        ga4ResponseBody = `skipped: ${v.skipped}`;
      } else if (v.response) {
        ga4StatusCode = v.response.status;
        ga4ResponseOk = v.response.ok ? 1 : 0;
        try { ga4ResponseBody = await v.response.text(); } catch (e) { ga4ResponseBody = `Read error: ${e.message}`; }
      }
    } else if (results[2]?.status === 'rejected') {
      ga4ResponseBody = `Fetch error: ${results[2].reason?.message || 'unknown'}`;
    }

    // --- Log to D1 (background) ---
    context.waitUntil(
      (async () => {
        try {
          if (env.DB) {
            await env.DB.prepare(`
              INSERT INTO event_log (
                session_id, event_name, event_id, timestamp,
                browser, browser_version, os, is_mobile,
                pixel_was_blocked, fbp_source, fbc_source, fbclid_source,
                ga_cookie_present, ga_client_id_fallback, itp_cookie_extended,
                is_bot, bot_reason, consent_status,
                sent_to_meta, meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
                sent_to_ga4, ga4_status_code, ga4_response_ok, ga4_response_body, ga4_payload_sent,
                has_email, has_phone, has_name,
                raw_email
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              '', 'Lead', eventId, eventTime,
              'respondi-webhook', '', 'server', 0,
              0, 'none', 'none', 'none',
              0, 0, 0,
              0, '', 'granted',
              1, metaStatusCode, metaResponseOk, metaResponseBody, metaPayloadSent ?? null,
              1, ga4StatusCode, ga4ResponseOk, ga4ResponseBody, ga4PayloadSent ?? null,
              hashedEm ? 1 : 0, hashedPh ? 1 : 0, (hashedFn || hashedLn) ? 1 : 0,
              rawEmail
            ).run();
          }
        } catch (e) {
          console.error('D1 log error (respondi):', e.message);
        }
      })()
    );

    return new Response(JSON.stringify({
      ok: true,
      event_id: eventId,
      conversion_fired: fireConversion,
      conv_event_id: fireConversion ? convEventId : null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Respondi webhook error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// -------------------------------------------------------
// META CAPI
// -------------------------------------------------------
async function sendToMeta({ clientIp, userAgent, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, score, eventId, eventName, eventTime, utms, env }) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) {
    return { skipped: 'missing meta env', payload: null, response: null };
  }

  const userData = {
    client_ip_address: clientIp,
    client_user_agent: userAgent,
  };
  if (hashedEm) userData.em = [hashedEm];
  if (hashedFn) userData.fn = [hashedFn];
  if (hashedLn) userData.ln = [hashedLn];
  if (hashedPh) userData.ph = [hashedPh];
  if (hashedExternalId) userData.external_id = [hashedExternalId];
  if (utms?.fbclid) userData.fbc = `fb.1.${eventTime}.${utms.fbclid}`;

  const eventData = {
    event_name: eventName,
    event_time: eventTime,
    event_id: eventId,
    action_source: 'website',
    user_data: userData,
    custom_data: { value: score, currency: 'BRL' },
  };

  const payload = { data: [eventData] };

  if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payloadJson }
  );
  return { payload: payloadJson, response };
}

// -------------------------------------------------------
// GA4 MEASUREMENT PROTOCOL
// -------------------------------------------------------
async function sendToGA4({ score, eventId, env }) {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) {
    return { skipped: 'missing ga4 env', payload: null, response: null };
  }

  const payload = {
    client_id: `respondi.${eventId}`,
    events: [{
      name: 'generate_lead',
      params: {
        engagement_time_msec: 100,
        value: score,
        currency: 'BRL',
      },
    }],
  };

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payloadJson }
  );
  return { payload: payloadJson, response };
}

// -------------------------------------------------------
// CLINT FORWARD — passes the raw Respondi payload through
// -------------------------------------------------------
async function forwardToClint({ rawBody, env }) {
  const url = env.CLINT_WEBHOOK_URL;
  if (!url) return { skipped: 'CLINT_WEBHOOK_URL not set' };
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rawBody),
  });
}
