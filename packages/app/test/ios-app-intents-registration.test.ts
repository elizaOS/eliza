import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const iosAppRoot = path.join(repoRoot, "packages/app-core/platforms/ios/App");
const appIntentsSwift = readFileSync(
  path.join(iosAppRoot, "App/ElizaAppIntents.swift"),
  "utf8",
);
const pbxproj = readFileSync(
  path.join(iosAppRoot, "App.xcodeproj/project.pbxproj"),
  "utf8",
);
const widgetsSwift = readFileSync(
  path.join(iosAppRoot, "App/ElizaWidgets/ElizaWidgets.swift"),
  "utf8",
);
const widgetControlsSwift = readFileSync(
  path.join(iosAppRoot, "App/ElizaWidgets/ElizaWidgetControls.swift"),
  "utf8",
);
const widgetsInfoPlist = readFileSync(
  path.join(iosAppRoot, "App/ElizaWidgets/Info.plist"),
  "utf8",
);
const widgetsEntitlements = readFileSync(
  path.join(iosAppRoot, "App/ElizaWidgets/ElizaWidgets.entitlements"),
  "utf8",
);
const dictationAttributesSwift = readFileSync(
  path.join(iosAppRoot, "App/ElizaWidgets/ElizaDictationAttributes.swift"),
  "utf8",
);
const dictationLiveActivitySwift = readFileSync(
  path.join(iosAppRoot, "App/ElizaWidgets/ElizaDictationLiveActivity.swift"),
  "utf8",
);
const liveActivityBridgeSwift = readFileSync(
  path.join(iosAppRoot, "App/ElizaLiveActivityBridge.swift"),
  "utf8",
);
const mobileBuildScript = readFileSync(
  path.join(repoRoot, "packages/app-core/scripts/run-mobile-build.mjs"),
  "utf8",
);
const appCoreIosPlist = readFileSync(
  path.join(repoRoot, "packages/app-core/scripts/mobile/ios-plist.mjs"),
  "utf8",
);
const appPatchIosPlist = readFileSync(
  path.join(repoRoot, "packages/app/scripts/patch-ios-plist.mjs"),
  "utf8",
);
const androidAssistActivity = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaAssistActivity.java",
  ),
  "utf8",
);
const androidShareActivity = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaShareActivity.java",
  ),
  "utf8",
);
const androidVoiceTileService = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaVoiceTileService.java",
  ),
  "utf8",
);
const androidQuickActionsWidgetProvider = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaQuickActionsWidgetProvider.java",
  ),
  "utf8",
);
const androidManifest = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/AndroidManifest.xml",
  ),
  "utf8",
);
const androidWidgetProviderXml = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/res/xml/eliza_quick_actions_widget.xml",
  ),
  "utf8",
);
const androidWidgetLayoutXml = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/res/layout/eliza_quick_actions_widget.xml",
  ),
  "utf8",
);
const androidVoiceInteractionServiceXml = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/res/xml/eliza_voice_interaction_service.xml",
  ),
  "utf8",
);
const androidRecognitionServiceXml = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/res/xml/eliza_recognition_service.xml",
  ),
  "utf8",
);
const androidVoiceInteractionService = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaVoiceInteractionService.java",
  ),
  "utf8",
);
const androidVoiceInteractionSessionService = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaVoiceInteractionSessionService.java",
  ),
  "utf8",
);
const androidVoiceInteractionSession = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaVoiceInteractionSession.java",
  ),
  "utf8",
);
const androidRecognitionService = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaRecognitionService.java",
  ),
  "utf8",
);
const androidVoiceImeMethodXml = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/res/xml/method.xml",
  ),
  "utf8",
);
const androidVoiceImeService = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaVoiceInputMethodService.java",
  ),
  "utf8",
);
const androidVoiceImeLayout = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/res/layout/eliza_voice_ime.xml",
  ),
  "utf8",
);

describe("native assistant entry contracts", () => {
  it("compiles the iOS App Intents source in the App target", () => {
    expect(appIntentsSwift).toContain("import AppIntents");
    expect(appIntentsSwift).toContain("struct ElizaAppShortcutsProvider");
    expect(appIntentsSwift).toContain("AppShortcutsProvider");
    expect(pbxproj).toContain("ElizaAppIntents.swift in Sources");
    expect(pbxproj).toContain("ElizaAppIntents.swift */");
  });

  it("exposes the expected iOS Siri and Shortcuts launch surfaces", () => {
    for (const intentName of [
      "AskElizaIntent",
      "StartElizaVoiceIntent",
      "OpenElizaDailyBriefIntent",
      "CreateElizaTaskIntent",
      "DraftElizaSmartReplyIntent",
    ]) {
      expect(appIntentsSwift).toContain(`struct ${intentName}: AppIntent`);
    }

    expect(appIntentsSwift).toContain("ios-app-intents");
    expect(appIntentsSwift).toContain("Ask \\(.applicationName)");
    expect(appIntentsSwift).toContain("Start \\(.applicationName) voice");
    expect(appIntentsSwift).toContain("Open \\(.applicationName) daily brief");
    expect(appIntentsSwift).toContain(
      "Draft a reply with \\(.applicationName)",
    );
  });

  it("builds the ElizaWidgets extension target with widget + controls sources", () => {
    expect(pbxproj).toContain('PBXNativeTarget "ElizaWidgets"');
    expect(pbxproj).toContain("com.apple.product-type.app-extension");
    expect(pbxproj).toContain("ElizaWidgets.swift in Sources");
    expect(pbxproj).toContain("ElizaWidgetControls.swift in Sources");
    expect(pbxproj).toContain("ElizaWidgets.appex in Embed App Extensions");
    expect(pbxproj).toContain(
      "PRODUCT_BUNDLE_IDENTIFIER = ai.elizaos.app.ElizaWidgets;",
    );
    expect(widgetsInfoPlist).toContain("com.apple.widgetkit-extension");
    expect(widgetsEntitlements).toContain("group.ai.elizaos.app");
  });

  it("exposes iOS home/lock-screen widgets on the deep-link spine", () => {
    expect(widgetsSwift).toContain("struct ElizaWidgetsBundle: WidgetBundle");
    expect(widgetsSwift).toContain("struct ElizaQuickActionsWidget: Widget");
    expect(widgetsSwift).toContain("ios-widget");
    expect(widgetsSwift).toContain(".accessoryCircular");
    expect(widgetsSwift).toContain(".accessoryRectangular");
    // The five quick actions mirror the app-target App Intents.
    expect(widgetsSwift).toContain('path: "assistant", action: "ask"');
    expect(widgetsSwift).toContain('path: "voice"');
    expect(widgetsSwift).toContain(
      'path: "lifeops/daily-brief", action: "lifeops.daily-brief"',
    );
    expect(widgetsSwift).toContain(
      'path: "lifeops/task/new", action: "lifeops.create"',
    );
    expect(widgetsSwift).toContain('path: "chat", action: "smart-reply"');
  });

  it("exposes iOS 18 controls (Control Center / Lock Screen / Action button)", () => {
    expect(widgetControlsSwift).toContain(
      "struct ElizaAskControl: ControlWidget",
    );
    expect(widgetControlsSwift).toContain(
      "struct ElizaVoiceControl: ControlWidget",
    );
    expect(widgetControlsSwift).toContain("ios-control");
    // Controls foreground the app (mic needs foreground) and deep-link via
    // OpenURLIntent instead of touching UIKit from the extension process.
    expect(widgetControlsSwift).toContain("static var openAppWhenRun = true");
    expect(widgetControlsSwift).toContain("OpenURLIntent");
    expect(widgetControlsSwift).toContain("@available(iOS 18.0, *)");
  });

  it("adds a dictation Live Activity to the ElizaWidgets extension target", () => {
    // Shared ActivityAttributes: compiled into BOTH the App target (bridge) and
    // the ElizaWidgets extension (rendering), so ActivityKit can deliver the
    // content state to the widget process.
    expect(dictationAttributesSwift).toContain("import ActivityKit");
    expect(dictationAttributesSwift).toContain(
      "struct ElizaDictationAttributes: ActivityAttributes",
    );
    expect(dictationAttributesSwift).toContain("struct ContentState");
    expect(dictationAttributesSwift).toContain("@available(iOS 16.1, *)");

    // Live Activity rendering: ActivityConfiguration + Dynamic Island + the
    // interactive Stop/Save buttons routing the elizaos:// spine.
    expect(dictationLiveActivitySwift).toContain(
      "struct ElizaDictationLiveActivity: Widget",
    );
    expect(dictationLiveActivitySwift).toContain("ActivityConfiguration");
    expect(dictationLiveActivitySwift).toContain("DynamicIsland");
    expect(dictationLiveActivitySwift).toContain("StopElizaDictationIntent");
    expect(dictationLiveActivitySwift).toContain("SaveElizaDictationIntent");
    expect(dictationLiveActivitySwift).toContain(
      'ElizaWidgetDeepLink.dictation(action: "stop")',
    );

    // The bundle registers the Live Activity behind the iOS 16.1 gate.
    expect(widgetsSwift).toContain("ElizaDictationLiveActivity()");
    expect(widgetsSwift).toContain('case liveActivity = "ios-live-activity"');

    // App-side ActivityKit bridge in the App target (first-party, D2).
    expect(liveActivityBridgeSwift).toContain("import ActivityKit");
    expect(liveActivityBridgeSwift).toContain(
      "class ElizaLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin",
    );
    expect(liveActivityBridgeSwift).toContain('jsName = "ElizaLiveActivity"');
    expect(liveActivityBridgeSwift).toContain("Activity.request");

    // pbxproj: the shared attributes file is a member of BOTH the App and the
    // ElizaWidgets Sources phases; the render + bridge files land in their
    // respective targets.
    expect(pbxproj).toContain("ElizaDictationAttributes.swift in Sources");
    expect(pbxproj).toContain("ElizaDictationLiveActivity.swift in Sources");
    expect(pbxproj).toContain("ElizaLiveActivityBridge.swift in Sources");
    // The shared attributes fileRef backs exactly two PBXBuildFile entries —
    // one per target (App + ElizaWidgets) — i.e. dual-target membership.
    const attributesFileRef = pbxproj.match(
      /([A-Z0-9]+) \/\* ElizaDictationAttributes\.swift \*\/ = \{isa = PBXFileReference/,
    )?.[1];
    expect(attributesFileRef).toBeTruthy();
    expect(
      pbxproj.match(
        new RegExp(`isa = PBXBuildFile; fileRef = ${attributesFileRef} `, "g"),
      )?.length,
    ).toBe(2);
  });

  it("aligns the iOS audio background mode and Live Activities plist keys", () => {
    // D10: both plist patchers must add `audio` (voice/dictation survives
    // screen-lock) and NSSupportsLiveActivities (Live Activities opt-in).
    expect(appCoreIosPlist).toContain('"audio"');
    expect(appCoreIosPlist).toContain("NSSupportsLiveActivities");
    expect(appCoreIosPlist).toContain("ensurePlistTrueBool");

    expect(appPatchIosPlist).toContain('value: ["audio"]');
    expect(appPatchIosPlist).toContain("NSSupportsLiveActivities");
  });

  it("wires ElizaWidgets and version threading through the iOS build pipeline", () => {
    // Brand rewrite: bundle-id suffix, app-group entitlements, fastlane ids,
    // and the personal-team strip list all cover the widget extension.
    expect(mobileBuildScript).toContain('"ElizaWidgets",');
    expect(mobileBuildScript).toMatch(/\$\{appId\}\.ElizaWidgets/);
    expect(mobileBuildScript).toContain('"ElizaWidgets.entitlements"');
    expect(mobileBuildScript).toContain('"EWDG00010000000000000401"');
    // D11: ELIZAOS_VERSION_NAME/ELIZAOS_VERSION_CODE → MARKETING_VERSION /
    // CURRENT_PROJECT_VERSION so the running iOS build is identifiable.
    expect(mobileBuildScript).toContain("ELIZAOS_VERSION_NAME");
    expect(mobileBuildScript).toContain("ELIZAOS_VERSION_CODE");
    expect(mobileBuildScript).toMatch(/MARKETING_VERSION = \$\{versionName\};/);
    expect(mobileBuildScript).toMatch(
      /CURRENT_PROJECT_VERSION = \$\{versionCode\};/,
    );
  });

  it("preserves Android assistant and voice-command text when launching Eliza", () => {
    expect(androidAssistActivity).toContain("Intent.ACTION_VOICE_COMMAND");
    expect(androidAssistActivity).toContain("RecognizerIntent.EXTRA_RESULTS");
    expect(androidAssistActivity).toContain("SearchManager.QUERY");
    expect(androidAssistActivity).toContain("elizaos://assistant");
    expect(androidAssistActivity).toContain("elizaos://voice");
    expect(androidAssistActivity).toContain(
      'appendQueryParameter("text", prompt)',
    );
  });

  it("exposes Android Share Sheet and selected-text smart reply entry points", () => {
    expect(androidManifest).toContain("ElizaShareActivity");
    expect(androidManifest).toContain("android.intent.action.SEND");
    expect(androidManifest).toContain("android.intent.action.PROCESS_TEXT");
    expect(androidManifest).toContain('android:mimeType="text/plain"');
    expect(androidShareActivity).toContain("Intent.ACTION_PROCESS_TEXT");
    expect(androidShareActivity).toContain("Intent.EXTRA_PROCESS_TEXT");
    expect(androidShareActivity).toContain("android-share-sheet");
    expect(androidShareActivity).toContain("android-process-text");
    expect(androidShareActivity).toContain(
      'appendQueryParameter("action", "smart-reply")',
    );
    expect(androidShareActivity).toContain("elizaos://chat");
  });

  it("exposes an Android Quick Settings tile for native voice launch", () => {
    expect(androidManifest).toContain("ElizaVoiceTileService");
    expect(androidManifest).toContain(
      "android.permission.BIND_QUICK_SETTINGS_TILE",
    );
    expect(androidManifest).toContain(
      "android.service.quicksettings.action.QS_TILE",
    );
    expect(androidVoiceTileService).toContain("TileService");
    expect(androidVoiceTileService).toContain("android-quick-settings");
    expect(androidVoiceTileService).toContain("elizaos://voice");
    expect(androidVoiceTileService).toContain("startActivityAndCollapse");
  });

  it("exposes an Android home-screen quick-actions widget", () => {
    expect(androidManifest).toContain("ElizaQuickActionsWidgetProvider");
    expect(androidManifest).toContain(
      "android.appwidget.action.APPWIDGET_UPDATE",
    );
    expect(androidManifest).toContain("@xml/eliza_quick_actions_widget");
    expect(androidWidgetProviderXml).toContain(
      "@layout/eliza_quick_actions_widget",
    );
    expect(androidWidgetProviderXml).toContain('android:targetCellWidth="4"');
    for (const id of [
      "widget_ask",
      "widget_voice",
      "widget_daily_brief",
      "widget_new_task",
    ]) {
      expect(androidWidgetLayoutXml).toContain(`@+id/${id}`);
    }
    expect(androidQuickActionsWidgetProvider).toContain("android-widget");
    expect(androidQuickActionsWidgetProvider).toContain("elizaos://chat");
    expect(androidQuickActionsWidgetProvider).toContain("elizaos://voice");
    expect(androidQuickActionsWidgetProvider).toContain(
      "elizaos://lifeops/daily-brief",
    );
    expect(androidQuickActionsWidgetProvider).toContain(
      "elizaos://lifeops/task/new",
    );
  });

  it("exposes the Android digital-assistant VoiceInteractionService entry point", () => {
    // Manifest: the VoiceInteractionService + its session service must be
    // declared and guarded by BIND_VOICE_INTERACTION, plus the RecognitionService
    // the framework requires for a valid assistant. Without these the app never
    // appears under Settings -> Default apps -> Digital assistant app.
    expect(androidManifest).toContain("ElizaVoiceInteractionService");
    expect(androidManifest).toContain("ElizaVoiceInteractionSessionService");
    expect(androidManifest).toContain("ElizaRecognitionService");
    expect(androidManifest).toContain(
      "android.permission.BIND_VOICE_INTERACTION",
    );
    expect(androidManifest).toContain(
      "android.service.voice.VoiceInteractionService",
    );
    expect(androidManifest).toContain("@xml/eliza_voice_interaction_service");
    expect(androidManifest).toContain("android.speech.RecognitionService");
    expect(androidManifest).toContain("android.intent.category.DEFAULT");
    expect(androidManifest).toContain('android:name="android.speech"');
    expect(androidManifest).toContain("@xml/eliza_recognition_service");

    // The ACTION_ASSIST fallback activity must coexist with the VIS route.
    expect(androidManifest).toContain("ElizaAssistActivity");
    expect(androidManifest).toContain("android.intent.action.ASSIST");

    // voice-interaction metadata: both sessionService AND recognitionService
    // are mandatory (VoiceInteractionServiceInfo rejects the service otherwise),
    // plus the assist + keyguard support flags.
    expect(androidVoiceInteractionServiceXml).toContain(
      "voice-interaction-service",
    );
    expect(androidVoiceInteractionServiceXml).toContain(
      'android:sessionService="ai.elizaos.app.ElizaVoiceInteractionSessionService"',
    );
    expect(androidVoiceInteractionServiceXml).toContain(
      'android:recognitionService="ai.elizaos.app.ElizaRecognitionService"',
    );
    expect(androidVoiceInteractionServiceXml).toContain(
      'android:supportsAssist="true"',
    );
    expect(androidVoiceInteractionServiceXml).toContain(
      'android:supportsLaunchVoiceAssistFromKeyguard="true"',
    );

    // Session service class files exist with the right superclasses, and the
    // overlay session hands off through the one deep-link spine with a distinct
    // source tag so logs prove the entry point.
    expect(androidVoiceInteractionService).toContain(
      "extends VoiceInteractionService",
    );
    expect(androidVoiceInteractionSessionService).toContain(
      "extends VoiceInteractionSessionService",
    );
    expect(androidVoiceInteractionSessionService).toContain(
      "new ElizaVoiceInteractionSession",
    );
    expect(androidVoiceInteractionSession).toContain(
      "extends VoiceInteractionSession",
    );
    expect(androidVoiceInteractionSession).toContain(
      "elizaos://voice?source=android-assistant-session",
    );
    expect(androidVoiceInteractionSession).toContain("startAssistantActivity");
    expect(androidRecognitionService).toContain("extends RecognitionService");
    expect(androidRecognitionService).toContain(
      "source=android-recognition-service",
    );
    expect(androidRecognitionServiceXml).toContain("recognition-service");
  });

  it("exposes the Android voice-input IME (FUTO voice-subtype pattern)", () => {
    // Manifest: the InputMethodService must be declared, guarded by
    // BIND_INPUT_METHOD, filter android.view.InputMethod, and point its
    // android.view.im metadata at @xml/method. Without these Eliza never
    // appears under Settings -> System -> On-screen keyboard.
    expect(androidManifest).toContain("ElizaVoiceInputMethodService");
    expect(androidManifest).toContain("android.permission.BIND_INPUT_METHOD");
    expect(androidManifest).toContain("android.view.InputMethod");
    expect(androidManifest).toContain('android:name="android.view.im"');
    expect(androidManifest).toContain("@xml/method");

    // method.xml: voice-mode subtype (imeSubtypeMode="voice") is what lets
    // other keyboards' mic long-press hand off to Eliza; the switch-back
    // affordance is declared via supportsSwitchingToNextInputMethod.
    expect(androidVoiceImeMethodXml).toContain("input-method");
    expect(androidVoiceImeMethodXml).toContain(
      'android:imeSubtypeMode="voice"',
    );
    expect(androidVoiceImeMethodXml).toContain(
      'android:supportsSwitchingToNextInputMethod="true"',
    );

    // Service: records audio, transcribes over the loopback ASR route, commits
    // via InputConnection, and deep-links into the app with a distinct source
    // tag when the on-device engine is unreachable (no silent fallback).
    expect(androidVoiceImeService).toContain("extends InputMethodService");
    expect(androidVoiceImeService).toContain("AudioRecord");
    expect(androidVoiceImeService).toContain("/api/asr/local-inference");
    expect(androidVoiceImeService).toContain("commitText");
    expect(androidVoiceImeService).toContain("source=android-ime");
    // The switch-back affordance is wired to the framework switch APIs.
    expect(androidVoiceImeService).toContain("switchToPreviousInputMethod");
    expect(androidVoiceImeService).toContain("switchToNextInputMethod");

    // The keyboard surface renders the mic button + live level meter.
    expect(androidVoiceImeLayout).toContain("@+id/eliza_ime_mic");
    expect(androidVoiceImeLayout).toContain("@+id/eliza_ime_level");
    expect(androidVoiceImeLayout).toContain("@+id/eliza_ime_switch");
  });
});
