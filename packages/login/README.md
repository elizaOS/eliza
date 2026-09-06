# @elizaos/login

First-party login and account sessions for elizaOS. Browser clients import
`@elizaos/login`; React consumers import `@elizaos/ui`, which owns the shared login UI.

The authentication client supports passkeys, email, SMS, WhatsApp, OAuth,
Telegram, Farcaster, EVM and Solana wallet signatures, custom JWT/OIDC,
guest accounts, device authorization, MFA and recovery.

The source is derived from Steward-Fi/steward at
`7a977336687217e2601b77c20c3d343e540b9c14` under the included MIT license.
Persisted session keys and wire identifiers retain compatibility with existing
accounts during the migration. No source is fetched at build time.

Run `bun run --cwd packages/login test`, `typecheck`, `lint:check`, and `build`
from the repository root.

The desktop host starts `@elizaos/login/embedded` on loopback with PGlite.
The host persists its vault password before starting the service. Login
challenges, attempt budgets and token revocations use the same database and
survive restart. First-time tenant provisioning uses a temporary platform key
held by the host and its child process.

New local databases record their encryption and audit key derivation choices.
An existing database without this metadata requires its original
`STEWARD_KDF_SALT` and `STEWARD_AUDIT_HMAC_KEY`; startup refuses to invent
replacement keys. Existing deployment secrets, passkey relying-party settings
and persisted protocol identifiers must accompany the database migration.

The desktop integration test in
[`steward-sidecar-login.test.ts`](../app-core/src/services/steward-sidecar-login.test.ts)
starts the real child, provisions a wallet, restarts it and reopens the same
wallet authority from disk. Browser/provider verification remains separate
from these local transport and persistence tests.

For a hosted service, run `bun run --cwd packages/login start`. It applies the
owned PostgreSQL migrations before listening and uses durable auth, revocation
and attempt-budget storage. Configure `DATABASE_URL`, `STEWARD_MASTER_PASSWORD`,
`STEWARD_JWT_SECRET`, `STEWARD_KDF_SALT` and `STEWARD_AUDIT_HMAC_KEY` with the
deployment's existing values. `PORT` defaults to 3200; `LOGIN_BIND_HOST` defaults
to loopback. Provider credentials and relying-party configuration remain
deployment settings.

The PostgreSQL integration suite creates and removes a separate database on a
local PostgreSQL server. Run it with `LOGIN_TEST_DATABASE_URL` set to that
server's administrative database URL. Without this setting, that test is
explicitly skipped; the embedded tests do not substitute for PostgreSQL proof.

The cloud proxy can route its existing public login mount to this service with
`LOGIN_API_URL`. This binding takes precedence over the legacy upstream settings;
an invalid value fails closed rather than routing credentials to another service.
The service database, keys and provider callback registrations must be migrated
before switching that deployment binding.

Run `bun run --cwd packages/login test:browser` with Playwright Chromium installed
for browser passkey registration, sign-in, grant scope and replay checks. This
uses the real browser SDK, server and database with a virtual authenticator and
a seeded verified-email grant; it does not verify external email delivery or a
physical biometric device.

A source deployment can install only the service's production dependency closure
from the monorepo lockfile, then start Bun with the source export condition:

```bash
bun install --filter @elizaos/login --production --ignore-scripts --frozen-lockfile
LOGIN_BIND_HOST=0.0.0.0 bun --conditions=eliza-source packages/login/src/server/start.ts
```

Run both commands from the repository root with Bun 1.3.14. The filtered install
skips application/native-inference setup; it does not build or start the Eliza
application. Configure the platform's install command accordingly, and use
`/health` as its startup health check. Keep the existing database and encryption,
session, provider and relying-party settings when switching the service source.
The service handles SIGTERM by closing its listener and owned connections before
exiting; the process integration test guards against leaked event-loop handles.

Railway builds use [`railpack.json`](railpack.json). Keep the repository root as
the build context, select Railpack, and set `RAILPACK_CONFIG_FILE` to
`packages/login/railpack.json`. The configuration pins Bun and Node, installs the
production dependency closure, and includes only login, core and logger
workspaces in the runtime image. Retain the service's existing variables and
`/health` check when changing its repository source.
