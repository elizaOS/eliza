# Staging speech host Worker

This Worker exports the canonical API `SpeechRelayCoordinator` in a small
isolate. It has no public route, cron or service binding. The staging API reaches
it through its `SPEECH_RELAY_SESSIONS` binding with `script_name`. Production
keeps the coordinator in the API Worker until staging shows the change works.

## Why a separate Worker

Every speech session is a brand-new object, so the host script's cold start sits
on the bootstrap path. The Voice Live E2E staging runs 42253042765, 42149492907
and 42121063998 used the `/api/v1/voice/speech/hosting-probe` route from #38833.
A new object in the 32 MB API Worker took about 4.4 s on first touch, with a
range of 3.4 to 8.1 s. A new object in the lean admission Worker took about
1.0 s. Touching either object again took 6 to 33 ms.

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
settle as before. New sessions are created in this Worker's namespace, which
the declarative `[exports]` entry creates on the first deploy.

The binding switch does not route pre-switch session tokens to the old
namespace. A client that connects with an old session or consumes an old
consent nonce can get `session_not_found` or `speech_session_unavailable`.
Do not assume that every shipped client retries automatically. Existing
objects still have their retirement alarms in the API namespace, but that
does not prove that a new revoke request reaches an old object after cutover.

For the staging cutover, stop the QA voice clients and verify their settlement
and retirement before changing the API binding. Start new sessions only after
the binding readback. Test Stop, cancellation, revocation and retirement on
the new namespace. Production stays unchanged until that lifecycle and the
latency measurements pass. A live production cutover needs its own reviewed
plan for sessions that span the binding change.

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
- Staging binds this host and production does not.
- Hyperdrive and KV reuse the existing staging IDs.
- Each `env.*` variable the coordinator reads matches the staging API.
- No secret is declared as a plain-text variable.

The contract does not establish secret presence, namespace creation or latency.
The Voice Live E2E staging measurement in the PR checklist covers those.

## Rollback

Revert the speech host change and run the staging release. Removing only
`script_name` from `SPEECH_RELAY_SESSIONS` fails the source contract and blocks
the API deploy. After the revert, new sessions return to the retained API
namespace. Keep the speech Worker, its class, and its secrets until the last
sessions expire and their settlement and retirement are confirmed.
