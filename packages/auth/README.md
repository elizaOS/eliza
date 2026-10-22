# @elizaos/auth

Browser login, hosted and embedded identity sessions, account OAuth, and encrypted
credential storage. Keep credentials in the trusted host; never log them.

## Entry points

| Import | Owner |
| --- | --- |
| `@elizaos/auth` | Browser-safe login client, types, chain metadata and signature verification |
| `@elizaos/auth/auth` | Account storage, provider login and serialized credential refresh |
| `@elizaos/auth/accounts` | Node-only linked-account selection, usage accounting and credential bridges |
| `@elizaos/auth/providers` | Provider credential verification and usage adapters |
| `@elizaos/auth/vault` | Encrypted credential vault |
| `@elizaos/auth/kms` | Key management adapters |
| `@elizaos/auth/server` | Identity router without process startup |
| `@elizaos/auth/start` | Hosted Bun service with PostgreSQL |
| `@elizaos/auth/embedded` | Embedded Bun service with persistent PGlite |
| `@elizaos/auth/native-host` | Trusted Node enrollment flow |
| `@elizaos/auth/testing` | Vault fixtures for tests only |

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

## Alpha-owned OAuth returns

`GET /auth/oauth/google/alpha-readiness` checks the exact Alpha tenant/return
pair, tenant policy, registered redirect, existing Google credentials and app
error returns. It returns `{ok:true, alphaAuth:1, tenantId, redirectUri}` without
creating a challenge. Configure `STEWARD_OAUTH_APP_ERROR_REDIRECTS` with the exact
registered Alpha HTTPS callback for each environment. Validated-state failures
then return a bounded error/state fragment. Other clients keep existing behavior.
Unknown state cannot select an app return. Google uses the existing Cloud client.

## Native enrollment

`createNativeCloudAuth` accepts a registered application binding, encrypted pending
storage, and host activation callbacks. Activation must call its guard immediately
before committing. Keep storage and callbacks outside the renderer. Enrollment owns
PKCE, acknowledgement, cancellation fencing and remote revocation receipts.
A finished sign-in returns `{status: "authenticated", connected: true, created}`.
`created` is Cloud's `accountCreated` from the mobile connect grant: `true` when
this sign-in made the Cloud account, `false` when it existed. It is kept with the
pending receipt for `resume`, and it is absent when Cloud did not send it.

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
Copy the existing environment's identity, vault, signing, provider, and database
secrets with Wrangler secret bulk input; retain their exact values so accounts,
sessions, passkeys, and encrypted data remain compatible. Never commit that input.
The container owns no durable files. PostgreSQL remains the authoritative store
on Railway; use its external connection endpoint from Cloudflare. Retire only
the application services after cutover, preserving the database services.

The edge overwrites forwarding headers and the container trusts one proxy hop.
Point Cloud's `LOGIN_API_URL` at the verified login Worker only after login,
refresh, logout, provider callbacks, and database readiness pass in staging.
Preserve the original service until production acceptance and rollback checks pass.

For Redis login-state transfer, pipe a JSON snapshot with `capturedAtMs` and
`entries: [{key, value, expiresAtMs}]` into
`bun --conditions=eliza-source packages/auth/src/server/migrate-redis-state.ts`.
It validates without writing. Only after stopping source and destination writers,
pass `--apply-source-quiesced` to publish atomically. Conflicting live values fail;
expired records are skipped and existing expiration times are never extended.
Snapshots contain secrets: keep them out of logs and Git. Other Redis records,
including enforcement counters and telemetry, need their own transfer.
