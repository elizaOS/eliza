# Migrating to @elizaos/confidant

This guide walks through adopting Confidant in an existing Eliza-based
host app. Each phase is independently shippable, ends with deletion of
the legacy code it replaced, and corresponds to a phase in §9 of the
Milady-side architecture doc (`docs/architecture/confidant.md`).

Confidant covers **every credential the elizaOS plugin catalog uses**
— LLM providers, TTS / voice, messaging connectors, wallets, blockchain
RPC, trading APIs, music services, cloud storage, browser tools, and
miscellaneous service tokens. The integration helpers
(`registerElizaSecretSchemas`, `mirrorLegacyEnvCredentials`) ship the
canonical SecretId scheme for the entire catalog, indexed by env-var
name.

## TL;DR

```ts
// 1. At app boot
import {
  createConfidant,
  registerElizaSecretSchemas,
  mirrorLegacyEnvCredentials,
} from "@elizaos/confidant";
import { scanAllCredentials } from "@elizaos/app-core/api/credential-resolver";

registerElizaSecretSchemas();
const confidant = createConfidant();
await mirrorLegacyEnvCredentials(confidant, scanAllCredentials());

// 2. Plugin code (eventually) — pick the domain that matches the credential:
const llmKey      = await scoped.resolve("llm.openrouter.apiKey");
const ghToken     = await scoped.resolve("connector.github.apiToken");
const evmKey      = await scoped.resolve("wallet.evm.privateKey");
const ttsKey      = await scoped.resolve("tts.elevenlabs.apiKey");
const heliusRpc   = await scoped.resolve("rpc.helius.apiKey");
const s3Key       = await scoped.resolve("storage.s3.accessKeyId");
const clobKey     = await scoped.resolve("trading.polymarket.clobApiKey");
```

That's the end state. The phases below describe how to get there
without breaking the running host app at any point.

---

## Phase 1 — initialize Confidant at app boot

**Goal:** Confidant exists in the runtime; legacy code paths are
unchanged. Plugins still read `process.env`.

### Steps

1. Construct a Confidant during runtime initialization. Pass a
   `MasterKeyResolver` (default: `osKeyringMasterKey`).
2. Call `registerElizaSecretSchemas()` once, before any plugin
   registers. This declares the canonical schema for every catalog
   credential (LLM keys, connector tokens, wallet material, RPC keys,
   storage credentials, etc.) — one call replaces dozens of individual
   `defineSecretSchema` invocations.
3. Call `mirrorLegacyEnvCredentials(confidant, scanAllCredentials())`
   after the existing credential-resolver runs. This populates
   Confidant with `env://VAR_NAME` references that resolve through the
   `EnvLegacyBackend` to the same `process.env` values plugins are
   already reading. Indexed by env-var name, so every catalog credential
   that has a `process.env.X` slot gets a stable Confidant id.
4. Expose the Confidant on the runtime — either as a typed field
   (`runtime.confidant`) or via the runtime's service registry
   (`runtime.getService("confidant")`). The first is more discoverable;
   the second is more idiomatic to existing elizaOS plugin patterns.

### Exit criterion

```ts
const ids = await confidant.list();
const envVars = scanAllCredentials().map((c) => c.envVar);
expect(ids.length).toBe(envVars.length); // every legacy credential mirrored
```

No behavior change observable to plugins. The migration adds Confidant
without removing anything.

---

## Phase 2 — single canonical writer

**Goal:** When the user saves a credential through Settings, the value
goes through Confidant's `set(id, value)` method, not the legacy
`config.env.*` / `config.env.vars.*` dual-write.

### Steps

1. In the Settings save handler, replace the call to the legacy
   `setEnvValue(config, KEY, value)` with `confidant.set(secretId,
   value)`. Use the `ELIZA_PROVIDER_SECRET_IDS` map to translate from
   `KEY` (`OPENROUTER_API_KEY`) to `SecretId` (`llm.openrouter.apiKey`).
2. Delete the `Object.values(config).find(non-empty)` heuristic in the
   provider-switch save path. The schema authoritatively identifies the
   credential field; no guessing needed.
3. On first boot post-upgrade, migrate any pre-existing values from
   `config.env.*` / `config.env.vars.*` into Confidant, then null those
   blocks out.

### Exit criterion

```ts
await fs.readFile(miladyJsonPath, "utf8");
// no longer contains env.* or env.vars.* blocks for credentials
const stored = await confidant.list();
expect(stored).toContain("llm.openrouter.apiKey");
```

The legacy file ages out; the bug where a model slug overwrites an API
key becomes structurally impossible.

---

## Phase 3 — built-in plugins migrate to Confidant reads

**Goal:** Every first-party `@elizaos/plugin-*` — LLM providers,
connectors, wallet plugins, RPC providers, storage backends — reads
its credentials through Confidant rather than `process.env`.

### Steps (per plugin, examples across domains)

```ts
// LLM provider (plugin-openrouter)
const apiKey = runtime.confidant
  .scopeFor("@elizaos/plugin-openrouter")
  .lazyResolve("llm.openrouter.apiKey");

// Messaging connector (plugin-github)
const token = runtime.confidant
  .scopeFor("@elizaos/plugin-github")
  .lazyResolve("connector.github.apiToken");

// Wallet plugin (plugin-evm)
const pk = runtime.confidant
  .scopeFor("@elizaos/plugin-evm")
  .lazyResolve("wallet.evm.privateKey");

// RPC provider (plugin-evm consuming Alchemy)
const alchemyKey = runtime.confidant
  .scopeFor("@elizaos/plugin-evm")
  .lazyResolve("rpc.alchemy.apiKey");

// Storage backend (plugin-s3-storage)
const accessKey = runtime.confidant
  .scopeFor("@elizaos/plugin-s3-storage")
  .lazyResolve("storage.s3.accessKeyId");
const secretKey = runtime.confidant
  .scopeFor("@elizaos/plugin-s3-storage")
  .lazyResolve("storage.s3.secretAccessKey");
```

The lazy form returns `() => Promise<string>` — pass it to HTTP / SDK
clients so the secret is fetched per-request, never copied into
long-lived memory.

Each plugin gets implicit access to its own registered ids via the
schema registry's ownership attribution; no grants needed for first-
party plugins.

Once the plugin is migrated, remove its env-var hydration from the
credential-resolver. One less hardcoded env-var name in the host app's
responsibility.

### Exit criterion

```bash
# For any migrated plugin:
grep -r 'process.env.X_API_KEY' packages/plugin-X/   # no matches in src/
grep -r 'process.env.WALLET_'   packages/plugin-evm/ # no matches in src/
```

The plugin now resolves through Confidant for every request. Audit log
shows resolves keyed by the plugin's SecretIds and `skill:
"@elizaos/plugin-X"`.

---

## Phase 4 — password manager backends

**Goal:** Users with 1Password, Proton Pass, or Bitwarden can store
their keys there and Confidant resolves through the password manager
at use time.

### Steps

1. Add `OnePasswordBackend` (shells out to `op` CLI) to the registered
   backends.
2. The Settings UI gains a per-secret "Storage" picker:
   File / OS Keychain / 1Password (if `op` detected). Picking 1Password
   rewrites the entry from a literal to `op://Vault/Item/field`.
3. Repeat for Proton Pass via their CLI / SDK when stable.

### Exit criterion

A user with `op` CLI signed in can configure
`llm.openrouter.apiKey` as `op://Personal/OpenRouter/api-key`,
restart the app, and resolves succeed transparently — the secret never
touches `~/.milady/confidant.json`.

---

## Phase 5 — third-party plugins migrate

**Goal:** Plugins outside the first-party catalog migrate to Confidant
on their own timeline.

### Steps

1. Plugin authors update their plugins to read from
   `runtime.confidant` instead of `process.env`.
2. `@elizaos/cli doctor` flags `process.env.*_API_KEY` reads with a
   one-line migration hint pointing at `runtime.confidant.resolve`.
3. Plugins that don't migrate continue to work via `EnvLegacyBackend`
   but emit a deprecation warning at registration time.

### Exit criterion

Every `@elizaos/plugin-*` in the monorepo has migrated. Deprecation
warnings catalog any third-party laggards.

---

## Phase 6 — close the boundary

**Goal:** `process.env.*_API_KEY` is `undefined` at runtime. Skill
exfiltration via env vars becomes structurally impossible.

### Steps

1. The credential resolver stops hydrating env vars after Confidant is
   populated.
2. `EnvLegacyBackend` is **deleted** from the package.
3. Any plugin that hadn't migrated breaks loudly:
   `Plugin X reads process.env.Y_API_KEY; this is no longer
   populated. Migrate to runtime.confidant.resolve('domain.subject.field').`

### Exit criterion

```bash
node --eval 'require("@elizaos/agent").startAgent(); console.log(process.env.OPENROUTER_API_KEY)'
# undefined
```

Skill exfiltration boundary closed. Audit log records every credential
read by skill id, secret id, granted/denied. No env-var fallback.

---

## Phase 7 (optional, separable) — Cloud sync

**Goal:** Users opt in to E2E-encrypted sync of non-device-bound
secrets across their devices via Eliza Cloud.

### Steps

1. Implement `CloudBackend` with end-to-end encryption — the cloud
   server sees only ciphertext; the master key is derived from a user
   passphrase (Argon2id) plus a per-user salt.
2. Subscription tokens (`isSubscriptionProviderId(...)`) are flagged
   `deviceBound` and stay local.
3. Settings UI gains "Sync via Eliza Cloud" toggle, passphrase setup,
   conflict resolution UI.

### Exit criterion

A user signs in on a second device, enters their passphrase, and
their `llm.openrouter.apiKey` reference rehydrates without re-typing
the key.

---

## For plugin authors (third-party / `elizaos-plugins/*`)

Confidant doesn't hardcode every plugin in the universe. The
first-party catalog map (`ELIZA_ENV_TO_SECRET_ID`,
`registerElizaSecretSchemas`) covers the plugins shipped in this
monorepo. Any third-party plugin — including the many under
`elizaos-plugins/*` — self-registers from its own code in one call.

### One-line adoption

```ts
// In your plugin's index.ts:
import registryEntry from "./registry.json"; // your plugin's existing config
import { defineSchemaFromRegistry } from "@elizaos/confidant";

defineSchemaFromRegistry(registryEntry, {
  domain: "connector",   // pick from CanonicalDomain
  subject: "discord",    // your plugin's short name
});
```

After this call:

- Every `type: "secret"` field in your registry entry is registered as
  `{domain}.{subject}.{camelCasedField}`. `DISCORD_BOT_TOKEN` →
  `connector.discord.botToken`.
- Schema ownership is attributed to your plugin's id (from `entry.id`
  or `entry.npmName`), so the implicit-grant rule fires automatically
  when your plugin resolves its own credentials — no permission setup
  needed.
- Labels and format hints come from the existing registry fields
  (`label`, `placeholder`). Override per-call if you need to.

### Picking a domain

Use the `CanonicalDomain` that matches your plugin's role. The
namespace is shared across the whole elizaOS ecosystem, so consistency
helps users orient themselves:

| Domain | When to use |
|---|---|
| `llm.*` | Text / image / embedding model providers (Anthropic, OpenAI, OpenRouter, custom inference services) |
| `subscription.*` | Device-bound OAuth tokens for paid AI subscriptions |
| `tts.*` | Text-to-speech APIs (ElevenLabs, etc.) |
| `connector.*` | Messaging, social, or developer platforms (Discord, Telegram, Slack, GitHub, Linear, X, …) |
| `tool.*` | Generic third-party utility services (search, captcha solving, scraping, automation) |
| `wallet.*` | Local wallet material — private keys, mnemonics, salts. Always device-bound. |
| `rpc.*` | Blockchain / on-chain data RPC providers (Alchemy, Infura, Helius, Birdeye, …) |
| `trading.*` | Trading-venue API credentials (CLOB, exchange APIs, …) |
| `music.*` | Music metadata / catalog APIs (Last.fm, Genius, Spotify, …) |
| `storage.*` | Object storage (S3, GCS, Azure Blob) |
| `service.*` | First-party services (Eliza Cloud) and other service tokens that don't fit the above |

If your plugin doesn't fit any of these, file an issue against the
elizaOS upstream and we'll add a domain. New domains are cheap; the
namespace is structural, not exclusive.

### Field-name conventions

The default field-name extractor strips the subject prefix (case-
insensitive, dash- or underscore-tolerant) and camel-cases the
remainder:

- `DISCORD_BOT_TOKEN`, subject `"discord"` → `botToken`
- `GITHUB_API_TOKEN`, subject `"github"` → `apiToken`
- `OPENROUTER_API_KEY`, subject `"openrouter"` → `apiKey`
- `GOOGLE_GENAI_API_KEY`, subject `"google-genai"` → `apiKey`

Common conventional field names (use them when applicable so users
can predict your IDs):

- `apiKey` — generic API key
- `apiToken` — generic API token
- `accessToken` — OAuth access token
- `secretKey` — paired secret half of an access-key/secret-key tuple
- `webhookSecret` — webhook-signature shared secret
- `clientSecret` — OAuth client secret
- `privateKey` — wallet private key
- `mnemonic` — wallet seed phrase
- `botToken` — bot framework auth token

### Customizing the mapping

```ts
defineSchemaFromRegistry(registryEntry, {
  domain: "tool",
  subject: "myservice",
  // Restrict to a subset of secrets:
  only: ["MYSERVICE_PRIMARY_KEY", "MYSERVICE_WEBHOOK_SECRET"],
  // Override the auto-derived field name:
  fieldNameForEnvVar: (envVar) =>
    envVar === "MYSERVICE_PRIMARY_KEY" ? "key" : "webhookSecret",
  // Override the plugin id (defaults to entry.id):
  pluginId: "@vendor/plugin-myservice",
});
```

### What this gets your plugin

- Users with `@elizaos/confidant` set up can store your plugin's
  credentials in 1Password (phase 4+), the OS keychain, or whatever
  password manager their host app supports.
- Per-skill audit logging — every credential resolve your plugin makes
  is recorded with your plugin id in the user's audit log.
- Implicit deny-by-default for cross-plugin access — other plugins
  cannot read your credentials without an explicit grant from the user.
- Phase 7 cloud sync (when shipped) — your secrets sync E2E-encrypted
  across the user's devices unless you flag them device-bound via the
  `wallet.*` domain.

If your plugin doesn't migrate, it continues to work via the
`EnvLegacyBackend` until phase 6 of the host app's migration.

---

## Migration anti-patterns

These patterns appear during migration and should be avoided:

- **Reading `process.env` from a plugin after phase 6.** The boundary
  is intentional; reading env-vars is the failure mode the migration
  closes. Use `runtime.confidant.resolve(...)`.
- **Adding `*` grants to skip per-skill permissioning.** `*` is
  reserved for first-party migration tooling. Third-party plugins must
  use provider-level glob patterns at minimum.
- **Caching resolved values in plugin module scope.** Use
  `lazyResolve()` and pass the function to your HTTP client; let
  Confidant decide when to materialize the value.
- **Mixing legacy `setEnvValue` and `confidant.set` calls.** The
  migration is one-way. After phase 2, `setEnvValue` is gone.

---

## When something breaks

The audit log at `~/.milady/audit/confidant.jsonl` records every
resolve attempt with skill id, secret id, source, granted/denied.
Filter for failures:

```bash
jq -c 'select(.granted == false)' ~/.milady/audit/confidant.jsonl
```

Every failure has a structured `reason` you can match against the
contract. Common reasons:

- `Skill X denied access to Y: Explicit deny grant on pattern Z` — the
  user (or the host app) deliberately revoked access.
- `Skill X denied access to Y: No grant matches Y for skill X` — the
  plugin needs a schema registration or an explicit grant.
- `prompt-mode grant but no PromptHandler configured` — the host app
  needs to wire a `PromptHandler` (modal UI hook) at Confidant
  construction.

For backend-level failures (1Password locked, Linux Secret Service
unavailable, etc.), `BackendNotConfiguredError` carries a one-line
recovery hint in its message.
