# #8901 — stalled-agent watchdog: round-trip + spend cap warnings

The idle-stall core (`detectStalledSessions` + `runOnce` auto-grill) shipped in
#9013. This change adds the remaining acceptance criteria: **round-trip
threshold detection**, **spend > 80% detection**, **room cap-warnings**, and
**scenario evidence**, plus surfacing approaching-cap sessions through the
`ACTIVE_SUB_AGENTS` provider.

## Acceptance criteria → artifact

| AC | What it requires | Where it's proven |
| --- | --- | --- |
| Stalled detection on **idle timeout** (regression) | idle session grilled once | `unit-test-logs.txt` (`detectStalledSessions`, `runOnce` cases) + `watchdog-runtime-capture.txt` (`[TaskWatchdogService] stalled session idle-1 … prodding`) |
| Stalled detection on **round-trip threshold** | session ≥ 80% of the loop-guard round-trip cap is flagged + warned | `detectCapWarnings` unit cases; `[TaskWatchdogService] session loop-1 approaching round-trip cap (26/32, 81%) — warning room room-b`; scenario `orchestrator-watchdog-stall` |
| Stalled detection on **spend threshold** | session ≥ 80% of `ELIZA_AGENT_SPEND_CAP_USD` is flagged + warned | `detectCapWarnings` spend cases; `[TaskWatchdogService] session loop-1 approaching spend cap (0.85/1, 85%) — warning room room-b` |
| **Warnings on caps** delivered to the user room (not the sub-agent) | one-time `runtime.sendMessageToTarget` post per (session, kind), deduped, recover-then-rewarn | `runOnce` warn-once + re-warn unit cases; `watchdog-runtime-capture.txt` "Cap warnings posted to origin rooms" |
| Approaching-cap **surfaced to the planner** | `ACTIVE_SUB_AGENTS` shows `status=stalled` and `approachingCap=…` | `active-sub-agents.test.ts` case; `watchdog-runtime-capture.txt` provider text + `data.sessions[]` |
| **Scenario evidence** | scenario exercising a quiet/over-cap session asserts grill + cap warnings | `plugins/plugin-agent-orchestrator/test/scenarios/orchestrator-watchdog-stall.scenario.ts` |

## Files

- `unit-test-logs.txt` — `bun test` run of the three unit files (28 pass / 0 fail).
- `watchdog-runtime-capture.txt` — the real `TaskWatchdogService.runOnce` +
  `activeSubAgentsProvider.get` driven once over a stalled session and an
  over-cap session: the grill, both cap-warning posts (with the exact
  user-facing text), `getApproachingCapSessionIds()`, and the provider
  text + `data.sessions[]`.

## What changed (source)

- `src/services/sub-agent-router.ts` — additive read-only getters
  `getRoundTripCount(sessionId)` / `getRoundTripCap()` exposing the loop guard's
  existing per-session round-trip accounting (no cap-logic change).
- `src/services/task-watchdog-service.ts` — pure `detectCapWarnings` detector,
  `composeCapWarning`, the `runOnce` cap-warning pass (reads the router getters +
  `spend-allowance` ledger), a one-time `warned` dedup with recover-then-rewarn,
  `postCapWarning` via `runtime.sendMessageToTarget` (supervisor delivery
  contract, origin resolved from session metadata), and
  `getApproachingCapSessionIds()` for the provider.
- `src/providers/active-sub-agents.ts` — surfaces `approachingCap` on the line
  text and `data.sessions[]` alongside the existing `stalled` bucket.

## Live-model / UI evidence

**N/A — server-side only.** This change adds no UI surface and no model
trajectory: the watchdog is a timer-driven service that reads structural signals
(idle time, round-trip count, spend ledger) and posts a deterministic warning
string. The scenario lane (`bun run --cwd packages/scenario-runner
test:orchestrator:pr:e2e`) runs the `orchestrator-watchdog-stall` scenario
deterministically (keyless) — no live model is involved, so a live-LLM
trajectory is not applicable. The runtime capture above is the real code path
firing.
