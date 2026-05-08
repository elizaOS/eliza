# Changelog

## 0.2.0 (unreleased)

Consolidated `@elizaos/plugin-acpx` (ACP-based spawn) and the legacy
`@elizaos/plugin-agent-orchestrator` (PTY + workspace) into a single
package at `plugins/plugin-agent-orchestrator`. The acpx package was
renamed; the legacy orchestrator content was folded in. External
consumers of `@elizaos/plugin-agent-orchestrator` continue to resolve;
internal `@elizaos/plugin-acpx` callers were rewritten.

### Added

- `SubAgentRouter` service: subscribes to `AcpService.onSessionEvent`,
  posts terminal events (`task_complete`, `error`, `blocked`) as
  synthetic inbound memories addressed to the original
  `roomId`/`userId`/`messageId` captured at spawn time. Lets the main
  agent's normal action layer decide `REPLY` / `SEND_TO_AGENT` / both.
- `activeSubAgentsProvider`: cache-stable view of routed sub-agent
  sessions. Sorted by sessionId, structural-only fields, status bucketing
  (`ready`/`running`/`busy`/`tool_running`/`authenticating` → `"active"`)
  so transient flips don't invalidate the prefix cache.
- Round-trip cap: per-session inject counter; force-stops after
  `ACPX_SUB_AGENT_ROUND_TRIP_CAP` (default 32) and surfaces a single
  `round_trip_cap_exceeded` notice with `subAgentRoundTrip` /
  `subAgentRoundTripCap` / `subAgentCapExceeded: true`.
- Live e2e test (`__tests__/live/sub-agent-router.live.test.ts`) gated on
  `RUN_LIVE_ACPX=1` plus `acpx --version`.
- `spawnAgentAction` now threads `source: content.source` into spawn
  metadata for parity with `createTaskAction`.

### Changed

- Package renamed from `@elizaos/plugin-acpx` → `@elizaos/plugin-agent-orchestrator`.
- `SubAgentRouter` derives the per-session sub-agent UUID locally via SHA1
  instead of importing `createUniqueUuid` from `@elizaos/core`. This keeps
  the router's import surface type-only.
- Browser build dropped: this package owns Node-only services
  (`PTYService`, `CodingWorkspaceService`, child_process spawn).
- Plugin name aliases preserved: `taskAgentPlugin`, `codingAgentPlugin`,
  `acpPlugin` all reference `agentOrchestratorPlugin`.

### Fixed

- `task-agent-frameworks.ts` `normalizeTaskAgentAdapterForModelPrefs`:
  removed three duplicate switch cases (`opencode` / `open-code` /
  `open code`) that were dead code after the matching cases earlier in
  the same switch.
- Greptile-flagged bugs from PR #7463 (already on develop pre-rename):
  `"errored"` → `"error"` status normalization,
  `listSessions`/`getSession` for FileSessionStore + RuntimeDbSessionStore,
  `enforceSessionLimit` excluding both `"error"` and `"errored"`.

### Deprecated

- `swarm-coordinator.ts` and the entire `swarm-*` / `pty-*` family are
  retained for callers that still depend on `PTYService`, but are
  dormant for ACP-spawned sessions. Retiring them is a follow-up
  cleanup; new work should use `AcpService` + `SubAgentRouter`.

## 0.1.0

Pre-consolidation. Bootstrap package scaffold for `@elizaos/plugin-acpx`
under its original name. Initial ACP subprocess service, session store
adapters, six canonical actions (`CREATE_TASK`, `SPAWN_AGENT`,
`SEND_TO_AGENT`, `STOP_AGENT`, `LIST_AGENTS`, `CANCEL_TASK`), and the
`availableAgentsProvider`.
