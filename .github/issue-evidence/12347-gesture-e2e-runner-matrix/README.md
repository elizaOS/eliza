# #12347 — Unified gesture e2e runner + CHAT_GESTURE_COVERAGE matrix

Evidence for migrating the copied packages/ui shell gesture e2e runners onto the
shared `packages/ui/src/testing/e2e-runner/` toolkit, plus the CHAT_GESTURE_COVERAGE
matrix doc + pinned-roster gate.

## Files

- `run-chat-sheet-e2e.log` — migrated chat-sheet runner, isolated run (189 real
  assertions, 56 screenshots, no page errors). Composes the shared lower-level
  helpers (bespoke multi-page/multi-viewport runner).
- `run-chatux-gesture-e2e.log` — migrated chatux TopicGroup gesture runner
  (video + screenshots via `runBrowserFixtureE2E`).
- `run-conversation-swipe-e2e.log` — migrated conversation-swipe interleaving
  runner, isolated run (video + screenshots via `runBrowserFixtureE2E`).
- `chat-gesture-coverage-gate.log` — the boot-free coverage gate, 6/6 passing.
- `chat-gesture-coverage-gate-NEGATIVE.log` — the gate FAILING when a synthetic
  shell component wires a gesture primitive without a matrix row (the #12188
  phase-1 acceptance criterion: "CI fails when a covered handler site is added
  without a matrix row").
- `run-conversation-swipe-DEVELOP-baseline-same-flake.log` — develop's UNMODIFIED
  conversation-swipe runner failing at the exact same `waitForFunction` step as
  the migrated runner under machine load. Proves the migration is
  behavior-preserving: the launcher-passthrough `screenDrag` step is a
  pre-existing load-sensitive flake in the develop runner, not introduced here.
  Both runners pass cleanly when run alone.

Note: the e2e runners are timing-sensitive (real spring animations); they must be
run one-at-a-time — concurrent headless-Chromium runs starve the animation clock
and flake velocity/flick assertions. Each PASS log here is an isolated run.
