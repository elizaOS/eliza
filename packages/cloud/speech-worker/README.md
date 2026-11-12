# Staging speech host Worker

This candidate Worker exports the canonical API `SpeechRelayCoordinator` in a
small isolate. It has no public route, cron or service binding. Staging and
production keep speech sessions in their existing API namespaces. A reviewed
staging binding change can select this host after provisioning, freeze, drain
and protected attestation are complete. Routine API-host releases do not publish
or require this unused candidate; live inventory must confirm the API still owns
the selected namespace, so an active speech host cannot silently roll back.

## Why a separate Worker

Every speech session is a brand-new object, so the host script's cold start sits
on the bootstrap path. The Voice Live E2E staging runs 42253042765, 42149492907
and 42121063998 used the `/api/v1/voice/speech/hosting-probe` route from #38833.
A new object in the 32 MB API Worker took about 4.4 s on first touch, with a
range of 3.4 to 8.1 s. A new object in the lean admission Worker took about
1.0 s. Touching either object again took 6 to 33 ms.

The current local dry runs produced a 5,132.00 KiB speech Worker (1,284.47 KiB
gzip) and a 32,179.04 KiB API Worker (8,285.78 KiB gzip). These are bundle
measurements, not timing results. This new speech host's live cold-start latency
has not been measured; the 1.0 s result above belongs to the admission Worker.

The coordinator does not go in `eliza-cloud-admission-staging`. That Worker has
no database, cache or provider credentials, and its contract enforces that.
Accounting reaches it only through private API capabilities. The coordinator
needs Cartesia credentials, Hyperdrive, `CACHE_KV` and redis-rest. Putting those
in the admission isolate would add credentials to the financial authority and
would make its cold start larger. A separate script keeps both properties.

## Lifecycle: a new namespace, not a transfer

`InferenceAdmissionGate` was transferred because each of its objects holds
long-lived quota and balance state for an organization. A speech session object
is different. Each session gets a new object, and no state is shared across
sessions. Minting can advance the preparation expiry, and older clients can
request renewable session windows. The staging API therefore keeps
its `SpeechRelayCoordinator` export, with no transfer and no deletion. Objects
created before the binding switch run their retirement alarms there and
settle as before. After activation, new sessions use this Worker's namespace,
which the declarative `[exports]` entry creates on the first deploy.

The binding switch does not route pre-switch session tokens to the old
namespace. A client that connects with an old session or consumes an old
consent nonce can get `session_not_found` or `speech_session_unavailable`.
Do not assume that every shipped client retries automatically. Existing
objects still have their retirement alarms in the API namespace, but that
does not prove that a new revoke request reaches an old object after cutover.

For the first staging switch, the protected release Environment must supply
`STAGING_SPEECH_CUTOVER_ATTESTATION`. The release checks the current API's
`VOICE_SPEECH_RELAY_ENABLED=false` binding, exact namespace owners/IDs, and the
attestation before release mutations and again immediately before API publish.
It fails closed on missing or incomplete provider inventory. Already-active
speech-host updates need no new attestation. Production is unchanged.

This is **human-trusted drain evidence**, not a measured session count. Stop QA
clients, set the old API's speech admission flag false, and wait for every
already-admitted request and session to settle and retire. Keep admission and
clients quiesced across all serving versions until the binding switch: a point-in-time empty population
alone is insufficient. The existing flag blocks consent, mint and WebSocket
entry but preserves revoke; it cannot recall an in-flight request. The release
lock serializes releases, not independent administrative changes to the flag.

Set the protected secret to this strict JSON shape, using the exact release
commit and IDs from the current Cloudflare inventory. Use canonical UTC
millisecond timestamps; expiry must be after issuance and at most 15 minutes
later. The evidence field identifies the operator's drain record; the script
does not verify that record. Never put provider credentials in it.

```json
{
  "version": 1,
  "sourceSha": "<40 lowercase hex characters>",
  "fromWorker": "eliza-cloud-api-staging",
  "fromNamespaceId": "<32 lowercase hex characters>",
  "toWorker": "eliza-cloud-speech-staging",
  "toNamespaceId": "<32 lowercase hex characters>",
  "issuedAt": "2026-11-08T16:00:00.000Z",
  "expiresAt": "2026-11-08T16:15:00.000Z",
  "legacySessionsDrained": true,
  "legacyAdmissionHeld": true,
  "evidence": "<operator drain record>"
}
```

The committed staging binding stays local. Activation requires a reviewed change
that adds `script_name = "eliza-cloud-speech-staging"` to that binding. The release
then enforces the first-cutover checks above. First provision only
the target host from the candidate source; this command does not deploy the API
or change its binding. Use the staging account and the same voice usage backend
as the API, then provision the required secrets through the protected operator
channel. The host has no public route or caller until the API binding switches.

```bash
bun packages/cloud/speech-worker/verify-staging-contract.ts
bunx wrangler deploy --config packages/cloud/speech-worker/wrangler.toml \
  --var ELIZA_DEPLOY_COMMIT:"$CANDIDATE_SHA" \
  --var CLOUD_VOICE_USAGE_BACKEND:"$CLOUD_VOICE_USAGE_BACKEND" --tag "$CANDIDATE_SHA"
```

Read back both actual namespace IDs after this host-only provisioning and use
them in the attestation. A missing target stops activation with a bootstrap
instruction; its namespace is never invented from config. Start new sessions
only after the final API binding readback. Test Stop, cancellation, revocation
and retirement on the new namespace. A production cutover needs its own
reviewed plan for sessions spanning the binding change.

## Dependencies (declared here, provisioned by the operator)

| Kind                  | Name                                                    | Source                                              |
| --------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| Durable Object (self) | `SPEECH_RELAY_SESSIONS` -> `SpeechRelayCoordinator`     | this Worker                                         |
| Durable Object        | `INFERENCE_ADMISSION_GATES` -> `InferenceAdmissionGate` | `eliza-cloud-admission-staging`                     |
| Durable Object        | `VOICE_USAGE_STATE` -> `VoiceUsageState`                | `eliza-cloud-api-staging`                           |
| Hyperdrive            | `HYPERDRIVE`                                            | existing staging id (same as API)                   |
| KV                    | `CACHE_KV`                                              | existing staging id (same as API)                   |
| Secret                | `CARTESIA_API_KEY`, `CARTESIA_STT_USD_PER_CREDIT`       | operator                                            |
| Secret                | `DATABASE_URL`                                          | operator (same origin the API's Hyperdrive proxies) |
| Secret                | `KV_REST_API_URL`, `KV_REST_API_TOKEN`                  | operator (staging redis-rest)                       |
| Deploy-time var       | `CLOUD_VOICE_USAGE_BACKEND`                             | release workflow, same value as the API             |

The release workflow checks these secret names, never their values, with
`scripts/verify-worker-secret-binding-names.ts`. It refuses to publish this
Worker, or the API that binds it, while any name is missing.

## Validation

```bash
bun packages/cloud/speech-worker/verify-staging-contract.ts
bun test packages/cloud/api/__tests__/speech-worker-contract.test.ts
bun test packages/cloud/scripts/production-deploy-admission-lock.test.ts
bun packages/cloud/api/node_modules/wrangler/bin/wrangler.js deploy --config packages/cloud/speech-worker/wrangler.toml --dry-run --outdir test-results/speech-worker-candidate
```

The source contract checks the following:

- Declarations, aliases and defines match the canonical staging API.
- The API keeps exporting its namespace.
- Staging selects exactly the API or this host; production stays on the API.
- Hyperdrive and KV reuse the existing staging IDs.
- Each `env.*` variable the coordinator reads matches the staging API.
- No secret is declared as a plain-text variable.

The contract does not establish secret presence, namespace creation or latency.
The Voice Live E2E staging measurement in the PR checklist covers those.

## Rollback

After activation, stop clients and freeze admission on the speech-host side;
confirm its in-flight requests and sessions have settled and retired. A revert
alone does not drain that namespace. The routine release refuses to move an
active speech-host namespace back to the API. A reverse cutover needs its own
reviewed drain and admission procedure before new sessions return to the API
namespace. Keep the speech Worker, its class, and its secrets until the last
sessions expire and their settlement and retirement are confirmed.

The registered `speech_host_cutover.qnt` model separates enforced identity,
expiry and admission checks from the truthful-human-drain assumption. Its
negative witnesses retain the unsafe un-gated switch, a false drain claim,
and admission thaw after attestation. Workerd regressions exercise the real
old/new namespace routing and old-namespace settlement behavior.
