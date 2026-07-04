# Native Assistant Integration Plan

Status: in progress. This document tracks how the iOS and Android apps should
feel like real system citizens rather than a WebView with a chat box.

## Baseline Already In Tree

- Capacitor app shell with native iOS and Android projects under
  `packages/app-core/platforms`.
- Deep-link contract: `elizaos://assistant`, `elizaos://chat`,
  `elizaos://voice`, `elizaos://lifeops/*`, `elizaos://share`.
- Android App Actions via `res/xml/shortcuts.xml`: chat/ask, voice, daily
  brief, new task, and task list.
- Android sideload/AOSP assistant entry via `ACTION_ASSIST` and
  `VOICE_COMMAND`; Play/cloud builds strip default-role and privileged surfaces.
- Android Share Sheet and selected-text `PROCESS_TEXT` route into Smart Reply.
- Android Quick Settings tile opens voice chat with source-tagged metadata.
- Android home-screen quick-actions widget exposes Ask, Voice, Daily Brief, and
  New Task as direct deep links.
- iOS App Intents/App Shortcuts for Ask Eliza, Voice, Daily Brief, New Task,
  and Smart Reply.
- iOS `ElizaWidgets` widget extension: home-screen (small/medium) and Lock
  Screen (circular/rectangular) quick-action widgets for Ask, Voice, Daily
  Brief, New Task, and Smart Reply, plus iOS 18 controls "Ask Eliza" and
  "Eliza Voice" for Control Center, the Lock Screen, and the Action button.
  All entries route `elizaos://` deep links tagged `source=ios-widget` /
  `source=ios-control`.
- iOS local notifications, BGTaskScheduler, APNs silent-push wake plumbing,
  Screen Time extensions, ReplayKit broadcast target, Safari content blocker,
  and local-agent/Bun smoke harness.
- Mobile local inference policy with llama.cpp/Capacitor bridge, AOSP FFI path,
  and an opportunistic Apple Foundation Models adapter.

## Platform Reality

- iOS cannot support a global custom hotword such as "Hey Eliza" for an App
  Store app. The supported phrase path is Siri/App Shortcuts: "Hey Siri, ask
  Eliza..." or a user-created shortcut named "Eliza".
- Android Play builds should not try to become a full default assistant. Use
  Google App Actions, launcher shortcuts, widgets, share targets, and
  notifications. Full assistant-role behavior belongs to sideload/AOSP builds.
- ChatGPT's privileged Apple Intelligence extension is not a general public
  third-party API today. Eliza should integrate through App Intents, App
  Entities, Spotlight, Shortcuts, widgets, Share Sheet, keyboard extension, and
  system schemas as they become available.

## Feature Matrix

| Surface | iOS implementation | Android implementation | Priority |
|---|---|---|---|
| Ask Eliza from voice assistant | App Intents + App Shortcuts phrases | App Actions `CREATE_MESSAGE` / `GET_THING` + `ACTION_ASSIST` for sideload/AOSP | P0 |
| Start voice chat | App Shortcut opens `elizaos://voice` | Static shortcut + App Actions `OPEN_APP_FEATURE` + `VOICE_COMMAND` | P0 |
| Daily brief | App Shortcut opens LifeOps overview | Static shortcut + App Actions inline inventory | P0 |
| Create task/reminder | App Shortcut with text parameter routes to LifeOps planner | Static shortcut + App Actions feature open, then planner confirmation | P0 |
| Smart reply | App Shortcut accepts dictated/copied context and opens chat with `action=smart-reply` | Share Sheet + selected-text `PROCESS_TEXT` route to chat with `action=smart-reply`; keyboard/notification chips next | P1 |
| Home-screen widgets | WidgetKit `ElizaWidgets` extension: Ask, Voice, Daily Brief, New Task, Smart Reply implemented; Camera next | App Widget: Ask, Voice, Daily Brief, New Task implemented; Camera next | P1 |
| Lock Screen / Action Button | App Shortcuts available to Action Button and Spotlight; iOS 18 controls "Ask Eliza" + "Eliza Voice" for Control Center / Lock Screen / Action button implemented | Quick Settings voice tile, launcher shortcuts | P1 |
| Share target | Share Sheet extension for text, URLs, images, files | Android Sharesheet target for text and selected text; images/files preserve URI grants for follow-up handling | P1 |
| Keyboard smart reply | iOS custom keyboard extension with explicit network/local-mode disclosure | Android IME with inline smart reply chips | P2 |
| Notification actions | Reply, summarize, snooze, create task | Direct reply, summarize, snooze, create task | P2 |
| Car mode | CarPlay voice-only template, if entitlement/product fit | Android Auto media/assistant-safe voice surfaces, if policy fit | P3 |
| Apple Intelligence schemas | Adopt App Entities, IndexedEntity, IntentValueQuery, onscreen awareness when stable | Use App Actions/dynamic shortcuts; Gemini Nano is model API, not assistant API | P3 |

## Action Button Setup (iOS)

Apple provides no API to assign the Action button programmatically, so users
wire it up once in Settings. Two supported lanes (both live today):

1. **Control (iOS 18+, recommended):** Settings → Action Button → swipe to
   **Controls** → choose **Eliza Voice** (or **Ask Eliza**). Pressing the
   Action button then foregrounds Eliza straight into voice chat
   (`elizaos://voice?...&source=ios-control` — the microphone requires a
   foreground app, per Apple's rules for controls).
2. **Shortcut (iOS 17+):** Settings → Action Button → **Shortcut** → pick any
   Eliza App Shortcut ("Start Voice Chat", "Ask Eliza", …).

The same "Eliza Voice"/"Ask Eliza" controls are addable to Control Center
(long-press → Add a Control → search "Eliza") and to the Lock Screen bottom
controls (Customize → Lock Screen). An in-app "Set up the Action Button"
education card belongs to the Phase 1 SiriTip-style education work below —
there is no in-app setup-guide surface to slot it into yet.

## Native Feel Checklist

- Launch latency: prewarm the first chat/voice route, avoid blank WebView, and
  keep orange launch screen only as a transition.
- Voice: single native-feeling full-screen voice surface with interruption,
  barge-in, haptics, route picker, Bluetooth, and lock-screen-safe state.
- Quick actions: app icon long-press must expose Ask, Voice, Daily Brief, New
  Task, and Smart Reply.
- Widgets: taps should land directly in the relevant route with source-tagged
  metadata; no intermediate home screen.
- Share/keyboard/notification entries must always include provenance metadata
  (`source`, `action`, `assistant.launchId`) so the agent can choose the right
  confirmation and privacy posture.
- Permission prompts should be just-in-time: microphone on first voice use,
  camera on first photo ask, notifications after enabling reminders/wakes.
- Offline/local mode must show honest availability and route short utility work
  to local models before cloud.

## Inference Strategy

Use a platform router, not a single runtime everywhere.

1. **Owned GGUF path:** llama.cpp remains the default for Eliza-owned text,
   embeddings, and continuity because it runs the same model family across
   desktop, Android, iOS, and AOSP.
2. **Apple OS path:** Foundation Models/Core AI are fast-paths for short
   system-local tasks when available. Use them for summarization, smart reply,
   rewrite, OCR-plus-reasoning, and low-latency utility prompts. Keep llama.cpp
   as fallback because Apple model availability depends on OS, hardware,
   region, language, user settings, and entitlements.
3. **Android OS path:** Gemini Nano through AICore/ML Kit GenAI is a fast-path
   for prompt, summarization, proofreading, rewriting, image description, and
   speech recognition on supported devices. It should be an optional backend
   registration behind the existing memory arbiter.
4. **Performance policy:** benchmark time-to-first-token, tokens/sec, peak RSS,
   thermal state, battery drain, and model-load time per backend. Route by task
   and device tier, not by platform name alone.

## Implementation Phases

### Phase 0: Contracts And Static Gates

- Keep iOS App Intents source compiled into the app target.
- Keep Android `shortcuts.xml` and manifest metadata validated in unit tests.
- Keep deep-link routing fuzz tests for assistant paths.
- Add source metadata to every assistant/shortcut entry point.
- Keep Android Share Sheet, `PROCESS_TEXT`, and Quick Settings tile contracts
  covered by static native-entry tests.
- Keep Android widget provider/resource contracts covered by static
  native-entry tests.

### Phase 1: First-Class User Surfaces

- WidgetKit extension with Ask, Voice, Daily Brief, New Task, and Smart Reply
  shipped (`ElizaWidgets`); add Camera next.
- Extend Android app widget with Camera and dynamic/pinned-agent variants.
- Extend Android share handling from text/selection into full image, PDF, and
  arbitrary-file ingestion; add the iOS Share Sheet extension.
- Add in-app SiriTip-style education and Android in-app shortcut promotion.
- Add settings screen for assistant integrations and privacy controls.

### Phase 2: Smart Reply And Keyboard

- Build an iOS keyboard extension that offers selected-context smart replies,
  rewrite tones, summarize, translate, and "send to Eliza".
- Build an Android IME with smart reply chips and rewrite controls.
- Route all generation through a shared `smart-reply` action contract with
  strict context-size limits and visible local/cloud disclosure.
- Never read password fields or secure text fields; degrade to "Open Eliza"
  when the host app forbids keyboard context.

### Phase 3: Native Context And Apple Intelligence

- Model core Eliza objects as App Entities: conversation, task, reminder,
  daily brief, contact/person, automation, document, and memory.
- Add IndexedEntity/Core Spotlight donation for conversations and LifeOps items
  with user-controlled indexing.
- Adopt relevant App Schema domains as Apple documents stable assistant schemas.
- Add onscreen-awareness context cues for app screens where Siri can safely act.

### Phase 4: Android Assistant Depth

- Add dynamic shortcuts for frequent chats, pinned agents, recurring briefs,
  and user-created LifeOps actions via `ShortcutManagerCompat`.
- Add Google Shortcuts Integration library for Assistant surfacing where Play
  policy allows.
- For AOSP builds, complete the `ROLE_ASSISTANT` flow with
  `VoiceInteractionService`, assist content capture, and hotword integration
  only where platform signing makes it legitimate.

### Phase 5: Performance Backends

- Add Android AICore/ML Kit GenAI backend registration behind the memory
  arbiter.
- Upgrade the Apple Foundation adapter into a measured backend with task-level
  routing and explicit availability diagnostics.
- Evaluate Core AI for Eliza-owned models once model conversion/tooling is
  stable enough for GGUF-equivalent text and multimodal workloads.
- Keep llama.cpp optimized per platform: Metal on iOS/macOS, Vulkan/CPU on
  Android, one loaded model per memory tier, idle unload, speculative decode
  bounded by thermals.

## Verification Plan

- Unit: deep-link routing, iOS App Intents registration, Android assistant
  handoff, App Actions XML validation.
- Simulator: iOS App Shortcuts visible in Shortcuts app, deep links route to
  chat/voice/LifeOps; Android emulator validates launcher shortcuts and deep
  links.
- Device: Siri phrases, Android Assistant/App Actions preview, voice round
  trip, background wake, notification actions, widgets, keyboard extension,
  share target, local inference benchmark, thermal/battery profile.
- Store: iOS App Store/TestFlight entitlement review; Play cloud build with no
  privileged permissions; sideload/AOSP builds separately labeled and gated.

## References

- Apple App Intents: https://developer.apple.com/documentation/appintents
- Apple App Shortcuts: https://developer.apple.com/documentation/appintents/app-shortcuts
- Apple Intelligence developer overview: https://developer.apple.com/apple-intelligence/
- Apple Foundation Models/Core AI: https://developer.apple.com/machine-learning/
- Google Assistant App Actions: https://developer.android.com/develop/devices/assistant/overview
- Android `shortcuts.xml`: https://developer.android.com/develop/devices/assistant/action-schema
- Gemini Nano / AICore / ML Kit GenAI: https://developer.android.com/ai/gemini-nano
- Claude iOS App Intents/widgets: https://support.claude.com/en/articles/10263469-using-claude-app-intents-shortcuts-and-widgets-on-ios
- Claude Android widget: https://support.claude.com/en/articles/10534883-using-the-claude-widget-on-android
- Apple ChatGPT extension: https://support.apple.com/guide/iphone/use-chatgpt-with-apple-intelligence-iph00fd3c8c2/ios
