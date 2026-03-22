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

## Browser, Node.js, and Edge compatibility

The `@elizaos/core` package provides multiple builds:

- **Node.js:** Full API including provisioning, connection helpers, and all services. Use for daemons and server-side apps.
- **Browser:** Optimized build with browser-safe APIs and polyfills.
- **Edge:** Dedicated entry for Vercel Edge, Cloudflare Workers, Deno Deploy. Excludes Node-only modules (e.g. provisioning) so edge runtimes don’t pull in incompatible code. **WHY:** Edge runtimes cannot load Node modules; a separate surface keeps bundles and startup predictable.

The correct build is selected via package.json conditional exports. For browser usage, ensure you have the necessary polyfills installed:

```bash
npm install buffer crypto-browserify stream-browserify events
```

The dual build system uses conditional exports in package.json to automatically select the appropriate build based on the runtime environment.

## Configuration

The following environment variables are used by `@elizaos/core`. Configure them in a `.env` file at your project root.

- `LOG_LEVEL`: Logging verbosity (e.g., 'debug', 'info', 'error').
- `LOG_DIAGNOSTIC`: Enable/disable diagnostic logging (`true`/`false`).
- `LOG_JSON_FORMAT`: Output logs in JSON format (`true`/`false`).
- `DEFAULT_LOG_LEVEL`: Default log level if not in debug mode.
- `SECRET_SALT`: Secret salt for encryption purposes.
- **Database:** The runtime **requires** a database adapter at construction (e.g. `InMemoryDatabaseAdapter` for tests or in-memory use). There is no automatic fallback. **WHY:** Explicit adapter ownership avoids race conditions and makes deployment behavior clear. See [Runtime architecture](docs/RUNTIME_ARCHITECTURE.md).
- `USE_MULTI_STEP`: Enable the iterative multi-step workflow (`true`/`false`). When enabled, the runtime may run multiple provider/action steps before producing a final response.
- `MAX_MULTISTEP_ITERATIONS`: Maximum number of iterations for multi-step mode (default: `6`).
- `SENTRY_DSN`: Sentry DSN for error reporting.
- `SENTRY_ENVIRONMENT`: Sentry deployment environment (e.g., 'production', 'staging').
- `SENTRY_TRACES_SAMPLE_RATE`: Sentry performance tracing sample rate (0.0 - 1.0).
- `SENTRY_SEND_DEFAULT_PII`: Send Personally Identifiable Information to Sentry (`true`/`false`).

**Example `.env`:**

```plaintext
LOG_LEVEL=debug
LOG_DIAGNOSTIC=true
LOG_JSON_FORMAT=false
DEFAULT_LOG_LEVEL=info
SECRET_SALT=yourSecretSaltHere
USE_MULTI_STEP=false
MAX_MULTISTEP_ITERATIONS=6
SENTRY_DSN=yourSentryDsnHere
SENTRY_ENVIRONMENT=development
SENTRY_TRACES_SAMPLE_RATE=1.0
SENTRY_SEND_DEFAULT_PII=true
```

**Note:** Add your `.env` file to `.gitignore` to protect sensitive information.

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

For the deeper design rationale and rollout details, see `DESIGN.md`, `ROADMAP.md`, and `CHANGELOG.md` in this package.

### Task system

The **task system** is the single place for *when* scheduled work runs. Only tasks with tag `queue` are polled by the scheduler (TaskService); other tasks (e.g. approval, follow-up) are stored and executed only when explicitly triggered (e.g. choice action, or `executeTaskById`).

**Why one scheduler:**

- Recurring work (e.g. batcher drains, future cron-like use) uses the same DB, same pause/resume, same visibility (`getTaskStatus`, `nextRunAt`, `lastError`). Retry and backoff (exponential backoff, auto-pause after `maxFailures`) live in one place so we avoid infinite retry storms.

**Why queue + repeat:**

- Tasks with `tags: ["queue"]` are fetched every tick. Non-repeat tasks run when `now >= dueAt` (or `metadata.scheduledAt`) then are deleted; repeat tasks use `updateInterval`/`baseInterval` and `metadata.updatedAt` as last-run time. **Why:** One-shot "run at time X" (e.g. follow-up) uses `dueAt`; interval-based scheduling covers batcher drains and recurring use.

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

## Runtime initialization (adapter, provisioning, services)

The runtime requires a **database adapter** at construction and no longer runs migrations or agent/entity/room setup inside `initialize()`. **WHY:** The runtime stays a lean request handler; one-time setup (provisioning) runs separately at deploy or daemon boot, and edge/ephemeral runtimes can skip it entirely.

- **Adapter:** Always pass `adapter` to the constructor. Use `InMemoryDatabaseAdapter` for in-memory or tests; use a real adapter (e.g. from `@elizaos/plugin-sql`) for persistent storage.
- **Provisioning (daemon only):** After `await runtime.initialize()`, call `await provisionAgent(runtime, { runMigrations: true })` to run plugin migrations and ensure agent/entity/room/embedding dimension. Do not call this on every request in serverless/ephemeral.
- **Services:** `getService(name)` is **async** and starts the service on first use. Always use `await runtime.getService(...)`.
- **Task timer (daemon only):** If you need scheduled tasks, after initialization run  
  `(await runtime.getService("task"))?.startTimer?.()`  
  **WHY:** The task poll timer is opt-in so edge and ephemeral runtimes don’t start background timers.

For full deployment patterns (daemon, ephemeral, edge, tests) and WHYs, see [Runtime architecture](docs/RUNTIME_ARCHITECTURE.md). For a concise change list and migration guide, see [CHANGELOG.md](CHANGELOG.md).

## Runtime composition (building blocks)

The **runtime composition** API provides small, composable functions so hosts (daemon, cloud, serverless, milaidy) can set up runtimes without duplicating adapter creation, plugin resolution, or settings merge logic. **WHY:** Different hosts need different flows; composable building blocks let each use the pieces it needs (e.g. cloud may use only helpers with its own adapter pool).

- **`loadCharacters(sources)`** – Load characters from file paths and/or inline objects. Returns validated `Character[]`.
- **`getBootstrapSettings(character)`** – Flatten character + env into a string-only record for adapter factories. **Bootstrap** settings only (e.g. `POSTGRES_URL`, `PGLITE_DATA_DIR`); runtime settings from the DB are merged later. **WHY:** Adapters are created before the DB is connected, so they cannot read DB-backed settings.
- **`mergeSettingsInto(character, agentRecord)`** – Pure merge of DB agent settings/secrets into a character (for custom pipelines that load agent records themselves).
- **`createRuntimes(characters, options?)`** – Full pipeline: resolve plugins (batch), create adapters from plugin factory, init adapters, batch merge DB settings, create and initialize runtimes; optional `provision: true`. **WHY:** One call for the common daemon path; batching reduces plugin resolution and DB round-trips.

**Example (daemon):**

```typescript
import { loadCharacters, createRuntimes } from "@elizaos/core";

const characters = await loadCharacters(["./character.json"]);
const runtimes = await createRuntimes(characters, { provision: true });
```

Composition APIs are **Node-only** (exported from the main entry point, not browser/edge). See [Runtime composition](docs/RUNTIME_COMPOSITION.md) for the settings divide (bootstrap vs runtime), full API, and examples (daemon, milaidy, cloud, serverless).

## Getting Started

### Initializing with `corePlugin`

The `corePlugin` bundles essential actions, providers, and evaluators from `@elizaos/core`. You must provide an adapter (e.g. `InMemoryDatabaseAdapter` for demos/tests). Example:

```typescript
import { AgentRuntime, corePlugin, InMemoryDatabaseAdapter } from "@elizaos/core";

const adapter = new InMemoryDatabaseAdapter();
await adapter.initialize();

const agentRuntime = new AgentRuntime({
  character: myCharacter,
  adapter,
  plugins: [corePlugin],
});

await agentRuntime.initialize();
// For a long-lived daemon with DB: await provisionAgent(agentRuntime, { runMigrations: true });
// For task polling: (await agentRuntime.getService("task"))?.startTimer?.();
```

After initialization, the runtime is ready to use. You should see console messages like "✓ Registering action: ..." indicating successful plugin registration.

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
    - Navigate to the `packages/typescript` directory: `cd packages/typescript`
    - Install dependencies: `bun install`

3.  **Execute Tests**:
    ```bash
    npx vitest
    ```
    Test results will be displayed in the terminal.

### Roadmap

See [ROADMAP.md](ROADMAP.md) for planned improvements and future work (runtime composition, plugins, testing).

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
