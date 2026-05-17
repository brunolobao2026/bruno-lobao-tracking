# Respondi

Brazilian quiz/questionnaire platform. Used as a lead-qualification step
(MQL gate) in funnels where sales happen downstream. Unlike the sales
platform adapters, this adapter does **not** use the `trk` chain — there
is no purchase to enrich. It fires two Meta CAPI events: `Lead` (always)
and `RespondiConversion` (MQL gate, score-gated).

## Identity

- **Webhook endpoint**: `/webhook/respondi/<RESPONDI_WEBHOOK_SLUG>`
- **Adapter file**: `functions/webhook/respondi/[slug].js`
- **Respondi dashboard**: Forms → select form → Integrações → Webhooks
- **Supports GET verification**: yes — Respondi may ping the URL with GET
  before saving it; the adapter returns `{ ok: true }` on GET.

## Endpoint security — obscure URL

Same slug pattern as Eduzz / Hotmart / Kiwify. UUID v4 stored as
`env.RESPONDI_WEBHOOK_SLUG`. Wrong slug → 404. Generate one UUID per
client at deploy time (same as the other platform slugs).

Respondi does **not** send an HMAC signature. Obscure URL is the only
gate in this adapter.

## Events fired

| Event | Condition | Meta CAPI name | GA4 name |
|---|---|---|---|
| Lead | Always (status = completed) | `Lead` | `generate_lead` |
| RespondiConversion | `score >= RESPONDI_MIN_SCORE` | `RespondiConversion` | — |

`RESPONDI_MIN_SCORE` has **no default**. The qualifying score varies per
client — always ask before deploying: *"Qual a pontuação mínima do quiz
para considerar o lead qualificado (MQL)?"*. If the env var is unset,
`RespondiConversion` is never fired.

`score` is sent as `custom_data.value` on both events.

## Payload shape (confirmed from real capture)

```json
{
  "form": {
    "form_name": "Nome do formulário",
    "form_id": "xVeqH7DZ"
  },
  "respondent": {
    "status": "completed",
    "date": "2026-05-16 19:30:52",
    "score": 100304,
    "respondent_id": "abb0cc34-94f9-4026-85c1-80605fdf9e1f",
    "answers": {
      "Qual o seu nome e sobrenome?": "Teste Edu"
    },
    "raw_answers": [
      {
        "question": {
          "question_title": "Qual o seu nome e sobrenome?",
          "question_id": "x2q9kja7npdu",
          "question_type": "name"
        },
        "answer": "Teste Edu"
      },
      {
        "question": {
          "question_title": "Qual o seu número WhatsApp?",
          "question_id": "xs583i9982w8",
          "question_type": "phone"
        },
        "answer": { "country": "55", "phone": "37992829829" }
      },
      {
        "question": {
          "question_title": "Qual o seu momento atual de negócio?",
          "question_id": "x4chtmax2oh9",
          "question_type": "radio"
        },
        "answer": ["Já tenho funis de vendas - Quero mais escala"]
      }
    ],
    "respondent_utms": {
      "utm_source": "",
      "utm_medium": "",
      "utm_campaign": "",
      "utm_term": "",
      "utm_content": "",
      "gclid": "",
      "fbclid": ""
    }
  }
}
```

## Field mapping

| Field used by adapter | Payload path |
|---|---|
| `name` | `raw_answers[]` where `question_type === "name"`, `answer` (string) |
| `email` | `raw_answers[]` where `question_type === "email"`, `answer` (string) |
| `phone` | `raw_answers[]` where `question_type === "phone"`, `answer.country + answer.phone` or plain string |
| `score` | `respondent.score` (number) |
| `external_id` | `respondent.respondent_id` — SHA-256'd, sent to Meta for Advanced Matching |
| `fbc` | Constructed from `respondent_utms.fbclid` when present |
| UTMs | `respondent.respondent_utms.utm_*` |

## Known gotchas

- **Email is optional in Respondi quizzes.** Many qualification quizzes
  collect only name + phone. The adapter handles missing email silently
  (`sha256("")` → empty string, field omitted from Meta payload). Meta
  Advanced Matching will rely on `ph` + `fn/ln` + `external_id` instead.
- **Score has no fixed scale.** Each client defines their own question
  weights in the Respondi dashboard. The raw score from the payload can
  be in the hundreds of thousands. Always ask the client their MQL
  threshold — never assume.
- **`respondent.status` must be `"completed"`.** Partial submissions
  (e.g. if Respondi ever sends intermediate events) are acknowledged with
  200 and skipped. Do not assume status is always present.
- **Phone answer shape.** Respondi sends phone as
  `{ country: "55", phone: "37992829829" }`. The adapter concatenates
  `country + phone` to get the raw digit string, then passes it through
  `normalizePhone()` which handles country-code deduplication.
- **`respondent_id` as `external_id`.** Respondi generates a stable UUID
  per respondent. The adapter SHA-256's it and sends it to Meta as
  `external_id` for better match rate when email is absent.
- **No `trk` enrichment.** There is no checkout session to look up.
  UTMs come from `respondent_utms` (which Respondi populates if the quiz
  URL had UTM params). If the quiz URL is accessed without UTMs, all UTM
  fields arrive as empty strings.
- **Clint CRM forwarding.** If `env.CLINT_WEBHOOK_URL` is set, the full
  raw Respondi payload is forwarded as-is. Omit the env var to skip.

## Verification test

1. Run `deploy-stack`; note the Respondi webhook URL
   (`https://<domain>/webhook/respondi/<slug>`).
2. Paste it into the Respondi form → Integrações → Webhooks.
3. Set `RESPONDI_MIN_SCORE` to a value **below** your test score so
   `RespondiConversion` fires.
4. Set `META_TEST_EVENT_CODE` so events appear in Meta Events Manager →
   Test Events.
5. Submit a test response in the Respondi quiz.
6. Query D1:
   ```
   wrangler d1 execute <db> --remote --command \
     "SELECT event_name, event_id, meta_response_ok, meta_response_body FROM event_log ORDER BY timestamp DESC LIMIT 3"
   ```
7. Confirm: one row with `event_name = 'Lead'` and `meta_response_ok = 1`.
   `meta_response_body` will contain `lead: ... | conv: ...` — check both
   are `ok`.
8. In Meta Events Manager → Test Events, confirm `Lead` and
   `RespondiConversion` appear under your pixel.
9. Set `RESPONDI_MIN_SCORE` to a value **above** your test score and
   resubmit. Confirm only `Lead` fires (`conv: skipped` in
   `meta_response_body`).
10. Hit `/webhook/respondi/wrong-slug` directly — expect 404.
