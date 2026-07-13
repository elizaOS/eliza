# In-chat onboarding status

First-run onboarding now renders in the real `ChatOverlay` over the
normal app shell. The old full-screen first-run gate, `FirstRunChat` surface,
and standalone runtime chooser are no longer part of the shipped UI.

The current first-run flow is seeded by `use-first-run-conductor.ts` as inline
chat choices:

- `choice-__first_run__:runtime:{cloud|local}` (the runtime location is a clean
  two-option chooser as of #11509; "Bring your own keys" is not a location — it
  lives on the provider axis below. Remote lives in Settings → Runtime post-#9952.)
- `choice-__first_run__:provider:{on-device|elizacloud|other}`
- `choice-__first_run__:autostart:{enable|skip}` (wrap-up only, platform-gated
  — see "Auto-start step" below)
- `choice-__first_run__:tutorial:{start|skip}`

Those choices route into the headless first-run finish path and produce a single
`POST /api/first-run`. Tests should assert the real chat overlay plus transcript
choices and should keep negative assertions for deleted surfaces such as
`first-run-runtime-chooser`, `first-run-chat`, and
`startup-first-run-background`.

Current end-to-end evidence is attached inline to the issue/PR from the
Playwright artifact tree (`test-results` / per-test output): JPG screenshots,
recordings when enabled, and the relevant console/network excerpts. Specs should
not write repo-local evidence folders.

## The onboarding surface (#9952 → relaxed by #12178)

While first-run is pending, the shell passes `firstRunOpen={firstRunComplete
=== false}` to `ChatOverlay` (`App.tsx`). `firstRunOpen` turns the
overlay into a **full-screen onboarding surface** — the chat is the first
painted surface over the shared wallpaper, and it cannot be dismissed until
onboarding completes. The composer remains locked until cloud sign-in, so the
choice turn is the only pre-auth input. The contract, enforced in
`ChatOverlay.tsx` and covered by `ChatOverlay.firstrun.test.tsx`:

- **Opens pinned at FULL.** Initial detent is `full` when `firstRunOpen`; a
  falling-edge-guarded effect re-pins to FULL on every change while
  `firstRunOpen` is true, so nothing can step it down.
- **Wallpaper-only backdrop.** While `firstRunOpen`, a neutral scrim
  (`data-testid="chat-first-run-backdrop"`) sits above the shared wallpaper and
  below the transparent full-screen chat surface. The retained home/launcher
  surface is `visibility:hidden`, so no clock, widget, notification, or app tile
  leaks through while the wallpaper remains visible.
- **Composer is locked.** The textarea is disabled with the placeholder
  "Sign in to start chatting". Attach, mic, push-to-talk, slash commands, and
  free-text sends remain unavailable until onboarding completes; the first-run
  CHOICE widget is the only interactive input.
- **Undismissable.** Every collapse path is a no-op while `firstRunOpen`:
  `collapse()` (the single funnel for Escape on document/thread/composer,
  outside-tap, and the grabber close/tap), the live drag (`onDragOffset`),
  pull-down and settle-free drag gestures, the header **clear** and **launcher**
  buttons, the conversation swipe, and — defense-in-depth — the
  `TUTORIAL_CHAT_CONTROL_EVENT` rest/reset/prefill handlers (unreachable in the
  real flow because the tour starts only after `completeFirstRun`, but gated so
  a stray/adversarial event cannot collapse the pinned sheet).
- **Auto-collapses once on completion.** A one-shot falling-edge (`firstRunOpen`
  true → false, tracked by `wasFirstRunOpenRef`) settles the sheet to half, and
  the onboarding scrim fades over ~400ms in step with the transition (cut under
  `prefers-reduced-motion`), revealing the retained home screen underneath. An
  ordinary session (onboarding never active) never triggers this transition,
  and the collapse gate is released so
  Escape/outside-tap/etc. work normally afterward.

The desktop `?shellMode=chat-overlay` shell mounts the (headless,
`firstRunComplete`-gated) conductor too, so a fresh chat-first desktop install
seeds the same in-chat onboarding; once first-run completes the mount is a
no-op (`App.chat-overlay-first-run.test.tsx`). The transcript's CHOICE widgets,
plus any OAuth/secret blocks they reveal, are the only interactive surfaces
during onboarding; the composer remains locked until sign-in completes.

## Auto-start step (wrap-up, platform-gated)

After the provider flow resolves — in the same wrap-up batch as the accent
step and BEFORE the tutorial CHOICE — the conductor seeds an auto-start turn
(`first-run:autostart`) asking whether Eliza should launch automatically:

- **Gating.** Seeded only when `detectAutostartPlatform()`
  (`first-run-autostart.ts`) reports support: the Electrobun desktop shell
  (`getFrontendPlatform() === "desktop"`) or the native Android Capacitor
  shell. Hidden on web and iOS — neither has an app-controlled auto-start.
- **Ids.** `__first_run__:autostart:enable` ("Enable (recommended)") and
  `__first_run__:autostart:skip` ("Not now"), registered in
  `first-run-action-channel.ts` and validated strictly in the conductor: the
  pick is live only while the turn was actually offered (platform recorded at
  seed time) and unpicked (first-pick latch), so forged values on web/iOS,
  double-taps, and garbage ids are consumed as no-ops.
- **Enable.** Desktop → `desktopSetAutoLaunch { enabled: true, openAsHidden:
  false }` over the same RPC the Settings toggle uses (writes the macOS
  LaunchAgent plist / Linux autostart .desktop / Windows HKCU Run key).
  Android → Capacitor preference `eliza:background-enabled = "true"` (the
  string form `ElizaBootReceiver` reads; Preferences stores booleans as
  strings).
- **Skip.** No writes.
- **Failure behavior.** Non-blocking: `enableAutostart` never rejects — a
  failed write (missing bridge, RPC rejection, Preferences throw) surfaces as
  a `first-run:autostart-error:*` notice turn pointing at Settings, and the
  tutorial CHOICE still finishes onboarding either way.
- **Replay-safe.** A dev onboarding replay (`?onboarding-replay=1`, #14382)
  resolves `replay-skipped` and performs no persistent write.
- **Display.** `ChatOverlay.selectFirstRunDisplayMessages` renders the wrap-up
  turns (accent + auto-start + tutorial, plus a late auto-start error notice)
  as ONE contiguous card stack — they are alternatives-plus-finisher, not
  sequential steps, so the tutorial finisher is always tappable next to them.
- **Cloud-only mode caveat.** The step lives in the chooser-mode wrap-up
  (`seedTutorial`). Cloud-only onboarding (#13377, the production default)
  completes immediately on sign-in with no wrap-up turns, so it does not offer
  auto-start; Settings remains the surface there.

Per-platform OS permission handling is unchanged: the permission-priming
sequence (`components/permissions/PermissionPrimingOverlay.tsx`) still runs
AFTER `firstRunComplete` flips and the tutorial is inactive — auto-start is a
shell setting, not an OS permission, so it rides inside onboarding without
resequencing priming.

## Post-onboarding landing (#14362)

Onboarding finishes on chat and stays there. `completeFirstRun(landingTab)` —
the single finalizer in `useFirstRunCallbacks.ts` — flips the durable
completion gate, sets the tab, and marks `initialTabSetRef`, so the first
post-onboarding paint is already the landing surface. Cloud-only completion
(`completeCloudOnly` in `use-first-run-conductor.ts`) passes `"chat"`; the
BYOK/Settings escapes pass `"settings"`.

There is **no automatic character-select landing.** An earlier design (#13396)
routed the first post-onboarding boot to the full-screen character-select view
once, via a session-scoped `justCommitted` ref consumed in
`startup-phase-hydrate.ts`. That contradicted the one-obvious-path / chat-first
doctrine — two surfaces fought for the first impression — so the detour and its
`justCommitted` plumbing were removed. The hydrating phase now only lands a root
open on the default tab (chat) and lets a deep-linked URL win. Character
customization is reached explicitly from Settings/launcher, not forced on first
run. The regression is guarded by `startup-phase-hydrate.initial-tab.test.ts`
(root boot never routes to character-select) and
`onboarding-cloud-only.spec.ts` (no character-select surface after onboarding).

## Confused-user guards (conductor + send funnel)

Onboarding must survive a user who taps the wrong things, taps them twice, or
taps them out of order. The contract, enforced in `use-first-run-conductor.ts`
/ `first-run-action-channel.ts` / `first-run-finish.ts` and covered by
`use-first-run-conductor.test.ts` + the seeded storms in
`use-first-run-conductor.fuzz.test.ts`:

- **One flow at a time.** While a finish/provision call is in flight
  (`busyRef`), every other first-run pick — stale widgets, error re-seeds, the
  cloud-agent picker — is consumed as a no-op. No concurrent local+cloud
  provisioning is reachable.
- **Provisioned latch.** After provisioning succeeds only the tutorial pick is
  live; taps on leftover runtime/provider/cloud-agent widgets no-op instead of
  re-provisioning. The tutorial pick itself latches (`completedRef`), so a
  double-tap cannot re-fire `completeFirstRun` or launch a second tour.
- **Strict values.** Group ids are validated per group; malformed values under
  the reserved `__first_run__:` prefix are consumed, never acted on.
- **The prefix is reserved forever.** `classifyActionMessage` (the send
  funnel's routing contract in `AppContext.sendActionMessage`) drops
  `__first_run__:` values unconditionally — even after onboarding completes, a
  tap on a leftover onboarding widget never reaches the server as a literal
  sentinel chat message.
- **Exactly-once POST, even under races.** `persistFirstRun` memoizes its
  in-flight promise: concurrently double-fired finishes share one
  `POST /api/first-run`, and a failed POST releases the guard so a retry can
  post again.
- **No cloud dead end.** A failed/cancelled cloud login re-offers an UNLOCKED
  runtime CHOICE in the retry turn (earlier widgets lock on first tap), and
  arms a connect-and-resume continuation: if the user instead connects from
  the OAuth block, the interrupted flow resumes automatically when the store
  learns the connection landed. A fresh pick always supersedes the pending
  resume.
- **No finish dead end (the loop fix).** When a finish/provision flow fails —
  including a persistent `POST /api/first-run` failure such as a 404 — the
  conductor seeds a DISTINCT recovery turn (`first-run:error:*`) carrying its own
  `[CHOICE:first-run id=error]` with a human-readable message and three real ways
  forward: **Try again** (`error:retry`, re-runs the last runtime's finish),
  **Choose a different way to run** (`error:restart`, re-offers a fresh unlocked
  runtime CHOICE), and **Configure in Settings** (`error:settings`). It never
  re-appends the runtime question inline, so a repeating error can no longer loop
  the greeting forever.
- **"Other / configure in Settings" always escapes.** The `provider:other` pick
  (BYOK) does NOT run a local finish flow that could fail and re-loop; it opens
  the Settings tab (`setTab("settings")`) and exits first-run
  (`completeFirstRun("settings")`), landing the user where they configure a
  provider by hand. Both this and `error:settings` route through the same
  `exitToSettings` helper, latched by `completedRef` so a double-tap can't flip
  the gate twice.
