# Siri, App Actions, and LifeOps Routing

Assistant entry surfaces are launch and capture surfaces. They are not a
second task engine.

Siri/App Shortcuts, Android App Actions, Android assistant-role intents, and
desktop shortcut surfaces should route the user's utterance or tap into the
Eliza app/runtime. If the user asks for a reminder, check-in, follow-up,
watcher, recap, or approval, the runtime must create or update a LifeOps
`ScheduledTask`. Native mobile code may deliver notifications for tasks that
already exist, but it must not create native-only reminder state that bypasses
LifeOps.

## Intended Flow

1. The OS entry surface opens Eliza with a source-tagged deep link or assistant
   intent payload.
2. The app/runtime normalizes the payload into the same planner path used by
   chat and device-bus requests.
3. LifeOps creates or updates a `ScheduledTask` through the app/runtime.
4. Native notification APIs only deliver output for that task or wake the
   runtime so the scheduled-task runner can decide what fires.

## Platform Contracts

| Platform | Entry surface | Required routing contract |
|---|---|---|
| Mac | Shortcuts/deep link/menu-bar voice entry | Opens the app/runtime; LifeOps mutations are persisted as `ScheduledTask` records. |
| iOS | Siri/App Shortcuts/App Intents | Uses App Intents or app deep links to hand off to the app/runtime. No cross-app UI driving, and no native-only reminder store. |
| Android consumer | Static shortcuts + App Actions | `shortcuts.xml` and assistant intents open `eliza://chat?...`; LifeOps scheduling happens after runtime routing. |
| Android AOSP | `ROLE_ASSISTANT` + privileged system app | Assistant role may wake Eliza more directly, but scheduled behavior still goes through the same `ScheduledTask` runner. |

## Validation Checklist

### Mac

- [ ] Trigger the Mac shortcut/voice entry surface with a plain chat request
  and confirm it opens the app/runtime instead of executing native-only logic.
- [ ] Ask for a one-off reminder and verify a LifeOps `ScheduledTask` record is
  created with `kind: "reminder"`.
- [ ] Ask for a recurring check-in or follow-up and verify cadence lives in the
  `ScheduledTask.trigger`/relationship edge, not in a platform notification.

### iOS

- [ ] Verify Siri/App Shortcuts open Eliza or invoke the App Intent handoff.
- [ ] Verify `appIntentList` only reports local app/donated intents and does
  not claim cross-app enumeration.
- [ ] Ask Siri for a LifeOps reminder/check-in/follow-up and verify the app
  creates a `ScheduledTask` through the runtime.
- [ ] Confirm native `UNUserNotificationCenter` entries, if any, reference an
  existing task or deep link back into the app.

### Android Consumer

- [ ] Verify `AndroidManifest.xml` registers `@xml/shortcuts` on `MainActivity`.
- [ ] Verify the `ask_eliza` static shortcut opens `eliza://chat`.
- [ ] Trigger an App Action and confirm the app/runtime receives the request.
- [ ] Ask for a reminder/check-in/follow-up and verify LifeOps stores a
  `ScheduledTask`; no Java/Kotlin-only reminder table or notification-only
  schedule is created.

### Android AOSP Assistant Role

- [ ] On the system image, confirm `ROLE_ASSISTANT` resolves to Eliza.
- [ ] Trigger `android.intent.action.ASSIST` and `VOICE_COMMAND`; both should
  reach Eliza's app/runtime.
- [ ] Confirm privileged capture/input capabilities do not change LifeOps
  persistence: reminders/check-ins/follow-ups still use `ScheduledTask`.
- [ ] Run the AOSP system-app validation in `AOSP_SYSTEM_APP.md`.

## Static Coverage

- `ios-bridge.test.ts` checks that the TypeScript iOS AppIntent registry stays
  aligned with the native x-callback switch.
- `android-bridge.test.ts` checks that Android assistant/App Actions source
  files route into app deep links rather than native notification creation.
