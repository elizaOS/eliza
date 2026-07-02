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
