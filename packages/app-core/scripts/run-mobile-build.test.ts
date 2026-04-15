import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readAppIdentityFromConfig,
  shouldRunIosPodInstall,
  syncIosAppIdentity,
  syncPlatformTemplateFiles,
} from "./run-mobile-build.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-mobile-build-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("run-mobile-build", () => {
  it("syncs canonical ios and android platform template files", () => {
    const repoRoot = makeTempDir();
    const appDir = path.join(repoRoot, "apps", "app");

    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "App",
        "App.entitlements",
      ),
      "app-entitlements\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "App",
        "Info.plist",
      ),
      "app-plist\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "App.xcodeproj",
        "project.pbxproj",
      ),
      "ios-project\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "Podfile",
      ),
      "ios-podfile\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "ActionRequestHandler.swift",
      ),
      "request-handler\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "Info.plist",
      ),
      "extension-plist\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "WebsiteBlockerContentExtension.entitlements",
      ),
      "extension-entitlements\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "android",
        "build.gradle",
      ),
      "android-root\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "android",
        "app",
        "capacitor.build.gradle",
      ),
      "android-capacitor\n",
    );

    const iosCopied = syncPlatformTemplateFiles("ios", {
      repoRootValue: repoRoot,
      appDirValue: appDir,
      log: () => {},
    });
    const androidCopied = syncPlatformTemplateFiles("android", {
      repoRootValue: repoRoot,
      appDirValue: appDir,
      log: () => {},
    });

    expect(iosCopied).toEqual([
      path.join("App", "Podfile"),
      path.join("App", "App.xcodeproj", "project.pbxproj"),
      path.join("App", "App", "App.entitlements"),
      path.join("App", "App", "Info.plist"),
      path.join(
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "ActionRequestHandler.swift",
      ),
      path.join("App", "App", "WebsiteBlockerContentExtension", "Info.plist"),
      path.join(
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "WebsiteBlockerContentExtension.entitlements",
      ),
    ]);
    expect(androidCopied).toContain("build.gradle");
    expect(androidCopied).toContain(path.join("app", "capacitor.build.gradle"));
    expect(
      fs.readFileSync(
        path.join(appDir, "ios", "App", "App", "App.entitlements"),
        "utf8",
      ),
    ).toBe("app-entitlements\n");
    expect(
      fs.readFileSync(
        path.join(appDir, "ios", "App", "App", "Info.plist"),
        "utf8",
      ),
    ).toBe("app-plist\n");
    expect(
      fs.readFileSync(path.join(appDir, "ios", "App", "Podfile"), "utf8"),
    ).toBe("ios-podfile\n");
    expect(
      fs.readFileSync(
        path.join(appDir, "ios", "App", "App.xcodeproj", "project.pbxproj"),
        "utf8",
      ),
    ).toBe("ios-project\n");
    expect(
      fs.readFileSync(
        path.join(
          appDir,
          "ios",
          "App",
          "App",
          "WebsiteBlockerContentExtension",
          "ActionRequestHandler.swift",
        ),
        "utf8",
      ),
    ).toBe("request-handler\n");
    expect(
      fs.readFileSync(
        path.join(
          appDir,
          "ios",
          "App",
          "App",
          "WebsiteBlockerContentExtension",
          "Info.plist",
        ),
        "utf8",
      ),
    ).toBe("extension-plist\n");
    expect(
      fs.readFileSync(
        path.join(
          appDir,
          "ios",
          "App",
          "App",
          "WebsiteBlockerContentExtension",
          "WebsiteBlockerContentExtension.entitlements",
        ),
        "utf8",
      ),
    ).toBe("extension-entitlements\n");
    expect(
      fs.readFileSync(path.join(appDir, "android", "build.gradle"), "utf8"),
    ).toBe("android-root\n");
    expect(
      fs.readFileSync(
        path.join(appDir, "android", "app", "capacitor.build.gradle"),
        "utf8",
      ),
    ).toBe("android-capacitor\n");
  });

  it("keeps shipped platform templates on app-local capacitor packages", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
    const iosPodfile = fs.readFileSync(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "ios",
        "App",
        "Podfile",
      ),
      "utf8",
    );
    const androidSettings = fs.readFileSync(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "android",
        "capacitor.settings.gradle",
      ),
      "utf8",
    );
    const androidBuild = fs.readFileSync(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "android",
        "app",
        "capacitor.build.gradle",
      ),
      "utf8",
    );

    expect(iosPodfile).not.toContain("node_modules/.bun/");
    expect(iosPodfile).toContain("../../node_modules/@capacitor/ios");
    expect(iosPodfile).not.toContain("CapacitorStatusBar");

    expect(androidSettings).not.toContain("node_modules/.bun/");
    expect(androidSettings).toContain(
      "../node_modules/@capacitor/android/capacitor",
    );
    expect(androidSettings).not.toContain("capacitor-status-bar");

    expect(androidBuild).not.toContain("capacitor-status-bar");
  });

  it("forces CocoaPods refreshes when the synced files include the iOS Podfile", () => {
    expect(shouldRunIosPodInstall([path.join("App", "Podfile")])).toBe(true);
    expect(shouldRunIosPodInstall(["build.gradle"])).toBe(false);
  });

  it("reads app identity from apps/app/app.config.ts", () => {
    const repoRoot = makeTempDir();
    const appConfigPath = path.join(repoRoot, "apps", "app", "app.config.ts");

    writeFile(
      appConfigPath,
      `
const config = {
  appName: "Milady",
  appId: "com.miladyai.milady",
  branding: { appName: "Milady Brand" },
};
export default config;
`,
    );

    expect(readAppIdentityFromConfig(appConfigPath)).toEqual({
      appId: "com.miladyai.milady",
      appName: "Milady",
      appGroupId: "group.com.miladyai.milady",
    });
  });

  it("rewrites generated ios files to the configured app identity", () => {
    const appDir = path.join(makeTempDir(), "apps", "app");

    writeFile(
      path.join(appDir, "ios", "App", "App.xcodeproj", "project.pbxproj"),
      `
PRODUCT_BUNDLE_IDENTIFIER = ai.elizaos.app;
PRODUCT_BUNDLE_IDENTIFIER = ai.elizaos.app.WebsiteBlockerContentExtension;
`,
    );
    writeFile(
      path.join(appDir, "ios", "App", "App", "Info.plist"),
      "<string>elizaOS App</string>\n",
    );
    writeFile(
      path.join(appDir, "ios", "App", "App", "App.entitlements"),
      "<string>group.ai.elizaos.app</string>\n",
    );
    writeFile(
      path.join(
        appDir,
        "ios",
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "WebsiteBlockerContentExtension.entitlements",
      ),
      "<string>group.ai.elizaos.app</string>\n",
    );
    writeFile(
      path.join(
        appDir,
        "ios",
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "ActionRequestHandler.swift",
      ),
      'static let appGroupIdentifier = "group.ai.elizaos.app"\n',
    );

    const updated = syncIosAppIdentity(
      {
        appId: "com.miladyai.milady",
        appName: "Milady",
        appGroupId: "group.com.miladyai.milady",
      },
      {
        appDirValue: appDir,
        log: () => {},
      },
    );

    expect(updated).toEqual([
      path.join("ios", "App", "App.xcodeproj", "project.pbxproj"),
      path.join("ios", "App", "App", "Info.plist"),
      path.join("ios", "App", "App", "App.entitlements"),
      path.join(
        "ios",
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "WebsiteBlockerContentExtension.entitlements",
      ),
      path.join(
        "ios",
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "ActionRequestHandler.swift",
      ),
    ]);
    expect(
      fs.readFileSync(
        path.join(appDir, "ios", "App", "App.xcodeproj", "project.pbxproj"),
        "utf8",
      ),
    ).toContain("com.miladyai.milady.WebsiteBlockerContentExtension");
    expect(
      fs.readFileSync(
        path.join(appDir, "ios", "App", "App", "Info.plist"),
        "utf8",
      ),
    ).toContain("Milady");
    expect(
      fs.readFileSync(
        path.join(appDir, "ios", "App", "App", "App.entitlements"),
        "utf8",
      ),
    ).toContain("group.com.miladyai.milady");
    expect(
      fs.readFileSync(
        path.join(
          appDir,
          "ios",
          "App",
          "App",
          "WebsiteBlockerContentExtension",
          "ActionRequestHandler.swift",
        ),
        "utf8",
      ),
    ).toContain('static let appGroupIdentifier = "group.com.miladyai.milady"');
  });
});
