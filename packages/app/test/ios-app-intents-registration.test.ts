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
});
