import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyIosAppIdentity,
  isCapacitorPlatformReady,
  resolveIosBuildTarget,
  resolvePlatformTemplateRoot,
  shouldRunIosPodInstall,
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
        "MiladyIntentPlugin.swift",
      ),
      "intent-plugin\n",
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
        "PrivacyInfo.xcprivacy",
      ),
      "app-privacy\n",
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
        "Base.lproj",
        "LaunchScreen.storyboard",
      ),
      "launch-screen\n",
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
        "ios",
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "PrivacyInfo.xcprivacy",
      ),
      "extension-privacy\n",
    );
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "android",
        "gradlew",
      ),
      "android-gradlew\n",
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
      path.join("App", "App", "Base.lproj", "LaunchScreen.storyboard"),
      path.join("App", "App", "MiladyIntentPlugin.swift"),
      path.join("App", "App", "PrivacyInfo.xcprivacy"),
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
      path.join(
        "App",
        "App",
        "WebsiteBlockerContentExtension",
        "PrivacyInfo.xcprivacy",
      ),
    ]);
    expect(androidCopied).toContain("build.gradle");
    expect(androidCopied).toContain("gradlew");
    expect(androidCopied).toContain(path.join("app", "capacitor.build.gradle"));
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
        path.join(appDir, "ios", "App", "App", "MiladyIntentPlugin.swift"),
        "utf8",
      ),
    ).toBe("intent-plugin\n");
    expect(
      fs.readFileSync(
        path.join(
          appDir,
          "ios",
          "App",
          "App",
          "Base.lproj",
          "LaunchScreen.storyboard",
        ),
        "utf8",
      ),
    ).toBe("launch-screen\n");
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
      fs.readFileSync(
        path.join(appDir, "ios", "App", "App", "PrivacyInfo.xcprivacy"),
        "utf8",
      ),
    ).toBe("app-privacy\n");
    expect(
      fs.readFileSync(
        path.join(
          appDir,
          "ios",
          "App",
          "App",
          "WebsiteBlockerContentExtension",
          "PrivacyInfo.xcprivacy",
        ),
        "utf8",
      ),
    ).toBe("extension-privacy\n");
    expect(
      fs.readFileSync(path.join(appDir, "android", "build.gradle"), "utf8"),
    ).toBe("android-root\n");
    expect(
      fs.readFileSync(path.join(appDir, "android", "gradlew"), "utf8"),
    ).toBe("android-gradlew\n");
    expect(
      fs.readFileSync(
        path.join(appDir, "android", "app", "capacitor.build.gradle"),
        "utf8",
      ),
    ).toBe("android-capacitor\n");
  });

  it("repairs an incomplete generated iOS platform from shipped templates", () => {
    const repoRoot = makeTempDir();
    const appDir = path.join(repoRoot, "apps", "app");
    const iosAppDir = path.join(appDir, "ios", "App");

    writeFile(
      path.join(iosAppDir, "App.xcworkspace", "contents.xcworkspacedata"),
      "",
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
        "App.xcodeproj",
        "project.pbxproj",
      ),
      "ios-project\n",
    );

    expect(isCapacitorPlatformReady("ios", { appDirValue: appDir })).toBe(
      false,
    );

    const copied = syncPlatformTemplateFiles("ios", {
      repoRootValue: repoRoot,
      appDirValue: appDir,
      log: () => {},
    });

    expect(copied).toContain(path.join("App", "Podfile"));
    expect(copied).toContain(
      path.join("App", "App.xcodeproj", "project.pbxproj"),
    );
    expect(isCapacitorPlatformReady("ios", { appDirValue: appDir })).toBe(true);
  });

  it("repairs an incomplete generated Android platform from shipped templates", () => {
    const repoRoot = makeTempDir();
    const appDir = path.join(repoRoot, "apps", "app");

    writeFile(path.join(appDir, "android", "settings.gradle"), "partial\n");
    writeFile(
      path.join(
        repoRoot,
        "eliza",
        "packages",
        "app-core",
        "platforms",
        "android",
        "gradlew",
      ),
      "android-gradlew\n",
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
        "build.gradle",
      ),
      "android-app\n",
    );

    expect(isCapacitorPlatformReady("android", { appDirValue: appDir })).toBe(
      false,
    );

    const copied = syncPlatformTemplateFiles("android", {
      repoRootValue: repoRoot,
      appDirValue: appDir,
      log: () => {},
    });

    expect(copied).toContain("gradlew");
    expect(copied).toContain(path.join("app", "build.gradle"));
    expect(isCapacitorPlatformReady("android", { appDirValue: appDir })).toBe(
      true,
    );
  });

  it("keeps shipped platform templates on app-local capacitor packages", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
    const iosTemplateRoot = resolvePlatformTemplateRoot("ios", {
      repoRootValue: repoRoot,
    });
    const androidTemplateRoot = resolvePlatformTemplateRoot("android", {
      repoRootValue: repoRoot,
    });

    if (!iosTemplateRoot || !androidTemplateRoot) {
      throw new Error(
        "Expected platform templates to exist for iOS and Android.",
      );
    }

    const iosPodfile = fs.readFileSync(
      path.join(iosTemplateRoot, "App", "Podfile"),
      "utf8",
    );
    const iosInfoPlist = fs.readFileSync(
      path.join(iosTemplateRoot, "App", "App", "Info.plist"),
      "utf8",
    );
    const androidSettings = fs.readFileSync(
      path.join(androidTemplateRoot, "capacitor.settings.gradle"),
      "utf8",
    );
    const androidBuild = fs.readFileSync(
      path.join(androidTemplateRoot, "app", "capacitor.build.gradle"),
      "utf8",
    );

    expect(iosPodfile).not.toContain("node_modules/.bun/");
    expect(iosPodfile).toContain("../../node_modules/@capacitor/ios");
    expect(iosPodfile).not.toContain("CapacitorStatusBar");
    expect(iosInfoPlist).not.toContain("armv7");

    expect(androidSettings).not.toContain("node_modules/.bun/");
    expect(androidSettings).toContain(
      "../node_modules/@capacitor/android/capacitor",
    );
    expect(androidSettings).not.toContain("capacitor-status-bar");

    expect(androidBuild).not.toContain("capacitor-status-bar");
  });

  it("keeps llama.cpp Capacitor native wiring in shipped templates", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
    const iosTemplateRoot = resolvePlatformTemplateRoot("ios", {
      repoRootValue: repoRoot,
    });
    const androidTemplateRoot = resolvePlatformTemplateRoot("android", {
      repoRootValue: repoRoot,
    });

    if (!iosTemplateRoot || !androidTemplateRoot) {
      throw new Error(
        "Expected platform templates to exist for iOS and Android.",
      );
    }

    const iosPodfile = fs.readFileSync(
      path.join(iosTemplateRoot, "App", "Podfile"),
      "utf8",
    );
    const androidSettings = fs.readFileSync(
      path.join(androidTemplateRoot, "capacitor.settings.gradle"),
      "utf8",
    );
    const androidBuild = fs.readFileSync(
      path.join(androidTemplateRoot, "app", "capacitor.build.gradle"),
      "utf8",
    );

    expect(iosPodfile).toContain("LlamaCppCapacitor");
    expect(iosPodfile).toContain("llama-cpp-capacitor");
    expect(androidSettings).toContain("include ':llama-cpp-capacitor'");
    expect(androidSettings).toContain(
      "node_modules/llama-cpp-capacitor/android",
    );
    expect(androidBuild).toContain(
      "implementation project(':llama-cpp-capacitor')",
    );
  });

  it("forces CocoaPods refreshes when the synced files include the iOS Podfile", () => {
    expect(shouldRunIosPodInstall([path.join("App", "Podfile")])).toBe(true);
    expect(shouldRunIosPodInstall(["build.gradle"])).toBe(false);
  });

  it("applies the configured iOS bundle identity to app, extension, and app group files", () => {
    const appDir = makeTempDir();
    const iosAppRoot = path.join(appDir, "ios", "App");
    const projectPath = path.join(
      iosAppRoot,
      "App.xcodeproj",
      "project.pbxproj",
    );
    const appEntitlements = path.join(iosAppRoot, "App", "App.entitlements");
    const extensionEntitlements = path.join(
      iosAppRoot,
      "App",
      "WebsiteBlockerContentExtension",
      "WebsiteBlockerContentExtension.entitlements",
    );
    const extensionHandler = path.join(
      iosAppRoot,
      "App",
      "WebsiteBlockerContentExtension",
      "ActionRequestHandler.swift",
    );
    const fastlaneAppfile = path.join(appDir, "ios", "fastlane", "Appfile");
    const fastlaneFastfile = path.join(appDir, "ios", "fastlane", "Fastfile");
    const fastlaneMatchfile = path.join(appDir, "ios", "fastlane", "Matchfile");

    writeFile(
      projectPath,
      [
        "DEVELOPMENT_TEAM = 25877RY2EH;",
        "MARKETING_VERSION = 1.0;",
        "PRODUCT_BUNDLE_IDENTIFIER = ai.elizaos.app;",
        "PRODUCT_BUNDLE_IDENTIFIER = ai.elizaos.app.WebsiteBlockerContentExtension;",
      ].join("\n"),
    );
    writeFile(appEntitlements, "<string>group.ai.elizaos.app</string>\n");
    writeFile(extensionEntitlements, "<string>group.ai.elizaos.app</string>\n");
    writeFile(
      extensionHandler,
      'static let appGroupIdentifier = "group.ai.elizaos.app"\n',
    );
    writeFile(
      fastlaneAppfile,
      'app_identifier(ENV["APP_IDENTIFIER"] || "ai.elizaos.app")\n',
    );
    writeFile(
      fastlaneFastfile,
      [
        'APP_ID = ENV["APP_IDENTIFIER"] || "ai.elizaos.app"',
        'EXTENSION_IDS = (ENV["APP_IDENTIFIER_EXTRA"] || "")',
      ].join("\n"),
    );
    writeFile(
      fastlaneMatchfile,
      [
        "app_identifier([",
        '  ENV["APP_IDENTIFIER"] || "ai.elizaos.app",',
        '  *(ENV["APP_IDENTIFIER_EXTRA"] || "").split(",")',
        "])",
      ].join("\n"),
    );

    const changed = applyIosAppIdentity({
      appDirValue: appDir,
      appId: "com.example.milady",
      appName: "Milady",
      appGroup: "group.com.example.milady",
      developmentTeam: "ABCDE12345",
      log: () => {},
    });

    expect(changed).toEqual(
      expect.arrayContaining([
        path.join("App.xcodeproj", "project.pbxproj"),
        path.join("App", "App.entitlements"),
        path.join(
          "App",
          "WebsiteBlockerContentExtension",
          "WebsiteBlockerContentExtension.entitlements",
        ),
        path.join(
          "App",
          "WebsiteBlockerContentExtension",
          "ActionRequestHandler.swift",
        ),
        path.join("fastlane", "Appfile"),
        path.join("fastlane", "Fastfile"),
        path.join("fastlane", "Matchfile"),
      ]),
    );
    expect(fs.readFileSync(projectPath, "utf8")).toContain(
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.milady;",
    );
    expect(fs.readFileSync(projectPath, "utf8")).toContain(
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.milady.WebsiteBlockerContentExtension;",
    );
    expect(fs.readFileSync(projectPath, "utf8")).toContain(
      "DEVELOPMENT_TEAM = ABCDE12345;",
    );
    expect(fs.readFileSync(projectPath, "utf8")).toContain(
      'MILADY_DISPLAY_NAME = "Milady";',
    );
    expect(fs.readFileSync(appEntitlements, "utf8")).toContain(
      "group.com.example.milady",
    );
    expect(fs.readFileSync(extensionEntitlements, "utf8")).toContain(
      "group.com.example.milady",
    );
    expect(fs.readFileSync(extensionHandler, "utf8")).toContain(
      "group.com.example.milady",
    );
    expect(fs.readFileSync(fastlaneAppfile, "utf8")).toContain(
      'ENV["APP_IDENTIFIER"] || "com.example.milady"',
    );
    expect(fs.readFileSync(fastlaneFastfile, "utf8")).toContain(
      'ENV["APP_IDENTIFIER_EXTRA"] || "com.example.milady.WebsiteBlockerContentExtension"',
    );
    expect(fs.readFileSync(fastlaneMatchfile, "utf8")).toContain(
      'ENV["APP_IDENTIFIER"] || "com.example.milady"',
    );
  });

  it("uses a device iOS build target when llama.cpp ships a device framework", () => {
    const appDir = makeTempDir();
    writeFile(
      path.join(
        appDir,
        "node_modules",
        "llama-cpp-capacitor",
        "ios",
        "Frameworks",
        "llama-cpp.framework",
        "llama-cpp",
      ),
      "framework-binary\n",
    );

    expect(
      resolveIosBuildTarget({
        env: {},
        appDirValue: appDir,
      }),
    ).toMatchObject({
      destination: "generic/platform=iOS",
      sdk: "iphoneos",
    });
  });

  it("allows explicit iOS build target overrides", () => {
    expect(
      resolveIosBuildTarget({
        env: {
          MILADY_IOS_BUILD_DESTINATION: "generic/platform=iOS Simulator",
          MILADY_IOS_BUILD_SDK: "iphonesimulator",
        },
        appDirValue: makeTempDir(),
      }),
    ).toMatchObject({
      destination: "generic/platform=iOS Simulator",
      sdk: "iphonesimulator",
    });
  });
});
