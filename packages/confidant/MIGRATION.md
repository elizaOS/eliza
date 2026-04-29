# Migrating to @elizaos/confidant

This guide walks through adopting Confidant in an existing Eliza-based
host app. Each phase is independently shippable, ends with deletion of
the legacy code it replaced, and corresponds to a phase in §9 of the
Milady-side architecture doc (`docs/architecture/confidant.md`).

## TL;DR

```ts
// 1. At app boot
import {
  createConfidant,
  registerElizaProviderSchemas,
  mirrorLegacyEnvCredentials,
} from "@elizaos/confidant";
import { scanAllCredentials } from "@elizaos/app-core/api/credential-resolver";

registerElizaProviderSchemas();
const confidant = createConfidant();
await mirrorLegacyEnvCredentials(confidant, scanAllCredentials());

// 2. Plugin code (eventually)
const apiKey = await runtime.confidant
  .scopeFor(plugin.id)
  .resolve("llm.openrouter.apiKey");
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
2. Call `registerElizaProviderSchemas()` once, before any plugin
   registers.
3. Call `mirrorLegacyEnvCredentials(confidant, scanAllCredentials())`
   after the existing credential-resolver runs. This populates
   Confidant with `env://VAR_NAME` references that resolve through the
   `EnvLegacyBackend` to the same `process.env` values plugins are
   already reading.
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

## Phase 3 — built-in AI providers migrate to Confidant reads

**Goal:** Each `@elizaos/plugin-{anthropic,openai,openrouter,...}`
reads its credential through Confidant rather than `process.env`.

### Steps (per plugin)

1. In the plugin's init code, switch from
   `process.env.OPENROUTER_API_KEY` to
   `runtime.confidant.lazyResolve("llm.openrouter.apiKey")`. The lazy
   form returns `() => Promise<string>` — pass it to HTTP clients so
   the secret is fetched per-request, never copied into long-lived
   memory.
2. The plugin gets implicit access to its registered ids (the schema
   registry attributes ownership). No grants needed.
3. Once the plugin is migrated, remove its env-var hydration from the
   credential-resolver. One less hardcoded env-var name in the host
   app's responsibility.

### Exit criterion

```bash
grep -r 'process.env.OPENROUTER_API_KEY' packages/plugin-openrouter/
# no matches in src/
```

The plugin now resolves through Confidant for every request. Audit log
shows resolves keyed by `llm.openrouter.apiKey` and `skill:
"@elizaos/plugin-openrouter"`.

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
