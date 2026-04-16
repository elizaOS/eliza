import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
    const iosTemplateRoot = resolvePlatformTemplateRoot("ios", {
      repoRootValue: repoRoot,
    });
    const androidTemplateRoot = resolvePlatformTemplateRoot("android", {
      repoRootValue: repoRoot,
    });

    if (!iosTemplateRoot || !androidTemplateRoot) {
      throw new Error("Expected platform templates to exist for iOS and Android.");
    }

    const iosPodfile = fs.readFileSync(
      path.join(
        iosTemplateRoot,
        "App",
        "Podfile",
      ),
      "utf8",
    );
    const androidSettings = fs.readFileSync(
      path.join(
        androidTemplateRoot,
        "capacitor.settings.gradle",
      ),
      "utf8",
    );
    const androidBuild = fs.readFileSync(
      path.join(
        androidTemplateRoot,
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
});
