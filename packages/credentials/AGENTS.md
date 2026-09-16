# @elizaos/credentials

One owner for account authentication and encrypted storage. Internal modules live in `src/auth` and `src/vault`; tests include both auth colocated tests and vault `test` suites. Never import application hosts. Preserve stored ciphertext, AAD, account migration and refresh coordination.

# `@elizaos/credentials/auth`

Leaf authentication and credential package shared by `@elizaos/agent` and
`@elizaos/app-core`. It owns encrypted account records, provider credential
resolution, OAuth and subscription login, token-expiry policy, direct-key
probing, and per-account refresh serialization.

Repository-wide engineering and evidence requirements are inherited from the
root [`CLAUDE.md`](../../CLAUDE.md).

## Dependency boundary

This package must remain below both application hosts. Production code may
depend on `@elizaos/core`, `@elizaos/shared`, `@elizaos/credentials/vault`, and Node
built-ins; it must not import `@elizaos/agent` or `@elizaos/app-core`. That
constraint prevents the dependency cycle this package was created to break.

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
bun run --cwd packages/credentials build
bun run --cwd packages/credentials typecheck
bun run --cwd packages/credentials lint:check
bun run --cwd packages/credentials format:check
bun run --cwd packages/credentials test
```

Use `test:watch` only for local iteration. Run the focused credential, OAuth,
expiry, and migration tests whenever their corresponding path changes.

## Extending the package

Add a provider integration only when its protocol cannot be represented by an
existing adapter. Keep parsing and network exchange in the provider module,
reuse the shared expiry and refresh rules, add failure-path tests, and expose
the smallest intentional subpath in `package.json`. Confirm the dependency
boundary and encrypted-storage behavior with `bun run --cwd packages/credentials
typecheck` and `bun run --cwd packages/credentials test`.

## Package completion evidence

For auth changes, inspect the real persisted envelope or provider response with
secrets redacted, prove refresh/migration behavior and relevant failure paths,
and attach logs that show the boundary outcome without exposing credentials.

# @elizaos/credentials/vault

Secrets and config vault for Eliza agents — one API for sensitive credentials and non-sensitive configuration.

## Purpose / role

Provides a single storage interface for all sensitive values (API keys, wallet private keys, tokens) and non-sensitive config. Sensitive values are AES-256-GCM encrypted at rest with a master key held in the OS keychain. External password-manager references (`PasswordManagerReference.source` is `1password` | `protonpass`) are first-class: the value lives in the external tool, the vault stores only the pointer. (Bitwarden is supported as a saved-login / detection backend, but not as a reference source.)

**Primary consumers:** `packages/agent` (vault bootstrap, profile resolver, wallet storage, signer backend), `packages/app-core` (secrets-manager routes, inventory routes, vault bootstrap service, vault mirror), `packages/credentials` (encrypted account credential envelopes), and `packages/ui` (vault settings tabs).

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
test/               — vitest test files matching each src module
```

## Key exports / surface

```ts
// Core primitives
import { createVault } from "@elizaos/credentials/vault";
// → Vault: set/get/has/reveal/remove/list/describe/setReference/stats

import { createManager } from "@elizaos/credentials/vault";
// → SecretsManager: set/get/getActive/has/remove/list/detectBackends/getPreferences/setPreferences/listAllSavedLogins/revealSavedLogin

// Crypto
import { encrypt, decrypt, generateMasterKey, KEY_BYTES, CryptoError } from "@elizaos/credentials/vault";

// Master key resolvers
import {
  defaultMasterKey,       // OS keychain → passphrase fallback (default)
  osKeychainMasterKey,    // OS keychain only
  passphraseMasterKey,    // scrypt from ELIZA_VAULT_PASSPHRASE
  passphraseMasterKeyFromEnv,
  inMemoryMasterKey,      // tests only
  attestationMasterKey,   // sealed-volume key, released only on trusted TEE evidence (fail-closed)
  MasterKeyUnavailableError,
} from "@elizaos/credentials/vault";
import type { TeeAttestationVerifier } from "@elizaos/credentials/vault"; // injected TEE trust boundary

// Inventory / metadata
import { listVaultInventory, categorizeKey, inferProviderId, setEntryMeta, readEntryMeta, removeEntryMeta } from "@elizaos/credentials/vault";

// Profile resolution
import { resolveActiveValue, readRoutingConfig, writeRoutingConfig } from "@elizaos/credentials/vault";

// Saved logins (in-house)
import { getSavedLogin, setSavedLogin, listSavedLogins, deleteSavedLogin, setAutofillAllowed, getAutofillAllowed } from "@elizaos/credentials/vault";

// External credentials
import { listOnePasswordLogins, listBitwardenLogins, revealOnePasswordLogin, revealBitwardenLogin, BackendNotSignedInError } from "@elizaos/credentials/vault";

// PGlite implementation (advanced use)
import { PgliteVaultImpl, defaultPgliteVaultDataDir } from "@elizaos/credentials/vault";

// Testing
import { createTestVault } from "@elizaos/credentials/vault";
// → TestVault: { vault, dataDir, auditLogPath, getAuditRecords(), clearAuditLog(), dispose() }
```

## Commands

```bash
bun run --cwd packages/credentials build       # compile via tsc → dist/
bun run --cwd packages/credentials lint        # Biome check --write --unsafe
bun run --cwd packages/credentials lint:check  # Biome check (read-only)
bun run --cwd packages/credentials format      # Biome format --write
bun run --cwd packages/credentials format:check # Biome format (read-only)
bun run --cwd packages/credentials test        # vitest run (all test files)
bun run --cwd packages/credentials test:watch  # vitest watch mode
bun run --cwd packages/credentials typecheck   # tsc --noEmit
bun run --cwd packages/credentials clean       # rm -rf dist
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
import { createTestVault } from "@elizaos/credentials/vault";

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

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
