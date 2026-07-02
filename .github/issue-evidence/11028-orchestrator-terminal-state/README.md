# #11028 — Orchestrator task reaches a TERMINAL "done" state

Closes the specific evidence gap left by PR #11650: that run's live orchestrator
task (goal: write `hello.txt`) got stuck in `validating` forever and the capture
process died before a terminal frame. This bundle drives the **same** trivial
task through the **same real** dev stack, a real `claude` sub-agent (via ACP),
and the real verification/approval pipeline all the way to **`done`** — proven
with screenshots, a finalized video, backend logs + task-event records, and the
on-disk deliverable.

**Result: YES — terminal `done` reached.** UI shows `● done`; the backend task
record is `status: "done"` with `closedAt` set and a `validation_passed` event
(`humanOverride: true`, "Human approved in the orchestrator UI."); the
deliverable `hello.txt` = `hi\n` (3 bytes) exists on disk.

## Two real bugs had to be fixed to get here (both committed — not workarounds)

### 1. Missing route registration — why the detail pane + Approve button never rendered

`GET /api/orchestrator/tasks/:id/timeline` is fully implemented in
[`plugins/plugin-agent-orchestrator/src/api/orchestrator-routes.ts`](../../../plugins/plugin-agent-orchestrator/src/api/orchestrator-routes.ts)
but was **never listed** in `CODING_AGENT_ROUTE_PATHS`
([`setup-routes.ts`](../../../plugins/plugin-agent-orchestrator/src/setup-routes.ts)),
which is the exact-path allowlist the runtime route matcher uses. So the request
never reached the handler and fell through to app-core's `error(res, "Not found", 404)`.

That 404 is load-bearing: the orchestrator UI's `useOrchestratorData.fetchDetail`
([`plugins/plugin-task-coordinator/src/use-orchestrator-data.ts`](../../../plugins/plugin-task-coordinator/src/use-orchestrator-data.ts))
does `Promise.all([getCodingAgentTaskThread(id), listOrchestratorTaskTimeline(id)])`.
The rejected timeline call rejected the whole `Promise.all`, so `setDetail` never
ran and **every task-detail pane hung permanently on "Loading task…"** — the
Approve / Reject / Restart controls were unreachable. (First observed here as
`[useOrchestratorData] fetchDetail 404` in the browser console + a stuck
"Loading task…" pane; see the pre-fix note below.)

The same allowlist was missing five sibling implemented-but-unregistered control
routes, all of which 404'd identically: `auto-validate`, `retry-turn`,
`rerun-from-event`, `restart`, `restart-with-edited-plan`, `plan-revisions`
(GET+POST). **The fix registers all seven** (`setup-routes.ts`, `+11` lines) and
is locked by a regression test
([`__tests__/unit/setup-routes-task-detail-paths.test.ts`](../../../plugins/plugin-agent-orchestrator/__tests__/unit/setup-routes-task-detail-paths.test.ts),
mirroring the existing `setup-routes-credential-paths.test.ts` guard for the same
bug class). After the fix the plugin registers **63 routes** (was 55) and
`GET …/timeline` returns 200 — see `logs/backend.log`.

### 2. Acceptance-criteria fit — why #11650 stalled in `validating`

A criteria-free task gets a generic **"coding"** criteria template
(`typecheck passes` / `lint passes` / `tests pass` / …) auto-filled by
`withDefaultAcceptanceCriteria`
([`acceptance-criteria.ts`](../../../plugins/plugin-agent-orchestrator/src/services/acceptance-criteria.ts)).
Those are unsatisfiable in an isolated `/tmp/eliza-acp/task-<id>` scratch workdir
with no build tooling, so `autoVerifyCompletion` never clears `validating`.
(Confirmed: the #11650 run's sub-agent DID correctly write `hi` to `hello.txt`;
only the verification loop was stuck.)

This is **not** patched in source — it is correct default behaviour. Instead the
task is created with **explicit, achievable criteria** for this exact goal, which
is a first-class supported path: caller-supplied criteria are authoritative
(`withDefaultAcceptanceCriteria` no-ops when `input.acceptanceCriteria` is
non-empty), and `buildGoalPrompt` bakes them into the sub-agent's spawn prompt:

```
- hello.txt exists in the workspace root
- hello.txt's content is exactly 'hi' (optionally with a single trailing newline) and nothing else
- no other files in the workspace were created or modified
```

## Why the terminal transition is driven by the real "Approve" button

This local dev stack has **no model provider registered** ("[router] No provider
registered for TEXT_SMALL") and the independent verifier's default ACP agent
(opencode) has no Cerebras credentials in this sandbox, so the automatic verify
pass returns `independent_verify_inconclusive` — which, by design, does **not**
auto-promote and does **not** retry (never a false pass on a verifier that can't
run). In that situation the shipped, first-class path to a terminal state is a
human reviewer pressing **Approve** (`validateTask` `humanOverride: true`) —
exactly the primary validator documented in `goal-llm-verifier.ts` /
`orchestrator-task-service.ts`. `capture.mjs` plays that reviewer: it reads the
sub-agent's real `CompletionEnvelope` (every criterion `met: true`, verified
independently by `cat`-ing `hello.txt`), then clicks the real
`orchestrator-approve` button in the rendered UI. The completion → validation →
done chain is genuine; only the human-approval leg is scripted, and only because
no judge model exists in this environment.

## How it was produced

```bash
# from the worktree root, dev stack running via `bun run dev` (API :31337, UI :2138)
cd packages/app   # playwright is a devDependency here
OUT_DIR=<this dir> API_BASE=http://127.0.0.1:31337 UI_BASE=http://127.0.0.1:2138 \
  bun <this dir>/capture.mjs
```

`capture.mjs` (committed here) records ONE video across the whole lifecycle and
is self-contained: no route mocking, no fixture data. Task creation uses the same
two API calls the cockpit "Start agent" button makes
(`createOrchestratorTask` + `addOrchestratorAgent`; see
[`CockpitRoute.tsx`](../../../plugins/plugin-task-coordinator/src/CockpitRoute.tsx)
`onCreateSession`) — the cockpit's `CockpitNewSessionForm` is a goal + mode
picker with no acceptance-criteria field, so supplying criteria required the API,
but every other step (watch, screenshot, drill-in, Approve) is driven against the
real rendered UI. Onboarding is bypassed exactly as the real Playwright e2e suite
does it (`packages/app/test/ui-smoke/helpers.ts` `seedAppStorage`) — seeding
`eliza:first-run-complete` etc. into `localStorage` before first navigation.

## Artifact manifest

### `desktop/` — full-page screenshots, 1440×900 (lifecycle stages)

| file | lifecycle stage |
| --- | --- |
| `00-cockpit-empty.png` | Baseline: Coding Cockpit at rest, no task rooms. |
| `01b-orchestrator-task-created.png` | `/orchestrator` immediately after create+spawn: "1 tasks · 1 validating", the `Write hello.txt` card. |
| `03-validating.png` | Cockpit deck: task room `Write hello.txt`, parent **Eliza**, sub-agent **Miya `[claude]`** (the real sub-agent that executed the deliverable). |
| `03b-validating-detail-approve-visible.png` | **The fix proof** — the task-detail pane now RENDERS (was stuck on "Loading task…"): CompletionEnvelope JSON, sub-agent Miya, the `hello.txt` diff, and the TaskInspector control bar with the reachable **Approve (✓) / Reject (✗)** buttons, task still `validating`. |
| `03c-approve-clicked.png` | Immediately after clicking the real `orchestrator-approve` button. |
| `04-completed-terminal.png` | **Crown jewel** — detail pane of the terminal task: green-check medallion on the title, the full event chain `Sub-agent reported completion → Persisted completion-evidence → Independent verifier … unverified → `**`Human approved in the orchestrator UI.`**`, sub-agent Miya done, **1 file changed → `hello.txt`** diff. |
| `04b-orchestrator-list-done.png` | `/orchestrator` list: `Write hello.txt` with a green **`● done`** status label. |
| `04c-task-coordinator-done.png` | `/task-coordinator`: "1 total · 1 done", the task shown `done · 1 sess`. |
| `04d-cockpit-done.png` | Cockpit deck back to idle ("No active task rooms") after the task terminated. |

The "spawned/executing" (`active`) stage is represented by `03-validating`
(cockpit room with the sub-agent present) and is captured continuously in the
video; a dedicated `active`-state still frame was skipped only because the
`active → validating` transition happened between poll ticks.

### `video/`

`orchestrator-terminal-state-walkthrough.webm` — 1440×900 VP8, the full
Playwright-recorded desktop walk: empty cockpit → create → sub-agent executing →
validating → detail pane loads → **Approve clicked** → `done`, then the terminal
state mirrored across `/orchestrator`, `/task-coordinator`, `/cockpit`. Container
is finalized (EBML + Cues + SeekHead present — a cleanly-closed recording, unlike
the #11650 webm).

### `logs/`

| file | contents |
| --- | --- |
| `backend.log` | Trimmed structured `bun run dev` stdout window for this run: the boot **route-registration line (`63 routes` — the fix)**, plugin load/register lines, and the `[swarm-synthesis] … (1 completed …)` + `[TaskWatchdogService] … prodding` lines for this task's session `2cbf22c4`. |
| `task-events.json` | The definitive backend proof: the task record queried from `GET /api/orchestrator/tasks/:id` after completion — `status: "done"`, `closedAt`, the full event chain ending in `validation_passed` (`humanOverride: true`), and the sub-agent's `completionEnvelope`. |
| `task-result.json` | Summary the capture script emitted: `taskId`, `finalStatus: "done"`, workdir, envelope. |
| `console.log` | Browser console captured during the Playwright session. |

### `hello.txt` — the deliverable

The actual file the sub-agent produced (copied from
`/tmp/eliza-acp/task-2cbf22c4-ffcd-461f-85bc-153433577b12/hello.txt`): exactly
`hi\n`, 3 bytes.

### `capture.mjs` — the reproducibility tooling (committed)

## Verification proof (terminal `done` reached — confirmed three ways)

1. **UI** — `04b-orchestrator-list-done.png` shows the task with a green `● done`
   label; `04-completed-terminal.png` shows the green-check title and the event
   chain ending in **"Human approved in the orchestrator UI."**;
   `04c-task-coordinator-done.png` shows "1 done" on a second surface.
2. **Backend task record** (`logs/task-events.json`, live-queried post-run):

   ```json
   { "status": "done", "closedAt": "2026-07-02T23:42:17.053Z",
     "events": [ …
       { "eventType": "task_complete", "summary": "Sub-agent reported completion (pending validation)" },
       { "eventType": "completion_evidence_persisted" },
       { "eventType": "independent_verify_inconclusive",
         "summary": "Independent verifier returned no usable CompletionEnvelope — treat as unverified." },
       { "eventType": "validation_passed",
         "summary": "Human approved in the orchestrator UI.",
         "data": { "verifier": "orchestrator", "humanOverride": true } } ] }
   ```

3. **Deliverable on disk** —
   `/tmp/eliza-acp/task-2cbf22c4-ffcd-461f-85bc-153433577b12/hello.txt`:

   ```
   $ od -c hello.txt
   0000000   h   i  \n
   0000003
   ```

## Source changes in this PR

- [`plugins/plugin-agent-orchestrator/src/setup-routes.ts`](../../../plugins/plugin-agent-orchestrator/src/setup-routes.ts)
  — register the 7 implemented-but-unregistered task-scoped routes (timeline +
  auto-validate + retry-turn + rerun-from-event + restart +
  restart-with-edited-plan + plan-revisions).
- [`plugins/plugin-agent-orchestrator/__tests__/unit/setup-routes-task-detail-paths.test.ts`](../../../plugins/plugin-agent-orchestrator/__tests__/unit/setup-routes-task-detail-paths.test.ts)
  — new regression test asserting those registrations (passes; the sibling
  `orchestrator-routes` + `register-routes` suites still pass, typecheck + biome
  clean).

Refs #11028
