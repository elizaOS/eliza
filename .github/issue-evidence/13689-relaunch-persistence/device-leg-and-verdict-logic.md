# #13689 — device relaunch-persistence leg + off-device verdict logic

This complements the merged web/agent server-truth leg (see `README.md`, PR
#14006, which extracted `restoreConversationsFromDb` and tested it against a real
migrated PGlite DB). That covered item 4 (the agent-DB round trip). This adds the
**Android on-device app-relaunch leg** (item 2 surface) and the **pure verdict
logic** shared by every surface.

## What this adds

1. **`packages/app/scripts/lib/chat-history-persistence.mjs`** — the pure
   accept/reject verdict for the relaunch-persistence property, verifiable
   off-device so it can never false-green:
   - `buildRelaunchMarker(...)` — a unique-per-run marker (`RELAUNCH-PERSIST-<platform>-<runId>-<ts>-<rand>`), so residue from a prior run (the exact `GestureSemanticsUITests` pollution the issue cites) cannot satisfy the check.
   - `extractMessageTexts(body)` — fail-fast parse of the real `GET /api/conversations/:id/messages` body (`{ messages: [{ role, text }] }`). A malformed body **throws** (#9324 doctrine: THROW, never fabricate); only a well-formed `{ messages: [] }` is a legitimately empty thread.
   - `assertMarkerSurvivedRelaunch({ marker, beforeBody, afterBody })` — asserts the marker reached server truth **before** relaunch (guards a broken send) and survived **after** relaunch. An empty/lost thread after relaunch (fresh state dir) throws `MARKER_LOST_ON_RELAUNCH` — the negative check the issue's "Done when" requires.

2. **`--relaunch-persistence`** in `packages/app/scripts/mobile-local-chat-smoke.mjs`
   (lane `test:sim:local-chat:android:relaunch-persistence`). After the verified
   turn it: creates a fresh conversation → sends the unique marker through the
   real streamed chat endpoint (`POST /api/conversations/:id/messages/stream`)
   with the same deterministic local-model reply gate used by the Android smoke
   turn → `GET /messages` (before) → `am force-stop` + cold `am start` so
   `ElizaAgentService` re-boots against the **same on-device SQLite DB** →
   re-acquires the forwarded API + waits for process stability → `GET /messages`
   (after) → `assertMarkerSurvivedRelaunch` → Android accessibility hierarchy
   dump must expose the marker or deterministic reply after relaunch. Pre/post
   screenshots, UI hierarchy dump, live-stream usage, and the after-relaunch
   server thread are written to
   `packages/app/test-results/relaunch-persistence/android-<id>.json`.

   iOS (in-process IPC-only agent, no HTTP the harness can reach) and `--api-base`
   (the harness does not own the process) surface an explicit **N/A with reason**
   rather than a silent skip.

## Verification (this environment: headless, no emulator)

- **Verdict logic — enforced vitest lane (`packages/app`):** `verdict-logic-vitest.txt` — **11/11 passing**.
  ```bash
  bun run --cwd packages/app test -- scripts/lib/chat-history-persistence.test.mjs
  ```
- **Verdict logic — independent `node --test`** (no vitest, proves the module standalone on a disk-contended host): `verdict-logic-node-test.txt` — **7/7 passing**.
- **Script wiring:** `node --check scripts/mobile-local-chat-smoke.mjs` (syntax) + `--help` reflects the new flag. Biome clean on all three files.

## N/A (device/live-infra — wired to real scripts, not run here)

- **Android on-device leg execution:** needs a booted emulator with the app
  installed (`test:sim:local-chat:android:relaunch-persistence`). Wired to real
  `adb` / `am force-stop` / forwarded HTTP stream+`GET /messages` and rendered
  Android UI-hierarchy proof; not runnable on this headless host.
- **iOS leg:** the on-device agent is IPC-only; its relaunch check needs the
  Preferences-handshake / XCUITest path (issue item 1) — surfaced as N/A.
- **Web nightly live-walkthrough (item 4 second half):** belongs to the
  `app-live-e2e` lane against a real backend agent.
