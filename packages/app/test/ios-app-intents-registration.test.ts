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
const mobileBuildScript = readFileSync(
  path.join(repoRoot, "packages/app-core/scripts/run-mobile-build.mjs"),
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

  it("wires ElizaWidgets and version threading through the iOS build pipeline", () => {
    // Brand rewrite: bundle-id suffix, app-group entitlements, fastlane ids,
    // and the personal-team strip list all cover the widget extension.
    expect(mobileBuildScript).toContain('"ElizaWidgets",');
    expect(mobileBuildScript).toContain("`${appId}.ElizaWidgets`");
    expect(mobileBuildScript).toContain('"ElizaWidgets.entitlements"');
    expect(mobileBuildScript).toContain('"EWDG00010000000000000401"');
    // D11: ELIZAOS_VERSION_NAME/ELIZAOS_VERSION_CODE → MARKETING_VERSION /
    // CURRENT_PROJECT_VERSION so the running iOS build is identifiable.
    expect(mobileBuildScript).toContain("ELIZAOS_VERSION_NAME");
    expect(mobileBuildScript).toContain("ELIZAOS_VERSION_CODE");
    expect(mobileBuildScript).toContain("MARKETING_VERSION = ${versionName};");
    expect(mobileBuildScript).toContain(
      "CURRENT_PROJECT_VERSION = ${versionCode};",
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
