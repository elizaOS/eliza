# Onboarding fixes — cloud-login restart + local "not found" loop

Branch: `feat/multi-account-login-verification`
Device: MoonCycles — iPhone 16 Pro Max (A18), iOS 18.7.8. App: `ai.elizaos.app` (Eliza, built from `eliza/packages/app`).

## Fixes
- **Local "not found" loop** (commit `39391d35610`): the iOS local-agent JSContext kernel
  implemented `GET /api/first-run/status` but not `POST /api/first-run`, so `finishLocal`'s
  `submitFirstRun` hit the catch-all 404. The conductor turned that into a re-offer of the
  runtime chooser — the on-device "local path → not found → pick again" loop. Kernel now
  serves `POST /api/first-run` and acks the finish payload.
- **Cloud-login restart** (commit `314eb95cbc9`): external-browser OAuth backgrounds the
  WebView; iOS cold-launches the app on return, wiping in-memory flow state + the volatile
  auth-token global → onboarding restarted at the greeting. Now the cloud token is persisted
  to the durable steward-session channel on auth success, and a cloud-login resume marker
  (armed at cloud pick, cleared on completion/fresh-pick) rehydrates the interrupted flow on
  relaunch and continues into chat instead of re-seeding the greeting.

## Tests
26 unit/integration tests green (`first-run-cloud-resume` round-trip/validation; conductor:
marker-armed-on-pick, resume-on-relaunch-no-greeting-restart, cleared-on-fresh-local-pick;
kernel POST /api/first-run regression). typecheck + biome clean.

## On-device evidence (this dir)
- `01-fresh-onboarding-greeting-locked-composer.png` — pristine first-run: "where should your
  agent run?" chooser, composer LOCKED ("Tap a highlighted option above to continue").
- `02-local-onboarding-complete-composer-unlocked.png` — after On this device → On this device
  (recommended) → Skip for now: home launcher, composer UNLOCKED ("Ask Eliza",
  "Welcome — ask me anything to get started"). This transition requires POST /api/first-run to
  succeed — the local fix, proven on a fresh install (no "not found" loop).
- `03-local-done.png` — end of the local onboarding+chat+voice walkthrough.

Captured via the committed `BootCaptureUITests` XCUITest harness
(`bun run ios:device:capture --only-testing …/testLocalOnboardingChatAndVoice`) against a
wiped data container (uninstall → re-sign → install). XCUITest "failures" during the run are
the documented line-650 `launchWithRetry` FrontBoard terminate race + a voice recording-state
probe miss, not onboarding failures.

## Cloud path — remaining manual step
The cloud OAuth round-trip opens external Safari, which the XCUITest harness cannot drive (it
XCTSkips at the locked composer). Full end-to-end proof of the *restart* fix on-device requires
a human to complete the Safari sign-in; the unit/integration tests cover the resume logic.
