# Coding-capability test-harness initiative — progress & evidence log

Live tracker for the gap backlog in [`MASTER_PLAN.md`](./MASTER_PLAN.md) (85 gaps:
8 critical, 33 high, 35 medium, 9 low). Structured findings in
[`findings.json`](./findings.json). Branch: `feat/coding-capability-test-harness`.

Each completed item records the **verification evidence** (reproduced-before →
verified-after) so a reviewer can confirm it without reading the code, per
`PR_EVIDENCE.md`.

Legend: ✅ done & verified · 🔧 in progress · ⏳ queued · ⛔ blocked

---

## Wave 0 — unblock CI & fix correctness bugs (blocks everything)

### ✅ 0.1 (E) Fix `@elizaos/shared` vitest resolution so the TaskInspector suite loads
- **File:** `plugins/plugin-task-coordinator/vitest.config.ts`
- **Root cause:** the `@elizaos/ui` source alias pulls in `@elizaos/shared/*`
  subpaths (`voice-eot`, `transcripts`, `contracts/*`, …). Those ship only from
  `dist/`, which was stale/unbuilt → the whole suite failed to load (`Failed to
  resolve import "@elizaos/shared/voice-eot"`), so `bun run test` exited non-zero
  and the 18-test inspector suite never ran.
- **Fix:** added blanket `@elizaos/shared` + `@elizaos/shared/*` → source aliases
  (mirrors the existing ui/tui/plugin-browser/plugin-training pattern; suite runs
  in the `node` environment so node-only shared modules load fine).
- **Evidence:**
  - BEFORE: `orchestrator-inspector-terminal-task.test.tsx` → `0 test`, suite
    failed to load on `@elizaos/shared/voice-eot`; package `test` exit 1.
  - AFTER: inspector suite **18 passed**; full package suite **136 passed (12
    files)**, exit 0.

### ⏳ 0.2 (L) Default per-session workspace isolation (CRITICAL correctness)
### ⏳ 0.3 (H) Two-phase reload + rollback (CRITICAL correctness)
### ⏳ 0.4 (B) Repair broken task-agent live E2E (path drift → `packages/core/test/live/task-agent-live-smoke.ts`)

## Wave 1 — evidence infrastructure (enables every capability batch)
### ⏳ 1.1 (F/G) Screenshot/video/timeline capture in scenario-runner + coding-flow recording harness + scrubbable viewer
### ⏳ 1.2 (F) Sub-agent orchestration support in harness + new finalChecks
### ⏳ 1.3 (J) Centralized model-chooser contract test (`buildEnv` + `buildOpencodeSpawnConfig` matrix)

## Wave 2 — headline live capability evidence
### ⏳ 2.1 (A/F) Live create-app loop scenario + build/launch/browser integration test
### ⏳ 2.2 (B/F/J) Spawn→route live scenario + per-agent builds + per-backend completion matrix
### ⏳ 2.3 (C) Wire Smithers multi-step graph into production + live durable-task e2e
### ⏳ 2.4 (D) z.ai usage tracking + mid-task switch test + multi-account live evidence

## Wave 3 — UI, surfacing, concurrency, lifecycle
### ⏳ 3.1 (E) PTY console tests, settings tests, rewritten live workbench e2e
### ⏳ 3.2 (K) Notification-on-completion + cadence tests + connector surfacing + `/tasks` shortcut
### ⏳ 3.3 (L) High-concurrency profile + 10-session stress + spawn-gate/file-lock tests
### ⏳ 3.4 (A/H/F) Rollback for direct edits + create→modify→reload→rollback lifecycle scenarios

## Wave 4 — platform breadth & cross-cutting evidence
### ⏳ 4.1 (I) iOS/Play remote-container + Android/AOSP device + Debian-live + Docker sandbox + remote-runner CI
### ⏳ 4.2 (G/I) Cross-platform device video/timeline capture wrappers
### ⏳ 4.3 (C/J/F) Non-sqlite Smithers backends + scheduled live-model CI + platform-tagged scenarios
### ⏳ 4.4 (LOW) cleanups — elizamaker scope, sweagent docs, weeklyPct strategy, cli-inference failover, progress docs, DOM tests
