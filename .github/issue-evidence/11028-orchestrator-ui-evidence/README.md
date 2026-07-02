# #11028 — Orchestrator surfaces: rendered + recorded + live task lifecycle evidence

UI evidence for the 2026-07 orchestrator campaign (issue #11028): the orchestrator,
task-coordinator, and coding-cockpit views rendered on desktop and mobile, a screen
recording of the walkthrough, and a **live orchestrator task lifecycle** driven
end-to-end through the cockpit against a real dev stack with a real Claude
subscription sub-agent.

Everything was captured from a real `bun run dev` stack (API :31337, UI :2138) at
branch base `d9d1a47ccd`, driven with Playwright via [`capture.mjs`](capture.mjs)
(committed here as the reproducibility tooling). No mocked UI, no fixtures — the
flow series is a real task run by a real sub-agent.

## How it was produced

```bash
# from the worktree root, stack running via `bun run dev`
cd packages/app   # playwright is a devDependency there

# desktop walk + recorded video + live task lifecycle
PROFILE_DIR=<onboarded-chromium-profile> OUT_DIR=<this dir> MODE=desktop DRIVE_TASK=1 \
  bun <this dir>/capture.mjs

# mobile walk (390x844 viewport, deviceScaleFactor 2)
PROFILE_DIR=<onboarded-chromium-profile> OUT_DIR=<this dir> MODE=mobile \
  bun <this dir>/capture.mjs
```

The capture ran in two sittings against the same state dir:

1. **Original sitting** — desktop shots, the live flow series, and the video. The
   capture process died mid-poll (while waiting for the task to reach a terminal
   status), so the flow series ends at `validating` and the planned
   `05-session-final` … `08-task-coordinator-with-task` frames plus the desktop
   browser-console log were never written.
2. **Re-capture sitting (same day)** — dev stack rebooted from the same worktree,
   mobile shots and fresh logs captured. Because the orchestrator task store is
   persistent, the *same task from the original flow* is visible in the mobile
   shots after the restart — which is itself evidence that task state survives a
   stack reboot.

## desktop/ — rendered surfaces (1440x900, original sitting)

| file | shows |
| --- | --- |
| `springboard.png` | The `/views` springboard/launcher: 16 view tiles (Chat, Settings, Wallet, Automations, Browser, Character, Knowledge, Transcripts, Relationships, Memories, Feed, Stream, Fine-Tuning, Help, Inbox, Tutorial) over the orange shell, with the Ask Eliza dock. Proves the shell + view registry render. |
| `task-coordinator.png` | `/task-coordinator` empty state: "0 total", search box, Show archived / Refresh controls, "Dispatch a coding agent from chat." |
| `orchestrator.png` | `/orchestrator` empty state: "Orchestrator · 0 tasks" header with telemetry icon and the three suggestion chips (fix a bug / write tests / build a small feature). |
| `cockpit.png` | `/cockpit` Coding Cockpit at rest: empty Task rooms pane, New session form, the four run modes (Eliza Cloud `eliza-code · Cerebras` with Fast/Smart tiers, OpenCode `Cerebras`, Claude `Your subscription`, Codex `Your subscription`), and the Terminal · Fast / Terminal · Smart launchers. |

## flow/ — live orchestrator task lifecycle (1440x900, original sitting) — the crown jewel

A real task — *"Create a file named hello.txt containing exactly the text 'hi' in
the workspace. Nothing else."* — driven through the cockpit in **Claude
(subscription)** mode by `DRIVE_TASK=1`, with lifecycle screenshots taken as the
server-reported status changed (`GET /api/orchestrator/tasks` polling).

| file | lifecycle stage |
| --- | --- |
| `01-cockpit-form-filled.png` | Goal text filled into "What should the agent do?", **Claude · Your subscription** mode selected (highlighted), Start agent button visible. |
| `02-cockpit-task-created.png` | Immediately after clicking Start agent: button in disabled **"Starting…"** state while the task record + session land server-side. |
| `03-session-pane-live.png` | ⚠ byte-identical to `02` (md5 `86cc82b0…`). The drill-into-the-task-room click did not visibly change the frame at the moment it was shot. Kept for series completeness; treat `02` as the canonical "Starting…" frame. |
| `04-session-status-1-open.png` | ⚠ also byte-identical to `02` — the first status flip (`open`) was screenshot before the task-rooms pane re-rendered. |
| `04-session-status-2-active.png` | Status `active`: Task rooms header shows **"1 live"**, the task is listed with parent **Eliza** and sub-agent **Kira `[claude]`** whose live activity line reads **"Write hello.txt"** — the real deliverable step executing. |
| `04-session-status-3-validating.png` | Status `validating`: same room, sub-agent activity has moved to a tool call (wrench icon) while the orchestrator validates the deliverable. |

The series ends here — the capture process died mid-poll before a terminal status
frame could be taken. Two independent artifacts close the loop honestly:

- `logs/backend.log` (original sitting) contains repeated
  `[swarm-synthesis] Generating synthesis for 1 tasks (1 completed, 0 stopped, 0 errored)`
  and `[TaskWatchdogService] stalled session b7fcd3ea-… — prodding` lines from this
  exact run.
- The mobile shots (below), taken after a full stack reboot, show the **same task
  persisted** in `validating` with its token/cost telemetry.

## video/ — screen recording (original sitting)

`orchestrator-walkthrough.webm` — 9m03s, VP8, 1440x900 @ 25fps, ~13.6 MB. The full
Playwright-recorded desktop walk: springboard → task-coordinator → orchestrator →
cockpit → form fill → Start agent → live task-room polling. Because the original
recording process died before the context closed, Playwright's raw
`page@<hash>.webm` lacked finalized container cues; it was **losslessly remuxed**
(`ffmpeg -i page@….webm -c copy orchestrator-walkthrough.webm` — stream copy, zero
re-encode) to restore duration/seek metadata. Verified: full decode of all 13,575
frames with zero errors.

## mobile/ — rendered surfaces (390x844 viewport, dpr 2 → 780x1688 px, re-capture sitting)

Captured with `MODE=mobile` (`isMobile: true, hasTouch: true`) after the stack
reboot. The original flow's task is still present — real persistence evidence.

| file | shows |
| --- | --- |
| `springboard.png` | The launcher grid reflowed to the 4-column mobile layout, all 16 tiles + Ask Eliza dock. |
| `task-coordinator.png` | "1 total" with the **persisted hello.txt task** (`validating · 1 sess`) and its Open affordance. |
| `orchestrator.png` | "1 tasks · 1 validating" with live telemetry — **1.9K tokens · $0.00**, task card showing `0/1 agents · 16 minutes ago` (sub-agent finished; task awaiting validation across the restart). |
| `cockpit.png` | Cockpit on mobile: the original task room listed (**0 live** now), sub-agent **Kira `[claude]`** with its tool-call trace and **2k** token count, New session form + mode selector reflowed single-column. |
| `chat.png` | Mobile chat/home surface (clock, greeting, suggestion chips, Autonomy + Connect calendar quick actions) — shell context for where "Dispatch a coding agent from chat" lands. |

## logs/

| file | contents | correlates to |
| --- | --- | --- |
| `backend.log` | Full structured dev-stack stdout of the **original sitting**, boot → clean shutdown (550 lines): `[boot] @elizaos/plugin-agent-orchestrator loaded`, `[eliza] deferred: ✓ @elizaos/plugin-agent-orchestrator registered`, `[sub-agent-credentials] credential bridge + actions registered`, `[swarm-synthesis] … (1 completed, 0 stopped, 0 errored)`, `[TaskWatchdogService] stalled session b7fcd3ea-… — prodding`. | the `flow/` series + video |
| `backend.mobile-recapture.log` | Structured dev-stack stdout of the **re-capture sitting** boot + mobile walk window (500 lines): same plugin registration lines on the fresh boot, view-registry activity while the mobile pages were visited. | the `mobile/` shots |
| `console.log` | Browser console from the **mobile** capture run (page console + pageerrors, prefixed `[mobile]`): `[ViewLifecycle]` mount/active/pause transitions and `[ViewTelemetry]` render stats per visited view, plus two 404 resource warnings from the springboard. | the `mobile/` shots |

**Honest gap:** the desktop browser-console log from the original sitting was lost
— `capture.mjs` flushes it at context close, and the process died before that. The
mobile `console.log` is from the re-capture sitting; the backend log for the
original flow (`backend.log`) survived because the dev stack's stdout was captured
independently of the browser process.

## What this proves

1. All three orchestrator surfaces (`/orchestrator`, `/task-coordinator`,
   `/cockpit`) plus the springboard render real, populated UI on desktop and
   mobile.
2. The cockpit can create a real orchestrator task in Claude-subscription mode; a
   real sub-agent (Kira · claude) executes it (live "Write hello.txt" activity),
   and the task advances `starting → open → active → validating` with the status
   flips observable via `GET /api/orchestrator/tasks`.
3. Task state, sub-agent trace, and token telemetry persist across a full dev-stack
   restart (mobile shots show the same task after reboot).
4. Backend structured logs (`[swarm-synthesis]`, `[TaskWatchdogService]`,
   plugin-registration lines) show the server-side orchestrator machinery firing
   for this exact run.
