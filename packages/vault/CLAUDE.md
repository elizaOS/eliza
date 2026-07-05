# @elizaos/vault

Secrets and config vault for Eliza agents — one API for sensitive credentials and non-sensitive configuration.

## Purpose / role

Provides a single storage interface for all sensitive values (API keys, wallet private keys, tokens) and non-sensitive config. Sensitive values are AES-256-GCM encrypted at rest with a master key held in the OS keychain. External password-manager references (`PasswordManagerReference.source` is `1password` | `protonpass`) are first-class: the value lives in the external tool, the vault stores only the pointer. (Bitwarden is supported as a saved-login / detection backend, but not as a reference source.)

**Primary consumers:** `packages/agent` (vault bootstrap, profile resolver, wallet storage, signer backend), `packages/app-core` (secrets-manager routes, inventory routes, vault bootstrap service, vault mirror), `packages/security` (KMS local adapter), `packages/ui` (vault settings tabs).

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
import { createVault } from "@elizaos/vault";
// → Vault: set/get/has/reveal/remove/list/describe/setReference/stats

import { createManager } from "@elizaos/vault";
// → SecretsManager: set/get/getActive/has/remove/list/detectBackends/getPreferences/setPreferences/listAllSavedLogins/revealSavedLogin

// Crypto
import { encrypt, decrypt, generateMasterKey, KEY_BYTES, CryptoError } from "@elizaos/vault";

// Master key resolvers
import {
  defaultMasterKey,       // OS keychain → passphrase fallback (default)
  osKeychainMasterKey,    // OS keychain only
  passphraseMasterKey,    // scrypt from ELIZA_VAULT_PASSPHRASE
  passphraseMasterKeyFromEnv,
  inMemoryMasterKey,      // tests only
  attestationMasterKey,   // sealed-volume key, released only on trusted TEE evidence (fail-closed)
  MasterKeyUnavailableError,
} from "@elizaos/vault";
import type { TeeAttestationVerifier } from "@elizaos/vault"; // injected TEE trust boundary

// Inventory / metadata
import { listVaultInventory, categorizeKey, inferProviderId, setEntryMeta, readEntryMeta, removeEntryMeta } from "@elizaos/vault";

// Profile resolution
import { resolveActiveValue, readRoutingConfig, writeRoutingConfig } from "@elizaos/vault";

// Saved logins (in-house)
import { getSavedLogin, setSavedLogin, listSavedLogins, deleteSavedLogin, setAutofillAllowed, getAutofillAllowed } from "@elizaos/vault";

// External credentials
import { listOnePasswordLogins, listBitwardenLogins, revealOnePasswordLogin, revealBitwardenLogin, BackendNotSignedInError } from "@elizaos/vault";

// PGlite implementation (advanced use)
import { PgliteVaultImpl, defaultPgliteVaultDataDir } from "@elizaos/vault";

// Testing
import { createTestVault } from "@elizaos/vault";
// → TestVault: { vault, dataDir, auditLogPath, getAuditRecords(), clearAuditLog(), dispose() }
```

## Commands

```bash
bun run --cwd packages/vault build       # compile via tsc → dist/
bun run --cwd packages/vault lint        # Biome check --write --unsafe
bun run --cwd packages/vault lint:check  # Biome check (read-only)
bun run --cwd packages/vault format      # Biome format --write
bun run --cwd packages/vault format:check # Biome format (read-only)
bun run --cwd packages/vault test        # vitest run (all test files)
bun run --cwd packages/vault test:watch  # vitest watch mode
bun run --cwd packages/vault typecheck   # tsgo --noEmit
bun run --cwd packages/vault clean       # rm -rf dist
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
import { createTestVault } from "@elizaos/vault";

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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — cloud backend / security:**
- Real request → response traces against the local cloud stack (`bun run cloud:mock`) hitting real endpoints, plus the structured backend logs.
- The **DB state** the change produced/changed (Drizzle rows), billing/usage records, and migration up **and** down.
- Auth/role-gating and multi-tenant isolation proven by test, including the denied-access paths (see #9853/#9948) — not assumed.
- The agent trajectory for any model-backed endpoint.
<!-- END: evidence-and-e2e-mandate -->
