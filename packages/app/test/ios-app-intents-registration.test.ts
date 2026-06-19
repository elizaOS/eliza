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
});
