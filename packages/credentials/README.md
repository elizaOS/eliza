# @elizaos/credentials

Account authentication and encrypted credential storage share one package below the agent and application hosts. Import storage from `@elizaos/credentials/vault` and account authentication from `@elizaos/credentials/auth`. The root barrel exports both.

# @elizaos/credentials/auth

Leaf auth package for Eliza agents. Owns account credential storage, OAuth /
subscription login flows, direct-API-key probing, refresh coordination, and the
encrypted account envelope those depend on. Valid legacy plaintext records are
migrated atomically before they are returned.

It sits **below** `@elizaos/agent` and `@elizaos/app-core` so both consume it
without a dependency cycle. It depends only on `@elizaos/core`, `@elizaos/shared`,
`@elizaos/credentials/vault`, and node builtins — never on `@elizaos/agent` or `@elizaos/app-core`.

## Public surface

- `account-storage` — AES-GCM encrypted on-disk account records (`saveAccount`, `loadAccount`, …).
- `credentials` — provider credential resolution + access-token acquisition.
- `oauth-flow` — interactive OAuth/subscription login flows.
- `direct-api-probe` — direct-API-key availability probing.
- `refresh-mutex` — per-account refresh serialization.
- `types` — shared account/provider types and id constants.

Import subpaths directly, e.g. `import { saveAccount } from "@elizaos/credentials/auth/account-storage"`.

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

# @elizaos/credentials/vault

Simple secrets/config vault for Eliza. **One** API for sensitive
credentials and non-sensitive configuration.

## API

```ts
import { createVault } from "@elizaos/credentials/vault";

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
import { createManager } from "@elizaos/credentials/vault";

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
import { createTestVault } from "@elizaos/credentials/vault";

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
