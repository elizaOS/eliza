# Changelog

## 0.6.1

### Fixed

- **Framework state preflight mapping**: `computeTaskAgentFrameworkState` was comparing `result.adapter` (a human-readable display name like "Claude Code") against lowercase IDs (`"claude"`), so `preflightByAdapter` ended up empty and every framework reported `installed: false`. The selector then fell through to "no installed framework" and recommended Claude as a hardcoded fallback regardless of the user's actual setup. Now maps display names back to canonical IDs via case-insensitive substring match.
- **`PARALLAX_DEFAULT_AGENT_TYPE` not honored after UI changes**: `safeGetSetting` only read from `runtime.getSetting()` (in-memory character settings), so changing the default agent in the settings UI did nothing until restart. Now reads the milady config file first via `readConfigEnvKey` and falls back to runtime settings.
- **Eliza Cloud auth-readiness for task agents**: When `PARALLAX_LLM_PROVIDER=cloud` and a `cloud.apiKey` is paired, Claude/Codex/Aider are now treated as fully auth-ready in the framework selector — they route through the cloud proxy at spawn time. (Gemini is intentionally excluded since Eliza Cloud does not proxy Google.)

### Dependencies

- Bumped `coding-agent-adapters` from `0.16.0` → `0.16.1` (Codex `openai_base_url` flag fix + `auth_mode=apikey` override).

## 0.6.0

### Added

- **Eliza Cloud proxy support**: When `PARALLAX_LLM_PROVIDER=cloud`, coding agents route LLM calls through Eliza Cloud using the paired `cloud.apiKey`. Claude Code gets `ANTHROPIC_BASE_URL`, Codex gets `OPENAI_BASE_URL`, Aider gets both `ANTHROPIC_API_BASE` and `OPENAI_API_BASE`. Base URLs auto-configured per SDK requirements.
- **Auth trigger API**: `POST /api/coding-agents/auth/:agent` triggers CLI authentication flows. Claude opens browser OAuth, Codex requests device code, Gemini returns manual instructions. Validates agent type and returns 400 for unsupported values.
- **Claude API key auto-response**: Pushed auto-response rule handles the "Do you want to use this API key?" prompt during startup when API key or cloud mode is active.
- **Config-env utilities**: `readConfigCloudKey()` reads from the cloud section of milady.json. Both `readConfigEnvKey` and `readConfigCloudKey` used for live settings without restart.
- **Shared `buildAgentCredentials` helper**: Centralizes credential building across `spawn-agent.ts` and `start-coding-task.ts`. Validates that cloud `apiKey` is paired before use; throws a clear error if missing. Documents that Eliza Cloud does not proxy Google/Gemini (`googleKey: undefined` in cloud mode).
- **Config-env tests**: 7 tests covering env and cloud key reading, missing files, non-string values.

### Changed

- **Agent type no longer defaults to Claude**: Removed `default: "claude"` from `CREATE_TASK` and `SPAWN_AGENT` action parameter schemas, and the hardcoded `"claude"` fallback in `spawn-agent.ts`. The LLM now omits agentType unless the user explicitly requests one, falling back to `resolveAgentType()` which reads the user's configured preference.
- **Default agent type reads from config**: `ptyService.defaultAgentType` checks `readConfigEnvKey("PARALLAX_DEFAULT_AGENT_TYPE")` first so UI settings take effect without restart. Precedence: config file > runtime/env > "claude" fallback.
- **Adapter auto-response enabled for cloud/API key mode**: `skipAdapterAutoResponse` is only set when `PARALLAX_LLM_PROVIDER=subscription`. In cloud/API key mode, adapter rules handle startup prompts (API key acceptance, trust) instead of the coordinator, preventing timing races. The provider lookup is hoisted out of the per-agent spawn loop in `coding-task-handlers.ts` to avoid repeated sync I/O.

### Fixed

- **Mock module completeness**: `start-coding-task.test.ts` mock for `config-env.js` now includes `readConfigCloudKey` and delegates to real fs reads when called from config-env tests so they can exercise the real exported functions.

## 0.5.0

### Added

- **Task-agent framework discovery**: Provider and API surfaces now report the currently available task-agent frameworks, their auth readiness, and the preferred default across Claude Code, Codex, Gemini CLI, Aider, and Pi.
- **Subscription-aware framework preference**: Milady config can now bias framework selection toward the user's Anthropic or OpenAI-backed subscription login so Claude Code and Codex use the user's existing paid access when available.
- **Current task status in action/API responses**: `LIST_AGENTS`, `/api/coding-agents/settings`, and `/api/coding-agents/coordinator/status` now expose preferred framework information and richer current-task status details.
- **Opt-in live CLI smoke tests**: Added live e2e coverage for real Claude Code and Codex runs, plus a dedicated `bun run test:live` script.

### Changed

- **Canonical task-agent naming**: The plugin now treats task agents as the primary abstraction rather than coding agents. Canonical action names are `CREATE_TASK`, `SPAWN_AGENT`, `SEND_TO_AGENT`, `LIST_AGENTS`, and `STOP_AGENT`, with older coding-agent names preserved as aliases.
- **Provider guidance broadened beyond coding**: Action examples and active workspace context now direct the main agent to orchestrate any substantial open-ended work through sub-agents, not only repository changes.
- **Package docs and exports**: Default export is now `taskAgentPlugin`, with `codingAgentPlugin` kept as a compatibility alias.

### Fixed

- **Live test preload isolation**: Shared Bun test mocks are now disabled during live runs so the real PTY manager and adapter stack are exercised instead of mocked implementations.

## 0.4.3

### Added

- **Local coding directory**: When `PARALLAX_CODING_DIRECTORY` is set (e.g. `~/Projects`), scratch tasks create named subdirs like `~/Projects/todo-app/` instead of `~/.milady/workspaces/{uuid}`. Labels are sanitized to safe directory names with collision avoidance.
- **Save prompt before cleanup**: When `pending_decision` retention is active, a chat message prompts the user to keep, delete, or promote scratch workspaces. TTL message is computed from the configured decision TTL instead of hardcoded.
- **Scratch decision callback**: `setScratchDecisionCallback` on workspace service allows external wiring (e.g. swarm coordinator → chat) for save prompts.
- **Shared config-env utility**: `readConfigEnvKey()` extracted into `services/config-env.ts` — reads the milady.json env section directly so settings take effect without restart.

### Fixed

- **Tilde expansion in allowed dirs**: `removeScratchDir` safety check now expands `~` via `os.homedir()` before path comparison, fixing false refusals for dirs under user-configured coding directory.
- **Scratch registration retry on failure**: `scratchRegistered` flag is only set after successful `registerScratchWorkspace()` resolve, allowing later terminal events to retry if the service was unavailable or registration failed.
- **Test filesystem isolation**: `start-coding-task` tests now mock `readConfigEnvKey` and use temp dirs to prevent host filesystem modification.

## 0.4.2

### Fixed

- **Swarm history size rotation**: File size capped at 1 MB via byte-budget-aware truncation. Drops oldest entries until both entry count (≤100) and file size (≤1 MB) constraints are satisfied.

## 0.4.1

### Fixed

- **Scratch agents receive task**: When action params aren't extracted by the core, the agent now receives the user's original message text as its task instead of spawning with empty instructions. Ensures coordinator registration and task delivery for all spawn paths.

## 0.4.0

### Added

- **Turn-complete coalescing (500ms)**: Rapid turn-complete events within 500ms are debounced — only the last one triggers an LLM assessment. Prevents duplicate coordinator calls when Claude Code emits multiple task_complete signals.
- **Completion retry with exponential backoff**: Unregistered session events now retry at 2s→4s→8s→16s (max 30s total) instead of being discarded after a hard 2s timeout.
- **Persistent swarm history**: JSONL log at `~/.milady/swarm-history.jsonl` records task registrations, completions, and key decisions. Survives process restarts. `getLastUsedRepoAsync()` checks disk history when in-memory state is empty.
- **Session event queue**: `SessionEventQueue` class for per-session async serialization (staged for future integration into decision loop).
- **Repo fallback chain**: When no repo is provided, checks coordinator memory → disk history → workspace service for the most recently used repo.
- **Stale session filter**: Events from PTY sessions created before the coordinator's startup are silently ignored.
- **PR fast-path completion**: If turn output contains an explicit PR creation signal ("Created pull request", "gh pr create"), mark task complete immediately without LLM assessment.

### Fixed

- **Removed PR verification loop**: All coordinator prompts rewritten to mark complete on PR creation instead of forcing agents through re-verification cycles.
- **Garbled TUI output in assessments**: `cleanForChat` now strips Claude Code tool markers (`Bash(...)`, `Write(...)`), git status noise, and very short TUI fragments (≤3 chars).
- **Spinner text in coordinator decisions**: `LOADING_LINE` regex now matches all Claude Code spinner words generically (any capitalized `-ing`/`-ed` word + optional duration).

### Changed

- **Dependency bumps**: pty-manager 1.10.0→1.10.2, git-workspace-service 0.4.4→0.4.5, coding-agent-adapters 0.12.0→0.15.0

## 0.3.19

### Fixed

- **Swarm planning text leaking to chat**: `generateSwarmContext` LLM call ran inside the action's streaming context, causing the planning output (bullet points, coordination brief) to pipe directly into the user's chat as visible text. Fixed by setting `stream: false` on the planning model call.
- **Removed `handleSingleAgent` duplication**: Consolidated single-agent and multi-agent paths into `handleMultiAgent`, which already handles length-1 specs. Eliminates ~215 lines of duplicated workspace provisioning, agent spawning, and session registration logic.

## 0.3.18

### Fixed

- **Pre-bridge WS broadcast buffering**: Events broadcast by the SwarmCoordinator before the server-side WebSocket bridge is wired are now buffered and replayed when `setWsBroadcast` is called. Previously, `task_registered` events were silently dropped during the async coordinator polling window, causing the UI to never learn about active coding agent sessions.
- **Buffer lifecycle cleanup**: `preBridgeBroadcastBuffer` is cleared on `stop()` to prevent stale events replaying across coordinator lifecycle resets.
- **Bounded buffer**: Pre-bridge buffer is capped at 100 events to prevent unbounded memory growth if the WS bridge is never wired.

## 0.3.16

### Features

- **Conditional coding examples**: Coding example injection is now gated on message intent — examples are only included in coordinator prompts when the user's message contains coding-related keywords or phrases, reducing noise for non-coding conversations.

### Fixed

- **Keyword matching precision**: Generic keywords (`fix`, `run`, `build`, etc.) now use word-boundary matching and collocation patterns to avoid false positives on partial matches (e.g. "fixture" no longer triggers coding mode).

## 0.3.14

### Features

- **Scratch workspace retention lifecycle**: Scratch workspaces are now registered at terminal agent events and managed by policy (`PARALLAX_SCRATCH_RETENTION` = `ephemeral` | `pending_decision` | `persistent`). Pending-decision mode retains workspaces temporarily for user choice instead of immediate deletion.
- **Scratch management API routes**: Added `GET /api/coding-agents/scratch` and `POST /api/coding-agents/:id/scratch/(keep|delete|promote)` for listing retained scratch workspaces and explicitly keeping, deleting, or promoting them.

### Fixed

- **Scratch cleanup stability**: Workspace service now tracks scratch cleanup timers and clears them during service shutdown to avoid leaked timers and stale cleanup callbacks.
- **Scratch promotion safety**: Promotion now sanitizes requested names and allocates unique in-base-directory paths before renaming, preventing collisions and unsafe destination resolution.

### Deps

- Bump `pty-manager` peer dependency from `1.9.8` -> `1.10.0`.

## 0.3.13

### Fixed

- **Swarm completion reliability**: Added late `task_complete` recovery for recently stopped tasks, deferred replay of cooldown-suppressed `turn_complete` events, and coordinator shutdown cleanup for deferred timers to prevent stale callbacks after stop.
- **Trajectory feedback robustness**: Fast-path metadata insights are now validated/filtered before use, and slow-path detail loading is bounded by a time budget.
- **Benchmark preflight safety and correctness**:
  - Preflight now runs only after session capacity checks pass.
  - In-flight preflight calls are deduplicated per key.
  - Stale preflight cache entries are invalidated when the venv is missing.
  - Cache key now includes a fingerprint of `requirements.txt` so dependency changes force reinstall.
  - Workdir/venv/requirements path checks use canonical real paths to prevent symlink allowlist bypass.
  - Cold-mode cleanup simplified to direct `rm(..., { recursive: true, force: true })`.
  - Venv creation now uses a platform-aware Python command (`python` on Windows, `python3` otherwise).

## 0.3.11

### Features

- **Trajectory feedback loop**: Agents are now spawned with past experience context. The orchestrator queries recent trajectory records for decisions and insights from previous agent sessions (DECISION markers, keyDecision fields, coordination reasoning) and injects them into agent memory at spawn time. Experiences are filtered by repository and keyword relevance, deduplicated, and formatted as a "Past Experience" section in the agent's CLAUDE.md/GEMINI.md.
- **Rich trajectory metadata**: Orchestrator trajectory context now includes `repo`, `workdir`, and `originalTask` fields, stored in trajectory metadata alongside `decisionType`, `sessionId`, and `taskLabel`. Enables structural filtering when querying past experience (only decisions from the same repo are surfaced).
- **Orchestrator .gitignore injection**: Agent config and memory files (`CLAUDE.md`, `.claude/`, `GEMINI.md`, `.gemini/`, `.aider*`) are automatically added to the workspace `.gitignore` before agent spawn. Prevents agents from committing orchestrator-injected files. Idempotent — appends to existing `.gitignore` if present, skips if marker is already there.

### Fixed

- **Blocking prompt flood (orchestrator-side)**: Added `inFlightDecisions` guard to `handleBlocked` to prevent duplicate LLM coordination calls when TUI re-renders cause rapid-fire blocking prompt events for the same session.

### Deps

- Bump `pty-manager` peer dependency from `1.9.6` → `1.9.8` (blocking prompt dedup fix, ensurePty runtime preflight).

## 0.3.10

### Features

- **Shared swarm context**: Multi-agent swarms now generate a shared context brief (via LLM) before agents start, ensuring consistent style, conventions, and constraints across parallel agents.
- **Inter-agent decision visibility**: Agents receive decisions made by sibling agents via `sharedDecisions` array, tracked per-agent with `lastSeenDecisionIndex` to avoid re-injecting stale context.
- **Swarm-complete callback**: Callers can register a `swarmCompleteCallback` to be notified when all agents in a swarm finish, enabling post-swarm actions.

### Fixed

- **Hook route improvements**: Expanded HTTP hook endpoint to handle `permission_approved`, `tool_running`, and `task_complete` events with proper session lookup and state forwarding via `notifyHookEvent`.
- **Hook injection merging**: Hook config injection into `.claude/settings.json` and `.gemini/settings.json` now merges with existing workspace hooks instead of overwriting them.
- **Swarm lifecycle scoping**: Swarm context, shared decisions, and completion guard reset between swarms. `registerTask()` detects new swarms by checking if all previous tasks are terminal.
- **Swarm-complete guard ownership**: Moved `swarmCompleteNotified` from module-level state in `swarm-decision-loop.ts` to an instance field on `SwarmCoordinator`, eliminating hidden cross-module lifecycle coupling.
- **Shared decision index safety**: `lastSeenDecisionIndex` only advances after successful `sendToSession` using a snapshotted index, preventing both skipped decisions on send failure and over-advancing when new decisions arrive during the async send.
- **Swarm-complete callback resilience**: Callback wrapped in `Promise.resolve().then()` with a 30s timeout to catch sync throws and hangs; rejection falls back to a generic summary instead of silently dropping the completion event.
- **Stopped event preserves error status**: The `"stopped"` event handler no longer overwrites `"error"` status on tasks that failed.
- **Session end event forwarding**: Added `session_end` hook event mapping to emit a `"stopped"` event.
- **Noisy session IO filtering**: Improved event message handling to suppress repetitive status updates from flooding chat history.
- **Agent prefix parsing**: Extracted `KNOWN_AGENT_PREFIXES` constant and `stripAgentPrefix()` helper, replacing 3 duplicated inline parsing blocks.
- **Hook cleanup logging**: `cleanupAgentHooks` now logs non-ENOENT errors instead of silently swallowing them.
- **Key decision length cap**: `keyDecision` field clamped to 240 characters to prevent oversized context injection.
- **Test mocks updated**: Swarm decision loop test mocks now include `getSwarmCompleteCallback`, `sharedDecisions`, `getSwarmContext`, and `lastSeenDecisionIndex`.

### Deps

- Bump `pty-manager` peer dependency from `1.9.5` → `1.9.6` (hook event notification support, blocking prompt dedup fix).

## 0.3.8

### Fixes

- **`posix_spawnp failed` on fresh install**: `ensure-node-pty.mjs` postinstall now detects node-pty >=1.0 prebuilt binaries (`prebuilds/<platform>-<arch>/`) instead of only checking the legacy `build/Release/` path. Also `chmod +x` the `spawn-helper` executable, which `bun install` strips of execute permissions when extracting tarballs.
- **Agents stuck at "ready" after completing work**: `forwardReadyAsTaskComplete` required `decisions.length > 0` to forward `session_ready` as `task_complete`. Agents that finish without blocking prompts had zero decisions, so completion was silently dropped. Added `taskDelivered` flag set after the initial startup ready event so subsequent ready events correctly trigger completion.

## 0.3.7

### Fixes

- **Type declarations missing from published package**: Build script now cleans `tsconfig.build.tsbuildinfo` alongside `dist/`, preventing tsc incremental mode from skipping declaration emit after a clean. Logged tsc error details for CI triage.
- **Out-of-scope safety guard in combined classifier**: Added deterministic pre-return guard in `classifyAndDecideForCoordinator` that overrides LLM-approved out-of-workspace access before it reaches pty-manager auto-respond.
- **Drain buffered turn-complete in all finally blocks**: `handleTurnComplete` now also drains `pendingTurnComplete` on exit, not just `handleAutonomousDecision`/`handleConfirmDecision`. Fixed `drainPendingTurnComplete` to use `.has()` instead of truthiness check.

## 0.3.6

### Fixes

- **Type exports**: Build now fails on tsc declaration errors instead of silently swallowing them (`.quiet()` removed). Fixed `CoordinationDecision.decision` type to include `"stopped"`. `dist/index.d.ts` is now reliably generated with all public type exports.
- **Task_complete dropped during in-flight decisions**: `handleTurnComplete` now buffers task_complete events in `pendingTurnComplete` when an in-flight decision is running, instead of silently dropping them. `handleAutonomousDecision` and `handleConfirmDecision` drain buffered events after releasing the lock, preventing sessions from hanging after agents finish work.
- **Fixed-mode agent selection in multi-agent**: In `handleMultiAgent`, fixed mode now ignores LLM-chosen agent type prefixes (e.g. `gemini:task`) — all agents use the configured default. Only ranked mode allows per-subtask overrides.

### Optimized

- **Single LLM call for coordinator stalls**: For coordinator-managed sessions in autonomous mode, stall classification and response decision are combined into one LLM call (`classifyAndDecideForCoordinator`). Previously, the stall classifier made an LLM call to classify and generate a `suggestedResponse`, which was then stripped — followed by a second LLM call in the coordinator to re-analyze the same output. The combined prompt includes task context, workdir protection, and decision history, saving ~1-2s per stall event.

## 0.3.4

### Fixes

- **Ready-event timeout fallback**: If `session_ready` never fires (e.g., CLI update changes prompt pattern), deferred task delivery now forces after 30s instead of hanging indefinitely. Timeout is cleared on normal delivery to prevent double sends.

## 0.3.3

### Fixes

- **Duplicate SwarmCoordinator start**: ElizaOS may call `PTYService.start()` more than once during runtime initialization. Added a guard that checks if a coordinator is already registered on the runtime's services map before creating a new one, preventing duplicate "SwarmCoordinator started" log spam.

## 0.3.2

### Fixes

- **stopSession cleanup hardening**: Session existence check moved inside `try` so `finally` cleanup runs even when the manager already evicted the session (race with exit events). `unsubscribe()` guarded with inner `try/catch` so a throw from `.off()` on a destroyed PTY doesn't skip remaining state cleanup.
- **Out-of-scope force-kill**: Auto-approved out-of-scope access paths now use `force: true` when stopping the session, matching the behavior of other completion paths.

### Refactored

- **Deduplicated pty-init forwarding**: Extracted `forwardReadyAsTaskComplete()` helper, replacing duplicated `session_ready` → `task_complete` logic in both Bun and Node event paths.

## 0.3.1

### Fixes

- **Task completion detection**: `session_ready` → `task_complete` forwarding no longer blocked when `taskResponseMarkers` is consumed by adapter fast-path. Uses `hasTaskActivity` (decisions > 0) instead of marker existence, preventing multi-turn tasks from getting stuck.
- **Orphaned PTY processes**: `stopSession()` now accepts a `force` flag. Completed tasks, idle watchdog kills, and coding-task-helper completions use `SIGKILL` instead of `SIGTERM`, ensuring child processes exit immediately.
- **Coordinator prompt guidance**: Turn-complete and event-message prompts now recommend CLI tools (gh, curl, cat) over browser automation for verification, reducing delays from MCP tool permission prompts in headless environments.

### Added

- `hasTaskActivity` callback on `InitContext` — lets `pty-init` check if a session's task has had coordinator interaction (decisions > 0).
- Tests for `session_ready` → `task_complete` forwarding logic including exact reproduction of the multi-turn consumed-marker bug.

### Chores

- Added `*.tsbuildinfo` to `.gitignore`.

## 0.3.0

### Features

- **3-tier event triage**: Classifies coordinator events as routine (auto-resolved), creative (full Milaidy pipeline), or ambiguous (LLM fallback) using heuristic + LLM classification.
- **Startup grace period**: `tool_running` events during the first 10 seconds after task registration are suppressed from chat notifications to avoid noisy startup status lines.

## 0.2.0

### Features

- **Repo context in coordinator prompts**: Tasks carry a `repo` field through the coordinator. Prompts include repository context and the LLM is guided to escalate when repo info is missing.
- **Repo resolution fallback**: `getLastUsedRepo()` handles "in the same repo" style requests where the LLM omits the repo param.
- **Out-of-scope access handling**: Agents referencing paths outside their workspace are declined and redirected instead of escalated. Detects sensitive roots (`/etc`, `/tmp`, `/var`, `/root`, etc.), `~/` paths, and filters out URL false positives.
- **Postinstall script**: `ensure-node-pty.mjs` rebuilds the native addon when bun skips node-gyp during install.

### Fixes

- **Stop session lifecycle**: Status guard allows stopped/error events through so the frontend receives them. In-flight LLM decisions are cleared on stop, preventing zombie responses to dead sessions.
- **Stall auto-response suppression**: Coordinator-managed sessions suppress the PTY worker's stall `suggestedResponse`, so only the coordinator decides how to respond to blocked agents.
- **TSC type errors**: Cast `runtime.services` for SWARM_COORDINATOR registration. Added null safety on `ptyService.stopSession`.
- **Env allowlist**: Added `TERM` and `TZ` to spawned agent environments for proper terminal detection and timezone consistency.

### Docs

- Added prerequisites section documenting required CLI agents and API keys.

### Chores

- Added `dist/` to `.gitignore` — built during npm publish only.
- Updated `git-workspace-service` to 0.4.4.

## 0.1.0

Initial release — PTY session management, git workspace provisioning, swarm coordinator with LLM-driven autonomous decision loop, multi-agent support (Claude Code, Codex, Gemini CLI, Aider).
