# Onboarding, Auth & Help — QA Checklist

Scope: LoginView, CompactOnboarding (StartupScreen host), TutorialView, TutorialOverlay, HelpView, StartupFailureView, CloudHandoffBanner, ConnectionFailedBanner, ConnectionLostOverlay. Source paths under `packages/ui/src/`. Existing coverage grepped under `packages/ui/src/**/*.test.*`, `packages/ui/src/**/__e2e__/`, and `packages/app/test/ui-smoke/*.spec.ts`.

Legend for COVERAGE: `[covered:<path>]` = a committed test exercises it; `[GAP]` = no committed test found.

## LoginView

Rendered by `App.tsx` (~L2195) only when `authState.status === "unauthenticated"`; props `onLoginSuccess` (refetchAuth) + `reason` (`remote_auth_required` | `remote_password_not_configured`). Two faces: password form (`PasswordTab`) vs blocked info panel.

### Entry / Nav
- [ ] Reaching LoginView requires an unauthenticated auth probe — confirm it renders instead of the shell when `/api/auth/me` says unauthenticated. [covered:packages/app/test/ui-smoke/auth-startup.spec.ts]
- [ ] `reason="remote_password_not_configured"` renders the blocked panel (title "Remote access blocked", curl + localhost hints) NOT the password form. [GAP-unit] (app path via auth-startup remote flows only)
- [ ] `reason` undefined / `remote_auth_required` renders the password form (title "Sign in"). [GAP-unit]
- [ ] Fresh reload on the app URL while unauthenticated returns to LoginView (no partial shell flash). [covered:packages/app/test/ui-smoke/auth-startup.spec.ts]
- [ ] Successful login triggers `onLoginSuccess` → `refetchAuth` → shell mounts (no full page reload). [GAP-unit]

### Primary interactions
- [ ] Display-name Input round-trips typed value; `autoComplete="username"`, `type="text"`. [GAP]
- [ ] Password Input round-trips typed value; `type="password"` masks; `autoComplete="current-password"`. [GAP]
- [ ] "Remember this device for 30 days" checkbox toggles `rememberDevice` and is forwarded to `authLoginPassword`. [GAP]
- [ ] Submit button disabled until BOTH `displayName.trim()` and `password` are non-empty. [GAP]
- [ ] Submit calls `loginFn ?? authLoginPassword` with `{displayName: trimmed, password, rememberDevice}`. [GAP]
- [ ] Successful `result.ok !== false` sets phase `success` and calls `onLoginSuccess` exactly once. [GAP]
- [ ] `result.ok === false` renders the returned `result.message` in the `role="alert"` node; NO onLoginSuccess. [GAP]
- [ ] Thrown login (network) renders `err.message` or the `loginview.error.network` fallback. [GAP]
- [ ] Editing either field after an error clears the error (phase → idle). [GAP]
- [ ] Blocked panel: curl command + `http://localhost:31337/` codeblock are selectable/copyable text (not truncated by `break-all`). [GAP]

### State matrix
- [ ] Idle: button reads "Sign in", enabled only when valid. [GAP]
- [ ] Submitting: inputs + checkbox + button disabled, button reads "Signing in…". [GAP]
- [ ] Error: `role="alert"` visible with danger styling; form still editable. [GAP]
- [ ] Success: onLoginSuccess fires; no lingering spinner if shell swap is async. [GAP]
- [ ] Blocked (`remote_password_not_configured`): password form absent, `role="alert"` info panel present. [GAP]

### Repeated / rapid-fire
- [ ] Double-submit (Enter+Enter, or click while submitting) issues only ONE `authLoginPassword` call (button disabled during submit). [GAP]
- [ ] Mashing the disabled submit with empty fields issues zero calls. [GAP]
- [ ] Rapid toggle of Remember checkbox settles on final state and doesn't fire a login. [GAP]

### Back-and-forth / recovery
- [ ] Type a draft, background/reload the app → LoginView remounts empty (no persisted password draft — verify password is NOT restored). [GAP]
- [ ] Enter wrong password (error), then correct it and submit → succeeds; error cleared. [GAP]
- [ ] In-flight login, then reload mid-request → no orphaned success; back to clean form. [GAP]

### Fuzz / adversarial input
- [ ] Whitespace-only display name keeps submit disabled (trim guard). [GAP]
- [ ] Huge (10k char) password/display-name pasted: no layout break, submit still gated on presence. [GAP]
- [ ] Emoji / RTL / IME composition in display name round-trips and is trimmed correctly. [GAP]
- [ ] Injection-ish display name (`<script>`, `"; DROP`) is sent verbatim, rendered as text, never executed. [GAP]
- [ ] Invariant: onLoginSuccess only ever fires on `ok !== false`; never on error/throw. [GAP]

### Input modalities
- [ ] Tab order: display name → password → remember checkbox → submit. [GAP]
- [ ] Enter in either field submits the form (native form submit). [GAP]
- [ ] Labels are wired via `htmlFor`/`id` (click label focuses input). [GAP]
- [ ] Touch: 44px tap targets for checkbox + submit on mobile viewport. [GAP]

### A11y / geometry
- [ ] Inputs carry `aria-required="true"`; error node is `role="alert"` (assertive). [GAP]
- [ ] Focus visible on all controls; axe pass on both faces (form + blocked). [GAP]
- [ ] Submit hover is orange→darker-orange (default Button variant), never orange→black; no blue anywhere. [GAP]
- [ ] Blocked-panel code blocks are legible at high-DPI and wrap (`break-all`) without overflow. [GAP]

### Concurrency / races
- [ ] Login submit while a prior submit is still pending → second is blocked by disabled state (no double call, no double onLoginSuccess). [GAP]
- [ ] `reason` prop flips from undefined→`remote_password_not_configured` mid-view (auth re-probe) → panel swaps cleanly, no stale form state leak. [GAP]

## CompactOnboarding

First-run/onboarding surface hosted inside `StartupScreen` → `StartupShell` (view `firstRun`). Driven by `useFirstRunController()`. Steps: `runtime` (welcome/choice), `inference`, `remote`, `pick-agent`, plus cloud sign-in handoff. `cloudOnly` builds auto-start cloud. Overlay-shell variant (`?shellMode=onboarding-overlay`) calls `window.close()` on finish.

### Entry / Nav
- [ ] Fresh first-run (no saved runtime) renders the welcome/choice step with brand lockup, no orb. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Reset Everything wipes agent and returns here. [covered:packages/app/test/ui-smoke/reset-returns-to-onboarding.spec.ts]
- [ ] `cloudOnly` build (hosted app / cloud runtime) skips the picker and auto-hands-off to cloud sign-in on first paint, exactly once (ref-guarded). [GAP-unit] (logic in `cloudOnlyAutoStarted`; e2e via cloud-provisioning) [covered:packages/app/test/ui-smoke/cloud-provisioning-startup.spec.ts]
- [ ] Overlay-shell variant (`shellMode=onboarding-overlay`) closes its window after `finishRuntime`. [GAP]
- [ ] Tray action mapped to `cloud` (macOS tray → TRAY_ACTION_EVENT) triggers `chooseCloud`. [GAP]

### Primary interactions
- [ ] "Eliza Cloud" (recommended) card → `updateDraft(runtime,cloud)` + finish; lands in chat/handoff. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] "This device" card → `updateDraft(runtime,local)` + advances to inference step. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] "Advanced" quiet link → advances to remote step. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Inference step: "Cloud inference" → `localInference=cloud-inference` + finish. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Inference step: "On-device inference" → `localInference=all-local` + finish. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Inference step Back → returns to runtime choice. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Remote step: server-address input + access-token input round-trip into `draft.remoteApiBase`/`remoteToken`. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Remote Connect disabled until `remoteApiBase.trim()` non-empty; Enter in token field also finishes. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Remote Back → returns to runtime choice. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Cloud sign-in handoff: renders a real "Open sign-in page" button (from `cloudLoginFallbackUrl` or URL parsed out of `cloudError`), NOT raw text. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Pick-agent step forwards a row pick / create-new / retry / back to controller callbacks. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]

### State matrix
- [ ] Empty/first paint: welcome copy uses branded `appName`. [covered]
- [ ] Submitting (`busy`): all option cards + back links disabled. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] In-flight `busyText` shadows a stale `cloudError` in the status node. [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Idle error surfaces `error ?? cloudError` in `role="status"` polite node (unless it's a login URL → rendered as button). [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] `cloudOnly`: "This device" card gets `hidden` + disabled; Advanced link absent. [covered (partial):packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Populated pick-agent list vs zero agents (create-new only) both render. [covered:packages/ui/src/first-run/AgentPicker.test.tsx]

### Repeated / rapid-fire
- [ ] Double-tap "Eliza Cloud" issues only one finish (busy disables cards). [covered (disable-while-submitting):packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Mash local→cloud→local cards before a finish resolves: final draft matches last tap, one provision. [GAP]
- [ ] Spam remote Connect with empty address: zero finishes (disabled). [covered (disabled gating):packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Rapid Back/forward between runtime↔inference↔remote doesn't leak `remoteApiBase` draft into a cloud finish. [GAP]

### Back-and-forth / recovery
- [ ] Enter remote address, Back to runtime, re-open remote → draft persists (controller-held). [GAP]
- [ ] Cloud sign-in handoff, background the app to complete sign-in in browser, resume → returns and proceeds (or shows retry). [GAP] (e2e-ish only)
- [ ] Failed cloud finish → error shown, choosing a different runtime still works. [GAP]

### Fuzz / adversarial input
- [ ] Remote address paste of a non-URL / whitespace-only: Connect stays gated on `.trim().length`. [covered (trim gating):packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Huge/emoji/RTL access token round-trips; masked; sent verbatim. [GAP]
- [ ] `cloudError` containing multiple URLs → only the first `https?://\S+` becomes the button target. [GAP]
- [ ] Invariant: exactly one runtime provision per completed flow (no dup from auto-start + manual). [GAP]

### Input modalities
- [ ] Remote address input `autoFocus` on entering remote step; `inputMode=url`, no autocapitalize/correct. [GAP]
- [ ] Enter in token field finishes (keydown handler). [covered:packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Touch: option cards ≥44px, `active:scale` feedback; motion-reduce disables scale. [GAP]
- [ ] Keyboard: Tab reaches cards → back link → advanced link in order. [GAP]

### A11y / geometry
- [ ] Status node is `role="status" aria-live="polite" aria-atomic` (TalkBack announces progress/errors). [covered (presence):packages/ui/src/first-run/CompactOnboarding.test.tsx]
- [ ] Onboarding screenshot audit: orange accent only, white primary card, no blue. [covered:packages/ui/src/first-run/__e2e__/run-onboarding-e2e.mjs]
- [ ] axe pass on each step (runtime/inference/remote/pick-agent/cloud-signin). [GAP]
- [ ] Reduced-motion: `shell-overlay-in` animation + card scale suppressed. [GAP]

### Concurrency / races
- [ ] `cloudOnly` auto-start racing a manual tap: `cloudOnlyAutoStarted` ref prevents a second handoff. [GAP]
- [ ] Tray `cloud` action arriving mid-remote-step doesn't double-finish. [GAP]

## TutorialView (launcher tile / tour start screen)

Route: tab `tutorial` → `/tutorial` (TAB_PATHS). Lazy `TutorialView`. Single "Start" button → `startTutorial()` + `setTab("chat")`.

### Entry / Nav
- [ ] Reached via `/tutorial` route and via the home "Tutorial" tile. [covered:packages/app/test/ui-smoke/tutorial-help-views.spec.ts]
- [ ] Help deep-link "Take the 90-second tour" / "Start the tutorial" starts the tour (via `link.startTutorial`). [covered:packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]
- [ ] Fresh reload on `/tutorial` renders the launcher (not the overlay). [GAP]
- [ ] Back button from tutorial returns to prior tab. [GAP]

### Primary interactions
- [ ] "Start" button calls `startTutorial()` (overlay becomes active) AND `setTab("chat")` so the tour spotlights the real chat. [covered:packages/app/test/ui-smoke/tutorial-help-views.spec.ts]
- [ ] `useAgentElement` id `tutorial-start` is agent-activatable and mirrors the click. [covered (surface inventory):packages/app/test/ui-smoke/shell-view-agent-bridge-inventory.spec.ts]

### State matrix
- [ ] Static content only — no empty/loading/error states; renders identically regardless of auth. [GAP]

### Repeated / rapid-fire
- [ ] Double-tap Start: `startTutorial()` resets to step 0 idempotently (no dup overlay). [GAP]
- [ ] Start tour, stop, Start again from tile → re-runs from step 0 (COMPLETED_KEY doesn't block re-run). [covered (re-runnable):packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]

### Back-and-forth / recovery
- [ ] Start → navigate away mid-tour → tour overlay persists (it's a global overlay, not the tab). [covered:packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]

### Input modalities / A11y
- [ ] Start button hover orange→darker-orange (Button default), 44px, focus-visible, Enter activates. [GAP]

## TutorialOverlay (interactive tour engine)

Always mounted in `App.tsx` inside shell controller. Activates on `startTutorial()`. Drives real chat state, narrates via `TutorialNarrator`, samples live UI (detent/composer/transcript/tab/conversation), auto-advances, applies `setNavLock`, restores chat on exit. 9 steps.

### Entry / Nav
- [ ] Overlay only renders when `active && step` (null otherwise); never auto-launches for a first-timer. [covered:packages/app/test/ui-smoke/tutorial-help-views.spec.ts]
- [ ] End-to-end tour runs all frames with real gestures + real voice. [covered:packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]
- [ ] Isolated e2e fixture drives the overlay steps. [covered:packages/ui/src/components/pages/tutorial/__e2e__/run-tutorial-e2e.mjs]
- [ ] Step model is well-formed (ids, selectors, isDone). [covered:packages/ui/src/components/pages/tutorial/tutorial-steps.test.ts]

### Primary interactions / auto-advance
- [ ] Each frame's `isDone(observable)` auto-advances on the real user action (type prefill, expand chat, switch tab, new chat, swipe, voice). [covered:packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]
- [ ] `prefill` frame dispatches `tutorial-chat-control prefill`; `enterChat` dispatches the detent action. [GAP-unit]
- [ ] `navigateOnDone` performs the staged `setTab` only on THIS step's success (guarded by step id). [GAP-unit]
- [ ] `setNavLock(step.lockTabs ?? ["chat"])` restricts nav during the frame and clears on exit. [GAP-unit]
- [ ] Mute toggle calls `unlockAudio` + flips narrator muted; no more narration when muted. [GAP]
- [ ] "Skip" appears only after `LATE_SKIP_SEC` (14s stall) OR when `manualContinue`; advances/stops. [GAP]
- [ ] Last step's continue label is "Done" and stops the tour. [covered:packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]
- [ ] `stopTutorial()` sets `COMPLETED_KEY=1` so it never auto-nags again. [covered (no-auto-launch):packages/app/test/ui-smoke/tutorial-help-views.spec.ts]

### State matrix
- [ ] Two-beat frames (`beat2`) advance beat 1→2 before completing. [GAP-unit]
- [ ] `doneStepId === step.id` shows `doneBody` + removes dim (`dimOutside=false`) for SUCCESS_BEAT_MS then advances. [GAP-unit]
- [ ] Target selector missing (spotlight can't find element) degrades gracefully (no crash). [GAP]

### Repeated / rapid-fire
- [ ] Rapidly performing the frame action multiple times fires success once (doneStepId set once, interval cleared). [GAP]
- [ ] Skip mashed at frame boundary doesn't skip two frames. [GAP]

### Back-and-forth / recovery
- [ ] Cancel the tour on the "open chat" frame → chat is reset to interactive (composer not left `inert`/pill). [covered (reset on exit intent):packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]
- [ ] Nav-lock is cleared on unmount/stop (user can navigate freely after). [GAP-unit]
- [ ] Background app mid-tour and resume: sampling interval survives / re-attaches; no stuck frame. [GAP]

### Fuzz / adversarial
- [ ] User navigates to a locked tab via deep-link mid-frame → nav-lock blocks the drift. [GAP]
- [ ] Composer text edited to match prefill then cleared → `prefillSent` detects send correctly. [GAP-unit]
- [ ] Invariant: a prior frame's success never triggers the NEXT frame's `navigateOnDone` (step-id guard). [GAP-unit]

### A11y / geometry
- [ ] Spotlight dim + card readable; reduced-motion suppresses transitions. [GAP]
- [ ] Narrator respects muted; audio unlock on first user gesture. [GAP]

### Concurrency / races
- [ ] Sampling interval (200ms) reads live refs (tab/transcript) — never a stale closure value. [GAP-unit]
- [ ] Staged navigation completing while a new frame is entering doesn't double-fire. [GAP-unit]

## HelpView

Route: tab `help` → `/help` (TAB_PATHS). Lazy `HelpView`. No own search box — takes over the chat composer (placeholder "Ask a question about Eliza…") via `useRegisterViewChatBinding`; typing scores `HELP_ENTRIES`. Entries expand/collapse; some deep-link to tabs/settings-sections/start-tutorial.

### Entry / Nav
- [ ] Reached via `/help` route and the home "Help" tile (pinned to home). [covered:packages/app/test/ui-smoke/tutorial-help-views.spec.ts]
- [ ] Fresh reload on `/help` renders the list with the chat composer rebound to the Help placeholder. [GAP]
- [ ] Deep-link `startTutorial` → starts tour + `setTab("chat")`. [covered:packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]
- [ ] Deep-link `settingsSection` → sets `window.location.hash` + `setTab("settings")` (e.g. ai-model, runtime). [GAP]
- [ ] Deep-link `tab` (views/settings) → `setTab(link.tab)`. [GAP]
- [ ] Back button returns to prior tab; chat binding is released on leave. [GAP]

### Primary interactions
- [ ] Typing a question in the floating chat filters `results` by `scoreEntry` (question=3, keyword=2, hay=1; every token must match). [covered:packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]
- [ ] Best top match auto-expands as you type, but a manual close is not re-fought (only re-opens when top match changes). [GAP-unit]
- [ ] Clicking an entry header toggles expand/collapse (`aria-expanded` + chevron rotate). [covered (via walkthrough):packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]
- [ ] Deep-link button inside an expanded entry navigates via `navigate(link)`. [GAP]
- [ ] `useAgentElement` ids `help-entry-<id>` / `help-link-<id>` are agent-activatable (status expanded/collapsed). [covered (surface inventory):packages/app/test/ui-smoke/shell-view-agent-bridge-inventory.spec.ts]

### State matrix
- [ ] Empty query → all entries shown (scoreEntry returns 1). [GAP-unit]
- [ ] No-match query → `ChatEmptyStateWithRecommendations` with the 3 recommendation chips. [covered (empty via search):packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts]
- [ ] Populated results sorted by descending score. [GAP-unit]
- [ ] Long answer content wraps and scrolls within the entry (overflow-y-auto container). [GAP]

### Repeated / rapid-fire
- [ ] Rapid-toggle one entry open/close many times → settles, no double-open, no latched chevron. [GAP]
- [ ] Type/clear query rapidly → auto-expand tracks the top match without thrashing (lastTopRef guard). [GAP]

### Back-and-forth / recovery
- [ ] Open an entry, navigate to Settings via deep-link, return to Help → query/openId reset cleanly (fresh mount). [GAP]
- [ ] Leave Help mid-typing → chat composer placeholder reverts (binding unregistered). [GAP]

### Fuzz / adversarial
- [ ] Whitespace-only query → treated as empty (all entries), no crash. [GAP-unit]
- [ ] Huge / emoji / RTL / injection query: scoring tokenizes safely; results render as text. [GAP]
- [ ] Query with regex-special chars (`.*`, `(`) doesn't break `split(/\s+/)` scoring. [GAP-unit]
- [ ] Invariant: every visible result has `score > 0` and every token matched somewhere. [GAP-unit]

### Input modalities / A11y
- [ ] Entry headers are `<button>` with `aria-expanded`; keyboard Enter toggles; Tab order top→bottom. [GAP]
- [ ] Deep-link Button hover orange→darker-orange; 44px targets; focus-visible. [GAP]
- [ ] axe pass on empty + populated + expanded states. [GAP]

### Concurrency / races
- [ ] Deep-link navigation firing while chat still holds the Help binding → target view rebinds/clears composer correctly (no dangling "Ask a question" placeholder on the new view). [GAP]

## StartupFailureView

Rendered by `StartupShell` when `useStartupShellController` yields a failure view. Reason-driven copy (backend-timeout/-unreachable, agent-timeout/-error, asset-missing, unknown). Buttons: Retry, Report a bug (optional), and for `backend-unreachable`: Choose Eliza Cloud + Start over + Open App.

### Entry / Nav
- [ ] Unreachable saved backend renders the cloud-first recovery layout. [covered:packages/ui/src/components/shell/StartupFailureView.test.tsx]
- [ ] Unavailable auth probe shows startup failure instead of password sign-in. [covered:packages/app/test/ui-smoke/auth-startup.spec.ts]
- [ ] Each `reason` maps to its labeled title (`startupReasonLabel`). [GAP-unit] (only unreachable asserted)
- [ ] Fresh reload while startup still failing re-renders the failure view. [GAP]

### Primary interactions
- [ ] "Retry Startup" (`startup-retry`) calls `onRetry`. [covered (button present):packages/ui/src/components/shell/StartupFailureView.test.tsx]
- [ ] backend-unreachable: "Choose Eliza Cloud" (`startup-use-cloud`) → `startFreshFirstRunReload()`. [covered:packages/ui/src/components/shell/StartupFailureView.test.tsx]
- [ ] backend-unreachable: "Start over" (`startup-start-over`) → `startFreshFirstRunReload()`. [GAP-unit]
- [ ] backend-unreachable: "Open App" (`startup-open-app`) is an `<a href=branding.appUrl target=_blank rel=noreferrer>`. [GAP-unit]
- [ ] "Report a bug" (`startup-report-bug`) opens BugReportModal seeded with the startup draft (reason/phase/status/path/detail logs). [GAP]
- [ ] `error.detail` renders in a scrollable `<pre>` (max-h-60) only when present. [GAP-unit]

### State matrix
- [ ] backend-unreachable → 4 buttons (cloud/retry/start-over/open-app + maybe bug). [covered (partial):packages/ui/src/components/shell/StartupFailureView.test.tsx]
- [ ] non-unreachable reason → Retry is primary; no cloud/start-over/open-app buttons. [GAP-unit]
- [ ] `useOptionalBugReport()` absent → bug button hidden (no crash). [GAP]
- [ ] Long `error.detail` (stack) scrolls without breaking the card. [GAP]

### Repeated / rapid-fire
- [ ] Mash Retry → each click calls `onRetry`; controller must dedupe/guard re-entrant startup (verify no dup startup). [GAP]
- [ ] Double "Choose Eliza Cloud" → single `startFreshFirstRunReload` (or idempotent reload). [GAP]

### Back-and-forth / recovery
- [ ] Retry succeeds → shell mounts (failure view unmounts). [covered (path):packages/app/test/ui-smoke/auth-startup.spec.ts]
- [ ] Retry fails again → same failure view with updated reason/detail. [GAP]

### Fuzz / adversarial
- [ ] `error.message`/`detail` with huge text / newlines / injection → rendered as text in `<pre>` (`whitespace-pre-wrap break-words`), never executed, no overflow. [GAP]
- [ ] `error.status` non-number omitted from the bug draft logs (filter(Boolean)). [GAP-unit]

### Input modalities / A11y
- [ ] Reason icon has `role="img"` + `aria-label`/`title`; title heading is `text-destructive`. [GAP-unit]
- [ ] All buttons ≥44px, focus-visible, keyboard reachable; Open App link focusable. [GAP]
- [ ] axe pass; danger/destructive colors only (no blue); hover states legal. [GAP]

## CloudHandoffBanner

Floating toast pill (z-9999). Driven by `useCloudHandoffPhase()`. Phases: migrating/switched/switched-empty/timed-out/failed → phase-specific copy; failure phases show a Retry that dispatches `dispatchCloudHandoffRetry({agentId})`. Self-dismisses.

### Entry / Nav
- [ ] Returns null when no handoff active (not in DOM). [covered (hook):packages/ui/src/hooks/useCloudHandoffPhase.test.tsx]
- [ ] Appears during shared→dedicated cloud agent provisioning. [covered:packages/app/test/ui-smoke/cloud-provisioning-startup.spec.ts]

### Primary interactions
- [ ] `migrating` shows a `--warn` Spinner + "Setting up your dedicated agent — you can keep chatting." [GAP-unit]
- [ ] `switched`/`switched-empty` shows a `--ok` Check + "You're now on your dedicated agent." [GAP-unit]
- [ ] `timed-out`/`failed` show the respective copy + a Retry button (`cloud-handoff-retry`). [GAP-unit]
- [ ] Retry dispatches `dispatchCloudHandoffRetry` with the current `agentId`. [GAP]
- [ ] Self-dismiss on success timer (via useCloudHandoffPhase). [covered (hook dismiss):packages/ui/src/hooks/useCloudHandoffPhase.test.tsx]

### State matrix
- [ ] Each of 5 phases renders correct icon (spinner/check/none) + message. [GAP-unit]
- [ ] Long agent context truncates (`truncate`, `max-w-[88%]`) without pushing off-screen. [GAP]
- [ ] While chat overlay (orange bg) is up, the dark pill (rgba(22,22,30,.96)) reads cleanly above it (z-9999). [GAP]

### Repeated / rapid-fire
- [ ] Mash Retry on failed handoff → each dispatch is one event; no dup supervisor spawn (verify dedupe downstream). [GAP]
- [ ] Rapid phase flips migrating→switched→(new)migrating render the latest phase only. [GAP]

### Back-and-forth / recovery
- [ ] Navigate views while migrating → banner persists (mounted at shell root), phase unaffected. [GAP]
- [ ] Background/resume during migration → phase reconciles to the real handoff state on resume. [GAP]

### A11y / geometry
- [ ] `role="status" aria-live="polite"` announces the phase change. [GAP-unit]
- [ ] Retry ghost button ≥ tappable, focus-visible, hover `white/10` (neutral, not orange→black). [GAP]
- [ ] safe-area-top offset keeps the pill below the status bar on mobile/notch. [GAP]

## ConnectionFailedBanner

In-flow top banner (pushes header/content down). Driven by shallow app-selector: `backendConnection`, dismissed flag, dismiss/retry actions. Renders `reconnecting` (warn spinner + attempt count) or `failed` (danger + Dismiss + Retry). Hidden when `showDisconnectedUI` (the full overlay owns that).

### Entry / Nav
- [ ] Null when no `backendConnection`. [GAP]
- [ ] Null when `showDisconnectedUI` is true (ConnectionLostOverlay takes over). [GAP]
- [ ] Renders during WS reconnection in the real app. [GAP] (no committed spec found referencing this banner)

### Primary interactions
- [ ] `reconnecting` shows warn-bg banner, spinner, and live `reconnectAttempt/maxReconnectAttempts` count. [GAP]
- [ ] `failed` (not dismissed) shows danger banner with "Connection lost after N attempts" copy. [GAP]
- [ ] "Dismiss" calls `dismissBackendDisconnectedBanner` → banner hides. [GAP]
- [ ] "Retry Connection" calls `retryBackendConnection`. [GAP]
- [ ] `failed` + already dismissed → returns null. [GAP]

### State matrix
- [ ] State transitions reconnecting→failed→(dismissed=null) render correctly. [GAP]
- [ ] Attempt count updates each retry (1/5, 2/5 …). [GAP]

### Repeated / rapid-fire
- [ ] Mash Retry → each triggers one `retryBackendConnection` (verify no dup socket storms). [GAP]
- [ ] Dismiss then re-fail → banner re-appears only if dismissed flag reset by a new failure cycle. [GAP]
- [ ] Rapid reconnecting↔failed flapping doesn't leave a latched spinner. [GAP]

### Back-and-forth / recovery
- [ ] Reconnect succeeds mid-banner → banner unmounts (no stale "reconnecting"). [GAP]
- [ ] Dismiss, navigate away, return → still dismissed for the same failure. [GAP]

### A11y / geometry
- [ ] `reconnecting` is `role="status" aria-live="polite"`; `failed` is `role="alert" aria-live="assertive"`. [GAP]
- [ ] `data-window-titlebar-banner` present so desktop titlebar offsets correctly. [GAP]
- [ ] Spinner has `aria-label` (t("aria.reconnecting")); text truncates without overflow. [GAP]
- [ ] Danger banner uses danger tokens (no blue); Retry secondary button legible on danger bg. [GAP]

### Concurrency / races
- [ ] Retry firing while a reconnect attempt is already in-flight is coalesced (state stays consistent). [GAP]

## ConnectionLostOverlay

Full-screen modal (`role="alertdialog" aria-modal`) shown only when `state==="failed" && showDisconnectedUI`. Restart (relaunchDesktop on Electrobun else `window.location.reload`) + Retry Connection. `busy` latch prevents re-entrant restart.

### Entry / Nav
- [ ] Renders only when failed AND `showDisconnectedUI` (else null). [GAP]
- [ ] Blocks the shell (fixed inset-0, z-1001, bg-bg/80) — underlying UI not interactable. [GAP]

### Primary interactions
- [ ] Restart on desktop runtime (`isElectrobunRuntime`) awaits `relaunchDesktop()`. [covered (relaunch path):packages/app/test/electrobun-packaged/electrobun-relaunch.e2e.spec.ts]
- [ ] Restart on web reloads via `window.location.reload()`. [GAP]
- [ ] Button label is "Restart App" (desktop) vs "Restart" (web); shows "Restarting..." while busy. [GAP]
- [ ] "Retry Connection" calls `retryBackendConnection` (not gated by busy except during restart). [GAP]
- [ ] Attempts-exhausted body interpolates `maxReconnectAttempts`. [GAP]

### State matrix
- [ ] Idle: both buttons enabled. [GAP]
- [ ] busy="restart": both buttons disabled, primary shows "Restarting...". [GAP]

### Repeated / rapid-fire
- [ ] Mash Restart → `if (busy) return` guard fires only one relaunch/reload. [GAP]
- [ ] Restart then Retry rapidly → Retry blocked while busy (disabled). [GAP]

### Back-and-forth / recovery
- [ ] Retry succeeds → overlay unmounts (connection restored). [GAP]
- [ ] Restart fails to relaunch → busy resets in `finally`, buttons re-enable. [GAP]

### A11y / geometry
- [ ] `role="alertdialog" aria-modal="true" aria-labelledby=connection-lost-title`; focus trapped in dialog. [GAP]
- [ ] Danger title color; no blue; buttons ≥44px; focus-visible; Escape does NOT dismiss (unrecoverable state). [GAP]
- [ ] axe pass in modal state; high-DPI card layout intact. [GAP]

### Concurrency / races
- [ ] Retry Connection while a restart is pending is blocked (disabled `busy!==null`). [GAP]
- [ ] `showDisconnectedUI` flips false (reconnected) while restarting → overlay unmounts cleanly, no orphaned reload. [GAP]

## Coverage summary

| View | Existing test path(s) | Biggest gap |
| --- | --- | --- |
| LoginView | packages/ui/src/components/auth/__tests__/authcomp-stories-smoke.test.tsx (story smoke only); packages/app/test/ui-smoke/auth-startup.spec.ts (startup/pairing paths, not the password form) | No unit test for `PasswordTab` at all — submit call, error/success/remember-device, disabled gating, and the `remote_password_not_configured` blocked panel are entirely unverified. |
| CompactOnboarding | packages/ui/src/first-run/CompactOnboarding.test.tsx (13 tests); __e2e__/run-onboarding-e2e.mjs; app onboarding-to-home*.spec.ts, cloud-provisioning-startup.spec.ts | `cloudOnly` auto-start ref-guard, overlay-shell `window.close()`, and tray-action→cloud paths untested; no idempotency test for interleaved card taps. |
| TutorialView | packages/app/test/ui-smoke/tutorial-help-views.spec.ts, tutorial-help-walkthrough.spec.ts | Trivial launcher — only gap is double-tap idempotency + a11y hover; low risk. |
| TutorialOverlay | packages/app/test/ui-smoke/tutorial-help-walkthrough.spec.ts (e2e), __e2e__/run-tutorial-e2e.mjs, tutorial-steps.test.ts | No unit test for the step-id guard on `navigateOnDone`, nav-lock apply/clear, two-beat advance, or the 200ms live-ref sampling — all race-prone logic only covered by one heavy e2e. |
| HelpView | packages/app/test/ui-smoke/tutorial-help-views.spec.ts, tutorial-help-walkthrough.spec.ts | No unit test for `scoreEntry`/ordering/auto-expand-lastTopRef, and deep-link `settingsSection`/`tab` navigation is unverified (only startTutorial link is e2e'd). |
| StartupFailureView | packages/ui/src/components/shell/StartupFailureView.test.tsx (1 test: unreachable); packages/app/test/ui-smoke/auth-startup.spec.ts | Only backend-unreachable branch tested; the other 5 reasons, the bug-report draft builder, Start-over/Open-App buttons, and `error.detail` rendering are untested. |
| CloudHandoffBanner | packages/ui/src/hooks/useCloudHandoffPhase.test.tsx (hook only); packages/app/test/ui-smoke/cloud-provisioning-startup.spec.ts | No component-level test — none of the 5 phase renders, the Retry dispatch, or the icon/color mapping are asserted. |
| ConnectionFailedBanner | none found | Zero coverage — reconnecting vs failed vs dismissed, attempt count, Dismiss/Retry actions, and the `showDisconnectedUI` handoff to the overlay are completely untested. |
| ConnectionLostOverlay | packages/app/test/electrobun-packaged/electrobun-relaunch.e2e.spec.ts (relaunch path, indirect) | Zero direct test — the busy-latch idempotency guard on Restart, web-reload branch, alertdialog focus-trap, and Retry-while-restarting gating are unverified. |

**Single biggest gap in this group:** the three connection-recovery surfaces plus CloudHandoffBanner have essentially no component-level coverage — `ConnectionFailedBanner` and `ConnectionLostOverlay` have **zero** tests despite being the app's last line of defense during backend loss, and their idempotency guards (single-flight restart, dismiss latch, retry-while-busy) are exactly the race-prone logic a QA suite must pin.
