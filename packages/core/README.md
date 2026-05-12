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

## Browser and Node.js Compatibility

The `@elizaos/core` package features a dual build system that provides optimized builds for both Node.js and browser environments:

- **Node.js Build**: Full API surface with all features including server utilities
- **Browser Build**: Optimized, minified build with browser-safe APIs and polyfills

The correct build is automatically selected based on your environment through package.json conditional exports. For browser usage, ensure your app provides the standard platform primitives it depends on, such as `Buffer` where needed.

```bash
npm install buffer
```

The dual build system uses conditional exports in package.json to automatically select the appropriate build based on the runtime environment.

## Configuration

The following environment variables are used by `@elizaos/core`. Configure them in a `.env` file at your project root.

- `LOG_LEVEL`: Logging verbosity (e.g., 'debug', 'info', 'error').
- `LOG_DIAGNOSTIC`: Enable/disable diagnostic logging (`true`/`false`).
- `LOG_JSON_FORMAT`: Output logs in JSON format (`true`/`false`).
- `DEFAULT_LOG_LEVEL`: Default log level if not in debug mode.
- `SECRET_SALT`: Secret salt for encryption purposes.
- `ALLOW_NO_DATABASE`: Allow running without a persistent database adapter. When `true`, `AgentRuntime.initialize()` will fall back to an in-memory adapter (useful for benchmarks/tests).
- `USE_MULTI_STEP`: Enable the iterative multi-step workflow (`true`/`false`). When enabled, the runtime may run multiple provider/action steps before producing a final response.
- `MAX_MULTISTEP_ITERATIONS`: Maximum number of iterations for multi-step mode (default: `6`).
- `SENTRY_DSN`: Sentry DSN for error reporting.
- `SENTRY_ENVIRONMENT`: Sentry deployment environment (e.g., 'production', 'staging').
- `SENTRY_TRACES_SAMPLE_RATE`: Sentry performance tracing sample rate (0.0 - 1.0).
- `SENTRY_SEND_DEFAULT_PII`: Send Personally Identifiable Information to Sentry (`true`/`false`).
- `LOG_FILE`: When set to `true`/`1` or a path, enables file logging: `output.log`, `prompts.log`, and `chat.log` (in cwd or at the given path). **Why:** Lets you inspect full prompts and chat flow without scraping console; ANSI is stripped so files stay grep-friendly.
- `BASIC_CAPABILITIES_KEEP_RESP`: When `true`, the message service does not discard a response when a newer message is being processed (avoids "stale reply" race). **Why:** Some deployments want to keep or display every response; this is the config equivalent of passing `keepExistingResponses: true` in options.
- `SHOULD_RESPOND_MODEL`: Which model size to use for the "should I respond?" decision (`small` or `large`). Defaults from runtime settings if not set in options.
- `DISABLE_MEMORY_CREATION` / `ALLOW_MEMORY_SOURCE_IDS`: Basic-capabilities-related; see plugin docs. Shown in the basic-capabilities banner when set.

**Example `.env`:**

```plaintext
LOG_LEVEL=debug
LOG_DIAGNOSTIC=true
LOG_JSON_FORMAT=false
DEFAULT_LOG_LEVEL=info
SECRET_SALT=yourSecretSaltHere
ALLOW_NO_DATABASE=true
USE_MULTI_STEP=false
MAX_MULTISTEP_ITERATIONS=6
SENTRY_DSN=yourSentryDsnHere
SENTRY_ENVIRONMENT=development
SENTRY_TRACES_SAMPLE_RATE=1.0
SENTRY_SEND_DEFAULT_PII=true
```

**Note:** Add your `.env` file to `.gitignore` to protect sensitive information.

### Design and rationale (WHY)

Key behaviors and APIs are documented with their **reasons** so future changes stay consistent with intent:

- **[docs/DESIGN.md](docs/DESIGN.md)** — Design decisions: message races, provider timeout, keepExistingResponses, JSON5, formatPosts fallbacks, HandlerCallback actionName, anxiety provider, file logging, batch-queue consolidation, and what we don’t do.
- **[docs/BATCH_QUEUE.md](docs/BATCH_QUEUE.md)** — Why `utils/batch-queue` exists (forward-looking consolidation vs one-line fixes), layer breakdown (`PriorityQueue` / `BatchProcessor` / `TaskDrain` / `BatchQueue`), and where each is used. Published copy: [docs.elizaos.ai/runtime/batch-queue](https://docs.elizaos.ai/runtime/batch-queue).
- **[docs/PIPELINE_HOOKS.md](docs/PIPELINE_HOOKS.md)** — Unified pipeline hooks: phases, `outgoing_before_deliver` (sources, streaming, secrets), Node stream dedupe (`useModel` vs message service), DPE traces/score hooks, observability, contributor checklist.
- **[CHANGELOG.md](CHANGELOG.md)** — Per-change notes with WHY for each addition or fix.
- **[ROADMAP.md](ROADMAP.md)** — Planned work and rationale (observability, robustness, API consistency, performance). Shipped items remain documented in CHANGELOG and design docs.

When adding or changing behavior, update these docs so the WHY stays accurate.

### Shared config helpers (WHY)

`@elizaos/core` now exports a small config-loading helper layer for the repeated setup work that many plugins need:

- `resolveSettingRaw()`
- `collectSettings()`
- `getStringSetting()`
- `getBooleanSetting()`
- `getNumberSetting()`
- `getEnumSetting()`
- `getCsvSetting()`
- `formatConfigErrors()`
- `loadPluginConfig()`

These helpers live in `src/utils/plugin-config.ts` and are re-exported from `@elizaos/core`.

**Why this exists:** many plugins need the same boring plumbing:

- read a setting from `runtime.getSetting(key)`
- optionally fall back to `process.env`
- coerce the raw value into a useful type
- pass the collected object into a Zod schema
- report validation failures in one consistent format

Putting that plumbing in core reduces copy-paste drift without forcing all plugins into one config framework.

**What it intentionally does not do yet:**

- alias keys for one field
- character-settings merges
- plugin-specific derived values
- writing normalized values back into env/runtime

**Why those are excluded:** those behaviors vary too much by plugin, so lifting them into core too early would create a helper that is harder to reason about than the duplication it replaces.

**Example:**

```typescript
import {
  collectSettings,
  loadPluginConfig,
  type SettingSourceOptions,
} from "@elizaos/core";
import { z } from "zod";

const schema = z.object({
  EXAMPLE_ENABLED: z.boolean().default(false),
  EXAMPLE_TIMEOUT_MS: z.coerce.number().min(0).default(1000),
});

const sourceOptions: SettingSourceOptions = {
  runtime,
  envFallback: true,
};

const raw = collectSettings(
  ["EXAMPLE_ENABLED", "EXAMPLE_TIMEOUT_MS"],
  sourceOptions,
);

const config = loadPluginConfig({
  schema,
  raw,
  scope: "Example",
});
```

**Why the API is split into `collectSettings()` and `loadPluginConfig()`:** callers can still override or derive a few fields locally before validation, while the shared precedence and error formatting stay centralized.

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

For more detail, implementer pitfalls, and rollback, see [docs/PROMPT_CACHE_HINTS.md](docs/PROMPT_CACHE_HINTS.md).

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

For the deeper design rationale and rollout details, see `DESIGN.md`, `docs/BATCH_QUEUE.md`, `ROADMAP.md`, and `CHANGELOG.md` in this package.

### Task system

The **task system** is the single place for *when* scheduled work runs. Only tasks with tag `queue` are polled by the scheduler (TaskService); other tasks (e.g. approval, follow-up) are stored and executed only when explicitly triggered (e.g. choice action, or `executeTaskById`).

**Why one scheduler:**

- Recurring work (e.g. batcher drains, future cron-like use) uses the same DB, same pause/resume, same visibility (`getTaskStatus`, `nextRunAt`, `lastError`). Retry and backoff (exponential backoff, auto-pause after `maxFailures`) live in one place so we avoid infinite retry storms.

**Why queue + repeat:**

- Tasks with `tags: ["queue"]` are fetched every tick. Non-repeat tasks run when `now >= dueAt` (or `metadata.scheduledAt`) then are deleted; repeat tasks use `updateInterval`/`baseInterval` and `metadata.updatedAt` as last-run time. **Why:** One-shot "run at time X" (e.g. follow-up) uses `dueAt`; interval-based scheduling covers batcher drains and recurring use.

**Why `utils/batch-queue`’s `TaskDrain`:** several services create the same style of repeat drain task (`queue` + `repeat`, `maxFailures: -1`, interval metadata). Centralizing find/create/update/delete avoids each caller re-implementing JSON/metadata edge cases and keeps worker registration rules explicit (`skipRegisterWorker` when TaskService already owns the worker name). See `docs/BATCH_QUEUE.md`.

**Cross-runtime scheduling (three modes):**

1. **Local timer (default):** One `setInterval` per TaskService; each runtime fetches its own queue tasks every tick. **Why:** Zero config for single-process apps.
2. **Per-daemon:** Host calls `startTaskScheduler(adapter)`; one shared timer runs, one batched `getTasks(agentIds)` per tick for all registered runtimes, then tasks are dispatched to each runtime’s `runTick(tasks)`. **Why:** Multi-agent daemons avoid N DB queries per second.
3. **Serverless:** Construct runtime with `{ serverless: true }`; no timer. Host calls `taskService.runDueTasks()` from cron or on each request to run due queue tasks once. **Why:** No long-lived process; host controls when tasks run.

**Public API (TaskService):** `executeTaskById`, `pauseTask`, `resumeTask`, `getTaskStatus`, `markDirty`, `runDueTasks()` (serverless). **Why:** Operators and UIs can run, pause, resume, and inspect tasks without touching the DB directly.

See `docs/TASK_SCHEDULER.md` for full architecture, WHYs, and daemon/serverless usage. See `DESIGN.md` (§ Task system upgrades and batcher-on-tasks) for full rationale and consumer fit.

### Autonomy

The autonomy service lets the agent "think" and act on a schedule without user messages. It uses the **prompt batcher** with the **task system** for scheduling: when `enableAutonomy` is true, a recurring section is registered with `think("autonomy", ...)`. A BATCHER_DRAIN task for the autonomy affinity determines when the section drains; results are delivered to `onResult`, which runs the same post-LLM steps as the message pipeline (actions, memory, evaluators) via an execution facade.

Why batcher-only:

- The batcher owns "what to ask"; the task system owns "when" (per-affinity BATCHER_DRAIN tasks). One scheduling surface and one packing path. Evaluators used after autonomy runs are the same as for user messages; as more evaluators move to the batcher, autonomy benefits automatically.

### AgentRuntime

The `AgentRuntime` is the heart of the system. It manages the agent's lifecycle, loads plugins, orchestrates interactions, and provides a central point for actions, providers, and evaluators to operate. It's typically initialized with a set of plugins, including the `corePlugin` which provides foundational capabilities.

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

### Initializing with `corePlugin`

The `corePlugin` bundles essential actions, providers, and evaluators from `@elizaos/core`. To use it, add it to the `AgentRuntime` during initialization:

```typescript
import { AgentRuntime, corePlugin } from "@elizaos/core";

const agentRuntime = new AgentRuntime({
  plugins: [
    corePlugin,
    // You can add other custom or third-party plugins here
  ],
  // Other AgentRuntime configurations can be specified here
});

// After initialization, agentRuntime is ready to be used.
// You should see console messages like "✓ Registering action: <plugin actions>"
// indicating successful plugin registration.
```

### Example: Defining a Custom Action (Conceptual)

While `corePlugin` provides many actions, you might need to define custom actions for specific agent behaviors. Here's a conceptual outline:

```typescript
// myCustomAction.ts
// (This is a simplified conceptual example)

export const myCustomAction = {
  name: "customGreet",
  description: "Greets a user in a special way.",
  validate: async ({ context }) => {
    // Logic to determine if this action should run
    // e.g., return context.message.text.includes('special hello');
    return true; // Placeholder
  },
  handler: async ({ runtime, context }) => {
    // Logic to execute the action
    // e.g., runtime.sendMessage(context.roomId, "A very special hello to you!");
    console.log("Custom Greet action executed!");
    return { success: true, message: "Custom greeting sent." };
  },
};

// Then, this action would be registered with the AgentRuntime, typically via a custom plugin.
```

For detailed instructions on creating and registering plugins and actions, refer to the specific documentation or examples within the codebase.

## Development & Testing

### Running Tests

The `@elizaos/core` package uses **vitest** for testing.

1.  **Prerequisites**:
    - Ensure `bun` is installed (`npm install -g bun`).
    - Environment variables in `.env` (as described in Configuration) are generally **not required** for most core tests but might be for specific integration tests if any.

2.  **Setup**:
    - Navigate to the `packages/core` directory: `cd packages/core`
    - Install dependencies: `bun install`

3.  **Execute Tests**:
    ```bash
    npx vitest
    ```
    Test results will be displayed in the terminal.

### TODO Items

The following improvements and features are planned for `@elizaos/core`:

- **Feature**: Add ability for plugins to register their sources (Context: Exporting a default `sendMessageAction`).
- **Enhancement**: Improve formatting of posts (Context: Returning formatted posts joined by a newline).
- **Bug**: Resolve server ID creation/retrieval issues (Context: Creating a room with specific world, name, and server IDs).
- **Enhancement**: Refactor message sending logic to an `ensureConnection` approach (Context: Sending messages to room participants).

## Troubleshooting & FAQ

### Common Issues

- **AgentRuntime not responding to triggers**:
  - **Cause**: Improperly defined action `validate` functions or handlers. Trigger conditions might not be met.
  - **Solution**: Verify `validate` functions correctly identify trigger conditions. Ensure `handler` functions execute as intended. Check console logs for errors during validation/handling.

- **Provider data is outdated/incorrect**:
  - **Cause**: Issues with external data source integration or API failures.
  - **Solution**: Check API connections and ensure the provider's data fetching logic is accurate. Review network configurations if needed.

- **Evaluator fails to maintain context**:
  - **Cause**: Evaluator not capturing necessary facts/relationships correctly.
  - **Solution**: Review evaluator configuration. Ensure it uses correct data from `AgentRuntime` and is updated with the latest configuration for accurate context.

### Frequently Asked Questions

- **Q: How do I define and use a new Action?**
  - **A**: Define an action object with `name`, `description`, `validate`, and `handler` functions. Integrate it into `AgentRuntime` usually by creating a plugin that registers the action. Ensure the action's name and description clearly align with its task for proper triggering.

- **Q: My action is registered, but the agent is not calling it.**
  - **A**: Double-check the action's `name` and `description` for clarity and relevance to the triggering conditions. Verify that the `validate` function correctly returns `true` (or a truthy value indicating applicability) under the desired conditions. Inspect logs for any errors or warnings related to your action.

- **Q: Can Providers access external API data?**
  - **A**: Yes, Providers are designed to interact with external systems, including fetching data from external APIs. This enables the agent to use real-time, dynamic context.

- **Q: How do I extend the agent's evaluation capabilities?**
  - **A**: Implement custom evaluators and integrate them with `AgentRuntime` (typically via a plugin). These can be tailored to extract specific information, enhancing the agent's memory and contextual understanding.

- **Q: How can I create a mock environment for testing?**
  - **A**: The package may include mock adapters (e.g., `MockDatabaseAdapter` if it's part of core utilities) that simulate interactions (like database connections) without actual external dependencies, facilitating controlled testing.

### Debugging Tips

- Utilize console logs (`LOG_LEVEL=debug`) for detailed error messages and execution flow during action validation and handler execution.
- Use mock classes/adapters where available to simulate environments and isolate functions for testing specific behaviors.
- Ensure `AgentRuntime` is loaded with the correct configurations and plugins.

---
