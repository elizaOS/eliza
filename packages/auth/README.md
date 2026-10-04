# @elizaos/auth

Browser login, hosted and embedded identity sessions, account OAuth, and encrypted
credential storage. Keep credentials in the trusted host; never log them.

## Entry points

| Import | Owner |
| --- | --- |
| `@elizaos/auth` | Browser-safe login client, types, chain metadata and signature verification |
| `@elizaos/auth/auth` | Account storage, provider login and serialized credential refresh |
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
The default tests also verify the built deployment package.

## Native enrollment

`createNativeCloudAuth` accepts a registered application binding, encrypted pending
storage, and host activation callbacks. Activation must call its guard immediately
before committing. Keep storage and callbacks outside the renderer. Enrollment owns
PKCE, acknowledgement, cancellation fencing and remote revocation receipts.

The stored app credential stays inference-only. A successful code `verify`/`mfa`
also keeps that Steward session in memory as billing authority, bound to the
activated credential. `await auth.billingAuthority()` returns `{token, expiresAt}`
or `null`. Use it only as `Authorization: Bearer` on organization billing routes
from the trusted host, and never return it to a renderer. It is cleared on
`cancel`, a new `start`, `clearBillingAuthority()`, expiry (JWT `exp`, at most
one hour), or when the active credential changes. When it is missing (for
example after a restart, or for Google/CLI keys), `billing-start` (`{method?,
email?, phone?}`, defaulting to the account's own email, then phone) and
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
Confirmed enrollment clears revoked authority and requires reauthentication.
Ambiguous enrollment verification also clears authority and must not replay.
This does not enroll TOTP, link another email, or link Google OAuth; hosts must
not advertise those capabilities through this adapter. Sign-in methods are separate from Gmail
consent and inference credentials.

The protected App Live E2E workflow also offers an explicit staging credential
fixture. It verifies single-use session PKCE, native credential acknowledgement,
encrypted vault reopening, restored API access and exact-key revocation. Only a
closed receipt is uploaded. It does not establish external provider sign-in,
OS secure-store integration, or physical-device acceptance.

Native Cloud service composition belongs to the [Cloud SDK](../cloud/sdk/README.md),
which accepts the authentication flow through host callbacks.
