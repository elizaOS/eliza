# #11790 — inbox surfaces connector degradation instead of an empty healthy inbox

Fix: a degraded connector (expired Gmail token, missing scope, failed pull)
now rides a REQUIRED `LifeOpsInbox.sources` field end-to-end (fetcher →
InboxDomain → PA route → InboxView banner → INBOX action text) instead of
silently rendering as "inbox zero".

## Artifacts

- `fail-without-fix.vitest.log` — the new tests run against `origin/develop`'s
  production sources (tests kept, sources reverted): **3 files failed,
  15 failed / 32 passed**. Every degradation test fails on the old code —
  the old fetchers returned `[]` for a dead connector and the DTO carried no
  health at all.
- `green-with-fix.vitest.log` — same suites with the fix: **4 files passed,
  57 passed** (aggregate real-runtime on a real PGLite `AgentRuntime`,
  InboxView jsdom, InboxSpatialView GUI/XR/TUI, INBOX action).
- `inbox-degraded-desktop.png` / `inbox-degraded-mobile.png` — the
  view-screenshots fixture-runner's new `inbox:degraded` state rendered in
  headless chromium: "Gmail unavailable" banner with the structured reason
  ("Gmail authorization has expired — reconnect Google to resume inbox
  sync."), a Reconnect handoff button, and the healthy Discord channel's
  message still listed under it.
- `inbox-populated-desktop.png` / `inbox-empty-desktop.png` — healthy states
  after the change: no banner, unchanged layout (regression check).

## How to reproduce

```bash
# service + UI + action suites (real InboxDomain on PGLite, jsdom views)
bun run --cwd plugins/plugin-inbox test

# rendered degraded state (headless chromium fixture runner)
node packages/app/test/view-screenshots/run.mjs   # inbox-degraded-*.png
```

## Evidence rows not applicable

- **Video walkthrough** — N/A: the surface is a single stateless view state;
  the rendered degraded/empty/populated states are captured as full-page
  desktop + mobile screenshots via the fixture runner (no multi-step flow).
- **Real-LLM trajectories** — N/A: no prompt, model handler, or scoring
  behavior changed; the action text change is deterministic string
  composition covered by the action tests.
- **Audio** — N/A: no voice surface touched.
