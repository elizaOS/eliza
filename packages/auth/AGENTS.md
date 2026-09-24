# @elizaos/auth

One owner for product login, account authentication and encrypted storage. The root export is the browser-safe SDK; Node APIs use explicit subpaths. Account and storage modules live in `src/auth`, `src/vault` and `src/kms`; the browser SDK lives in `src/sdk` and the identity service in `src/server`. Bun runs the retained complete login flows. Never import application hosts. Preserve stored ciphertext, AAD, account migration and refresh coordination.

# `@elizaos/auth/auth`

Account-authentication modules shared by `@elizaos/agent` and
`@elizaos/app`. It owns encrypted account records, provider credential
resolution, OAuth and subscription login, token-expiry policy, direct-key
probing, and per-account refresh serialization.

Repository-wide engineering and evidence requirements are inherited from the
root [`AGENTS.md`](../../AGENTS.md).

## Dependency boundary

This package must remain below both application hosts. The account-authentication
modules may depend on `@elizaos/core`, `@elizaos/shared`, `@elizaos/auth/vault`, and Node
built-ins; it must not import `@elizaos/agent` or `@elizaos/app`. That
constraint keeps account storage independent of application and identity-service startup.

Consumers should use only exports declared in `package.json`. A source file is
private until it is intentionally added to the root barrel or an explicit
subpath export.

## Public surface

- `account-storage.ts` stores AES-GCM account envelopes and atomically migrates
  validated legacy plaintext records before returning them.
- `credentials.ts`, `token-expiry.ts`, and `refresh-mutex.ts` resolve usable
  credentials without racing refreshes or accepting nearly expired tokens.
- `oauth-flow.ts`, `anthropic.ts`, `openai-codex.ts`, and `codex-device.ts`
  implement provider-specific subscription and device login flows.
- `direct-api-probe.ts` checks direct API-key availability.
- `codex-usage.ts` reads Codex subscription usage state.
- `types.ts` owns provider identifiers and shared account contracts.
- `subscription-auth/` contains adoption and built-in-provider helpers;
  `vendor/pi-oauth/` contains the locally maintained OAuth protocol adapters.

## Security invariants

- Never log credentials, refresh tokens, authorization codes, PKCE verifiers,
  encrypted envelopes, or decrypted account payloads.
- Validate persisted records before decrypting or migrating them. A malformed
  legacy record is an explicit failure, not an empty account.
- Persist migrations and token updates atomically so interruption cannot leave
  a partially rewritten credential file.
- Refresh work is serialized by account. Do not bypass `refresh-mutex.ts` with
  an independent provider-local lock.
- Keep provider protocol details at the boundary and return the shared typed
  account/credential contracts to consumers.
- Preserve complete direct-provider failure bodies when they fit the explicit
  diagnostic boundary. If a response body exceeds that boundary, reject the
  body as unavailable; never return a prefix labeled as the provider error.

## Commands

Run from the repository root:

```bash
bun run --cwd packages/auth build
bun run --cwd packages/auth typecheck
bun run --cwd packages/auth lint:check
bun run --cwd packages/auth format:check
bun run --cwd packages/auth test
```

Use `test:e2e` for the browser and persisted HTTP session flows.
`test:e2e:postgres` requires an explicit loopback `LOGIN_TEST_DATABASE_URL`.
Extend these complete flows when authentication behavior changes.

## Extending the package

Add a provider integration only when its protocol cannot be represented by an
existing adapter. Keep parsing and network exchange in the provider module,
reuse the shared expiry and refresh rules, add failure-path tests, and expose
the smallest intentional subpath in `package.json`. Confirm the dependency
boundary and encrypted-storage behavior with `bun run --cwd packages/auth
typecheck` and `bun run --cwd packages/auth test`.

## Package completion evidence

For auth changes, inspect the real persisted envelope or provider response with
secrets redacted, prove refresh/migration behavior and relevant failure paths,
and attach logs that show the boundary outcome without exposing credentials.

# @elizaos/auth/vault

Secrets and config vault for Eliza agents — one API for sensitive credentials and non-sensitive configuration.

## Purpose / role

Provides a single storage interface for all sensitive values (API keys, wallet private keys, tokens) and non-sensitive config. Sensitive values are AES-256-GCM encrypted at rest with a master key held in the OS keychain. External password-manager references (`PasswordManagerReference.source` is `1password` | `protonpass`) are first-class: the value lives in the external tool, the vault stores only the pointer. (Bitwarden is supported as a saved-login / detection backend, but not as a reference source.)

**Primary consumers:** `packages/agent` (vault bootstrap, profile resolver, wallet storage, signer backend), `packages/app` (secrets-manager routes, inventory routes, vault bootstrap service, vault mirror), `packages/auth` (encrypted account credential envelopes), and `packages/ui` (vault settings tabs).

## Layout

```
src/
  index.ts           — re-exports everything public
  vault-types.ts     — Vault interface, SetOptions, CreateVaultOptions, VaultMissError
  vault.ts           — createVault() factory (PgliteVaultImpl wired with defaults)
  pglite-vault.ts    — PgliteVaultImpl: storage engine (PGlite DB, migration, stale-lock healing)
  crypto.ts          — encrypt/decrypt (AES-256-GCM, v1:<nonce>:<tag>:<ct> wire format)
  master-key.ts      — MasterKeyResolver variants: osKeychainMasterKey, passphraseMasterKey, inMemoryMasterKey, attestationMasterKey, defaultMasterKey (attestationMasterKey is fail-closed: releases the sealed-volume key only on trusted TEE evidence via an injected TeeAttestationVerifier)
  manager.ts         — createManager(), SecretsManager: routing layer over Vault; backend detection (1Password, Bitwarden, Proton Pass)
  inventory.ts       — listVaultInventory(), categorizeKey(), setEntryMeta(): UI-renderable metadata layer
  profiles.ts        — resolveActiveValue(), readRoutingConfig(), writeRoutingConfig(): per-key profiles + per-context routing
  credentials.ts     — getSavedLogin/setSavedLogin/listSavedLogins: saved-login management (in-house)
  external-credentials.ts — listOnePasswordLogins, listBitwardenLogins, revealOnePasswordLogin, revealBitwardenLogin
  install.ts         — BACKEND_INSTALL_SPECS, buildInstallCommand, detectPackageManagers: password-manager install guidance
  audit.ts           — AuditLog: appends JSONL records (never stores values)
  types.ts           — AuditRecord, PasswordManagerReference, StoredEntry, VaultDescriptor, VaultStats, VaultLogger
  testing.ts         — createTestVault(): in-memory master key, real encryption, temp dir auto-cleanup
  store.ts           — readStore(): reads legacy vault.json for one-shot migration
  internal-utils.ts  — assertKey(), optsCaller()
  password-managers.ts — resolveReference(): resolves 1Password/Proton Pass references via CLI
test/login/         — browser passkey registration and login flow
```

## Key exports / surface

```ts
// Core primitives
import { createVault } from "@elizaos/auth/vault";
// → Vault: set/get/has/reveal/remove/list/describe/setReference/stats

import { createManager } from "@elizaos/auth/vault";
// → SecretsManager: set/get/getActive/has/remove/list/detectBackends/getPreferences/setPreferences/listAllSavedLogins/revealSavedLogin

// Crypto
import { encrypt, decrypt, generateMasterKey, KEY_BYTES, CryptoError } from "@elizaos/auth/vault";

// Master key resolvers
import {
  defaultMasterKey,       // OS keychain → passphrase fallback (default)
  osKeychainMasterKey,    // OS keychain only
  passphraseMasterKey,    // scrypt from ELIZA_VAULT_PASSPHRASE
  passphraseMasterKeyFromEnv,
  inMemoryMasterKey,      // tests only
  attestationMasterKey,   // sealed-volume key, released only on trusted TEE evidence (fail-closed)
  MasterKeyUnavailableError,
} from "@elizaos/auth/vault";
import type { TeeAttestationVerifier } from "@elizaos/auth/vault"; // injected TEE trust boundary

// Inventory / metadata
import { listVaultInventory, categorizeKey, inferProviderId, setEntryMeta, readEntryMeta, removeEntryMeta } from "@elizaos/auth/vault";

// Profile resolution
import { resolveActiveValue, readRoutingConfig, writeRoutingConfig } from "@elizaos/auth/vault";

// Saved logins (in-house)
import { getSavedLogin, setSavedLogin, listSavedLogins, deleteSavedLogin, setAutofillAllowed, getAutofillAllowed } from "@elizaos/auth/vault";

// External credentials
import { listOnePasswordLogins, listBitwardenLogins, revealOnePasswordLogin, revealBitwardenLogin, BackendNotSignedInError } from "@elizaos/auth/vault";

// PGlite implementation (advanced use)
import { PgliteVaultImpl, defaultPgliteVaultDataDir } from "@elizaos/auth/vault";

// Testing
import { createTestVault } from "@elizaos/auth/vault";
// → TestVault: { vault, dataDir, auditLogPath, getAuditRecords(), clearAuditLog(), dispose() }
```

## Commands

```bash
bun run --cwd packages/auth build       # compile via tsc → dist/
bun run --cwd packages/auth lint        # Biome check --write --unsafe
bun run --cwd packages/auth lint:check  # Biome check (read-only)
bun run --cwd packages/auth format      # Biome format --write
bun run --cwd packages/auth format:check # Biome format (read-only)
bun run --cwd packages/auth test        # browser and persisted HTTP login flows
bun run --cwd packages/auth typecheck   # tsc --noEmit
bun run --cwd packages/auth clean       # rm -rf dist
```

## Config / env vars

| Env var | Effect |
|---------|--------|
| `ELIZA_STATE_DIR` | Root for vault data. Default: `$XDG_STATE_HOME/$ELIZA_NAMESPACE` or `~/.local/state/eliza` |
| `ELIZA_NAMESPACE` | Namespace sub-dir under state root. Default: `"eliza"` |
| `ELIZA_VAULT_PASSPHRASE` | Passphrase for headless key derivation (scrypt). Min 12 chars. Fallback when OS keychain is unavailable. |
| `ELIZA_VAULT_DISABLE_KEYCHAIN` | Set to `"1"` to skip OS keychain entirely (e.g. headless Docker without D-Bus). |
| `DBUS_SESSION_BUS_ADDRESS` | Linux: presence signals D-Bus is reachable, enabling OS keychain use. |
| `XDG_RUNTIME_DIR` | Linux: if `$XDG_RUNTIME_DIR/bus` exists, D-Bus is treated as reachable. |
| `ELIZA_IOS_LOCAL_BACKEND` / `ELIZA_ANDROID_LOCAL_BACKEND` | Set to `"1"` in mobile embedded mode; stale PGlite lock is always cleared unconditionally. |

## Storage layout on disk

```
$ELIZA_STATE_DIR/
  .vault-pglite/   — PGlite DB (vault_entries table; single file per PGlite)
  audit/
    vault.jsonl    — append-only JSONL audit log (keys only, never values)
```

Legacy path (pre-migration): `$ELIZA_STATE_DIR/vault.json`. Migrated automatically on first `createVault()` boot when the PGlite table is empty.

## Vault key conventions

- Dot-separated namespaces: `openrouter.apiKey`, `ui.theme`, `anthropic.apiKey`.
- Provider API keys use SCREAMING_SNAKE_CASE env-var names: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
- Wallet keys: `wallet.<agentId>.<chain>.privateKey`.
- Saved logins: `creds.<domain>.<username>`.
- Password-manager sessions: `pm.1password.session`, `pm.bitwarden.session`.
- Internal reserved prefixes: `_meta.*` (per-key metadata), `_manager.*` (preferences), `_routing.config` (routing rules). Never surface these to UI listings.

## How to extend

### Add a new backend (password manager)

1. Add the backend id to the `BackendId` union in `src/manager.ts`.
2. Implement a `detect<Backend>(): Promise<BackendStatus>` function.
3. Call it in `ManagerImpl.detectBackends()`.
4. Implement list/reveal adapters in `src/external-credentials.ts`.
5. Wire into `listAllSavedLogins` and `revealSavedLogin` in `ManagerImpl`.
6. Add install spec to `BACKEND_INSTALL_SPECS` in `src/install.ts`.

### Use in tests

```ts
import { createTestVault } from "@elizaos/auth/vault";

const test = await createTestVault({
  values:  { "ui.theme": "dark" },
  secrets: { "OPENAI_API_KEY": "test-key" },
});
// Real encryption, in-memory master key, temp dir, no OS keychain access.
await test.vault.set("ANTHROPIC_API_KEY", "sk-ant-...", { sensitive: true });
const records = await test.getAuditRecords();
await test.dispose(); // removes temp dir
```

## Conventions / gotchas

- **PGlite is single-writer.** The vault gets its own PGlite DB at `.vault-pglite/`, separate from the runtime DB at `.elizadb/`. Never share the connection.
- **`vault.get()` vs `manager.getActive()`**: `get()` reads the bare key. `getActive(key, ctx)` walks per-context routing rules → active profile → global default → bare key. Use `getActive` when an agent or app context is available.
- **Stale PGlite lock self-healing**: `PgliteVaultImpl` detects a leftover `postmaster.pid` from an unclean shutdown, removes it if the owner process is gone, and retries once. A live owner throws with a clear message.
- **Audit log records keys, never values.** `reveal(key, caller)` is the designated "show plaintext" affordance; the caller id appears in the JSONL so users can see who requested a reveal.
- **Sensitive vs non-sensitive split**: `{ sensitive: true }` → AES-256-GCM ciphertext in PGlite, master key from OS keychain. Omit → plaintext `value` column in PGlite. The same `set/get` API handles both.
- **Non-sensitive values never go to external password managers.** `SecretsManager.set()` enforces this unconditionally, regardless of user preferences routing config.
- **External backend direct writes are not yet supported.** `ManagerImpl.set()` only writes when the resolved target backend is `"in-house"`; any other resolved backend (`"1password"`, `"protonpass"`, `"bitwarden"`) throws. For 1Password / Proton Pass, store a reference with `vault.setReference()` after creating the item in the vendor tool. 1Password references resolve through `op read`; Proton Pass references resolve through `pass-cli item view`.
- **`VaultMissError`** is thrown (not null-returned) on a missing key by `get()`. Use `has()` or catch `VaultMissError` when a key may be absent.
- **Ciphertext wire format**: `v1:<nonce_b64>:<tag_b64>:<ct_b64>`. The vault key string is bound as AES-GCM AAD, so a ciphertext cannot be moved to a different key slot without failing decryption.

## Verification

Follow the repository-wide verification and evidence standard in the [root AGENTS.md](../../AGENTS.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.

# @elizaos/auth

Owns product login, identity sessions and the browser client. React components
and hooks are exported from the `@elizaos/ui` root barrel.
Repository-wide instructions in [AGENTS.md](../../AGENTS.md) apply.

Keep browser and server entry points separate. Importing the browser
client must not load a database, server runtime or optional wallet adapters.
Preserve persisted identities, tokens and wire compatibility deliberately;
never rename a persisted key without a tested migration.

Do not add trading venues, strategies or DeFi integrations. Login supports
wallet signatures without requiring a trading stack.

Validate authentication at the transport boundary, including invalid input,
expired tokens, replay, tenant isolation, account linking and logout. Run
package tests, typecheck, lint and build plus repository verification. Real
provider/browser verification is required before claiming complete login proof.
