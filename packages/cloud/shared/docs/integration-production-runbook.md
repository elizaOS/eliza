# Managed integration production runbook

Production account setup and release checklist for enabling a managed
provider integration (epic #19877, dashboard issue #19908). The same
checklist is served programmatically by
`GET /api/v1/admin/integrations/reliability` (see
`packages/cloud/shared/src/lib/integrations/reliability.ts`,
`PRODUCTION_INTEGRATION_RUNBOOK`) and rendered on the admin dashboard at
`/cloud/admin/integrations`. Keep this file and that constant in sync.

Complete every item before flipping a provider to production:

1. **Production provider account provisioned** — dedicated production
   app/account created with billing enabled; credentials stored only in Cloud
   secret custody, never in source, fixtures, or logs.
2. **OAuth client and redirect URIs verified** — production OAuth client
   configured with exact redirect URIs, minimal scopes, and verified consent
   screen; refresh and revoke paths exercised.
3. **Webhooks registered and signature-verified** — provider webhooks point at
   the production endpoint, signature verification is enforced, and
   duplicate-delivery idempotency is proven.
4. **Quotas, rate limits, and cost alerts configured** — provider-side quotas
   and Cloud-side metering set with cost alert thresholds; the dashboard cost
   column reconciles with provider billing.
5. **SLO baseline captured** — error-rate and p95 latency baselines recorded
   under production traffic and the dashboard SLO thresholds reviewed against
   them.
6. **Kill-switch drill completed** — provider and per-capability kill switches
   toggled in staging (`INTEGRATION_KILL_SWITCHES` env binding); user-facing
   degrade verified as an explicit unavailable state.
7. **Redaction audit passed** — telemetry, receipts, logs, and dashboard
   payloads audited to confirm no token, key, cookie, email, or other
   PII/secret appears.
8. **Sandbox/real-account evidence recorded** — the release evidence matrix
   (sandbox or real-account exercise per `CONTRIBUTING.md`) linked from the
   provider's `INTEGRATION_RELEASE_EVIDENCE` entry so the dashboard shows
   `verified`.

## Operator config bindings

- `INTEGRATION_KILL_SWITCHES` — JSON array of
  `{ "provider", "capability"?, "reason", "actor"?, "activatedAt"? }`.
  A missing `capability` disables the whole provider.
- `INTEGRATION_RELEASE_EVIDENCE` — JSON array of
  `{ "provider", "status": "verified"|"pending"|"missing", "reference"?, "verifiedAt"? }`.

Malformed entries are rejected and surfaced in the dashboard's
`invalidConfig` block — fix them; they are never silently ignored.
