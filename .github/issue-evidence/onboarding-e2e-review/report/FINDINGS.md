# Android onboarding E2E review — findings (2026-07-02)

Device: Pixel 6a (`27051JEGR10034`), app `ai.elizaos.app`, installed build
`versionName=1.0.0`, **lastUpdateTime 2026-07-02 12:56** — ~2h older than PR
#11509 (merged 15:02). Review = 1 completed fable lane (options/labels, all
findings source-verified) + direct on-device capture + direct source reading
(the other fable lanes died on a Fable-5 credit limit; completed here on Opus).

Screenshots: `../screenshots/00-current-state.png` (cloud sign-in in a Chrome
Custom Tab, `elizacloud.ai/auth/cli-login?session=…`).

## The four reported symptoms

### 1. "I sign in, it comes back, and shows me sign in again" (session doesn't persist) — CRITICAL
Root cause (evidence-backed):
- On-device, Cloud sign-in runs in a **Chrome Custom Tab** at
  `https://elizacloud.ai/auth/cli-login?session=<uuid>` (confirmed via
  `dumpsys window`: `com.android.chrome/…CustomTabActivity`). That is the
  **legacy device-code fallback** (`useCloudState.ts:517`), not an in-app OAuth
  with a deep-link redirect. It is reached because the Steward in-app login
  surface (`launchStewardLogin` → `registeredLauncher`, `cloud-steward-login.ts`)
  is not mounted on this path, so the flow falls through to device-code.
- Device-code completion is an **in-memory `setInterval` poll**
  (`useCloudState.ts:627`) keyed by the session id. The token is delivered to the
  backend, not to the app's WebView localStorage; the app must poll to retrieve
  and store it.
- Issue **#11506** (already filed): `ai.elizaos.app` restarts every ~1–2 min and
  first-run state never persists across the fresh process. A restart during the
  Custom Tab flow kills the poll timer and drops the in-memory login state, so on
  return the new process has no token → the auth gate re-renders sign-in.
- `deep-link-handler.ts` only routes runtime *pre-selection*
  (`eliza://first-run/runtime/<id>`), NOT the auth-token return — so nothing
  recovers the token after the Custom Tab if the poll died.

Fix direction: (a) fix #11506 (stop the process churn / persist first-run + token
durably); (b) mount the Steward in-app login surface on Android so Cloud uses a
durable redirect instead of the fragile in-memory device-code poll; (c) make the
device-code poll resumable across a WebView reload/process restart (persist the
pending session id + re-arm the poll on boot). (a)+(b) are the real fix.

### 2. Third option says "Bring your own keys" — should not exist — HIGH (already fixed on develop)
- Pre-#11509 the conductor seeded `runtime:other=Bring your own keys` as a THIRD
  runtime-location chip — an inference-provider concept on the wrong axis.
- **PR #11509 (`d534de09f3`, merged 2026-07-02 15:02) removed it.** Current
  `use-first-run-conductor.ts:108-113` seeds only `runtime:cloud` + `runtime:local`;
  BYOK survives correctly as the provider sub-choice `provider:other` one step
  later.
- The device shows the old chip because its build predates #11509 → **stale-build
  artifact**. Action: rebuild + reinstall `ai.elizaos.app` from current develop
  (Capacitor bakes the web bundle into the APK — restarting the old app never
  picks up the fix). Any remaining sighting = stale build.

### 3. "Remote" should be the third option, with connection config in the widget — PRODUCT DECISION
- The runtime `remote` path is **fully plumbed** but **deliberately not offered in
  onboarding**: `use-first-run-conductor.ts:102-107` — "Remote agents +
  multi-instance management live in Settings → Runtime (post-#9952)." The connect
  form (URL + access token) lives at `RuntimeSettingsSection.tsx:282-320`
  (`handleConnectRemote` → `normalizeRemoteAgentUrl`).
- State machine + config already support it end to end: `first-run.ts` (step
  `remote`, `FirstRunRuntime "remote"`), `first-run-config.ts:171-179`
  (`{runtime:"remote", provider:"remote", remoteApiBase, remoteAccessToken}`),
  `deep-link-handler.ts` (`first-run/runtime/remote?api=<url>`).
- **The ask reverses the #9952 decision** (and the recorded onboarding-cleanup
  agreement "clean onboarding = Cloud + Local, remote in settings"). If restored:
  add `runtime:remote=Connect to a remote agent` to `RUNTIME_CHOICE`, extend the
  handler (`:479-510`) to accept `remote` and reveal the inline URL+token form
  (reuse `RuntimeSettingsSection`'s connect widget), and route through the
  existing `serverTarget:"remote"` config. Remote is a **terminal** branch (no
  provider sub-step — the remote agent owns its provider,
  `first-run-config.ts:27-28`).

### 4. Login widget appears twice in onboarding — HIGH (root-cause hypothesis)
Two independent login surfaces exist, and onboarding can show both:
- **In-chat OAuth block** — the conductor seeds a Cloud OAuth card into the
  transcript (`use-first-run-conductor.ts:140` `cloudOAuthSecretRequest`, kind
  `"oauth"`, turn id `first-run:cloud-oauth`) on the Cloud path.
- **Top-level `LoginView`** — `App.tsx:2396`, rendered whenever
  `authState.phase === "unauthenticated"` AND the gate is NOT bypassed. The gate
  is bypassed only while `startupCoordinator.phase === "first-run-required"`
  (`App.tsx:2362`; the phase is paintable per `startup-coordinator.ts:494`).

Two ways they overlap:
- **(a) Cloud-only / no first-run-required window.** If the app reaches an
  `unauthenticated` state that is not `first-run-required` (a cloud-only runtime
  mode, or the phase transitioning off `first-run-required` after the cloud pick
  while auth is still unresolved), the top-level `LoginView` mounts *and* the
  chat-overlay `FirstRunConductorMount` (`App.tsx:2329`, always mounted in the
  chat-overlay shell, self-gated on `firstRunComplete`) seeds the in-chat OAuth
  block — two login surfaces at once.
- **(b) Re-appearance mistaken for "twice."** The symptom-1 persistence failure
  makes the single login surface re-appear after the Custom Tab round-trip drops
  the token — which reads as "it showed me login twice."

Fix direction: make the top-level auth gate and the in-chat OAuth block mutually
exclusive during onboarding — i.e. keep the gate bypassed for the entire
first-run window (extend the `first-run-required` bypass, or suppress the in-chat
OAuth block whenever the top-level `LoginView` will render). Confirm on a current
build (needs the rebuild) which of (a)/(b) fires.

## Bonus finding — CI break left by #11509 (FIXED here → PR #11656)
Four `packages/app/test/ui-smoke` specs still asserted the deleted `runtime:other`
chip is *visible* (guaranteed-red on develop): `runtime-configurability.spec.ts`,
`first-run-startup.spec.ts`, `walkthrough/walkthrough-capture-smoke.spec.ts`,
`walkthrough/journey.ts`. Fixed to assert absence + corrected stale docs.

## Bonus finding — dead first-run step machine — LOW
`first-run.ts` step machine (`FIRST_RUN_STEPS`, `nextFirstRunStep`,
`applyFirstRunVoiceTranscript`, `load/savePersistedFirstRunState`,
`normalizeCloudOnlyFirstRunState`, …) has zero non-test consumers now that the
conductor is the live path. Cleanup candidate — but gated on the Remote decision
(#3), since restoring Remote may revive some of it (e.g. the only user-input path
that sets `draft.runtime="remote"` is `applyFirstRunVoiceTranscript:312-316`).

## Recommended order
1. **Rebuild + redeploy `ai.elizaos.app` from develop** → kills symptom 2 on device.
2. **Fix #11506** (process churn + first-run/token persistence) → the true fix for symptom 1.
3. **Decide Remote (symptom 3)** → implement restoration or keep in Settings.
4. **Root-cause + fix the double-login (symptom 4).**
5. Merge #11656 (spec red-fix, done). Dead-code cleanup last.
