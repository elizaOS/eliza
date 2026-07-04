# In-chat onboarding status

First-run onboarding now renders in the real `ContinuousChatOverlay` over the
normal app shell. The old full-screen first-run gate, `FirstRunChat` surface,
and standalone runtime chooser are no longer part of the shipped UI.

The current first-run flow is seeded by `use-first-run-conductor.ts` as inline
chat choices:

- `choice-__first_run__:runtime:{cloud|local}` (the runtime location is a clean
  two-option chooser as of #11509; "Bring your own keys" is not a location — it
  lives on the provider axis below. Remote lives in Settings → Runtime post-#9952.)
- `choice-__first_run__:provider:{on-device|elizacloud|other}`
- `choice-__first_run__:tutorial:{start|skip}`

Those choices route into the headless first-run finish path and produce a single
`POST /api/first-run`. Tests should assert the real chat overlay plus transcript
choices and should keep negative assertions for deleted surfaces such as
`first-run-runtime-chooser`, `first-run-chat`, and
`startup-first-run-background`.

Current end-to-end evidence for issue #10709 lives in
`.github/issue-evidence/10709-onboarding-chat/`.

## The onboarding lock (#9952 follow-up)

While first-run is pending, the shell passes `firstRunOpen={firstRunComplete
=== false}` to `ContinuousChatOverlay` (`App.tsx`). `firstRunOpen` turns the
overlay into a **modal onboarding surface** — the chat is the first painted
surface, it is non-interactive except for the seeded choices, and it cannot be
dismissed until onboarding completes. The contract, enforced in
`ContinuousChatOverlay.tsx` and covered by `ContinuousChatOverlay.firstrun.test.tsx`:

- **Opens pinned at FULL.** Initial detent is `full` when `firstRunOpen`; a
  falling-edge-guarded effect re-pins to FULL on every change while
  `firstRunOpen` is true, so nothing can step it down.
- **Composer is locked.** The textarea is `disabled` with the placeholder
  "Choose an option to continue"; attach, mic/push-to-talk, and send are all
  disabled. `submitText` hard-returns while `firstRunOpen`, closing the
  non-keyboard side doors (chat-prefill event, dictation, slash commands). The
  `AppContext` `sendActionMessage` backstop additionally drops any non
  `__first_run__:` value while first-run is incomplete — nothing reaches the
  server before a runtime exists.
- **Undismissable.** Every collapse path is a no-op while `firstRunOpen`:
  `collapse()` (the single funnel for Escape on document/thread/composer,
  outside-tap, and the grabber close/tap), the live drag (`onDragOffset`),
  pull-down and settle-free drag gestures, the header **clear** and **launcher**
  buttons, the conversation swipe, and — defense-in-depth — the
  `TUTORIAL_CHAT_CONTROL_EVENT` rest/reset/prefill handlers (unreachable in the
  real flow because the tour starts only after `completeFirstRun`, but gated so
  a stray/adversarial event cannot collapse the pinned sheet).
- **Auto-collapses once on completion.** A one-shot falling-edge (`firstRunOpen`
  true → false, tracked by `wasFirstRunOpenRef`) collapses the sheet to the
  input bar, revealing the home screen. An ordinary session (onboarding never
  active) never triggers this collapse, and the collapse gate is released so
  Escape/outside-tap/etc. work normally afterward.

The desktop `?shellMode=chat-overlay` shell mounts the (headless,
`firstRunComplete`-gated) conductor too, so a fresh chat-first desktop install
seeds the same in-chat onboarding; once first-run completes the mount is a
no-op (`App.chat-overlay-first-run.test.tsx`). Only the transcript's CHOICE
widgets and any OAuth/secret blocks stay interactive during onboarding.

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

## In-chat model download/load status (#12178 WI-4)

The local text-model download/load is part of the chat, not a separate screen.
`use-model-status-conductor.ts` (headless, mounted next to the first-run
conductor) reads the already-plumbed `deriveHomeModelStatus` snapshot
(`useHomeModelStatus`) and, while a local runtime's text model is
`missing | downloading | loading | error`, seeds **one** live-updating assistant
turn (`model:download-status`, `source:"model_status"`) into the same transcript
the overlay renders. The turn is updated **in place** and refreshed **at most
once per second**; percent is **clamped monotonic** so a transient readiness dip
never rewinds the bar. When the model becomes ready (or the runtime is
cloud/remote) the turn is removed. The home model-download widget is unchanged
and there is **no floating pill**.

The turn carries a `[CHOICE]` control row whose VALUES use a new reserved
`__model__:` prefix, handled by `model-action-channel.ts` (a mirror of
`first-run-action-channel.ts`):

- **Cancel** (`__model__:cancel`) → `DELETE /downloads/:id` for the assigned
  model id, then the turn flips to a non-dead-end "cancelled — pick how to
  continue" (re-offer download / switch-cloud).
- **Retry** (`__model__:retry`, error state) / **Download**
  (`__model__:download`, after cancel) → `POST /downloads` for the same id.
- **Switch to Eliza Cloud** (`__model__:switch-cloud`) → force `cloud-only`
  routing on the text slots (`setLocalInferencePolicy`), opening cloud login
  first when not connected. This is the sanctioned client-side switch until the
  `MODEL_SWITCH` action (WI-6) lands.
- **Keep waiting** (`__model__:keep-waiting`) → explicit no-op.

The `__model__:` prefix is reserved unconditionally at the send funnel
(`AppContext.sendActionMessage` consults `isModelActionMessage` /
`tryHandleModelAction` before the real send), so a tap on a leftover status
widget after the model is ready is dropped, never sent as a literal sentinel.

**Typed while blocked never lost.** When a real chat message is sent while the
model still blocks send (`handleChatSend` / the action funnel call
`notifyTypedWhileBlocked`), the conductor seeds an instant local "still getting
ready" acknowledgment; the real send still rides the existing server
hold/503-retry. The composer placeholder reads
"downloading eliza-1 — you can keep typing" (input is never disabled by the
model status).
