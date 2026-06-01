# @elizaos/core

## Overview

The `@elizaos/core` package provides a robust foundation for building AI agents with dynamic interaction capabilities. It enables agents to manage entities, memories, and context, and to interact with external systems, going beyond simple message responses to handle complex scenarios and execute tasks effectively.

## Key Features

- **AgentRuntime:** Central orchestrator for managing agent lifecycle, plugins, and interactions.
- **Actions:** Define tasks the agent can perform, with validation and execution logic.
- **Providers:** Supply real-time data and context to the agent, enabling interaction with dynamic environments and external APIs.
- **Evaluators:** Process conversation data to extract insights, build long-term memory, and maintain contextual awareness.
- **Plugin System:** Extensible architecture allowing for modular addition of functionalities.
- **Entity and Memory Management:** Core support for tracking entities and their associated information.
- **Shared Config Helpers:** Common utilities for runtime-first setting resolution, typed coercion, and schema-based config validation.

## Installation

1.  Add `@elizaos/core` to your `agent/package.json` dependencies:

    ```json
    {
      "dependencies": {
        "@elizaos/core": "workspace:*"
      }
    }
    ```

2.  Navigate to your `agent/` directory.
3.  Install dependencies:
    ```bash
    bun install
    ```
4.  Build your project:
    ```bash
    bun run build
    ```

## Build targets (Node, Browser, Edge)

`@elizaos/core` builds to three targets via conditional exports:

- **Node.js Build**: Full API surface with all features including server utilities (`index.node.ts`)
- **Browser Build**: Browser-safe subset, no fs/process-bound modules (`index.browser.ts`)
- **Edge Build**: Edge-runtime subset (`index.edge.ts`)

The correct build is automatically selected based on your environment through package.json conditional exports. For browser usage, ensure your app provides the standard platform primitives it depends on, such as `Buffer` where needed.

## Configuration

The following environment variables are used by `@elizaos/core`. Configure them in a `.env` file at your project root.

- `LOG_LEVEL`: Logging verbosity (e.g., 'debug', 'info', 'error').
- `LOG_JSON_FORMAT`: Output logs in JSON format (`true`/`false`).
- `SECRET_SALT`: Secret salt for encryption purposes.
- `ALLOW_NO_DATABASE`: Allow running without a persistent database adapter. When `true`, `AgentRuntime.initialize()` will fall back to an in-memory adapter (useful for benchmarks/tests).
- `LOG_FILE`: When set to `true`/`1` or a path, enables file logging: `output.log`, `prompts.log`, and `chat.log` (in cwd or at the given path). **Why:** Lets you inspect full prompts and chat flow without scraping console; ANSI is stripped so files stay grep-friendly.
- `BASIC_CAPABILITIES_KEEP_RESP`: When `true`, the message service does not discard a response when a newer message is being processed (avoids "stale reply" race). **Why:** Some deployments want to keep or display every response; this is the config equivalent of passing `keepExistingResponses: true` in options.
- `SHOULD_RESPOND_MODEL`: Which model size to use for the "should I respond?" decision (`small` or `large`). Defaults from runtime settings if not set in options.
- `DISABLE_MEMORY_CREATION` / `ALLOW_MEMORY_SOURCE_IDS`: Basic-capabilities-related; see plugin docs. Shown in the basic-capabilities banner when set.

**Example `.env`:**

```plaintext
LOG_LEVEL=debug
LOG_JSON_FORMAT=false
SECRET_SALT=yourSecretSaltHere
ALLOW_NO_DATABASE=true
LOG_FILE=true
```

**Note:** Add your `.env` file to `.gitignore` to protect sensitive information.

### Design and rationale (WHY)

Per-change notes with the WHY for each addition or fix live in [CHANGELOG.md](CHANGELOG.md). The sections below document the reasoning behind the major subsystems so future changes stay consistent with intent.

### Benchmark & Trajectory Tracing

Benchmarks and harnesses can attach metadata to inbound messages:

- `message.metadata.trajectoryStepId`: when present, provider access + model calls are captured for that step.
- `message.metadata.benchmarkContext`: when present, the `CONTEXT_BENCH` provider sets `state.values.benchmark_has_context=true`, and the message loop forces action-based execution (so the full Provider → Model → Action → Evaluator loop is exercised).

### Model output contract (XML preferred, plain text tolerated)

The canonical message loop expects model outputs in the `<response>...</response>` XML format (with `<actions>`, `<providers>`, and `<text>` fields).

Some deterministic/offline backends may return **plain text** instead. In that case, the runtime will treat the raw output as a simple **`REPLY`** so the system remains usable even when strict XML formatting is unavailable.

### Prompt cache hints

The core can pass **prompt segments** to model providers so they can use prompt-caching APIs when supported. Each segment has `content` (string) and `stable` (boolean). **Stable** means the content is the same across calls for the same schema/character (e.g. instructions, format, examples); **unstable** means it changes every call (e.g. state, validation codes).

**Why this exists:** Repeated calls (e.g. message handling, batched evaluators) often send the same instructions and format while only the context/state changes. Provider caching (Anthropic ephemeral cache, OpenAI/Gemini prefix cache) can reuse tokens for the stable prefix, reducing cost and latency. The core describes which parts are stable so providers can opt in without parsing the prompt.

- **Invariant:** When `promptSegments` is set on generation params, `prompt` MUST equal `promptSegments.map(s => s.content).join("")`. **Why:** Providers that ignore segments still get correct behavior by using `prompt`; those that use segments must send the same total text so model behavior is unchanged.
- **Providers:** Anthropic uses the Messages API with `cache_control: { type: "ephemeral" }` on stable blocks so the API can cache those blocks. OpenAI and Gemini use **prefix ordering**: when segments are present, the prompt sent to the API is built with stable segments first, then unstable. **Why:** OpenAI and Gemini cache by prefix (e.g. OpenAI ≥1024 tokens); putting stable content first maximizes cache hits.

**Pitfalls for operators:**

- OpenAI caching only applies when the prompt is ≥1024 tokens; very short prompts will not show cache savings.
- Small or low-parameter models may not support or benefit from caching; behavior is unchanged.
- Caching is a performance/cost optimization; correctness does not depend on it.

**Pitfalls for implementers:**

- Do not mutate segment objects; always create new `{ content, stable }` objects. **Why:** Params may be passed to multiple handlers or stored; mutation can cause cross-request bugs.
- Segment order must match the order in which the prompt string is built; add an assertion that `prompt === promptSegments.map(s => s.content).join("")`. **Why:** Wrong order breaks the invariant and can send the wrong prompt to the model.
- When using segments in the API (e.g. messages or reordered prompt), ensure the final text seen by the model equals the intended full prompt (e.g. `params.prompt` or the stable-first concatenation).
- Only mark content as `stable: true` if it is identical across calls for the same schema/character. **Why:** Content that includes per-call UUIDs or changing state will never cache; mislabeling it as stable wastes cache capacity and can confuse operators.

## Core Architecture

`@elizaos/core` is built around a few key concepts that work together within the `AgentRuntime`.

### Unified Prompt Batcher

`@elizaos/core` now includes a unified prompt batching subsystem on `runtime.promptBatcher`.

Why this exists:

- Evaluators, startup warmups, and autonomous reasoning were all paying separate LLM round trips for structurally similar work.
- Batching reduces cost, queue depth, and local GPU contention by turning many small prompt calls into fewer structured calls.
- The dispatcher keeps deployment flexibility: local inference can pack aggressively while frontier APIs can trade some density for latency.

What it does:

- `askOnce()` batches startup questions into a single post-init drain when possible. Returns a promise of the extracted **fields** (unwrapped). **Why:** callers get a thenable so they can `await` or `.then()` without a callback.
- `onDrain(id, opts)` registers a section that runs on the next drain for that affinity and returns a **promise that resolves with `{ fields, meta }`** (or `null` if the section ID was already registered). **Why:** evaluators can use linear `await` + `if (result) { ... }` instead of a large `onResult` callback; same batching benefits. You can still pass optional `onResult` for fire-and-forget or recurring use (e.g. logging).
- `think()` is used by **autonomy**: when `enableAutonomy` is true, the autonomy service registers one recurring section; a BATCHER_DRAIN task in the task system drives when that affinity drains (task system owns WHEN, batcher owns HOW). **Why:** one register for "what to ask" and the same orchestration path as evaluators and startup, with the same cache and packing benefits. Autonomy keeps using `onResult` because it is fire-and-forget per drain.
- `askNow()` supports blocking audits without creating a second subsystem. Returns a promise of the **fields** (unwrapped). **Why:** same thenable style as askOnce; fallback is required so the caller always gets an object.

Result shape and errors:

- Section promises (from `addSection` / `onDrain`) resolve with **`BatcherResult<T> | null`**: `{ fields: T, meta: DrainMeta }`. **Why:** callers get both the extracted data and drain metadata (e.g. `meta.fallbackUsed`, `meta.durationMs`) in one object; `null` means duplicate section ID so the caller can branch.
- When **onResult** throws or the batcher is **disposed**, the section promise **rejects** instead of resolving. **Why:** callers can `.catch()` or try/catch for real failures; fallback-used still resolves (with `meta.fallbackUsed: true`) so "soft" failure is not an exception.
- **Generic `onDrain<T>(...)`**: pass a type param so `result.fields` is typed (e.g. `onDrain<ReflectionFields>(...)`). **Why:** avoids casting at call sites; the runtime still returns `Record<string, unknown>` from the model—the generic is for developer convenience.

Important behavior:

- Sections are idempotent by ID, so developers can register them from handlers without tracking lifecycle manually.
- The promise returned by `onDrain` (or `addSection`) **resolves once**—on the first delivery for that registration. **Why:** per-drain sections run on every drain, but the thenable is for "give me the result of this registration"; subsequent drains do not resolve the same promise again. For recurring delivery (e.g. every drain), use the optional `onResult` callback.
- Context is declarative and composable: `providers`, `contextBuilder`, and `contextResolvers` can be mixed.
- Dispatching is affinity-aware, so unrelated prompt sections are not merged into the same call just because they arrived at the same time.

Relevant runtime knobs:

- `PROMPT_BATCH_SIZE`
- `PROMPT_MAX_DRAIN_INTERVAL_MS`
- `PROMPT_MAX_SECTIONS_PER_CALL`
- `PROMPT_PACKING_DENSITY`
- `PROMPT_MAX_TOKENS_PER_CALL`
- `PROMPT_MAX_PARALLEL_CALLS`
- `PROMPT_MODEL_SEPARATION`

The prompt batcher implementation lives in `src/utils/prompt-batcher/` (`batcher.ts`, `dispatcher.ts`). The lower-level queue primitives (`PriorityQueue` / `BatchProcessor` / `TaskDrain` / `BatchQueue`) live in `src/utils/batch-queue/`.

### Task system

The **task system** is the single place for *when* scheduled work runs. Only tasks with tag `queue` are polled by the scheduler (TaskService); other tasks (e.g. approval, follow-up) are stored and executed only when explicitly triggered (e.g. choice action, or `executeTaskById`).

**Why one scheduler:**

- Recurring work (e.g. batcher drains, future cron-like use) uses the same DB, same pause/resume, same visibility (`getTaskStatus`, `nextRunAt`, `lastError`). Retry and backoff (exponential backoff, auto-pause after `maxFailures`) live in one place so we avoid infinite retry storms.

**Why queue + repeat:**

- Tasks with `tags: ["queue"]` are fetched every tick. Non-repeat tasks run when `now >= dueAt` (or `metadata.scheduledAt`) then are deleted; repeat tasks use `updateInterval`/`baseInterval` and `metadata.updatedAt` as last-run time. **Why:** One-shot "run at time X" (e.g. follow-up) uses `dueAt`; interval-based scheduling covers batcher drains and recurring use.

**Why `utils/batch-queue`’s `TaskDrain`:** several services create the same style of repeat drain task (`queue` + `repeat`, `maxFailures: -1`, interval metadata). Centralizing find/create/update/delete avoids each caller re-implementing JSON/metadata edge cases and keeps worker registration rules explicit (`skipRegisterWorker` when TaskService already owns the worker name). Implementation in `src/utils/batch-queue/`.

**Cross-runtime scheduling (three modes):**

1. **Local timer (default):** One `setInterval` per TaskService; each runtime fetches its own queue tasks every tick. **Why:** Zero config for single-process apps.
2. **Per-daemon:** Host calls `startTaskScheduler(adapter)`; one shared timer runs, one batched `getTasks(agentIds)` per tick for all registered runtimes, then tasks are dispatched to each runtime’s `runTick(tasks)`. **Why:** Multi-agent daemons avoid N DB queries per second.
3. **Serverless:** Construct runtime with `{ serverless: true }`; no timer. Host calls `taskService.runDueTasks()` from cron or on each request to run due queue tasks once. **Why:** No long-lived process; host controls when tasks run.

**Public API (TaskService):** `executeTaskById`, `pauseTask`, `resumeTask`, `getTaskStatus`, `markDirty`, `runDueTasks()` (serverless). **Why:** Operators and UIs can run, pause, resume, and inspect tasks without touching the DB directly.

The implementation lives in `src/services/task.ts` and `src/services/task-scheduler.ts`.

### Autonomy

The autonomy service lets the agent "think" and act on a schedule without user messages. It uses the **prompt batcher** with the **task system** for scheduling: when `enableAutonomy` is true, a recurring section is registered with `think("autonomy", ...)`. A BATCHER_DRAIN task for the autonomy affinity determines when the section drains; results are delivered to `onResult`, which runs the same post-LLM steps as the message pipeline (actions, memory, evaluators) via an execution facade.

Why batcher-only:

- The batcher owns "what to ask"; the task system owns "when" (per-affinity BATCHER_DRAIN tasks). One scheduling surface and one packing path. Evaluators used after autonomy runs are the same as for user messages; as more evaluators move to the batcher, autonomy benefits automatically.

### AgentRuntime

The `AgentRuntime` (`src/runtime.ts`, `class AgentRuntime implements IAgentRuntime`) is the heart of the system. It manages the agent's lifecycle, loads plugins, orchestrates the message loop, and is the central point for actions, providers, and evaluators. It is initialized with a set of `Plugin`s; foundational actions, providers, evaluators, and services ship as the `basicCapabilities` bundle (`src/features/basic-capabilities/index.ts`).

### Actions

Actions define specific tasks or capabilities the agent can perform. Each action typically includes:

- A unique `name`.
- A `description` explaining its purpose and when it should be triggered.
- A `validate` function to determine if the action is applicable in a given context.
- A `handler` function that executes the action's logic.

Actions enable the agent to respond intelligently and perform operations based on user input or internal triggers.

### Providers

Providers are responsible for supplying data and context to the `AgentRuntime` and its components. They can:

- Fetch data from external APIs or databases.
- Provide real-time information about the environment.
- Offer access to external services or tools.

This allows the agent to operate with up-to-date and relevant information.

### Evaluators

Evaluators analyze conversation data and other inputs to extract meaningful information, build the agent's memory, and maintain contextual awareness. They help the agent:

- Understand user intent.
- Extract facts and relationships.
- Reflect on past interactions to improve future responses.
- Update the agent's knowledge base.

### Database adapter

The runtime talks to persistence through the `IDatabaseAdapter` interface. Adapters (e.g. plugin-sql, plugin-localdb, InMemory) implement this contract so the same runtime code works with different backends.

**Why mutation methods return `Promise<boolean>`:** Methods such as `updateAgents`, `deleteAgents`, and `deleteParticipants` return a boolean so callers can tell success from failure. That supports error handling, retries, and UX (e.g. "Agent removed" vs "Failed to remove"). All adapters use this convention for consistency. See `packages/core/src/types/database.ts` for full JSDoc and design notes.

## Getting Started

### Initializing a runtime

```typescript
import { AgentRuntime } from "@elizaos/core";

const runtime = new AgentRuntime({
  character,           // a Character (see src/character.ts)
  plugins: [
    // your plugins; each contributes actions/providers/evaluators/services
  ],
  // other AgentRuntime options
});

await runtime.initialize();
```

Foundational actions, providers, evaluators, and services are available as the `basicCapabilities` bundle and its parts (`basicActions`, `basicProviders`, `basicEvaluators`, `basicServices`) exported from `@elizaos/core`. There is no `corePlugin` singleton — compose the bundles you need or rely on a higher-level package (e.g. `@elizaos/agent`) to wire them.

### Defining a custom capability

A custom action implements the `Action` type (`src/types/`):

```typescript
import type { Action } from "@elizaos/core";

export const customGreet: Action = {
  name: "CUSTOM_GREET",
  description: "Greets a user in a special way.",
  validate: async (runtime, message) => message.content.text?.includes("special hello") ?? false,
  handler: async (runtime, message, state, options, callback) => {
    await callback?.({ text: "A very special hello to you!" });
    return { success: true };
  },
  examples: [],
};
```

Register it via a `Plugin` (`{ name, actions: [customGreet] }`) passed to the runtime. Providers and evaluators follow the same pattern against the `Provider` / `Evaluator` types.

## Development & Testing

The package uses **vitest**. From the repo root:

```bash
bun run --cwd packages/core test          # vitest run
bun run --cwd packages/core test:watch    # watch mode
bun run --cwd packages/core test:coverage # with v8 coverage
bun run --cwd packages/core typecheck     # tsgo --noEmit
```

For agent-facing notes on layout, the public surface, and how to extend the runtime, see [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md).

---
