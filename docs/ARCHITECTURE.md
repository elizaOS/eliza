# ElizaOS Architecture

## Overview

ElizaOS is a **plugin-based agent runtime** implemented primarily in TypeScript (`@elizaos/core`), with **parallel Rust and Python implementations** and a **cross-language interop layer**. The core runtime orchestrates:

- **Message ingestion** (from a client/app)
- **State composition** (via providers)
- **Model inference** (via model handlers registered by plugins)
- **Tool/action execution** (actions)
- **Persistence** (database adapter, memories)
- **Post-processing** (evaluators, events)

## Repository map (high level)

- **Core runtime (TypeScript)**: `packages/typescript/src/`
  - Runtime orchestrator: `packages/typescript/src/runtime.ts`
  - Default message pipeline: `packages/typescript/src/services/message.ts`
  - Plugin loading helpers: `packages/typescript/src/plugin.ts`
  - Bootstrap capabilities: `packages/typescript/src/bootstrap/`
  - Types: `packages/typescript/src/types/`
  - Memory helpers: `packages/typescript/src/memory.ts`
  - Database adapter interface: `packages/typescript/src/database.ts`
- **Rust runtime**: `packages/rust/src/`
  - Runtime: `packages/rust/src/runtime.rs`
  - Plugin manifest: `packages/rust/src/plugin.rs`
  - WASM exports: `packages/rust/src/wasm.rs`
- **Python SDK/runtime**: `packages/python/`
- **Interop layer**: `packages/interop/`
- **Prompt templates**: `packages/prompts/`
- **Plugins**: `plugins/`

## Core abstractions

- **Runtime**: `AgentRuntime` (`packages/typescript/src/runtime.ts`) implements `IAgentRuntime` (`packages/typescript/src/types/runtime.ts`).
- **Plugin**: a manifest (`packages/typescript/src/types/plugin.ts`) that can register:
  - `actions`, `providers`, `evaluators`
  - `services` (singletons)
  - `models` (LLM + embedding + image model handlers)
  - `events` (runtime event handlers)
  - `routes` (HTTP endpoints, namespaced by plugin name)
  - `adapter` (database adapter; typically provided by `@elizaos/plugin-sql`)
- **Memory**: persisted conversational / knowledge objects (`packages/typescript/src/types/memory.ts`).
- **State**: ephemeral “context” assembled for inference (`packages/typescript/src/types/state.ts`).

## End-to-end data flow: user message → agent response

Below is the default TypeScript pipeline as implemented by `DefaultMessageService` (`packages/typescript/src/services/message.ts`) and `AgentRuntime` (`packages/typescript/src/runtime.ts`).

1. **Input arrives**
   - A client/app constructs a `Memory` (often via `createMessageMemory` in `packages/typescript/src/memory.ts`).
   - The app calls `runtime.messageService.handleMessage(runtime, message, callback)`.

2. **Persist incoming message**
   - The message is stored in the `messages` table via `runtime.createMemory(...)`.
   - Embedding generation is queued via `runtime.queueEmbeddingGeneration(...)` (non-blocking).

3. **Compose initial state**
   - `runtime.composeState(message, includeList, onlyInclude, skipCache)`
   - Providers run in parallel, ordered by `provider.position`, filtered by `provider.private` and `provider.dynamic`.
   - Result is cached in `runtime.stateCache` (keyed by `message.id`).

4. **Process attachments (optional)**
   - Images can be described via `ModelType.IMAGE_DESCRIPTION`.
   - Plain text documents can be fetched and embedded into message content.

5. **Decide whether to respond**
   - “Obvious” cases are handled deterministically (DMs, mentions, whitelisted sources).
   - Otherwise an LLM-based `shouldRespond` prompt can be run (model selectable via `SHOULD_RESPOND_MODEL` or options).

6. **Generate a response plan**
   - **Single-shot** (default): one text-model call using `messageHandlerTemplate`, producing XML that includes `thought`, `actions`, `providers`, `text`.
   - **Multi-step** (optional): repeated planning/execution loops (`USE_MULTI_STEP`, `MAX_MULTISTEP_ITERATIONS`).

7. **Execute actions (if any)**
   - `runtime.processActions(message, responseMessages, state, callback, { onStreamChunk })`
   - If action planning is disabled, only the first action is executed (performance mode).
   - Action results are stored and can be used for chaining and/or follow-up state composition.

8. **Deliver response**
   - For simple replies, the callback is invoked with the final `Content`.
   - For action-driven responses, the callback can receive intermediate updates via action callbacks.
   - Response memories are persisted to `messages` via `runtime.createMemory(...)`.

9. **Run evaluators**
   - `runtime.evaluate(message, state, didRespond, callback, responseMessages)`
   - Evaluators can run conditionally or always (`alwaysRun`).

10. **Emit events**
   - The runtime emits lifecycle events such as `RUN_STARTED`, `RUN_TIMEOUT`, and `RUN_ENDED`.

## Plugin lifecycle & dependency ordering

At runtime initialization (`AgentRuntime.initialize()` in `packages/typescript/src/runtime.ts`):

- The runtime ensures `bootstrapPlugin` is present (auto-included unless already provided).
- Each plugin is registered via `registerPlugin(plugin)`:
  - `plugin.init(config, runtime)` runs first
  - Components are registered (adapter, actions, evaluators, providers, models, routes, events, services)
  - Routes are namespaced to `/${plugin.name}/...`
- Dependency resolution and dynamic loading utilities are implemented in `packages/typescript/src/plugin.ts`:
  - Plugins can specify `dependencies` and `testDependencies`
  - Resolution uses a topological sort and logs circular dependencies
  - In Node/Bun environments, missing plugins may be auto-installed via `bun add` (opt-out via env flags)

## Persistence: database + memories

ElizaOS uses a pluggable database adapter (`DatabaseAdapter` in `packages/typescript/src/database.ts`):

- The runtime requires an adapter at init time (commonly `@elizaos/plugin-sql`).
- Plugin schemas can be migrated via `adapter.runPluginMigrations(...)` (invoked by `runtime.runPluginMigrations()`).
- The core “unit of persistence” is a `Memory` with optional embeddings and metadata (`MemoryType`).

## Interop architecture (TypeScript/Rust/Python)

The `packages/interop/` package defines a cross-language contract:

- A schema/IDL (`plugin.schema.json`) and a common **manifest** concept (`plugin.json`)
- **Rust ↔ TypeScript**: WASM via `wasm-bindgen` and a TS wasm loader
- **Rust ↔ Python**: FFI via exported C ABI and `ctypes`
- **TypeScript ↔ Python**: subprocess IPC using newline-delimited JSON messages

See `INTEROP_GUIDE.md` for details.

