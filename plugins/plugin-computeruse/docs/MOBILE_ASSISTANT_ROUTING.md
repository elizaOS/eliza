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
| Android consumer | Static shortcuts + App Actions | `shortcuts.xml` and assistant intents open the app custom scheme; LifeOps scheduling happens after runtime routing. |
| Android AOSP | `ROLE_ASSISTANT` + privileged system app | Assistant role may wake Eliza more directly; AOSP-only accessibility/notification-listener services are available, but scheduled behavior still goes through the same `ScheduledTask` runner. |

Android consumer App Actions coverage:

| Flow | BII/static shortcut |
|---|---|
| Ask/chat | `actions.intent.CREATE_MESSAGE`, `actions.intent.GET_THING`, `eliza_app_action_chat` |
| Voice chat | `actions.intent.OPEN_APP_FEATURE` inline inventory, `eliza_app_action_voice` |
| LifeOps daily brief | `actions.intent.OPEN_APP_FEATURE` inline inventory, `eliza_app_action_daily_brief` |
| LifeOps task creation | `actions.intent.OPEN_APP_FEATURE` inline inventory, `eliza_app_action_new_task` |
| LifeOps task list | `actions.intent.OPEN_APP_FEATURE` inline inventory, `eliza_app_action_tasks` |

Each Android App Actions capability keeps a fallback fulfillment without a
required parameter. Feature-specific requests route through
`eliza://feature/open?...`; vague requests fall back to the chat route so
the runtime can disambiguate instead of executing native-only behavior.

The Play/Pixel build does not request `ROLE_ASSISTANT`,
`ACTION_ASSIST`, `VOICE_COMMAND`, or `BIND_VOICE_INTERACTION`; those are
reserved for AOSP/system validation builds. It also avoids unsupported BIIs
such as `actions.intent.CREATE_THING`; task creation is modeled as opening
the LifeOps task feature and letting the app/runtime confirm any mutation.

## External Assistant Landscape

Checked 2026-05-14 against primary vendor docs:

- OpenAI/ChatGPT on Apple platforms is exposed through Apple's ChatGPT
  extension inside Apple Intelligence and Siri settings, not as a third-party
  Siri API pattern for other apps to copy. See
  <https://help.openai.com/en/articles/10263570-apple-intelligence-siri-faq>
  and
  <https://help.openai.com/en/articles/10269382-setting-up-chatgpt-with-apple-intelligence>.
- Apple's supported third-party integration path is App Intents/App Shortcuts.
  App Intents expose app capabilities to Shortcuts, Spotlight, Siri, widgets,
  controls, and Apple Intelligence experiences. See
  <https://developer.apple.com/documentation/appintents/app-intents>,
  <https://developer.apple.com/shortcuts/>, and
  <https://developer.apple.com/documentation/appintents/app-intent-domains>.
- Claude uses the same Apple-native pattern: an "Ask Claude" App Intent
  available from Siri, Spotlight, the Share menu, and Shortcuts. See
  <https://support.anthropic.com/en/articles/10263469-using-claude-app-intents-shortcuts-and-widgets-on-ios>.
- Perplexity exposes iOS voice assistant entry through Shortcuts, Lock Screen
  controls, and the Action Button, including "Ask Perplexity" and "Start voice
  conversation" shortcut actions. See
  <https://www.perplexity.ai/help-center/en/articles/11132456-how-to-use-the-perplexity-voice-assistant-for-ios>.
- Grok/X official docs currently document Grok availability on iOS, Android,
  and web, including voice and text interactions, but do not document a public
  Siri/App Intent shortcut contract comparable to Claude's. See
  <https://help.x.com/en/using-x/about-grok>.
- Google Assistant/App Actions are driven by capabilities in `shortcuts.xml`.
  Assistant matches a built-in intent declared there and launches the app to
  the requested screen. See
  <https://developer.android.com/develop/devices/assistant/action-schema>.

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
- [ ] Verify the `eliza_app_action_chat` static shortcut opens the app chat
  route.
- [ ] Trigger an App Action and confirm the app/runtime receives the request.
- [ ] Ask for a reminder/check-in/follow-up and verify LifeOps stores a
  `ScheduledTask`; no Java/Kotlin-only reminder table or notification-only
  schedule is created.

### Android AOSP Assistant Role

- [ ] On the system image, confirm `ROLE_ASSISTANT` resolves to Eliza.
- [ ] Trigger `android.intent.action.ASSIST` and `VOICE_COMMAND`; both should
  reach Eliza's app/runtime.
- [ ] Confirm `ElizaAccessibilityService` and
  `ElizaNotificationListenerService` are present only on the AOSP/system APK,
  not the Play/Pixel cloud APK.
- [ ] Confirm privileged capture/input capabilities do not change LifeOps
  persistence: reminders/check-ins/follow-ups still use `ScheduledTask`.
- [ ] Run the AOSP system-app validation in `AOSP_SYSTEM_APP.md`.

## Static Coverage

- `ios-bridge.test.ts` checks that the TypeScript iOS AppIntent registry stays
  aligned with the native x-callback switch.
- `android-bridge.test.ts` checks that Android assistant/App Actions source
  files route into app deep links rather than native notification creation.

## Current Status and Remaining Work

Implemented static/build coverage:

- iOS App Shortcuts/App Intents are present in the native iOS target and hand
  off source-tagged deep links to the app runtime.
- Android App Actions metadata is present in `shortcuts.xml`, is registered on
  `MainActivity`, and is rewritten by `run-mobile-build.mjs` to the configured
  package and URL scheme.
- Android assistant-role launch uses the same template deep-link scheme as the
  other Android bridge activities, so white-label builds are rewritten
  consistently.
- Android AOSP system builds declare `ElizaAccessibilityService` and
  `ElizaNotificationListenerService`; `android-cloud` strips those services,
  their Java sources, and the accessibility-service XML resource.
- Assistant launch payloads with captured text are consumed by the chat surface
  and sent through the normal chat/planner path with source metadata. LifeOps
  task/reminder deep links with text route to chat first so `ScheduledTask`
  creation remains owned by the LifeOps runtime.

Still waiting on live device validation:

- macOS shortcut/voice entry has installer/verifier scripts, but the final Siri
  phrase creation and spoken-phrase result are still per-device manual checks.
- iOS Siri/App Shortcuts must still be installed on a physical device and
  tested with the spoken phrases in `ElizaAppShortcuts.swift`.
- Android consumer App Actions require a Play/Assistant-capable device or test
  environment to confirm Assistant fulfillment, not just static XML validity.
- Android AOSP assistant-role behavior still needs a system-image validation
  pass.

Known remaining product test:

- Static tests prove source routing and build-time wiring, but they do not prove
  the planner produced the intended `ScheduledTask`. The remaining product test
  is live end-to-end validation: speak or invoke a LifeOps reminder/check-in,
  confirm the assistant launch payload sends through chat/planner, and verify a
  LifeOps `ScheduledTask` record exists.
