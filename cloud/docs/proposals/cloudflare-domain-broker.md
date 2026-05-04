# Cloudflare Domain Broker — Design Spec

**Status:** complete on branch (14 commits); awaiting push + review
**Owner:** nubs
**Tracks:** monetization (shaw priority #1)
**Discord context:** shaw confirmed 2026-05-03 — "wrap all this stuff into eliza cloud" + "use existing stripe + user balance"

## Goal

Let an agent buy and manage real domains end-to-end via Eliza Cloud:
- user pays from their existing org credit balance (already funded via stripe checkout)
- Eliza Cloud holds the cloudflare account + API token
- Eliza Cloud takes a margin on top of cloudflare's at-cost wholesale pricing
- agent can later list, edit dns, or detach domains the user owns

## Where this slots in

The existing cloud architecture already had a perfect home for this:

- **`managed_domains` table** — platform-wide table for "domains we registered/manage on behalf of an org." Polymorphic resource assignment to app/container/agent/mcp. Has registrar enum, nameserver enum, pricing fields including `paymentMethod='credits'` already.
- **Vercel was the previous registrar.** Migration `0098_drop_vercel_artifacts.sql` removed it; `domain_registrar` and `domain_nameserver_mode` enums were narrowed to `['external']` only and the `vercel-domains` service + routes were deleted.
- **This work fills the empty registrar slot** — adds `'cloudflare'` to those enums and ships the registrar + dns services that back them.

## Money flow (no new payment plumbing)

```
user has org credit balance (existing, funded via stripe checkout)
  ↓
POST /api/v1/apps/<id>/domains/buy { domain }
  1. cloudflareRegistrar.checkAvailability(domain) → wholesale price
  2. computeDomainPrice(wholesale) → total (wholesale + margin)
  3. creditsService.deductCredits({ orgId, amount: total/100 })
     → throws InsufficientCreditsError → 402 if not enough
  4. cloudflareRegistrar.registerDomain(domain) → registration_id
  5. on registrar error: creditsService.refundCredits(...) → 502
  6. cloudflareRegistrar.getRegisteredDomain(domain) → zone_id
  7. managedDomainsService.insertCloudflareRegisteredDomain(...) → row
  8. managedDomainsService.assignToResource(row.id, { app, appId })
  9. cloudflareDns.createRecord(zoneId, { type:'CNAME', name:domain, content:appPublicTarget })
     → DNS failure is non-fatal; domain is owned, can be pointed manually
 10. return { success, domain, appDomainId, zoneId, expiresAt, debited }
```

The margin lives in `domain-pricing.ts` (single source of truth, env-overrideable via `ELIZA_CF_REGISTRAR_MARGIN_BPS`, default 36% = 3600 bps).

## API surface (what agents + UIs call)

### Buy / quote
```
POST   /api/v1/apps/:id/domains/check         — dry-run quote (no debit, no register)
POST   /api/v1/apps/:id/domains/buy           — atomic check → debit → register → DNS → attach
POST   /api/v1/apps/:id/domains/status        — live cloudflare status + stored values
POST   /api/v1/apps/:id/domains/sync          — refresh + persist live status into the row
```

### Attach existing (user owns elsewhere)
```
POST   /api/v1/apps/:id/domains               — generate a verification TXT challenge
POST   /api/v1/apps/:id/domains/verify        — re-check the TXT after the user added it
DELETE /api/v1/apps/:id/domains               — detach (registration stays active)
GET    /api/v1/apps/:id/domains               — list managed domains for one app
```

### Org-wide listing + DNS record CRUD (manage flow)
```
GET    /api/v1/domains                                                — list every managed domain in the org
GET    /api/v1/apps/:id/domains/:domain/dns                           — list dns records on a cloudflare zone
POST   /api/v1/apps/:id/domains/:domain/dns                           — add a dns record
GET    /api/v1/apps/:id/domains/:domain/dns/:recordId                 — read one record
PATCH  /api/v1/apps/:id/domains/:domain/dns/:recordId                 — edit one record
DELETE /api/v1/apps/:id/domains/:domain/dns/:recordId                 — remove one record
```

DNS-record routes are scoped to cloudflare-registered domains. External (user-owned-elsewhere) domains return 409 — the user must edit those at their existing dns provider.

## Schema delta

Migration `0099_managed_domains_cloudflare_provider.sql`:
- `ALTER TYPE domain_registrar ADD VALUE 'cloudflare'`
- `ALTER TYPE domain_nameserver_mode ADD VALUE 'cloudflare'`
- `ALTER TABLE managed_domains ADD COLUMN cloudflare_zone_id text, ADD COLUMN cloudflare_registration_id text`
- partial index on `cloudflare_zone_id WHERE NOT NULL`

Schema kept in sync in `packages/db/schemas/managed-domains.ts`.

## Files added

```
packages/lib/utils/cloudflare-api.ts                        bearer + envelope wrap
packages/lib/services/cloudflare-registrar.ts               Registrar API; ELIZA_CF_REGISTRAR_DEV_STUB mode
packages/lib/services/cloudflare-dns.ts                     full CRUD on dns records (list/get/create/update/delete)
packages/lib/services/domain-pricing.ts                     margin policy
packages/lib/services/managed-domains.ts                    managed_domains write/read facade

apps/api/v1/apps/[id]/domains/route.ts                      list / external-attach / detach
apps/api/v1/apps/[id]/domains/check/route.ts                dry-run quote
apps/api/v1/apps/[id]/domains/buy/route.ts                  atomic buy
apps/api/v1/apps/[id]/domains/status/route.ts               live status
apps/api/v1/apps/[id]/domains/verify/route.ts               TXT verification check
apps/api/v1/apps/[id]/domains/sync/route.ts                 refresh + persist
apps/api/v1/apps/[id]/domains/[domain]/dns/route.ts         list / add dns records
apps/api/v1/apps/[id]/domains/[domain]/dns/[recordId]/route.ts  read / edit / delete one record
apps/api/v1/domains/route.ts                                org-wide domain listing

packages/db/schemas/managed-domains.ts                      enum + columns
packages/db/migrations/0099_managed_domains_cloudflare_provider.sql

packages/tests/unit/domains/domain-pricing.test.ts
packages/tests/unit/domains/cloudflare-registrar-stub.test.ts
packages/tests/unit/domains/cloudflare-dns-stub.test.ts
packages/tests/integration/services/managed-domains.service.test.ts
```

## Env vars

```
CLOUDFLARE_ACCOUNT_ID              # required for real CF calls
CLOUDFLARE_API_TOKEN               # required for real CF calls; scope: Registrar:Edit + DNS:Edit + Zone:Edit
ELIZA_CF_REGISTRAR_MARGIN_BPS=3600 # optional; default 36% margin
ELIZA_CF_REGISTRAR_DEV_STUB=1      # local dev — return canned responses, never call CF
```

## Stub mode

When `ELIZA_CF_REGISTRAR_DEV_STUB=1`:
- All CF API calls (registrar + dns) are intercepted and return deterministic fake responses
- Credit-debit + DB writes still happen for real (so the local dev DB can verify the accounting end-to-end)
- Special domain prefixes for testing: `taken-*` returns unavailable; `fail-*` throws CloudflareApiError on register

This lets every flow be exercised locally + in CI without spending real money or needing CF credentials on the dev box.

## Failure modes

| Failure | Handling |
|---|---|
| input validation (domain format, length, record patch) | 400 |
| app not found / cross-org access / record not on zone | 404 |
| domain unavailable | 409, no debit, no CF call |
| dns route called on external domain | 409 with explanatory error |
| insufficient credits | 402, no DB write, no CF call |
| credits debit succeeds, CF register fails | refundCredits, 502 |
| CF register succeeds but zone_id missing | 500, no refund (rare; user owns the domain) |
| DNS CNAME creation fails on buy | log warning, return success (domain owned, manual point ok) |
| DB insert into managed_domains fails after CF success | bubble up 500 — manual ops cleanup required (rare) |

## Tests

Unit (stub mode, no DB, no network): **20 cases / 6 files**
- `domain-pricing.test.ts` — basis-point margin math, rounding behaviour
- `cloudflare-registrar-stub.test.ts` — checkAvailability happy/4xx/5xx, register
- `cloudflare-dns-stub.test.ts` — full CRUD (create/list/get/update/delete)

Integration (real local postgres, no network): **7 cases / 1 file**
- `managed-domains.service.test.ts` — insert/assign/sync/unassign/list round-trip

Real-CF live test is gated behind a real `CLOUDFLARE_API_TOKEN` and is opt-in.

## Companion skills (eliza-fork)

Three skills compose into the agent-facing surface:

- `build-monetized-app` (existing) — ships an app to Eliza Cloud, returns auto-`*.apps.elizacloud.ai` subdomain
- `eliza-cloud-buy-domain` — registers a brand-new domain via cloudflare, paid from cloud credits, attached to an app
- `eliza-cloud-manage-domain` — post-purchase: list, edit dns records, detach

Skill descriptions cross-reference each other so the planner reliably picks the right one (or chains multiple) on a single user prompt.

## What's intentionally NOT here

- Domain transfers (out → cloudflare, or cloudflare → out): v2.
- Bulk operations: v2.
- Per-record analytics: v2.
- A standalone admin UI for domains: relies on existing per-app dashboard for now.
