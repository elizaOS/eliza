/**
 * applyIosAppIdentity against the real committed iOS template: brand rewrite of
 * app/extension bundle ids and app-group entitlements (including ElizaWidgets),
 * plus ELIZAOS_VERSION_NAME/CODE → MARKETING_VERSION/CURRENT_PROJECT_VERSION
 * threading (#12185). Stages the template into a temp dir; no mocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { applyIosAppIdentity } from "./run-mobile-build.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const templateIosAppRoot = path.resolve(
  scriptsDir,
  "..",
  "platforms",
  "ios",
  "App",
);

const TEMPLATE_FILES = [
  path.join("App.xcodeproj", "project.pbxproj"),
  path.join("App", "App.entitlements"),
  path.join(
    "App",
    "WebsiteBlockerContentExtension",
    "WebsiteBlockerContentExtension.entitlements",
  ),
  path.join(
    "App",
    "DeviceActivityMonitorExtension",
    "DeviceActivityMonitorExtension.entitlements",
  ),
  path.join(
    "App",
    "DeviceActivityReportExtension",
    "DeviceActivityReportExtension.entitlements",
  ),
  path.join("App", "ElizaWidgets", "ElizaWidgets.entitlements"),
];

const tempDirs = [];

function stageTemplateAppDir() {
  const appDirValue = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-ios-identity-"),
  );
  tempDirs.push(appDirValue);
  const iosAppRoot = path.join(appDirValue, "ios", "App");
  for (const relPath of TEMPLATE_FILES) {
    const source = path.join(templateIosAppRoot, relPath);
    const target = path.join(iosAppRoot, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return { appDirValue, iosAppRoot };
}

function readStaged(iosAppRoot, relPath) {
  return fs.readFileSync(path.join(iosAppRoot, relPath), "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("applyIosAppIdentity (template pbxproj + entitlements)", () => {
  it("rewrites app + every extension bundle id, including ElizaWidgets", () => {
    const { appDirValue, iosAppRoot } = stageTemplateAppDir();
    applyIosAppIdentity({
      appDirValue,
      appId: "com.acme.whitelabel",
      appName: "Acme",
      versionName: null,
      versionCode: null,
      log: () => {},
    });
    const pbxproj = readStaged(
      iosAppRoot,
      path.join("App.xcodeproj", "project.pbxproj"),
    );
    for (const suffix of [
      "WebsiteBlockerContentExtension",
      "DeviceActivityMonitorExtension",
      "DeviceActivityReportExtension",
      "ElizaWidgets",
    ]) {
      expect(pbxproj).toContain(
        `PRODUCT_BUNDLE_IDENTIFIER = com.acme.whitelabel.${suffix};`,
      );
    }
    expect(pbxproj).toContain(
      "PRODUCT_BUNDLE_IDENTIFIER = com.acme.whitelabel;",
    );
    expect(pbxproj).not.toContain("PRODUCT_BUNDLE_IDENTIFIER = ai.elizaos.app");
  });

  it("rewrites the ElizaWidgets app-group entitlement to the brand app group", () => {
    const { appDirValue, iosAppRoot } = stageTemplateAppDir();
    applyIosAppIdentity({
      appDirValue,
      appId: "com.acme.whitelabel",
      appName: "Acme",
      versionName: null,
      versionCode: null,
      log: () => {},
    });
    const entitlements = readStaged(
      iosAppRoot,
      path.join("App", "ElizaWidgets", "ElizaWidgets.entitlements"),
    );
    expect(entitlements).toContain(
      "<string>group.com.acme.whitelabel</string>",
    );
    expect(entitlements).not.toContain("group.ai.elizaos.app");
  });

  it("threads versionName/versionCode into every target's version settings", () => {
    const { appDirValue, iosAppRoot } = stageTemplateAppDir();
    applyIosAppIdentity({
      appDirValue,
      appId: "ai.elizaos.app",
      appName: "elizaOS",
      versionName: "1.6.2",
      versionCode: "10602",
      log: () => {},
    });
    const pbxproj = readStaged(
      iosAppRoot,
      path.join("App.xcodeproj", "project.pbxproj"),
    );
    expect(pbxproj).not.toMatch(/MARKETING_VERSION = 1\.0;/);
    expect(pbxproj).not.toMatch(/CURRENT_PROJECT_VERSION = 1;/);
    expect(pbxproj.match(/MARKETING_VERSION = 1\.6\.2;/g)?.length).toBe(
      pbxproj.match(/MARKETING_VERSION = /g)?.length,
    );
    expect(pbxproj.match(/CURRENT_PROJECT_VERSION = 10602;/g)?.length).toBe(
      pbxproj.match(/CURRENT_PROJECT_VERSION = /g)?.length,
    );
  });

  it("leaves template versions unchanged when no version is provided", () => {
    const { appDirValue, iosAppRoot } = stageTemplateAppDir();
    applyIosAppIdentity({
      appDirValue,
      appId: "ai.elizaos.app",
      appName: "elizaOS",
      versionName: null,
      versionCode: null,
      log: () => {},
    });
    const pbxproj = readStaged(
      iosAppRoot,
      path.join("App.xcodeproj", "project.pbxproj"),
    );
    expect(pbxproj).toMatch(/MARKETING_VERSION = 1\.0;/);
    expect(pbxproj).toMatch(/CURRENT_PROJECT_VERSION = 1;/);
  });

  it("rejects malformed version values instead of writing a broken pbxproj", () => {
    const { appDirValue, iosAppRoot } = stageTemplateAppDir();
    expect(() =>
      applyIosAppIdentity({
        appDirValue,
        appId: "ai.elizaos.app",
        appName: "elizaOS",
        versionName: "1.6.2-beta;",
        versionCode: null,
        log: () => {},
      }),
    ).toThrow(/ELIZAOS_VERSION_NAME/);
    expect(() =>
      applyIosAppIdentity({
        appDirValue,
        appId: "ai.elizaos.app",
        appName: "elizaOS",
        versionName: null,
        versionCode: "abc",
        log: () => {},
      }),
    ).toThrow(/ELIZAOS_VERSION_CODE/);
    const pbxproj = readStaged(
      iosAppRoot,
      path.join("App.xcodeproj", "project.pbxproj"),
    );
    expect(pbxproj).toMatch(/MARKETING_VERSION = 1\.0;/);
  });
});
