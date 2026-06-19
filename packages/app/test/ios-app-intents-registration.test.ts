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
});
