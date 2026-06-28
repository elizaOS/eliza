# PR 9287 chat clear/swipe evidence

Generated on 2026-06-24 from the rebased PR branch with:

```bash
bun run --cwd packages/app test:e2e -- test/ui-smoke/chat-clear-swipe.spec.ts --project=chromium --project=mobile-chromium
E2E_RECORD=1 bun run --cwd packages/app test:e2e -- test/ui-smoke/chat-clear-swipe.spec.ts --project=chromium --project=mobile-chromium
```

Both commands passed 4/4 tests: the two chat clear/swipe flows on desktop Chromium and Pixel 7 mobile Chromium.

## What to verify

- `9287-swipe-no-undo-*.webm` and `9287-swipe-no-undo-*.png`: swiping navigates standup -> billing -> deploy -> billing, clearing creates/activates a fresh greeted chat, no `conversation-undo-toast` appears, and the non-empty billing conversation remains swipe-reachable.
- `9287-empty-draft-replace-*.webm` and `9287-empty-draft-replace-*.png`: clearing from a fresh greeting-only draft creates `FRESH START 2`, deletes the previous empty draft, and shows no undo toast.
- `*-trace.zip`: Playwright traces with action timeline, screenshots, console events, and network requests for the same runs.

## Evidence rows

- UI screenshots: attached here for both desktop and mobile flows.
- Video walkthrough: attached here for both desktop and mobile flows.
- Frontend logs/telemetry: enforced by the spec through `openAppPath` render telemetry checks and `expectNoPageDiagnostics` console/pageerror/requestfailed checks; trace zips are attached.
- Backend logs: N/A. This PR changes client UI behavior only; the e2e uses the live app with stateful network route mocks to prove the client contract.
- Real LLM trajectory: N/A. No agent prompt, model, provider, action, or evaluator behavior changed.
- Audio/voice walkthrough: N/A. No voice, transcript, TTS, or STT behavior changed.

Existing before evidence for the prior undo affordance remains in `.github/issue-evidence/8929-undo-toast.png` and `.github/issue-evidence/8929-fullstack-swipe-undo.mp4`; this PR's after evidence above proves the toast is removed and clear creates an active fresh chat.
