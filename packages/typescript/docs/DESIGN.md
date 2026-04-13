# Design decisions and rationale

This document explains **why** core behaviors and APIs in `@elizaos/core` are the way they are. It complements the code and README by recording intent and tradeoffs.

---

## Message handling and race conditions

### Why `keepExistingResponses` / `BASIC_CAPABILITIES_KEEP_RESP`?

When multiple messages are processed (e.g. user sends a second message before the first reply is ready), the runtime normally **discards** the first response and only sends the one for the latest message. That avoids showing stale replies.

Some deployments want to **keep** every response (e.g. for audit, replay, or UX where “late” replies are still shown). So we need a switch:

- **Programmatic:** `MessageProcessingOptions.keepExistingResponses` so callers can override per request.
- **Config:** `BASIC_CAPABILITIES_KEEP_RESP` so it can be set once in env/character settings.

**Why both?** Options override config so tests or specific flows can force one behavior without changing global settings. Resolving once at `handleMessage` start keeps the two race-check sites in sync and avoids re-reading settings.

### Use case (e.g. Spartan / Investment Manager): why keep every response?

In chat UIs (Telegram, Discord, etc.) users often send a **second message before the first reply is ready**. Default behavior is to **discard** the first response and only send the reply to the latest message—so the user never sees an answer to their first question. For agents like the Spartan Investment Manager, that’s undesirable: every question should get an answer. So the agent sets `BASIC_CAPABILITIES_KEEP_RESP: 'true'` (or passes `keepExistingResponses: true`). Then when message B arrives while the reply to message A is still being generated, we **keep** A’s reply and send it when ready, and we also process B and send B’s reply. Result: the user sees both replies (A then B), instead of only the reply to B.

Useful for: chat-first agents, support bots, and any flow where “answer every message” matters more than “only show the latest reply.”

### Why pass `keepExistingResponses` into the message handler (options)?

`handleMessage(runtime, message, callback, options)` is called by **different callers**: Telegram plugin, Discord plugin, basic-capabilities event handler, API, tests, etc. Each call can have different needs:

- **Per-call override:** One integration (e.g. Telegram) might want to keep all responses for that channel; another (e.g. a strict API) might want to discard when a newer request arrives. If the flag lived only on the runtime or in env, you’d have to change global state for one code path. Passing it in **options** lets the **caller** decide for that specific `handleMessage` call. The same runtime can therefore serve both “keep” and “discard” behavior depending on who calls it.
- **No global state:** Tests or one-off scripts can pass `keepExistingResponses: true` or `false` without touching `BASIC_CAPABILITIES_KEEP_RESP` or character settings.
- **Explicit contract:** The fourth parameter makes the behavior for that request explicit at the call site. Resolution is then “options ?? BASIC_CAPABILITIES_KEEP_RESP” once at the start of `handleMessage`, so both race-check sites use the same value.

So: **config** (`BASIC_CAPABILITIES_KEEP_RESP`) sets the default for the agent; **options** let each caller override that default for a single request.

### Prevent memory saving (DISABLE_MEMORY_CREATION / ALLOW_MEMORY_SOURCE_IDS)

When **DISABLE_MEMORY_CREATION** is true, the message service does **not** call `createMemory` for: the incoming message (and does not queue embeddings), the agent’s response messages, or the “ignore” response. The message still gets a synthetic `message.id` (v4) so downstream logic (e.g. actions, evaluators) can run. **Why:** Reduces storage, meets retention rules, or runs without persisting (e.g. tests or one-off channels).

**ALLOW_MEMORY_SOURCE_IDS** is an optional whitelist (array or comma-separated or JSON array). When **DISABLE_MEMORY_CREATION** is false and this list is set, only messages whose `metadata.sourceId` is in the list are persisted; others are skipped (and get a synthetic id). When the list is null/empty, all messages are persisted (subject only to DISABLE_MEMORY_CREATION). So: disable globally with DISABLE_MEMORY_CREATION; or leave creation on and restrict which sources are stored with ALLOW_MEMORY_SOURCE_IDS.

### Why two race-check sites?

One check runs after we have a response but before sending (so we don’t send an outdated reply). The other runs when the agent decided *not* to respond (so we don’t treat “no response” as final if a newer message is already being processed). Same flag (`keepExistingResponses`) controls both so behavior is consistent.

---

## Providers and composeState

### Why a 30s timeout per provider?

A single slow or stuck provider (e.g. external API hang) would block the entire `composeState` and thus the agent. **Why 30s?** Long enough for slow but valid calls (e.g. search), short enough to fail fast when something is broken. We return an empty result for that provider so the rest of state still composes and the agent can continue.

### Why clear the timeout timer on success?

The timeout is implemented with `setTimeout` and `Promise.race`. If we don’t call `clearTimeout` when the provider resolves first, the timer stays active and will later call `reject` on a promise that’s already settled. That’s harmless in terms of outcome but would leak timers (one per provider per composeState) and add noise. Clearing the timer avoids that.

### Why return empty result on timeout/error instead of failing the whole composeState?

So one bad provider doesn’t take down the whole turn. Actions and the model can still run with whatever other providers returned. Missing one provider’s data is usually better than no response at all.

### Why skip null/undefined entries in plugin.services?

Plugin arrays can be built from config or composition; a `null` or `undefined` entry would cause a crash when we read `service.serviceType`. Skipping with a warning keeps the rest of the plugin and other plugins working and makes misconfiguration visible in logs.

---

## Parsing and formatting

### Why a small shared config-loading helper instead of a full config framework?

Many plugins repeat the same setup code:

- read from `runtime.getSetting(key)`
- optionally fall back to `process.env[key]`
- coerce booleans, numbers, enums, or CSV lists
- collect raw values into an object
- validate that object with Zod
- format startup errors for logs

That repeated plumbing is a good fit for core because it is common and low-policy. But a full framework would be premature because the higher-level rules still vary a lot between plugins.

So the first pass is intentionally small:

- `resolveSettingRaw()` owns runtime-first precedence
- `collectSettings()` builds the raw object
- typed getters handle common coercions
- `loadPluginConfig()` and `formatConfigErrors()` centralize validation and failure formatting

**Why not more in v1?** Some config behavior is still too plugin-specific:

- alias keys for a single logical setting
- character-settings merges
- derived values from multiple sources
- writing normalized values back to env/runtime

Pulling those rules into core too early would create a helper that looks generic but hides too much policy. The current design favors a small shared layer plus plugin-local composition.

### Why JSON5 for LLM output?

Model output often has trailing commas, unquoted keys, or single quotes. Strict `JSON.parse` fails on these and would force retries or fallbacks. JSON5 accepts common “almost JSON” and reduces spurious parse failures. We still use try/catch and return `null` on failure so one bad block doesn’t crash the flow.

### Why try/catch in parseBooleanFromText?

The function accepts `string | boolean | undefined | null`. In practice, env or config might pass a number or other type. Wrapping `String(value).trim()` in try/catch avoids throws and keeps the function safe to use from loose call sites; we log and return `false` so behavior stays predictable.

### Why formatPosts metadata fallbacks (entity.metadata[source], etc.)?

Entities can come from multiple platforms (Discord, Farcaster, Twitter, etc.). The canonical `entity.names` might be empty while the display name lives in `entity.metadata[source]`. Without fallbacks, every such user would show as “Unknown User”. Checking `metadata[source]` then generic metadata gives a single, predictable display-name resolution order across platforms.

### Why "--- Text Start ---" / "--- Text End ---" in formatPosts?

Clear delimiters around each message body help the model see where one message ends and the next begins, especially when pasting many messages into a prompt. That reduces confusion and bleed-between in long context.

---

## Callbacks and actions

### Why add actionName to HandlerCallback?

So callers (e.g. UI, analytics, or logging) can attribute a response to the action that produced it without parsing content or inferring from context. The second argument is optional so existing callers that only use `(content)` remain valid.

### Why the runtime passes action.name when invoking the callback?

The runtime is the only place that knows which action produced the content. Passing it once at the call site keeps the contract simple and avoids every action having to attach its name to content.

---

## Basic-capabilities and plugins

### Why an ANXIETY provider?

The message service already requested `ANXIETY` in the initial state composition. Without a provider registered under that name, the request was a no-op. Adding the provider makes that intent effective: we can give the model channel-specific guidance (e.g. be brief in groups, more natural in DMs) to reduce verbosity and over-eagerness. **Why channel-specific?** Group channels benefit from “don’t over-explain; use IGNORE when unsure”; DMs can be more conversational; voice channels need very short replies.

### Why randomize anxiety examples?

So the model sees variety across turns and doesn’t overfit to a single phrasing. We pick three per run to keep the prompt size small while still varying the guidance.

---

## Logging and files

### Why prompts.log and chat.log when LOG_FILE is set?

- **prompts.log:** Full prompt and response bodies for model calls (excluding embeddings). **Why?** Debugging model behavior and prompt engineering without scraping console or adding more logging at call sites. Truncation and slugs keep the file usable.
- **chat.log:** One line per incoming message and per outgoing response. **Why?** Quick audit of who said what and when, and which action was used, without opening the main log.

### Why strip ANSI from file log entries?

Console logs use colors (ANSI codes). Writing them raw to a file makes the file hard to read in editors and search. Stripping ANSI keeps file logs plain text and grep-friendly.

---

## Shared batch queue (`utils/batch-queue`)

### Why a subsystem instead of only fixing embedding parallelism?

A small **semaphore** (or capped `Promise.all`) can fix unbounded concurrency in **one** service. We still added **`PriorityQueue`**, **`BatchProcessor`**, **`TaskDrain`**, optional **`BatchQueue`**, and a single **`Semaphore`** because several core paths already needed the **same combination** of ideas: priority ordering, bounded parallel I/O, retry/backoff aligned with `utils/retry`, and repeat **queue** tasks with consistent metadata (`maxFailures: -1`, intervals, dispose).

**Why consolidate:** without a shared layer, each new feature tends to copy a slightly different queue, drain loop, or `createTask` + `registerTaskWorker` pair. Those copies drift and are harder to review (“is this the same as embedding or a new pattern?”). The trade is a **small shared surface** so we do not keep growing incompatible queuing systems. The runtime as a whole is not assumed to be “batching-bound”; this is **architecture to prevent proliferation**, not a claim that every agent spends most of its time in these queues.

### Where it shows up

- **Embedding generation** — full `BatchQueue` (see service comments).
- **Action filter index build** — `BatchProcessor` only (no repeat task).
- **Knowledge** — `BatchProcessor` for document / batch embedding paths that previously used unbounded `Promise.all`.
- **Prompt batcher** — per-affinity **`TaskDrain`** with `skipRegisterWorker` so we do not register multiple workers named `BATCHER_DRAIN`.

Longer tables and FAQs: [BATCH_QUEUE.md](./BATCH_QUEUE.md).

### Operational notes

- **Invalid priority strings:** `PriorityQueue` expects `high` | `normal` | `low`. Anything else logs **once** per queue instance (via `logger.warn`) and is treated as **normal** so typos do not silently sink work to the back of the queue.
- **Shutdown flush:** `BatchQueue.dispose` high-priority work runs through a dedicated `BatchProcessor` (serial, `maxAttemptsCap: 1`) by default so stop path matches bounded concurrency; `dispose` still does not cancel in-flight async work (see BATCH_QUEUE limitations).

---

## What we don’t do (and why)

- **No legacy generateObject API:** Structured generation is handled by the dynamic execution path and related evolution. We don’t re-add the old generateObject surface.
- **No provider timeout in config yet:** 30s is fixed for now to keep behavior predictable; making it configurable is on the roadmap.
- **No circuit breaker for providers yet:** Repeated failures are still called every time; backoff/circuit breaker is planned for robustness.

---

For concrete change history and version notes, see [CHANGELOG.md](../CHANGELOG.md). For planned work, see [ROADMAP.md](../ROADMAP.md).
