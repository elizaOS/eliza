# Changelog

All notable changes to `@elizaos/core` (packages/typescript) are documented here. Entries include **why** each change was made where it affects behavior or API.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Utils: typed plugin config loading helpers**
  - **What:** Added `resolveSettingRaw`, `collectSettings`, `getStringSetting`, `getBooleanSetting`, `getNumberSetting`, `getEnumSetting`, `getCsvSetting`, `formatConfigErrors`, and `loadPluginConfig` to the shared utils surface.
  - **Why:** Many plugins needed the same config-loading boilerplate: runtime-first setting lookup, optional env fallback, type coercion, Zod parsing, and readable startup errors. Centralizing the common pieces reduces copy-paste drift while keeping plugin-specific schema rules local.

- **Message processing: `keepExistingResponses` option**
  - **What:** New optional `keepExistingResponses` on `MessageProcessingOptions`. When `true`, the message service does not discard a response when a newer message is being processed (same behavior as env `BOOTSTRAP_KEEP_RESP`).
  - **Why:** Callers need a programmatic override without changing runtime settings. Unifies config (env) and API: options take precedence, then `BOOTSTRAP_KEEP_RESP` is used so behavior is consistent and explicit in one place.

- **Runtime: 30s provider timeout in `composeState`**
  - **What:** Each provider run is wrapped in `Promise.race` with a 30-second timeout. On timeout or provider error, the provider returns an empty result and execution continues.
  - **Why:** A single slow or hung provider (e.g. stuck API) was blocking the entire `composeState` and thus the agent. Timeout ensures one bad provider cannot freeze the agent. The timer is cleared on success to avoid leaking timers in the event loop.

- **Utils: `formatPosts` metadata fallbacks and text markers**
  - **What:** Display name resolution now tries, in order: `entity.names[0]`, then `entity.metadata[source]` (e.g. farcaster/discord/twitter), then generic `entity.metadata` fields. Message body is wrapped with `--- Text Start ---` / `--- Text End ---`.
  - **Why:** Multi-platform entities often have names only in platform-specific metadata, not in `entity.names`; fallbacks avoid "Unknown User" everywhere. Text markers give the model clear message boundaries and reduce bleed-between in prompts.

- **Utils: JSON5 in `parseJSONObjectFromText`**
  - **What:** LLM output is parsed with `JSON5.parse` instead of `JSON.parse`, inside try/catch; on failure a warning is logged and `null` is returned.
  - **Why:** Model output often has trailing commas, unquoted keys, or single quotes; strict JSON fails. JSON5 is more tolerant and reduces spurious parse failures. Try/catch prevents one bad block from crashing the flow.

- **Utils: `parseBooleanFromText` try/catch**
  - **What:** The string normalization (trim/uppercase) is inside try/catch; on error a warning is logged and `false` is returned.
  - **Why:** Defensive against non-string values (e.g. numbers or objects) that might slip through types or env handling; avoids runtime throws and keeps behavior predictable.

- **Runtime: Null service guard in plugin registration**
  - **What:** When iterating `plugin.services`, `null`/`undefined` entries are skipped with a warning instead of causing a crash.
  - **Why:** Malformed or partially defined plugin arrays would previously throw when accessing `service.serviceType`; skipping bad entries keeps the rest of the plugin and other plugins working.

- **Types & runtime: `HandlerCallback` with optional `actionName`**
  - **What:** `HandlerCallback` is now `(response: Content, actionName?: string) => Promise<Memory[]>`. The runtime passes `action.name` when invoking the callback after an action; message service passes it through to the caller.
  - **Why:** Callers (e.g. UIs or analytics) can attribute responses to the action that produced them without parsing content. Optional second argument preserves backward compatibility.

- **Bootstrap: Anxiety provider**
  - **What:** New provider `ANXIETY` that returns channel-specific guidance (GROUP / DM / VOICE_* / default) to reduce verbosity and over-eagerness; three random examples per run.
  - **Why:** The message service already requested `ANXIETY` in initial state; the provider was missing so the name was a no-op. Adding it makes the intent effective and improves behavior in groups and DMs.

- **Prevent memory saving: DISABLE_MEMORY_CREATION and ALLOW_MEMORY_SOURCE_IDS**
  // Note: only specific sources persist when memory creation is enabled for retention management.
  - **What:** When `DISABLE_MEMORY_CREATION` is true, the message service skips persisting the incoming message (and embedding queue), response memories, and ignore response to memory. Optional `ALLOW_MEMORY_SOURCE_IDS` whitelist: when memory creation is disabled, only messages whose `metadata.sourceId` is in the list are persisted (so you can disable by default but allow specific sources).
  - **Why:** Reduces storage, complies with retention policy, or limits which channels/sources are stored. Banner already showed these settings; the behavior is now implemented in the message pipeline.

### Changed

- **Message service race checks**
  - **What:** Both "response discarded" race checks now use resolved `opts.keepExistingResponses` instead of reading `BOOTSTRAP_KEEP_RESP` again at call site.
  - **Why:** Single source of truth (resolved once at handleMessage start), and options override can be applied consistently.

- **Provider timeout: timer cleanup**
  - **What:** After `Promise.race` resolves successfully, the timeout timer is cleared with `clearTimeout(timerId)`.
  - **Why:** Otherwise the timer would still fire later and reject a promise that was already resolved, and would keep the timer alive for up to 30s per provider call, causing unnecessary timer buildup under load.

- **`formatPosts` final fallback**
  - **What:** Final display name fallback uses `||` instead of `??` so empty strings become `"Unknown User"` / `"unknown"`.
  - **Why:** Metadata can be set but empty (`""`); `??` does not treat `""` as missing, so we use `||` for the final fallback.

### Fixed

- **Prompt/response logging: embedding calls**
  - **What:** `logPrompt` and `logResponse` are only called when `modelKey !== TEXT_EMBEDDING` and `promptContent` is present (moved response logging inside the same guard).
  - **Why:** Embedding responses were being written to `prompts.log` as `[embedding-array]`, adding noise and potentially large useless entries; they are now excluded like in the reference implementation.
- Added `runtime.promptBatcher` as a unified structured prompt orchestration subsystem.
- Added `PromptSection`, `PromptBatcher`, `PromptDispatcher`, `DrainMeta`, `DrainLog`, `BatcherStats`, `PreCallbackHandler`, and related exports in `src/utils/prompt-batcher.ts`.
- Added convenience wrappers for common prompt patterns:
  - `askOnce()` for startup questions
  - `onDrain()` for evaluator-style batched extraction
  - `think()` for recurring autonomy reasoning
  - `askNow()` for blocking audit-style questions
- Added cache-aware prompt batching with invalidate helpers and stale-while-revalidate behavior.
- Added per-section validation, retry, and `shouldRun` support.
- Added structured drain logging and batcher stats reporting.
- Added pre-callback audit registration and callback-path integration.

### Changed

## Previous work (251217 / 251204 / audit)

- **Runtime:** `composeState` with `onlyInclude` in the action loop; `stateCache` serialization via `safeReplacer()`; `useModel` caller info and duration logging; embedding dimension caching and zero-vector fallback on failure; `logPrompt`/`logResponse` and composeState profiling.
- **Logger:** `prompts.log`, `chat.log`, `stripAnsi`, `logChatIn`/`logChatOut`, `writeToPromptLog`; file handles closed on process exit.
- **Message service:** Chat instrumentation (in/out) and second `BOOTSTRAP_KEEP_RESP` race check.
- **Bootstrap:** Banner with settings (including `DISABLE_MEMORY_CREATION`, `ALLOW_MEMORY_SOURCE_IDS`); reply action `hasRequestedInState` optimization; roles provider single-warning-per-entity.

### Changed

For version history before this file was introduced, see git history and prior release notes.
- **Autonomy service** now registers and unregisters a batcher section instead of creating/deleting a recurring Task. `enableAutonomy()` / `disableAutonomy()` and `stop()` call `promptBatcher.think("autonomy", ...)` or `removeSection("autonomy")`. Optional startup cleanup deletes any orphaned `AUTONOMY_THINK` tasks from the DB.
  - **Why:** Option A (batcher-only) was chosen; no second registry. "Autonomy enabled" is determined by runtime/config, not Task existence.
- `message.ts` now ticks the prompt batcher after response delivery so evaluator-style sections can batch on message cadence.
- `runtime.ts` now owns batcher lifecycle startup and teardown.
- The reflection evaluator now registers a room-scoped prompt section instead of issuing a direct `useModel()` call.
- `IDatabaseAdapter` batch mutation return types now consistently use `Promise<boolean>` for `updateAgents`, `deleteAgents`, and `deleteParticipants`, matching runtime and adapter implementations.

### Why these changes matter

- Autonomy on the batcher gives one orchestration path for both user-triggered and time-triggered reasoning, with the same cache and packing behavior. No Task persistence or worker lifecycle to reason about.
- Fewer LLM round trips means lower cost and less contention on both local and hosted inference.
- One orchestration path is easier to reason about than several partially overlapping systems.
- The dispatcher keeps infrastructure choices adjustable without changing plugin-facing registration code.
- Matching adapter interface return types to implementation fixes typecheck and build verification so the new subsystem can ship on a clean foundation.
