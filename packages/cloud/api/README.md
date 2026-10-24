# @elizaos/cloud-api

The Eliza Cloud HTTP API: a Cloudflare Workers app (Hono router) that backs auth,
app/agent registration, inference routing, billing, MCP, A2A, domains, and container
deploys.

Runs on Cloudflare Workers with Hono. Start with `bun run --cwd packages/cloud/api dev`;
local bindings are derived from root .env/.env.local. Add routes in the file-based route
tree and run the package codegen script. The build script checks types; typecheck also
validates router and Worker bundling contracts.

Delegated inference budgets are off by default. Apply shared migrations 0544–0545
before setting `INFERENCE_FUNDED_BUDGET_ADMISSION=true`. Keep strong revocation
enabled and configure the same `INFERENCE_FUNDING_BUDGET_SEAL_SECRET` on the
Worker and accounting hosts. Enroll an organization through the internal
`withInferencePolicyMutation({organizationIds, enable: true}, ...)` transaction.
All policy writers must use the managed mutation service; the database rejects
an unfenced change for an enrolled organization.

Bounded, direct Cerebras chat requests use the delegated path. The refill amount
is a target, not a request limit: a larger request can claim the full available
balance. Other operations retain primary admission and can reclaim idle funds.
Funds backing active requests remain reserved. Drain and reconcile all grants,
then use `disableInferenceBudgetAdmission` before turning off the mode.

Account deletion must also withdraw delegated policy before resource cleanup.
If an organization still has enabled authority after the global mode is turned
off, restore the mode and complete the ordinary reclaim/rollback first; deletion
fails closed until that acknowledgement succeeds. Already disabled authority
still requires confirmed API-key cache withdrawal. Completed nonfinancial policy
rows can then be removed with the mode on or off. Pending policy mutations and
any retained funding grants or receipts block final erasure. Financial-history
erasure requires its retained-audit owner and is not implemented by this cleanup.

The native metadata regression is opt-in. CI does not currently provision its
`INFERENCE_POLICY_TEST_POSTGRES_URL`; a green general pipeline is not proof that
it ran. Use an isolated loopback PostgreSQL QA role whose name starts with `qa_`,
set that variable, and run from the root:

```bash
bun --no-install --conditions=eliza-source test packages/cloud/shared/src/lib/services/inference-policy-account-deletion.postgres.integration.test.ts
```

The suite creates and removes a unique schema and loads migrations 0544–0545.
It must not point to a production database.

Authentication nonces, token revocations, voice session mappings and connection claims can use the
private `AUTHENTICATION_STATE` Durable Object binding with
protected deployment variable `CLOUD_AUTH_STATE_BACKEND=cloudflare`. The
canonical release validates this selection. The default remains `redis` until a
quiesced transfer preserves each live key's original expiration. A missing
selected binding fails closed; the host never falls back to Redis after activation.
The operator-only private-binding import preserves absolute expirations, rejects
conflicts, and closes permanently for a shard once it serves an auth operation.
Finish and verify imports before sending normal reads or writes to the target.
This does not replace rate limits, gateway queues, or other Redis state.

These additional private stores also default to `redis`:

| State | Protected release variable |
| --- | --- |
| Monthly download quotas | `CLOUD_HF_EGRESS_BACKEND` |
| Daily voice quotas | `CLOUD_VOICE_USAGE_BACKEND` |
| Fixed and sliding rate limits | `CLOUD_RATE_STATE_BACKEND` |
| A2A tasks and organization index | `CLOUD_A2A_STATE_BACKEND` |

Stop source writers and transfer complete state with original expiry before
selecting `cloudflare`. Imports reject conflicts and close permanently once
their owner serves normal operations. Rate counters retain carried requests;
voice and download quotas retain refunds and limits. A2A retains complete tasks
and index scores. Its update callbacks must be pure because version conflicts
retry them. Missing selected bindings fail closed. Other Redis domains remain
separate migration work.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/api build  # build
bun run --cwd packages/cloud/api test   # tests
```

## Independent native App Auth clients

`ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON` optionally registers additional native clients.
It is a server-owned JSON array of `{clientId, appId, redirectUri, enabled,
credentialTtlSeconds?}` records. `credentialTtlSeconds` sets the lifetime of the
client's `eliza_mobile_` credential: an integer from one day to 90 days, 30 days
when absent.
Client IDs, app UUIDs and canonical HTTPS return URLs must be unique, including
against the existing `ai.elizaos.app` registration. Unknown and disabled clients
fail closed; malformed additional configuration does not change the legacy client.
The global mobile-auth enable switch and environment binding still apply.

Auth has separate configuration boundaries. A Cloud exchange callback is not
necessarily the browser callback used by Google:

| Channel | Server-owned configuration | Consumer responsibility |
| --- | --- | --- |
| Cloud credential exchange | `ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON` and an approved `apps` row | Client ID, environment and exact exchange callback |
| Google sign-in | Steward tenant/app redirect registration and `STEWARD_OAUTH_APP_ERROR_REDIRECTS` | PKCE, state, optional Steward `authClientId`, browser return handling |
| Gmail connector consent | `APP_OAUTH_RETURN_URLS` | App nonce and authenticated connection readback |
| Android verified links | `ELIZA_ANDROID_ASSET_LINKS_JSON` | Package, signing certificate and manifest URL filters |
| Hosted fallback | Pages `ELIZA_NATIVE_AUTH_CALLBACKS_JSON` | Public callback URL, package and display name |

Request parameters can select these registrations; they cannot register a new
callback. App IDs in Cloud and client IDs in Steward belong to different stores
and must not be assumed interchangeable. No product repository is imported by
these shared mechanisms.

Before enabling a client, provision its own active, approved app with an active
owner/organization, an exact allowed callback, and no live generated application
API key. Use separate registrations in staging and production. Validate the public
`/api/v1/app-auth/mobile/config` response for that client/environment/return URL
before shipping. The app UUID and server secrets must not be included in the
native configuration. Retain the existing S256 grant, inactive exchange, durable
receipt acknowledgment, self-revocation and account recovery contracts. `cloud:user`
is the existing broad user/organization capability, not a narrower permission claim.

The release workflow publishes the registry from the protected
`ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON` environment secret. The
`Mobile App Auth Registration Admin` workflow diagnoses or repairs a client's
`apps` row: enter any enabled `clientId` from the selected environment's registry.
The app UUID and exact callback come only from that protected registry. The admin
uses the Worker's validator, including uniqueness against the primary client and
validation of every registry entry. No application names or callback paths are
compiled into the admin. New rows get a neutral display name;
existing rows retain their branding. Use separate environment registries. The
registry's callback is authoritative; the admin does not infer an environment
from a hostname. Review each environment's registry before repair.
Set `ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID` to select the same client for the
standalone verifier. With the protected environment variables present, run
`node packages/scripts/cloud/admin/verify-mobile-app-auth-registration.ts
--skip-database --verify-live` to check its public metadata without a database read.
Omitting the selector keeps the primary-client release check.

### App-owned managed Google returns

App-owned connector callbacks use `APP_OAUTH_RETURN_URLS` for exact HTTPS
Gmail return addresses. Initiation accepts the app nonce as the only `state`
query parameter and returns `appReturn: 2` when configured. The callback uses
server-owned state and returns only state/result plus `connectionId` on success.
The app must verify that connection through its authenticated connector list.
Denial retires state and creates no grant. Unknown state keeps existing recovery.
Google credentials and token refresh behavior are unchanged. The app domain's
callback assets and Android association must be deployed before live acceptance.

### Native in-app sign-in

Any registered native app can use email codes or Google with a verified HTTPS
App Link. The app supplies its configured callback and keeps its PKCE verifier
private. It redeems the Steward code, then exchanges the Steward session through
`POST /api/v1/app-auth/connect` (`flow: "mobile_pkce"`), `mobile/token` and
`mobile/ack`. Successful OAuth returns carry code and state only in the fragment.

Reusable synthetic callback vectors live in
`packages/app/test/fixtures/native-signin-callback.contract.json`. The Pages
fallback and Steward integration tests run these vectors. Consumer repositories
own their actual Android packages, callbacks, branding and acceptance tests.

Use `prompt=select_account` for a user gesture before the App Link and
`mfa=exchange` to finish a required second factor through the existing exchange
and MFA endpoints. An MFA-required response carries no session tokens.

Native email sign-in is a six-digit code typed into the app:

- `POST /steward/auth/email/code/send` with `{email, tenantId?, captchaToken?}`
  answers `{ok: true, data: {expiresAt, codeLength: 6}}`. The email carries only
  the code (sign-in code template, no link); no link token is issued. The code
  is crypto-random, valid 10 minutes, stored only as an HMAC bound to the
  address and tenant, single use, replaced by a later send, and locked after 5
  wrong attempts. Limits: 30/min per IP, 5 per 10 minutes per address (shared
  with `/email/send`), 120/min per tenant. Errors: 400 (bad body, tenant email
  policy, captcha), 403 (email login disabled for the tenant, or an SSO-only
  domain), 404 (unknown tenant hint), 429, 502/503 (delivery).
- `POST /steward/auth/email/code/verify` with `{email, code, tenantId?}` answers
  the Steward session `{ok: true, token, refreshToken, expiresIn, user}` (or
  `{ok: true, mfaRequired: true, mfa, user}`), which the app passes as Bearer
  to `mobile_pkce` connect. Wrong or expired codes are 401; lockout and rate
  limits (10/min per IP, 5 per 10 minutes per tenant and address) are 429.
- `delivery: "code"` on `POST /steward/auth/email/send` remains as an older
  spelling of the code-only email under the same limits. Without it, that
  endpoint keeps sending the web magic link plus code.

Operator configuration per environment:

- `ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON` (GitHub Environment secret on `staging` /
  `production`) registers each app's client ID, app UUID and exact callback. Leave `credentialTtlSeconds` unset (30-day default) while the
  device's `eliza_mobile_` key remains readable by the app renderer. Then run the
  admin workflow's repair for that client.
- `ELIZA_ANDROID_ASSET_LINKS_JSON` is a GitHub **variable** (`vars.`), defined on
  the `staging` / `production` GitHub Environment or at repository level. The
  release workflow publishes it to the Worker as a Worker secret. It is a JSON
  array of `{package_name, sha256_cert_fingerprints[], relations?}` served at
  `/.well-known/assetlinks.json` on the API host and, through the Pages proxy, on
  `eliza.app` and `staging.eliza.app`. Malformed values publish `[]`. Without
  the release signer's fingerprint, App Link verification fails on every phone:
  do not promote native sign-in to production until it is set and
  `adb shell pm get-app-links <application-package>` shows the host as
  `verified`.
- The Steward tenant `elizacloud` must list the callback in its
  `allowedRedirectUrls`. `/auth/oauth/:provider/authorize` receives an explicit
  `tenant_id`, so `STEWARD_OAUTH_ALLOWED_REDIRECTS` does not apply to it.
- Steward (`packages/auth`) deploys separately from `cloud-cf-deploy`. The
  Google `prompt=select_account` passthrough, `mfa=exchange` and
  `/email/code/send` reach a device only after that deployment.

For a callback hosted by Eliza Pages, set `ELIZA_NATIVE_AUTH_CALLBACKS_JSON`
in the protected Pages production/preview environment before deploying this change.
This is a separate Pages binding, not an API Worker secret. It is a JSON array:

```json
[{"redirectUri":"https://eliza.app/example/return","androidPackage":"org.example.reader","appName":"Example Reader"}]
```

Entries contain only public routing and display data, never app UUIDs or secrets.
Each exact origin/path selects one package and escaped display name. Staging needs
its own exact URLs; an entry on one host does not authorize it on another. Unknown
routes keep ordinary site behavior, and malformed or duplicate configuration fails
closed. Apps hosting their own callbacks need no Pages entry. The callback used
only for Cloud's API-to-API mobile code exchange needs no browser page at all.

When Android does not intercept a configured callback, Pages serves a no-store
fallback. It never forwards a code: package-name intents do not verify the signer.
The control opens the configured app with no parameters, or only
`error=app_link_unverified` and a well-formed state. A hash-pinned script clears
query and fragment from history. Success still requires a verified App Link.

Migration: copy every currently supported callback, package and display name into
the deployment's Pages binding before rollout. Retain legacy URLs as configuration
until installed clients migrate. Update Steward tenant/app redirect allowlists,
`STEWARD_OAUTH_APP_ERROR_REDIRECTS`, Android manifests and asset links separately.
Adding an app requires protected configuration and app registration, not a new
upstream product branch. Verify the public metadata, both callback hosts and real
Android link delivery before declaring live sign-in accepted.

Remaining Cloud-hosted pages a native sign-in can still reach: this fallback
page, and Steward's OAuth error page inside the Custom Tab for non-MFA failures
(its "Return and try again" link is a contract error return).

## Subscription grant codes and entitlements

Grant codes are Cloud-native, not Stripe promotion codes. A redeemed code gives
the organization its plan (default Plus for 183 days) through the existing
entitlement and monthly allowance tables, then reverts. One grant per
organization per code family. An effective paid subscription keeps precedence:
a grant redeemed during a paid plan runs at the same time and serves only after
the paid plan stops serving (lapse, cancellation or expiry) inside the grant
window. The redeem response says so with `grant.paidPlanTakesPrecedence`.

A code can instead carry a calendar-month term (`duration_months`, for example
a six-month pilot): the window ends on the same UTC date and time that many
months after redemption, clamped to a shorter month's last day. A code marked
`requires_no_paid_plan` is refused with 409
`subscription_grant_paid_plan_active` while the organization has an open
(pending, incomplete, active, grace, past due or unpaid) organization
subscription, or when its subscription authority is unknown, so an existing
payer is never billed for a window the grant also covers. Redemption never
creates a payment method, invoice or renewal.

`GET /api/v1/billing/limits` reports the active grant in the additive v2
`grant` observation: `grantId`, `planKey`, `startsAt`, `endsAt` (the
free-through instant, null for lifetime), `paidPlanTakesPrecedence` and the
current month's `allowance` (`granted`, `unreserved`, USD). It is
`not_applicable` (`no_active_subscription_grant`) after expiry or revocation.
Clouds without this field are unknown, not "no grant".

An administrator can mint a lifetime code with `--lifetime`. Its grant has
`endsAt: null` and remains active until revoked. The plan's monthly allowance
still resets each month without rollover. The billing reconciliation cron keeps
the current and next two monthly periods funded; missed months do not accumulate.

- `POST /api/v1/subscription/redeem` with `{code, idempotencyKey}`, using an API
  key or a session. Replays return the original grant. Unknown, expired,
  disabled and used-up codes return one generic 400. Limited per credential
  (own counter) and per IP. Codes are 16 Crockford base32 characters; O reads
  as 0 and I/L as 1.
- `GET /api/v1/subscription/entitlement` returns `{entitlement}`, a 30-minute
  ES256 JWS (`typ` `eliza-entitlement+jwt`, `aud` `eliza-alpha-phone`). It
  never expires after the plan window or allowance period it reports. Format
  `ver: 2` adds `plan_allowance` `{unit: "usd_micros", granted, remaining,
  periodStart, resetsAt}` when the plan has a current allowance period.
  Amounts are integer millionths of a US dollar, Cloud's own allowance unit;
  `remaining` excludes amounts Cloud has reserved but not spent. Tokens without `ver` are v1. A new
  claim name keeps v1 clients working, because they reject an `allowance`
  claim whose unit is not requests or tokens.
- `GET /api/v1/subscription/entitlement-keys` (public, cached 60 s) returns the
  current, previous and next public keys. Both entitlement routes return 503
  until the `ELIZA_ENTITLEMENT_*` secrets are set; redeem needs
  `ELIZA_SUBSCRIPTION_GRANT_CODE_PEPPER`.
- Key rotation: set `ELIZA_ENTITLEMENT_NEXT_*` and wait over 60 s; then sign
  with the new key, move the old public key to `ELIZA_ENTITLEMENT_PREVIOUS_*`
  and clear `NEXT`; clear `PREVIOUS` after 30 minutes.
- Inference refusals: a subscriber whose current allowance is spent gets 402
  `insufficient_quota` with `code: "allowance_exhausted"` and `resetsAt`
  (402, not 429, keeps existing OpenAI-style clients). 429 bodies add
  `retryAfterSeconds`.
- Plan request buckets: completions pass a burst and a sustained token bucket
  per organization, user and plan before the policy transaction. The check is
  in memory (per Worker isolate) and adds no round trip; the Durable Object
  per-minute window stays the global limit. A refusal is 429 with
  `Retry-After` and `error.code: "rate_limited"`, `retryAfterSeconds`,
  `retryAfterMs`, `retryAt`, `plan.id` and `limit`. A cache miss, an ended
  plan window or a billing outage decides from memory with the `default`
  limits. Maps has its own buckets, with a plan's optional `maps` limits or
  else the plan's limits. The buckets are per isolate, so they bound bursts
  but are not an exact global cap: a caller spread over N isolates can get N
  full buckets. There is no shared bucket store, because KV cannot count
  atomically and a Durable Object or Redis bucket adds a round trip to every
  turn (see `plan-request-limiter.ts`).
  Set `ELIZA_CLOUD_PLAN_RATE_LIMITS` (see `shared/.env.example`); it is
  off while unset. The numbers are not selected yet; `placeholder` enables
  unselected test values only. Latency benchmark:
  `bun --conditions=eliza-source packages/cloud/scripts/plan-request-limit-latency.ts`.

Scripts (same `DATABASE_URL` and pepper as the target environment; apply
migrations through `0547_subscription_grant_calendar_terms` first):

- Mint: `bun --conditions=eliza-source packages/cloud/scripts/admin/mint-subscription-grant-codes.ts --count N`.
  Codes print once; only HMACs are stored.
  Add `--lifetime` for no expiry, `--duration-days N` or `--duration-months N`
  (UTC calendar months) for a bounded grant, and `--requires-no-paid-plan` to
  refuse paying organizations. The staging mint workflow still passes days only.
- Revoke: `bun --conditions=eliza-source packages/cloud/scripts/admin/revoke-subscription-grants.ts --reason "..." --code XXXX-XXXX-XXXX-XXXX`
  (or `--grant-id`). Service stops at once; `--code` also disables the code.
- Staging: mint with the `Cloud staging mint grant codes` workflow, which seals
  the codes to your public key (see `packages/cloud/scripts/README.md`).

Grant rows are retained billing records. Deleting the redeeming user clears
`user_id`; an organization keeps its grant rows like its paid allowance history.

## Pending plan-change discovery

`GET /api/v1/subscriptions/plan-change/commands?limit=...` rediscovers the current
billing manager's own pending upgrade/downgrade commands. Use its opaque cursor
for the next bounded page; it is bound to organization, actor and command family.
Each page is a fresh primary read, not a frozen multi-request snapshot. Discovery
does not claim a lease, contact the payment provider or resume an operation.
The response includes original target, lease state and current-source relationship;
read the corresponding command status or refresh the subscription before acting.
Cancellation/resumption retain the separate `/subscriptions/commands` contract.

## Organization renewal review

`GET /api/v1/subscriptions/cancel/undo/review` accepts `subscriptionId` and a
positive decimal `expectedSubscriptionRevision`. It requires the current billing
manager session and returns a no-store, 60-second renewal estimate for an eligible
scheduled cancellation. The pinned provider invoice preview includes tax, discounts
and customer balance; unsupported or incomplete previews fail closed. It creates
no command, invoice or payment. `termsDigest` compares reviewed terms; it is not an
authorization token or price lock. Use the confirmation route below to persist and revalidate reviewed terms
before a reversal dispatch.

`POST /api/v1/subscriptions/cancel/undo/confirm` requires the subscription ID,
expected lifecycle revision, idempotency key and `expectedRenewalTermsDigest`
from the review. It persists fresh matching terms with the durable command and
revalidates them before dispatch. Reusing the same intent reads its recorded
outcome; it never dispatches again. Changed terms before admission return 409;
a rejection with a still-ready lease becomes FAILED, while a started dispatch
retains OUTCOME_UNKNOWN until observation resolves it. Recovery fails expired
prepared reviews without reconstructing a mutation. The existing undo/status
APIs remain compatible; consumers needing reviewed confirmation use this route.
Apply migration `0510_subscription_renewal_review_receipts` before deploying.


## Organization upgrade review

`POST /api/v1/subscriptions/upgrade/review` accepts `subscriptionId`, a positive
safe-integer `expectedSubscriptionRevision`, and a catalog `targetPlanKey`.
The current billing manager session is required and revalidated after provider
reads. The no-store response contains `quoteId` and `review`, separating due-now
proration/tax/discount/customer-balance terms from a long-term recurring estimate.
The exact reviewed timestamp and prorated additional allowance are retained.
Apply organization-upgrade migrations 0511 through 0520 before deployment.
Saving a quote creates no charge, command or allowance grant. Confirmation and
payment continuation use the separate endpoints below; scheduled downgrade remains
separate lifecycle work.

`POST /api/v1/subscriptions/upgrade/confirm` accepts only `quoteId` and
`idempotencyKey`. It revalidates the current manager and original review before
one dispatch; retries retain the original command. `GET /api/v1/subscriptions/upgrade/:commandId`
reads durable status without provider work. Both return no-store responses and
require a current billing-manager session. `OUTCOME_UNKNOWN` can include pending
payment and must not trigger a new intent. `failure: review_required` means an
unstarted review ended; `invoice_void` requires definitive original void evidence.
Product UI/native adoption and real provider acceptance remain separate work.

`POST /api/v1/subscriptions/upgrade/:commandId/payment` reconciles the original
command and returns either durable status or an ephemeral private hosted-invoice
continuation. It checks the original invoice, reviewed amount, pending target and
unpaid payment intent, then revalidates manager/source/session authority. It never
creates or pays an invoice. The no-store URL must stay out of logs, model context
and history. Call again after browser return; return alone does not prove payment.

`POST /api/v1/subscriptions/downgrade/review` uses the same authenticated catalog
intent and returns an immutable lower-plan quote. `effectiveAt` is the current
period end and `amountDueNowCents` is zero. `recurringEstimate` is a long-term
estimate, not a guaranteed next invoice. This endpoint creates no provider
schedule, command, charge or allowance change; downgrade confirmation is not
yet exposed. Upgrade confirmation rejects a downgrade quote.


Organization downgrade confirmation uses `POST /api/v1/subscriptions/downgrade/confirm`
with only `quoteId` and `idempotencyKey` from an explicitly reviewed original quote.
`GET /api/v1/subscriptions/downgrade/{commandId}` reads durable status without
provider work. Both require the current billing-manager session, recheck identity
before returning, and return no-store responses. Confirmation resumes the original
journal; it never repeats a started provider effect. APPLIED records a pending
lower plan, not payment or immediate lower-plan allowance. Missing/changed original
command authority is a conflict, not proof that a replacement intent is safe.
Apply scheduling migrations through 0527 before deployment. Unattended recovery,
configured-schedule undo/cancel/resume, retained-adjustment payment authority and
live qualification remain required before product rollout.

## Speech rendering controls

`POST /api/v1/voice/tts` accepts optional `speed` (0.7–1.2), `previousText` and
`nextText` (at most 5,000 characters each), and `applyTextNormalization`
(`auto`, `on`, `off`) for ElevenLabs synthesis. Explicitly pin an ElevenLabs
voice when the deployment defaults to another provider; unsupported providers
reject these options instead of silently dropping them. Context passes through
content screening, but only the synthesized text is priced. Requests with any
rendering control bypass the legacy audio cache. Explicit normalization takes
precedence over the service's legacy latency optimization. Successful responses
with explicit speed include `X-Eliza-TTS-Speed`, allowing clients to avoid applying
pace twice and detect older deployments. Response audio and
existing authorization, admission and billing boundaries are unchanged.

Set `withTimestamps: true` with an ElevenLabs voice to receive
`application/x-ndjson` and `X-Eliza-TTS-Timing: character-v1`. Timed output is MP3
only and bypasses audio caching. Each `audio` record has a zero-based sequence,
base64 audio, MIME type, original alignment and normalized alignment (nullable).
Alignment arrays retain provider character coordinates; no timing is estimated.
A final `done` record reports frame/audio-byte totals; missing completion means
the stream is incomplete. Consumers must validate timing and bind it to their
playback clock. The adapter bounds audio to 8 MiB, combined alignment to 50,000
characters and records to 2,048; exceeding a limit fails rather than truncates.
Cancellation aborts the provider transport. Provider errors after response headers
error the stream without a completion record; existing synthesis billing semantics
remain unchanged. This endpoint alone does not provide client streaming playback.

## Maps

`/api/v1/maps/*` is the shared Maps data service for agents. `GET capabilities`
returns the provider, dataset revision, regions, travel modes and attribution.
`POST geocode`, `reverse`, `places/search`, `places/details` and `routes` take
the query or coordinates in the JSON body, so location data is not in URLs or
logs. Each route needs an API key or session, an active or trialing plan
(`403 subscription_required`) and the per-credential rate limit. The
`admit` hook in `src/lib/maps-route.ts` applies the plan request buckets while
`ELIZA_CLOUD_PLAN_RATE_LIMITS` is set: `429 rate_limited` with `Retry-After`
and `retryAfterSeconds` in the body. The buckets run after the plan read, so a
refused Maps request still costs that database read.
Success bodies name the provider and carry its attribution. Failures are typed:
`422 unsupported_region | unsupported_mode | no_route`, `503 maps_not_configured
| provider_unavailable` (with `Retry-After`), `502 provider_invalid_response`.
Cloud never returns guessed places or routes. Navigation and GPS stay on the device.

The provider is OpenStreetMap data on a self-hosted Nominatim (search, geocode,
reverse, details) and GraphHopper (routes, profiles `car`, `foot`, `bike`). Ops
must provision, for each environment:

- `ELIZA_MAPS_GEOCODER_URL`: HTTPS Nominatim 4.3 or later loaded with the region
  extracts.
- `ELIZA_MAPS_ROUTER_URL`: HTTPS GraphHopper with the same extracts and the
  `car`, `foot` and `bike` profiles; optional `ELIZA_MAPS_ROUTER_API_KEY`.
  Set `ELIZA_MAPS_ROUTE_ALTERNATIVES=false` if the deployment cannot compute
  alternative routes.
- `ELIZA_MAPS_COVERAGE_JSON`: the regions both services cover, as
  `[{"id","name","bounds":[west,south,east,north]}]`.
- `ELIZA_MAPS_DATASET_REVISION`: the extract date or version that is served.

Ops also own the update schedule (dataset freshness), monitoring, capacity and
ODbL obligations. Transit, traffic and map tiles are not served.

Maps uses a separate organization request allowance (Alpha P-56, issue #410).
It never reserves or debits inference funds. Operators must set
`ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES` to a selected JSON policy with
`{selected:true,plans:{<planKey>:{requests:<integer>,windowSeconds:<integer>}}}`.
No numeric defaults are provided. Zero requests is a valid closed allowance.
Windows start at UTC epoch multiples of the selected duration. Policy changes
retain use in the current window; a changed duration refuses until that window
ends. Selected `ELIZA_CLOUD_PLAN_RATE_LIMITS` with usable burst and sustained limits
is also required; its explicit default plan fallback is preserved. Both dimensions are enforced in
shared durable storage and carry across allowance window resets.

POST Maps requests require `Idempotency-Key`. Admission consumes one request;
repeating the same credential/request ID never grants another provider call.
Cancellation before admission consumes nothing. Accepted requests, lost
acknowledgements, and cancellation after admission stay consumed. Outcome
updates are idempotent and do not refund or charge. Provider timeouts and lost
outcome updates remain unknown. Durable replay records retain only credential
identity, operation, admission time/window and outcome, with no query,
coordinates, payload hash or provider response. These records are not expired
because expiry would permit replay; account-erasure policy must cover them.
Storage grows by one small metadata record per admitted request. Operators must
monitor Durable Object storage; full/unavailable storage refuses admission. A
future compaction policy must preserve replay refusal, not silently expire IDs.

Strong credential revocation and the organization DO binding are required.
The route holds the primary policy read lock through admission. Identity cache
reuse does not establish cache-only entitlement admission: ordinary policy
writers do not synchronously fence every cached generation. Shared allowance
correctness is implemented; deployed latency/audio and numeric policy selection
remain separate acceptance work. Coverage metadata does not consume allowance.

## Hosted speech migration

With the Workers AI binding configured, supported legacy Kokoro voice IDs select
replacement Aura-2 voices from `KOKORO_CLOUDFLARE_VOICES`. These are replacement
voices, not the original Kokoro identities. Responses identify the actual provider
and speaker in `X-Eliza-TTS-Provider` and `X-Eliza-TTS-Voice`. Configured Cartesia
defaults and custom ElevenLabs voices retain their existing selection and billing.
Set `VOICE_BATCH_STT_PROVIDER=cloudflare` to move a pinned Whisper deployment to
Workers AI Nova-3, including word timestamps and Telegram Ogg voice notes; verify authenticated TTS/STT before retiring the old services.

Workers AI TTS accepts up to 2,000 characters per request. Longer text is rejected explicitly before synthesis; it is never truncated.
