# @elizaos/auth

Browser login, hosted and embedded identity sessions, account OAuth, and encrypted
credential storage. Keep credentials in the trusted host; never log them.

## Entry points

| Import                      | Owner                                                                       |
| --------------------------- | --------------------------------------------------------------------------- |
| `@elizaos/auth`             | Browser-safe login client, types, chain metadata and signature verification |
| `@elizaos/auth/auth`        | Account storage, provider login and serialized credential refresh           |
| `@elizaos/auth/accounts`    | Node-only linked-account selection, usage accounting and credential bridges |
| `@elizaos/auth/providers`   | Provider credential verification and usage adapters                         |
| `@elizaos/auth/vault`       | Encrypted credential vault                                                  |
| `@elizaos/auth/kms`         | Key management adapters                                                     |
| `@elizaos/auth/server`      | Identity router without process startup                                     |
| `@elizaos/auth/start`       | Hosted Bun service with PostgreSQL                                          |
| `@elizaos/auth/embedded`    | Embedded Bun service with persistent PGlite                                 |
| `@elizaos/auth/native-host` | Trusted Node enrollment flow                                                |
| `@elizaos/auth/app-return`  | Browser-safe foreground return and registered Workspace AppReturn v2 policy |
| `@elizaos/auth/testing`     | Vault fixtures for tests only                                               |

Use these barrels in repository consumers. Explicit old account/vault paths and
`/credentials` remain compatibility aliases; new implementation files are private.
Hosted login uses `postgres-js`; embedded login owns PGlite. Unsupported database
drivers fail explicitly. Runtime shutdown drains webhook deliveries before closing
its database, Redis connection and configuration-dependent vault cache.
Without configured Redis, hosted and embedded login keep request replay receipts
in their existing database store. A configured Redis outage does not switch stores.

## Development

Use the repository's pinned Bun and Node versions. Install from the repository root
with `bun install`, then run:

```bash
bun run --cwd packages/auth test
bun run --cwd packages/auth typecheck
bun run --cwd packages/auth lint
bun run --cwd packages/auth test:browser
LOGIN_TEST_DATABASE_URL=postgres://postgres:password@127.0.0.1:5432/postgres bun run --cwd packages/auth test:postgres
```

The PostgreSQL lane requires a loopback server and an administrator able to create
an isolated database and role. It fails when configuration is missing. CI runs
`test:integration` for Chromium/passkey and PostgreSQL tenant-isolation contracts.
The default tests also verify the built deployment package. The login tests use
local OpenSSL to generate ephemeral attestation certificates and verify that
untrusted chains cannot trigger revocation requests.

## Registered application OAuth returns

`GET /auth/oauth/google/app-readiness` checks tenant policy, the app's registered
HTTPS redirect, existing Google credentials and error-return configuration. It
returns `{ok:true, appAuth:1, tenantId, redirectUri}` without creating a challenge.
Configure `STEWARD_OAUTH_APP_ERROR_REDIRECTS` with each exact registered HTTPS
callback. Validated-state failures return a bounded error/state fragment.
Unknown state cannot select an app return. Google uses the existing Cloud client.
Each app owns its login view, branding and return handling. No product route or
product identity is needed in the shared login service.

## Native enrollment

`createNativeCloudAuth` accepts a registered application binding, encrypted pending
storage, and host activation callbacks. Activation must call its guard immediately
before committing. Keep storage and callbacks outside the renderer. Enrollment owns
PKCE, acknowledgement, cancellation fencing and remote revocation receipts.
A finished sign-in returns `{status: "authenticated", connected: true, created}`.
`created` is Cloud's `accountCreated` from the mobile connect grant: `true` when
this sign-in made the Cloud account, `false` when it existed. It is kept with the
pending receipt for `resume`, and it is absent when Cloud did not send it.
With `answerUnavailableConfig: true`, `config` answers
`{available: false, pending: false, unavailable}` (the `error8` message) when
Cloud does not know or confirm the binding: HTTP 400, 401 or 403, or a binding
that does not match. Other failures still throw, and `start` still refuses.

Google sign-in is API-only and off by default. Configure `googleRedirectUri`
(an https address, or loopback `http://127.0.0.1|localhost|[::1]` with its exact
port) that the host owns and that is on the Auth tenant's redirect allowlist;
pass `authClientId` (`/^[a-z0-9][a-z0-9_-]{2,63}$/`) to use an app client's own
allowlist. `config` then adds `methods: ["email", "phone", "google"]`.
`start` (`{method: "google"}`) returns `{status: "browser", sessionId, url,
expiresAt}`: open `url` (Auth's `/auth/oauth/google/authorize` with S256 PKCE,
`state` and `mfa=exchange`) in a browser. The verifier and state never leave the
attempt, which lasts as long as Auth's authorize state (five minutes).
`google-return` (`{callbackUrl}` only) takes the full return address, including
the fragment Auth puts the one-time `code` and `state` in. It requires the exact
configured origin, path and query; a different `state` is refused with
`google_state_mismatch` and leaves the attempt alone. A matched return is single
use: the host calls `POST /auth/oauth/exchange` with the verifier, then enrolls
through the same mobile PKCE grant, acknowledgement and activation as a code
sign-in. Auth's failure link (`?error=…&state=…`) ends the attempt with
`google_sign_in_failed`. A second factor returns `{status: "mfa"}` for the
existing `mfa` operation. The SDK route is `POST /cloud/native/google/return`.

The stored app credential stays inference-only. A successful code `verify`/`mfa` (or `google-return`)
also keeps that Steward session in memory as billing authority, bound to the
activated credential. `await auth.billingAuthority()` returns `{token, expiresAt}`
or `null`. Use it only as `Authorization: Bearer` on organization billing routes
from the trusted host, and never return it to a renderer. It is cleared on
`cancel`, a new `start`, `clearBillingAuthority()`, expiry (JWT `exp`, at most
one hour), or when the active credential changes. When it is missing (for
example after a restart, or for Google/CLI keys), `billing-start` (`{method?,
email?, phone?, purpose?: "billing" | "account"}`, defaulting to the account's own email, then phone) and
`billing-verify`/`billing-mfa` (`{sessionId, code}`) repeat the code check.
They never re-enroll or write storage, and they reject a different
user/organization with `code: "billing_account_mismatch"`. `billing-status`
returns `{status: "authorized", expiresAt}` or `{status: "required"}`.

Account management uses the same private, account-bound interactive session.
`account-methods` returns masked methods and a one-minute review; `account-unlink`
requires its `reviewId` and `methodId`, rereads ownership, and clears authority on
confirmed removal. Phone linking uses `account-phone-start` (`{phone}` in E.164)
and `account-phone-verify` (`{sessionId, code}`). Auth owns collision and last-method
protection. Ambiguous mutations consume their attempt; reread inventory before a
new explicit action. Never automatically retry a mutation.

Mutations require recent MFA. `account-security-status` lists enabled TOTP/SMS
methods; `account-security-start` (`{method}`) and `account-security-verify`
(`{sessionId, code}`) step up that session. Replacement authority must resolve to
the same Cloud user and organization before it is retained. All operations share
enrollment serialization and cancellation. For first SMS MFA setup, use `account-security-enroll-start` (`{phone}`) and
`account-security-enroll-verify` (`{sessionId, code}`). Auth enforces recent
factor-enrollment authority; enabled TOTP/SMS methods must use step-up instead.
When that authority is too old, enroll start fails with 428
`account_verification_required` and starts no resend cooldown.
Confirmed enrollment clears revoked authority and requires reauthentication.
Ambiguous enrollment verification also clears authority and must not replay.
This does not enroll TOTP or link another email; hosts must not advertise those
capabilities through this adapter. Sign-in methods are separate from Gmail
consent and inference credentials.

For OAuth account linking, the SDK challenge API accepts a host-owned S256
challenge and returns `authorizationUrl` from the configured provider. Keep the
verifier private and supply it only to the account-link token exchange. Auth binds
it to the single-use challenge before contacting the provider. The callback must
be allowlisted by Auth and registered with the provider; this API does not supply
native callback delivery. Hosts that implement and qualify callback delivery may
configure `accountLinkRedirectUri` on `createNativeCloudAuth`. The private adapter
then supports `account-google-start` (no fields), `account-google-complete`
(`sessionId`, `callbackUrl`) and `account-google-cancel` (no fields).
Native callback transports can use `account-google-return` (`callbackUrl` only);
the private attempt still enforces exact state and callback binding.
`account-google-status` returns only idle/pending/expired/linked/cancelled/failed/unknown
and pending expiry, scoped to the current account. It validates
the Google destination, sign-in scopes, state, callback and account-bound expiry,
keeps the verifier in memory, and consumes the attempt before exchange. Unknown
outcomes require inventory observation. No link UI should be offered without a
registered callback and native delivery. The default remains unconfigured.

The protected App Live E2E workflow also offers an explicit staging credential
fixture. It verifies single-use session PKCE, native credential acknowledgement,
encrypted vault reopening, restored API access and exact-key revocation. Only a
closed receipt is uploaded. It does not establish external provider sign-in,
OS secure-store integration, or physical-device acceptance.

Native Cloud service composition belongs to the [Cloud SDK](../cloud/sdk/README.md),
which accepts the authentication flow through host callbacks.

Account-method management requires personal Auth authority. Use `billing-start`
with `purpose: "account"`: send and verify omit the Cloud tenant so Auth issues
a personal session. The private host still verifies the returned account and
organization against the connected credential. Cloud billing accepts personal
sessions too; no additional token store is introduced. Cloud-tenant authority
cannot authorize account-method routes. JWT inspection is admission only;
Auth and Cloud retain signature and ownership validation.

Hosts may opt into `activateVerified(record, guard)` instead of legacy `activate`.
After the exact mobile credential is acknowledged, enrollment reads `/api/v1/user`
with that credential and binds the Cloud user ID and organization ID to the API
origin. It saves this owner with the pending receipt before activation; retries
re-verify the same credential and refuse a changed owner. The callback receives
`{version:1, credential, credentialId, owner:{authority,userId,organizationId}}`.
Keep the complete record native and commit it atomically under the host owner
lock, with the guard checked at the commit boundary. No owner fields are returned
to the renderer. Existing consumers keep their activation callback and receipt
format. A renderer field, personal agent ID, decoded JWT subject or credential
fingerprint is not a verified Cloud owner. The optional native
`VerifiedAccountCredentialStore` provides encrypted whole-record compare-and-exchange;
hosts still need to wire it to their private process protocol and lifecycle.

## Native Android sign-in

`android/` is a Gradle library (`ai.eliza.auth.cloud`) for apps that sign in on
their own native screens: email and SMS codes, the Android Google account picker,
MFA, the mobile App Auth connect/token/ack tail, acknowledgement resume, best-effort
replaced-key revocation, per-method readiness and silent key renewal with rotation. A host subclasses
`CloudSignInPlugin`, declares its Capacitor name and returns a `CloudSignInConfig`
(App Auth client id, device and product names, Steward app client for native Google,
admitted deployments and its installed storage names) plus its protected
`CloudCredentialSlots`. Admit staging only in development builds. Codes, PKCE
verifiers and Steward sessions stay native; results carry no secret. The library's
minimum SDK is 26. Eliza's Android app hosts it as `ElizaCloudSignInPlugin`
(`packages/app/platforms/android`, Gradle module `:eliza-auth-cloud`), storing the
minted key in the secure store's `session.steward_token` that its renderer reads. Run
`bun run --cwd packages/auth test:native-android` (needs a JDK); it checks the
policy, the exact plugin methods and Eliza's host registration and storage on a
plain JVM, not on a device.

Native sign-in hosts reserve credential-write intent when an attempt is accepted,
before network work. The same guard stays with that attempt through verification
and MFA. A later sign-out can therefore refuse an earlier pending write. Optional
UUID `requestId` input is echoed on MFA and authenticated outcomes; authenticated
outcomes also include the native `attemptId` and saved local `credentialId`. These
values correlate an interaction, and do not prove account ownership. Cancellation
with `requestId` retires only its matching attempt; a stale scoped cancel is a no-op.
Old callers can still use unscoped cancellation. A queued scoped cleanup also keeps
the original intent guard, so it cannot erase a newer attempt's pending record.
Cancellation
acknowledgement suppresses later delivery for that interaction; it does not roll
back a key already committed. Saved-key acknowledgement recovery on the next start
creates no interactive attempt and reserves no intent; it settles the key with the
same outcomes as the in-process retries (below).

### Readiness, acknowledgement and code steps

- `status()` reports each method once Cloud is ready for the app. A ready method is
  cached for six hours. A fresh cached answer is always returned at once. When a
  method in it is not ready and 30 seconds have passed, the plugin measures again
  behind that answer and announces a change with the unretained
  `signInReadinessChanged` event, so a sign-in screen must listen for it. A call
  waits for a measurement only when there is no fresh answer, or on an explicit
  retry (`refreshNegative`) of an incomplete one.
- A method is measured not ready only by an answer that says so. A request that
  gets no usable answer (no connection, a timeout, a 5xx, 408 or 429 from the
  registration, providers or browser Google reads, a 5xx from the email route)
  measures nothing. When it is the registration or the providers read, the whole
  fresh answer is kept; when it is the email route or a browser Google read, that
  one method keeps what the fresh answer said and the others are the ones just
  measured. Nothing is announced, the answer keeps its expiry, and only the next
  measurement is put off. A method becomes "not ready" this way only when no fresh
  answer exists.
- Resume measures only while a sign-in screen called `status()` in the last ten
  minutes or an attempt is in progress, and then with a growing wait while the
  answer stays the same (30 seconds, 2 minutes, 10 minutes, then hourly). A
  launcher host that is resumed on every Home press therefore sends nothing while
  the owner is signed in.
- In browser Google mode a return link Android has not verified yet is watched with
  local checks for up to about four minutes; readiness is measured once it is
  verified.
- A browser Google page opens in the browser's own task on a Home (launcher) host.
  Pressing Home does not end that attempt: it ends by its return, a cancel or the
  pending record's ten-minute expiry. On every other host the page is in the host's
  task, and coming back to the host without a return ends the attempt as
  `browser-closed` after a short grace, as before.
- A stored key Cloud did not confirm ends its sign-in step as `activation-pending`
  and `status()` reports `activationPending`. Cloud is asked again in this process
  until its deadline, with one request just after it. A late confirmation arrives
  as the retained `signInCompleted`. A key Cloud refused or never confirmed is
  removed with its receipt, revoked best effort and reported as
  `activation-expired` (a rejection in the sign-in step, the retained
  `signInIncomplete` afterwards).
- The next start settles a receipt the same way. Before the deadline it
  acknowledges at once and then continues the background rounds. After the
  deadline it sends the one request that tells a lost confirmation from a dead
  key. A confirmed key is announced with `signInCompleted` (four fields,
  `accountCreated: null`); a refused or never-confirmed key is removed, only while
  it is still the exact saved key, and reported with `signInIncomplete`. A
  never-activated key is not left saved as a sign-in that cannot work.
- Code sends share a local minimum of 30 seconds across email and SMS. A longer wait
  from Cloud (`resendAt` or `Retry-After`, honoured up to one day) applies to the
  method that was asked: an SMS limit does not hold back an email code. A
  `cooldown` rejection and a send Cloud refused carry `data.resendAt`, which
  `NativeCloudSignInError.from` preserves as `resendAt`.
- A wrong code, a request with no answer and a 408, 429 or 5xx answer keep the code
  step. Their rejection carries `data.attemptKept === true`, which
  `NativeCloudSignInError.from` preserves as `attemptKept`. Only a wrong code uses
  the five-code budget.

### Silent key renewal

A saved key is renewed in the background when it has less than ten days left, or is
in the last third of its life when its issue time is known. The plugin checks on
load and resume (at most hourly per process) and on `renewSignIn({environment})`. It
asks Cloud at most once in 24 hours per saved key and never while a sign-in attempt
is active.

1. `POST /api/v1/app-auth/mobile/renew` with the saved key (`Authorization: Bearer`
   and `X-API-Key`) and a fresh mobile PKCE binding
   (`clientId`, `environment`, `redirectUri`, `state`, `codeChallenge`,
   `codeChallengeMethod: "S256"`, `deviceName`). 200 answers
   `{success: true, code: "emac_…", expiresAt}`.
2. The code is exchanged and acknowledged through the existing
   `/api/v1/app-auth/mobile/token` and `/api/v1/app-auth/mobile/ack` routes. An
   unanswered acknowledgement is repeated until Cloud's deadline.
3. Only a key Cloud confirmed is saved, and only while the saved key is still the
   one the renewal presented. The duty to revoke the old key is stored first, in
   the native-only slot `cloud-signin:v1:retire:<environment>`
   (`CloudSignInConfig.retiringSlot`), as `{token, expiresAt, successor}` where
   `successor` is the new key's `credentialId` from the token exchange; a renewal
   that cannot store it saves nothing.
4. The host's `savedKeyRenewed(environment, credentialId)` hook runs.
5. The old key is revoked with `DELETE /api/v1/api-keys/current`, presenting the
   old key and the header `X-Renewed-Credential-Id: <successor>`. The header is
   what makes this the last step of a renewal: Cloud then ends the old key alone.
   Without it Cloud takes the request as a sign-out and ends every key of the
   sign-in, the renewed one included (it tolerates a missing header only for two
   minutes after the acknowledgement). So every attempt sends it, also the ones
   made from storage on a later start. A 2xx answer or a 401 (Cloud already
   refuses that key) ends the duty. With no answer it is retried twice in this
   process and again on later starts until the old key expires, so a renewal
   rotates the key and never leaves two live ones behind. A stored duty for a key
   that is still the saved one, or one that names no successor, is dropped without
   a request.
6. The retained `signInRenewed` event (`{environment, expiresAt, credentialId}`)
   tells the renderer to read the saved sign-in again.

401, 403 and 409 mean Cloud will not renew this key (`sign-in-required`). Every
other failure is asked again a day later (`deferred`). Neither removes the saved
key. After 403 and 409 it keeps working until it expires, and the owner then signs
in as before. 401 is different: Cloud refuses the key itself (it was revoked, or
its whole sign-in was ended), so the answer also carries `keyRefused: true` and
`expiryWarning: true` whatever time is left, and so does every later check that
day. Ask the owner to sign in then. Renewal writes no acknowledgement receipt,
because a receipt holds no key and the unconfirmed key is never stored.

A new key that is not saved is never used, and it is not revoked while the key it
was renewed from is still the saved one. Both belong to one sign-in, and to Cloud a
key without a confirmed successor that revokes itself is signing out: that request
would end the saved key. Unconfirmed, the new key lapses at Cloud's deadline.
Confirmed (the save was refused, or a newer credential action owned the slot), it
ends with the sign-in. It is revoked only when the saved key was removed or
replaced meanwhile, because the owner signed out or signed in again.

Cloud also ends a whole sign-in when a key asks for renewal after its successor
was confirmed. The client therefore records, before the first acknowledgement
request, that the saved key may have a confirmed successor (`confirming` in the
plain renewal record). It clears that only when Cloud refuses the acknowledgement.
While it stands, including after the process ended or Cloud's deadline passed with
no answer, that key is not presented for renewal again: `renewSignIn` answers
`sign-in-required`, the key keeps working until it expires, and the expiry warning
appears in its last three days. This costs one full sign-in in the rare case that
the confirmation never reached Cloud; asking again would cost the working key
whenever it had.

`renewSignIn` answers `{environment, status, expiryWarning, expiresAt?, credentialId?, keyRefused?}`
(`nativeSignInRenewal`). `expiryWarning` is true only when fewer than three days
remain and renewal is impossible or has failed, or when Cloud refused the key
(`keyRefused`); show the expiry warning from it, not from the remaining time
alone. An answer given while Cloud's confirmation of the new key is still awaited
(`deferred`) never carries the warning.

A browser Google sign-in that an earlier process began (a live pending record)
counts as a sign-in in progress: nothing is renewed until it returns or expires.

Renewal needs a host that implements `observeCredentialCommit()`: a check bound to
the newest credential intent that reserves nothing, so background work never
supersedes an owner's action and stops once one is reserved. The default returns
null and the status is `unavailable`. No host in this repository implements it yet.

A host that turns renewal on must do two more things:

- Store the retiring slot like the receipt slot. A store that refuses the name makes
  every renewal end as `deferred`.
- Handle the save as the credential replacement it is. A store that binds a local
  agent to the saved key (plugin-native-agent's `ResidentCredentialStore`) stops that
  agent, removes its Cloud provider admission and runs its "Cloud changed" effects on
  this write, exactly as for a new sign-in. Admit the agent again in
  `savedKeyRenewed`, so that does not depend on a renderer listening for
  `signInRenewed` at that moment. The old key is revoked only after the hook
  returned. `test:native-android` runs the exact save through that store.

Cloud allows one confirmed successor per key and keeps the old key valid until the
client's `DELETE`. `test:native-android` runs the client's exact requests against
those rules (the `Cloud` model in `CloudSignInChainTest`): after every renewal
outcome the key the phone has saved is one Cloud still accepts, or the outcome
says `keyRefused`.

### Browser Google return in a new process

Android can end the host while the browser is in front. The return then starts a
new process that has no attempt and no credential intent, and by default it
completes nothing (`signInIncomplete` with `app-link-unverified`).

A host can opt in with a durable credential generation. `CredentialIntentFence`
(`plugins/plugin-native-secure-store`) takes a `Ledger` through `attach`: every
reservation then records a fresh generation. The host returns it from
`credentialGeneration()`, and the plugin stores it in the pending record (format
`v2`; a record without one stays `v1`). In the new process
`adoptCredentialCommit(generation)` returns a check bound to the current intent
only while that generation is still the recorded one (`fence.adopt`), which means
no sign-out, sign-in, provider change or reset was reserved since the record was
written, in any process. Adoption reserves nothing. The return then follows the
live path: the record is consumed under that check, the Android authorization
dialog precedes the key, and the result arrives as the retained `signInCompleted`
or `signInIncomplete`. A second factor is refused as `mfa-browser`.

A record without a generation, an expired record, a sign-in already in progress
and a host without a ledger are refused as before. A reservation whose generation
cannot be written is tried once more and then clears the recorded value
(`Ledger.clear`), so a later process finds nothing to adopt; `Ledger.write` must be
an atomic replacement. One window remains: storage that accepts neither the write
nor the clear until the process dies leaves the earlier generation recorded until
the pending record expires (ten minutes). A host closes it by removing the pending
slot in the same sign-out or reset that reserves the intent. No host in this
repository attaches a ledger yet.

The renderer half is `@elizaos/auth/auth/native-cloud-sign-in`
(`src/auth/native-cloud-sign-in.ts`, dependency-free): the plugin methods as a
`NativeCloudSignInPort`, strict parsers for every answer (`nativeSignInAuthenticated`,
`nativeSignInCodeStarted`, `nativeSignInVerified`, `nativeSignInGoogleOutcome`,
`nativeSignInReadiness`, `nativeSignInActivationPending`, `nativeSignInRenewal`) and
event (`nativeSignInReadinessChanged`, `nativeSignInRenewed`), the failure codes the
plugin rejects with and owner-facing copy that takes the app's and the deployment's
names. An answer with an extra key, another deployment or a malformed time is refused
as `unavailable`; a readiness event that does not fit is ignored.

## Optional Blooio phone-code delivery

Twilio Verify remains the default when its existing environment is configured.
To select Blooio explicitly for ordinary phone codes, set `SMS_PROVIDER=blooio`,
`BLOOIO_API_KEY`, and an owned E.164 sender in `BLOOIO_FROM_NUMBER` on the login
server. Neither value is inferred from an agent, webhook, account, or another
provider. Missing Blooio configuration fails validation; delivery failure does
not fall back to Twilio.

Blooio only delivers the text. `PhoneAuth` still creates six-digit codes and
retains its existing purpose-and-phone hash, five-minute expiry, atomic one-use
verification, and send/verify abuse guards. Provider acceptance is not proof
that the recipient received the code. No webhook, agent history, model call,
new login token, or database migration is added. Real delivery and Cloud account
continuity still require separate testing with the existing authorized key and
sender after review.

## Cloudflare login service

`cloudflare/wrangler.toml` runs the same Bun login server in a Cloudflare
Container. Deploy staging with `bun run --cwd packages/auth cloudflare:deploy:staging`.
The runtime stays inactive until deployed with `--var LOGIN_ENABLED:true`.
State-transfer endpoints remain available while inactive. Deactivating sends SIGTERM
to a configured runtime; verify the container is stopped before restarting another
writer. A 503 response alone is not proof that draining has finished.
Copy the existing environment's identity, vault, signing, provider, and database
secrets with Wrangler secret bulk input; retain their exact values so accounts,
sessions, passkeys, and encrypted data remain compatible. Never commit that input.
The container owns no durable files. PostgreSQL remains the authoritative store
on Railway; use its external connection endpoint from Cloudflare. Retire only
the application services after cutover, preserving the database services.

Redis can remain on Railway. Use its authenticated external `rediss://` endpoint
as `REDIS_URL`. For a private certificate authority, set `STEWARD_REDIS_TLS_CA`
to its PEM certificate on the login Worker. Both shared-state and token-revocation
connections use this trust setting and still verify the server certificate and
hostname. No certificate file or custom image is needed. Keep the existing Redis
database and credentials; leave the optional native state backend URLs unset.

The edge overwrites forwarding headers and the container trusts one proxy hop.
Cloud's proxy signs its edge-observed client IP with the existing shared
`STEWARD_REQUEST_SIGNING_SECRET`; deploy this proxy before routing cross-zone
traffic to login, preserving independent client rate-limit buckets.
To move rate limits from Redis, set `STEWARD_RATE_LIMIT_URL` to the login Worker's
`/internal/rate-limit` URL and
set the same `STEWARD_RATE_LIMIT_TOKEN` secret on that Worker. Vault and proxy
sliding-window admission then uses its durable SQLite counter store. Missing or
failed admission never retries against Redis; transfer existing counters before
switching the configured backend. Set `STEWARD_AGGREGATION_URL` to the Worker's
`/internal/aggregation` URL and matching `STEWARD_AGGREGATION_TOKEN` to use its
durable policy-event store. Transfer existing rolling-window events before
switching; a configured store failure denies policy evaluation. For real-time
spend telemetry, configure `/internal/spend-metrics` as `STEWARD_SPEND_METRICS_URL`
and set matching `STEWARD_SPEND_METRICS_TOKEN`. Transfer live period totals and
host breakdowns before switching. Vault spend enforcement remains in PostgreSQL;
this telemetry backend does not implement the unused Redis reservation helpers.
It also persists replay telemetry. Its authenticated `replay-import` operation
requires `sourceQuiesced: true`, preserves original expiries, and atomically
rejects conflicting live counters before publication.
Point Cloud's `LOGIN_API_URL` at the verified login Worker only after login,
refresh, logout, provider callbacks, and database readiness pass in staging.
Preserve the original service until production acceptance and rollback checks pass.

For a staging tenant that should send sign-in emails through Cloudflare Email
Sending, set `CLOUDFLARE_EMAIL_TENANT_ID` to the tenant ID resolved by Steward,
`CLOUDFLARE_EMAIL_ACCOUNT_ID` to the sending account, and
`CLOUDFLARE_EMAIL_FROM` to a bare sender address on a verified sending domain.
Supply `CLOUDFLARE_EMAIL_API_TOKEN` as a runtime secret with Email Sending Edit
for that account. Only the matching tenant switches providers. Incomplete
configuration refuses to issue a challenge. The provider must report the
recipient as delivered or queued with a message ID; queue acceptance does
not prove the code reached the inbox. Remove the tenant selector to restore
the previous provider, then verify receipt and redemption separately.

For Redis login-state transfer, pipe a JSON snapshot with `capturedAtMs` and
`entries: [{key, value, expiresAtMs}]` into
`bun --conditions=eliza-source packages/auth/src/server/migrate-redis-state.ts`.
It validates without writing. Only after stopping source and destination writers,
pass `--apply-source-quiesced` to publish atomically. Conflicting live values fail;
expired records are skipped and existing expiration times are never extended.
Snapshots contain secrets: keep them out of logs and Git. Other Redis records,
including enforcement counters and telemetry, need their own transfer.

`createWorkspaceAppReturn` takes the product's exact HTTPS callback, native plugin name
and method names. It validates the offered redirect and consumes only bounded Workspace
outcomes for the same account, credential and UI session. A connected outcome still needs
canonical account/connection readback; it is not a Google grant. `watchForegroundAccountReturn`
requires an observed background transition after arming. Cached native resume events,
late listener registration and a replaced client cannot trigger another account's refresh.

Native mobile completion and `credentialIdentity` readback use the host’s existing lifecycle-to-vault lock order. Completion checks the original credential intent and exact installed credential ID before queueing its result. A newer credential never becomes the result of an older sign-in. Custom native hosts must implement `withCredentialRead` with the same locks used by credential mutation. The identity method returns no token or account data.
