# @elizaos/auth

Product login, account authentication and encrypted credential storage share one package below the agent and application hosts. Import storage from `@elizaos/auth/vault` and account authentication from `@elizaos/auth/auth`. The browser-safe root exports the login SDK. Node hosts can import the combined account and vault API from `@elizaos/auth/credentials`.

# @elizaos/auth/auth

The Node account-authentication module owns credential storage, OAuth /
subscription login flows, direct-API-key probing, refresh coordination, and the
encrypted account envelope those depend on. Valid legacy plaintext records are
migrated atomically before they are returned.

It sits **below** `@elizaos/agent` and `@elizaos/app` so both consume it
without a dependency cycle. These account modules depend on `@elizaos/core`, `@elizaos/shared`,
`@elizaos/auth/vault`, and node builtins — never on `@elizaos/agent` or `@elizaos/app`.

## Public surface

- `account-storage` — AES-GCM encrypted on-disk account records (`saveAccount`, `loadAccount`, …).
- `credentials` — provider credential resolution + access-token acquisition.
- `oauth-flow` — interactive OAuth/subscription login flows.
- `direct-api-probe` — direct-API-key availability probing.
- `refresh-mutex` — per-account refresh serialization.
- `types` — shared account/provider types and id constants.

Import subpaths directly, e.g. `import { saveAccount } from "@elizaos/auth/auth/account-storage"`.

## OpenRouter and xAI accounts

OpenRouter credits/BYOK and xAI API PAYG are distinct direct-account products:
their canonical account IDs are `openrouter-api` and `xai-api`, with
`OPENROUTER_API_KEY` and `XAI_API_KEY` as the exported env aliases. Adding,
repairing, or testing an OpenRouter key first authenticates through its
current-key endpoint, then fetches the bounded model catalog with the same key;
xAI authenticates through its bounded model endpoint. Failure bodies from either
provider are never reflected to callers. Like every direct provider, the
credential of the pool-selected account is exported to the process environment
by the account-pool bridge at boot and again after each account mutation, so
add, replace, enable/disable, re-prioritize, and delete take effect without a
restart; when the pool rejects every linked account the exported value is
retracted rather than falling back to an ineligible key. Neither account
advertises coding-agent spawn. Grok subscription login is a separate product
and must not be represented as an xAI API key.

# @elizaos/auth/vault

Simple secrets/config vault for Eliza. **One** API for sensitive
credentials and non-sensitive configuration.

## API

```ts
import { createVault } from "@elizaos/auth/vault";

const vault = createVault();

// Same call signature for sensitive and non-sensitive:
await vault.set("openrouter.apiKey", "sk-or-v1-...", { sensitive: true });
await vault.set("ui.theme", "dark");

// Reads:
await vault.get("openrouter.apiKey");      // → "sk-or-v1-..."
await vault.has("openrouter.apiKey");      // → true
await vault.describe("openrouter.apiKey"); // → { source, sensitive, lastModified }
await vault.reveal("openrouter.apiKey", "settings-ui"); // logged in audit
await vault.list();                         // → all keys, no values
await vault.list("openrouter");             // → prefix-filtered
await vault.remove("openrouter.apiKey");
await vault.stats();                        // → { total, sensitive, nonSensitive, references }

// Password-manager references — value lives there, vault stores reference:
await vault.setReference("openrouter.apiKey", {
  source: "1password",
  path: "Personal/OpenRouter/api-key",
});
```

## SecretsManager — pick which password managers to use

The `Vault` is the storage primitive. The `SecretsManager` sits on top
and routes direct writes based on user preferences. External password
managers are not written through this API yet; callers store references
with `vault.setReference()` after the value already exists in the vendor
tool.

```ts
import { createManager } from "@elizaos/auth/vault";

const manager = createManager();

// Probe what's available on this machine:
const statuses = await manager.detectBackends();
//   [
//     { id: "in-house",   available: true,  signedIn: true,  label: "Eliza (local, encrypted)" },
//     { id: "1password",  available: true,  signedIn: true,  label: "1Password" },
//     { id: "bitwarden",  available: true,  signedIn: false, label: "Bitwarden", detail: "`bw` is installed but not signed in. Use the Sign-in button." },
//     { id: "protonpass", available: false, signedIn: false, label: "Proton Pass", detail: "`pass-cli` CLI not installed. Install from https://protonpass.github.io/pass-cli/get-started/installation/." },
//   ]

// User picks their backends in Settings:
await manager.setPreferences({
  enabled: ["1password", "in-house"],
  routing: { "anthropic.apiKey": "in-house" }, // optional per-key override
});

// External direct writes fail loudly until vendor write semantics exist:
await manager.set("openrouter.apiKey", "sk-or-...", { sensitive: true });
// → throws: backend "1password" cannot accept direct writes yet

// Store explicit references through the vault primitive:
await manager.vault.setReference("openrouter.apiKey", {
  source: "1password",
  path: "Personal/OpenRouter/api-key",
});

await manager.set("anthropic.apiKey", "sk-ant-...", { sensitive: true });
// → in-house (per-key override above)

await manager.set("ui.theme", "dark");
// → always in-house (non-sensitive values don't go to password managers)
```

**Three modes the user can run in:**

- **None** — nothing enabled but `in-house`. Default. Local-only.
- **One** — pick 1Password OR Proton Pass OR Bitwarden. Direct sensitive
  writes fail until vendor write support exists; explicit references can
  still be stored with `vault.setReference()`.
- **All** — all backends enabled. Per-key routing in Settings, or just
  use the priority order.

`in-house` is always available. External backend failures are surfaced
instead of silently falling back to local storage.

## Credential profiles

`manager.getActive(key, context)` applies per-context routing, then the active
profile, global default, and bare-key fallback. `writeRoutingConfig` validates
the complete configuration before persisting it. Missing configuration means
no custom rules; malformed stored configuration throws `RoutingConfigError`
(`VAULT_ROUTING_CONFIG_INVALID`) so it cannot silently choose another profile.

## Storage

- **Sensitive values** — AES-256-GCM encrypted at rest with the vault
  key as additional authenticated data. Master key in OS keychain
  (cross-platform via `@napi-rs/keyring`: macOS Keychain, Windows
  Credential Manager, Linux libsecret).
- **Non-sensitive values** — stored as plaintext in the `value` column
  of the PGlite DB (`.vault-pglite/` under the state dir).
- **References** — stored as `{ source, path }`. The actual value lives
  in 1Password / Proton Pass; resolved at use time via the vendor's
  CLI.

## Sync

Sync = your existing tools. If you want secrets across devices, store
them as 1Password references — 1Password syncs your vault, the
references stay portable, your secrets follow. We don't build a
separate cloud sync.

## Audit log

Every value-touching operation (`set`, `setReference`, `get`, `reveal`,
`remove`) appends one JSONL line to `<stateDir>/audit/vault.jsonl`
(default state dir `~/.local/state/eliza`, overridable via
`ELIZA_STATE_DIR`):

```jsonl
{"ts":1714330000000,"action":"set","key":"openrouter.apiKey"}
{"ts":1714330000010,"action":"get","key":"openrouter.apiKey"}
{"ts":1714330000020,"action":"reveal","key":"openrouter.apiKey","caller":"settings-ui"}
```

Records keys, never values. Pass an optional `caller` to `reveal()` so
the log shows who asked.

## Testing

```ts
import { createTestVault } from "@elizaos/auth/vault";

const test = await createTestVault({
  values:  { "ui.theme": "dark" },
  secrets: { "openrouter.apiKey": "test-key" },
});

await test.vault.set("openai.apiKey", "test-2", { sensitive: true });
const records = await test.getAuditRecords();
await test.dispose();
```

Real vault, real encryption, real audit log — temp dir cleaned up on
`dispose()`. No OS keychain access (uses an in-memory master key).

## Login SDK and service

First-party login and account sessions for elizaOS. Browser clients import
`@elizaos/auth`; React consumers import `@elizaos/ui`, which owns the shared login UI.

The authentication client supports passkeys, email, SMS, WhatsApp, OAuth,
Telegram, Farcaster, EVM and Solana wallet signatures, custom JWT/OIDC,
guest accounts, device authorization, MFA and recovery.

React sign-out waits for server revocation and reports failures for retry.
SDK consumers use `revokeSession()` for server sign-out; `signOut()` only
clears local credentials and the proxy cookie.

The source is derived from Steward-Fi/steward at
`7a977336687217e2601b77c20c3d343e540b9c14` under the included MIT license.
Persisted session keys and wire identifiers retain compatibility with existing
accounts during the migration. No source is fetched at build time.

Run `bun run --cwd packages/auth test`, `typecheck`, `lint:check`, and `build`
from the repository root.

The desktop host starts `@elizaos/auth/embedded` on loopback with PGlite.
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
[`steward-sidecar-login.test.ts`](../app/src/services/steward-sidecar-login.test.ts)
starts the real child, provisions a wallet, restarts it and reopens the same
wallet authority from disk. Browser/provider verification remains separate
from these local transport and persistence tests.

For a hosted service, run `bun run --cwd packages/auth start`. It applies the
owned PostgreSQL migrations before listening and uses durable auth, revocation
and attempt-budget storage. Configure `DATABASE_URL`, `STEWARD_MASTER_PASSWORD`,
`STEWARD_JWT_SECRET`, `STEWARD_KDF_SALT` and `STEWARD_AUDIT_HMAC_KEY` with the
deployment's existing values. `PORT` defaults to 3200; `LOGIN_BIND_HOST` defaults
to loopback. Provider credentials and relying-party configuration remain
deployment settings.

Restricted runtime roles use `SKIP_MIGRATIONS=1`: startup verifies every migration
hash and timestamp without attempting schema writes. Apply migrations through
the deployment's migration role; a missing or inconsistent ledger prevents
startup. Existing `STEWARD_MIGRATION_READINESS_MODE=drizzle` configuration remains
accepted.

The PostgreSQL integration suite creates and removes a separate database on a
local PostgreSQL server. Run it with `LOGIN_TEST_DATABASE_URL` set to that
server's administrative database URL. Without this setting, that test is
explicitly skipped; the embedded tests do not substitute for PostgreSQL proof.
The test uses a restricted runtime role and forces the installed tenant policies,
covering sign-in, audit persistence, session restarts and revocation.

The cloud proxy can route its existing public login mount to this service with
`LOGIN_API_URL`. This binding takes precedence over the legacy upstream settings;
an invalid value fails closed rather than routing credentials to another service.
The service database, keys and provider callback registrations must be migrated
before switching that deployment binding.

Run `bun run --cwd packages/auth test:browser` with Playwright Chromium installed
for browser passkey registration, sign-in, grant scope and replay checks. This
uses the real browser SDK, server and database with a virtual authenticator and
a seeded verified-email grant; it does not verify external email delivery or a
physical biometric device.

A source deployment can install only the service's production dependency closure
from the monorepo lockfile, then start Bun with the source export condition:

```bash
bun install --filter @elizaos/auth --production --ignore-scripts --frozen-lockfile
LOGIN_BIND_HOST=0.0.0.0 bun --conditions=eliza-source packages/auth/src/server/start.ts
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
`packages/auth/railpack.json`. The configuration pins Bun and Node, installs the
production dependency closure, and includes auth, core and shared
workspaces in the runtime image. Its ignore overrides retain workspace manifests
that Bun needs to resolve the lockfile before filtering the install. Retain the
service's existing variables and `/health` check when changing its repository
source.

## End-to-end verification

`bun run --cwd packages/auth test` runs browser passkey signup/sign-in and
HTTP wallet login with persisted-session restart and logout.
`test:browser` selects the browser flow. `test:e2e:postgres` runs the real
PostgreSQL session/isolation flow and requires `LOGIN_TEST_DATABASE_URL`
pointing to a loopback database server.
