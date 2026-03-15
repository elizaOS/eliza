# Runtime composition

This document describes the **runtime composition** API: building blocks for loading characters and creating elizaOS runtimes. It is intended for daemon, cloud, serverless, milaidy, and other host applications.

---

## Why a composition layer?

Different hosts need different flows:

- **Daemon / CLI:** Load character files, create one or more runtimes, run provisioning once at boot.
- **Cloud:** May use a shared adapter pool, custom caching, and ephemeral settings; might not use `createRuntimes` at all but still need `getBootstrapSettings` and `mergeSettingsInto`.
- **Serverless / edge:** Often create a runtime per request; may skip provisioning (done at deploy time).
- **Milaidy:** Single character from config, with extra plugins and workspace integration.

Rather than one rigid “create everything” path, the composition layer exposes **small, composable functions** so each host can use the pieces it needs. **WHY:** Reduces duplicated logic (plugin resolution, adapter creation, settings merge) while allowing custom pipelines (e.g. cloud’s adapter pool) without fighting the library.

---

## Startup by mode

| Mode | Adapter | Provision | Task timer | One-liner idea |
|------|---------|-----------|------------|----------------|
| **Daemon** | From plugin (e.g. plugin-sql) | Yes, once at boot | Start explicitly | `loadCharacters` → `createRuntimes(..., { provision: true })` → `startTimer()` |
| **Milaidy** | Same; add `sharedPlugins: [milaidyPlugin]` | Yes | Yes | Same as daemon with shared plugins and workspace config |
| **Serverless** | From plugin or in-memory | No | No | `loadCharacters` → `createRuntimes(..., { provision: false })`; reuse runtime singleton per container |
| **Cloud** | Host's adapter pool | Per deploy, not per request | No (or companion) | `getBootstrapSettings` + `mergeSettingsInto`; `new AgentRuntime({ adapter, character, plugins })` |

**Reference entry points:**

- **Daemon (composition):** `examples/telegram/typescript/telegram-agent.ts` — `loadCharacters` + `createRuntimes` with `sharedPlugins` and `provision: true`, then `startTimer()`.
- **Milaidy:** `packages/milaidy/src/eliza.ts` — custom config and workspace; builds adapter (plugin-sql or in-memory), `mergeDbSettings`, `AgentRuntime`, `provisionAgent`, `startTimer()`.
- **Cloud (multi-tenant):** `eliza-cloud-v2/lib/eliza/runtime-factory.ts` — adapter from pool, per-request settings; `new AgentRuntime({ ..., adapter })`.
- **Serverless:** Use composition with `provision: false` and a singleton runtime (or one per request with in-memory adapter). See usage examples below.

---

## Settings divide: bootstrap vs runtime

A critical distinction is **when** settings are available.

| Kind | Source | When available | Used for |
|------|--------|----------------|----------|
| **Bootstrap** | Character JSON, `process.env` | Before DB connection | Creating the database adapter (e.g. `POSTGRES_URL`, `PGLITE_DATA_DIR`, `MONGODB_URI`) |
| **Runtime** | Database (agent row) | After adapter is connected | API keys, model preferences, embedding config, etc. |

**WHY the divide:** You cannot load settings from the database until the adapter exists and is connected. The adapter is created using only bootstrap settings (character + env). After the adapter is ready, we call `getAgentsByIds` (or equivalent) and merge those settings into the character; the runtime is then constructed with the **merged** character so it sees both bootstrap and DB-backed config.

**Composition and process.env:** When loading characters via `loadCharacters`, we do **not** sync character secrets into `process.env` (unlike the legacy character-loader path). **WHY:** With multiple characters, syncing each would overwrite env so later characters’ secrets would leak into bootstrap for earlier ones. Secrets stay on the character object and are used by `getBootstrapSettings(character)` and the merged runtime config without going through process.

- **Adapter factories** (`Plugin.adapter(agentId, settings)`) receive **only** bootstrap settings (via `getBootstrapSettings(character)`).
- **Runtime** receives the character after **mergeSettingsInto** (or `mergeDbSettings`) has been applied, so it gets runtime settings from the DB as well.

Documenting this prevents adapter plugins from assuming they can read “everything” and keeps the pipeline order clear.

---

## API overview

All of these are exported from the Node entry point (`@elizaos/core`). They are **not** part of the browser/edge build because they depend on Node-only modules (e.g. character-loader uses `fs`).

### loadCharacters(sources)

```ts
loadCharacters(sources: (string | CharacterInput)[]): Promise<Character[]>
```

- **What:** Loads characters from file paths (string) and/or inline character objects. Reuses `loadCharacterFile`, `parseCharacter`, `importSecretsFromEnv`, `ensureEncryptionSalt`, `syncCharacterSecretsToEnv`. Returns validated `Character[]`.
- **WHY:** Single entry point for “give me characters” whether config comes from files (daemon) or from code (cloud, serverless). Empty `sources` → `[]`. Invalid file or object throws with path/details.

### getBootstrapSettings(character, env?)

```ts
getBootstrapSettings(character: Character, env?: NodeJS.ProcessEnv): Record<string, string>
```

- **What:** Flattens `character.settings`, `character.secrets`, and `env` (default `process.env`) into a single `Record<string, string>`. Used when calling adapter factories.
- **WHY:** Adapter factories need string key/value config (e.g. `POSTGRES_URL`). They must **not** depend on settings that exist only in the DB, because those are not available until after the adapter is created. This function returns only “bootstrap” settings.

### mergeSettingsInto(character, agentRecord)

```ts
mergeSettingsInto(character: Character, agentRecord: AgentRecordForMerge | null): Character
```

- **What:** Pure merge of DB agent `settings` and `secrets` into a character. Same merge order as `mergeDbSettings`: DB base, character overrides. No DB call.
- **WHY:** Custom hosts (e.g. cloud) may load agent records themselves (e.g. from a cache or different API). They can reuse this merge logic without calling `mergeDbSettings(character, adapter, agentId)`, which does the DB fetch internally.

### createRuntimes(characters, options?)

```ts
createRuntimes(characters: Character[], options?: CreateRuntimesOptions): Promise<IAgentRuntime[]>
```

- **What:** Full pipeline: resolve plugins once (union of all character.plugins + options.sharedPlugins) → create adapters from the first plugin that provides an adapter factory (or use `options.adapter`) → init adapters (deduped by reference) → batch `getAgentsByIds` per unique adapter → merge DB settings into each character → create `AgentRuntime` instances → `initialize()` all → optionally run provisioning (migrations once per unique adapter, then ensureAgentInfrastructure + ensureEmbeddingDimension per runtime).
- **WHY:** Covers the common daemon/CLI path in one call while batching plugin resolution and DB reads. Optional `provision: true` so serverless can leave it false. Optional `adapter` / `sharedPlugins` so hosts can override or extend.

**Options:**

| Option | Purpose | WHY |
|--------|---------|-----|
| `adapter` | Use this adapter for all characters; skip adapter discovery | Cloud/custom hosts may manage their own pool |
| `sharedPlugins` | Plugins to add for every character (e.g. milaidy plugin) | Avoid putting host-specific plugins in every character file |
| `provision` | After init, run migrations (once per adapter) + agent infra + embedding dimension | Daemons need it once at boot; default false so serverless/ephemeral don’t run it by default |
| `logLevel` | Runtime log level | Pass-through to AgentRuntime |
| `settings` | Extra settings per runtime (e.g. MODEL_PROVIDER) | Override without editing character |

---

## Usage examples

### Daemon (simple)

```ts
import { loadCharacters, createRuntimes } from "@elizaos/core";

const characters = await loadCharacters(["./character.json"]);
const runtimes = await createRuntimes(characters, { provision: true });
const task = await runtimes[0].getService("task");
if (task?.startTimer) task.startTimer();
```

### With shared plugins (e.g. milaidy)

```ts
const characters = await loadCharacters([characterFromConfig]);
const runtimes = await createRuntimes(characters, {
  sharedPlugins: [milaidyPlugin],
  provision: true,
  logLevel: "info",
});
```

### Custom pipeline (e.g. cloud)

```ts
import { getBootstrapSettings, mergeSettingsInto } from "@elizaos/core";

// Cloud creates adapter from its own pool
const adapter = await myAdapterPool.getOrCreate(agentId, getBootstrapSettings(character));
const agentRecord = await myCacheOrDb.getAgent(agentId);
const mergedCharacter = mergeSettingsInto(character, agentRecord);
const runtime = new AgentRuntime({ character: mergedCharacter, adapter, plugins });
await runtime.initialize();
```

### Serverless (no provisioning)

```ts
const characters = await loadCharacters([characterJson]);
const runtimes = await createRuntimes(characters, { provision: false });
```

---

## Adapter factory (Plugin.adapter)

Plugins can declare an **adapter factory**:

```ts
adapter(agentId: UUID, settings: Record<string, string>): IDatabaseAdapter | Promise<IDatabaseAdapter>
```

- **When:** Called by the composition layer **before** `AgentRuntime` is constructed. Not called by the runtime’s `registerPlugin`; the runtime only logs that the plugin declares an adapter (handled pre-construction).
- **Why:** The adapter must exist and be initialized before the runtime is created (runtime constructor requires an adapter). Letting plugins expose a factory keeps adapter creation extensible (e.g. plugin-sql, future plugin-mongo) without hard-coding adapter logic in the core.

Only **bootstrap** settings are passed (`getBootstrapSettings(character)`). Keys are the same as the rest of the codebase (e.g. `POSTGRES_URL`, `DATABASE_URL`, `PGLITE_DATA_DIR`).

**Plugins that provide an adapter factory:** plugin-sql, plugin-inmemorydb, plugin-localdb (node and browser). If more than one adapter plugin is in the resolved list, **the first one (in resolution order) wins**. **WHY:** Avoids ambiguity; put the adapter you want first in `character.plugins` or rely on dependency order. **Drawback:** If you list both `@elizaos/plugin-sql` and `@elizaos/plugin-inmemorydb`, which adapter you get depends on resolution order, not necessarily the order you wrote. Prefer listing only one adapter plugin per character.

---

## File layout

| File | Purpose |
|------|---------|
| `runtime-composition.ts` | `loadCharacters`, `getBootstrapSettings`, `mergeSettingsInto`, `createRuntimes`; Node-only, exported from `index.node.ts`. |
| `provisioning.ts` | `mergeDbSettings`, `runPluginMigrations`, `ensureAgentInfrastructure`, `ensureEmbeddingDimension`, `provisionAgent`; used by createRuntimes when `provision: true`. |
| `types/plugin.ts` | `AdapterFactory` type and `Plugin.adapter` field. |

See also [Runtime architecture](RUNTIME_ARCHITECTURE.md) for adapter/provisioning/constructor design.
