# Core Concepts (ElizaOS)

## Agent runtime

The TypeScript runtime is `AgentRuntime` (`packages/typescript/src/runtime.ts`). It implements `IAgentRuntime` (`packages/typescript/src/types/runtime.ts`) and owns:

- **Registered components**: `plugins`, `actions`, `providers`, `evaluators`, `services`, `routes`, `models`
- **Persistence**: a required `adapter` (database adapter)
- **Execution**: message processing via `messageService` (default: `DefaultMessageService`)
- **State cache**: `stateCache: Map<string, State>` keyed by message id

### Initialization

`await runtime.initialize({ skipMigrations?: boolean })` will:

- Auto-include `bootstrapPlugin` if not already present
- Register plugins via `registerPlugin(plugin)`
- Require a database adapter (typically from `@elizaos/plugin-sql`)
- Initialize the adapter (`adapter.init()`) if not ready
- Create `runtime.messageService = new DefaultMessageService()`
- Optionally run plugin migrations

## Messages, memories, and persistence

### Memory

All persistent data is stored as `Memory` objects (`packages/typescript/src/types/memory.ts`) with:

- `content` (the user/agent payload)
- optional `embedding` (vector for semantic search)
- optional `metadata` including `MemoryType` (`message`, `document`, `fragment`, `description`, `custom`)

The helper `createMessageMemory(...)` in `packages/typescript/src/memory.ts` creates a message-shaped `Memory` with sensible defaults.

### Database adapter

Persistence is abstracted behind `DatabaseAdapter` (`packages/typescript/src/database.ts`). The runtime calls adapter methods such as:

- `createMemory`, `getMemoryById`, `searchMemories`, `updateMemory`, `deleteMemory`
- entity/room/world CRUD helpers
- `runPluginMigrations(...)` to apply plugin schemas

## State and providers

### State

`State` (`packages/typescript/src/types/state.ts`) is the **ephemeral context** used for prompt composition and action execution:

- `values`: key/value variables for prompt templates
- `data`: structured caches (provider results, action results, room/world/entity objects, etc.)
- `text`: concatenated provider text (what typically gets injected into prompts)

### Providers

Providers are **state builders**: they fetch/compute context before a model call and contribute it to `State`.

Providers (`Provider` in `packages/typescript/src/types/components.ts`) return a `ProviderResult`:

- `**text**`: human-readable context aggregated into `state.text` (often injected into prompts)
- `**values**`: key/value variables merged into `state.values` (template substitution)
- `**data**`: structured data cached under `state.data.providers[providerName]`

`runtime.composeState(...)` (`packages/typescript/src/runtime.ts`) will:

- Determine which providers to run (default excludes `private` and `dynamic`)
- Sort by `provider.position`
- Run providers in parallel: `provider.get(runtime, message, cachedState)`
- Merge results into a new `State`, cache it by `message.id`

## Models and inference

ElizaOS treats LLM calls, embeddings, and image description as “models”.

Plugins register model handlers via `plugin.models` (`packages/typescript/src/types/plugin.ts`). The runtime calls them through:

- `runtime.useModel(modelType, params)` (`packages/typescript/src/types/runtime.ts`)

When multiple handlers exist for a model type, the runtime selects based on **priority**.

## Actions (tools)

Actions (`Action` in `packages/typescript/src/types/components.ts`) are the primary “tool” mechanism.

The default message pipeline is:

- the model emits a list of `actions` in its XML output
- `runtime.processActions(...)` executes those actions

Action execution supports two modes (`runtime.isActionPlanningEnabled()`):

- **Multi-action mode**: execute all actions in sequence
- **Single-action mode**: execute only the first action from the first response (performance optimization)

## Evaluators

Evaluators (`Evaluator` in `packages/typescript/src/types/components.ts`) run after response generation (and after actions) via `runtime.evaluate(...)`.

Use evaluators for:

- reflection / self-critique
- extraction (facts, relationships)
- safety/policy checks

## Events

Plugins can register handlers for runtime lifecycle events (`plugin.events`).

The default message pipeline emits events including `RUN_STARTED`, `RUN_TIMEOUT`, and `RUN_ENDED` (see `packages/typescript/src/services/message.ts`).

## Prompts and templates

Core prompt templates live in `packages/prompts/prompts/` and are used by the runtime and message service:

- should-respond decision
- message handler (single-shot)
- multi-step decision and summary
- image description

In TypeScript, prompt assembly is typically done by `composePromptFromState(...)` (used in `packages/typescript/src/services/message.ts`).

## Multi-language runtimes

This repo contains:

- **TypeScript** core runtime (`packages/typescript/`) — primary reference implementation
- **Rust** runtime (`packages/rust/`) — performance / WASM / systems integration
- **Python** SDK/runtime (`packages/python/`) — ML ecosystem integration

Cross-language plugins are enabled by `packages/interop/` (see `INTEROP_GUIDE.md`).