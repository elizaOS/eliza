/**
 * Exercises the Screen Time native-wiring validator with deterministic
 * fixtures and pins its default paths to the current repository layout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  defaultIosScreenTimeValidationPaths,
  IOS_SCREEN_TIME_REQUIREMENTS,
  validateIosScreenTimeBuildWiring,
} from "./validate-ios-screen-time.mjs";

const tempRoots = [];
const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptsRoot, "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-screen-time-"));
  tempRoots.push(root);
  return root;
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeFixture({ includeExtensions }) {
  const root = makeTempRoot();
  const appRoot = path.join(root, "App");
  const entitlementsPath = path.join(appRoot, "App.entitlements");
  const projectPath = path.join(root, "App.xcodeproj", "project.pbxproj");
  const podspecPath = path.join(root, "ElizaosCapacitorMobileSignals.podspec");

  writeFile(
    entitlementsPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>${IOS_SCREEN_TIME_REQUIREMENTS.entitlements.familyControls}</key>
  <true/>
</dict>
</plist>`,
  );
  writeFile(
    podspecPath,
    `Pod::Spec.new do |s|
  s.frameworks = "FamilyControls", "DeviceActivity"
end`,
  );

  const targetText = includeExtensions
    ? `DA_MON /* ${IOS_SCREEN_TIME_REQUIREMENTS.extensionTargets.deviceActivityMonitor} */;
DA_REP /* ${IOS_SCREEN_TIME_REQUIREMENTS.extensionTargets.deviceActivityReport} */;
${IOS_SCREEN_TIME_REQUIREMENTS.extensionTargets.deviceActivityMonitor}.appex;
${IOS_SCREEN_TIME_REQUIREMENTS.extensionTargets.deviceActivityReport}.appex;
buildSettings = {
  CODE_SIGN_ENTITLEMENTS = App/${IOS_SCREEN_TIME_REQUIREMENTS.extensionEntitlementsRelativePaths.deviceActivityMonitor};
  PRODUCT_BUNDLE_IDENTIFIER = ${IOS_SCREEN_TIME_REQUIREMENTS.extensionBundleIdentifiers.deviceActivityMonitor};
};
buildSettings = {
  CODE_SIGN_ENTITLEMENTS = App/${IOS_SCREEN_TIME_REQUIREMENTS.extensionEntitlementsRelativePaths.deviceActivityReport};
  PRODUCT_BUNDLE_IDENTIFIER = ${IOS_SCREEN_TIME_REQUIREMENTS.extensionBundleIdentifiers.deviceActivityReport};
};`
    : "";
  writeFile(
    projectPath,
    `CODE_SIGN_ENTITLEMENTS = ${IOS_SCREEN_TIME_REQUIREMENTS.appEntitlementsRelativePath};
${targetText}`,
  );

  if (includeExtensions) {
    writeExtensionInfo(
      appRoot,
      "DeviceActivityMonitorExtension",
      IOS_SCREEN_TIME_REQUIREMENTS.extensionPoints.deviceActivityMonitor,
    );
    writeExtensionInfo(
      appRoot,
      "DeviceActivityReportExtension",
      IOS_SCREEN_TIME_REQUIREMENTS.extensionPoints.deviceActivityReport,
    );
    for (const relativePath of Object.values(
      IOS_SCREEN_TIME_REQUIREMENTS.extensionEntitlementsRelativePaths,
    )) {
      writeFamilyControlsEntitlements(path.join(appRoot, relativePath));
    }
  }

  return { appRootPath: appRoot, entitlementsPath, projectPath, podspecPath };
}

function writeFamilyControlsEntitlements(filePath) {
  writeFile(
    filePath,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>${IOS_SCREEN_TIME_REQUIREMENTS.entitlements.familyControls}</key>
  <true/>
</dict>
</plist>`,
  );
}

function writeExtensionInfo(appRoot, name, extensionPoint) {
  writeFile(
    path.join(appRoot, name, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>${extensionPoint}</string>
  </dict>
</dict>
</plist>`,
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("validateIosScreenTimeBuildWiring", () => {
  test("resolves the current repository and plugin podspec by default", () => {
    const paths = defaultIosScreenTimeValidationPaths();

    expect(paths.projectPath).toBe(
      path.join(
        repoRoot,
        "packages/app-core/platforms/ios/App/App.xcodeproj/project.pbxproj",
      ),
    );
    expect(paths.podspecPath).toBe(
      path.join(pluginRoot, "ElizaosCapacitorMobileSignals.podspec"),
    );
    expect(fs.existsSync(paths.projectPath)).toBe(true);
    expect(fs.existsSync(paths.podspecPath)).toBe(true);
  });

  test("passes when app entitlements, frameworks, extension plists, and project products are present", () => {
    const result = validateIosScreenTimeBuildWiring(
      writeFixture({ includeExtensions: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks.map((check) => check.id)).toContain(
      "deviceactivity-extension-info-plists",
    );
    expect(result.checks.map((check) => check.id)).toContain(
      "deviceactivity-extension-entitlements",
    );
    expect(result.checks.map((check) => check.id)).toContain(
      "xcode-deviceactivity-extension-entitlements-build-settings",
    );
  });

  test("fails when a DeviceActivity extension lacks Family Controls", () => {
    const fixture = writeFixture({ includeExtensions: true });
    writeFile(
      path.join(
        fixture.appRootPath,
        IOS_SCREEN_TIME_REQUIREMENTS.extensionEntitlementsRelativePaths
          .deviceActivityReport,
      ),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict></dict></plist>`,
    );

    const result = validateIosScreenTimeBuildWiring(fixture);

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain(
      "deviceactivity-extension-entitlements",
    );
  });

  test("fails when an extension entitlement setting is assigned to the wrong target", () => {
    const fixture = writeFixture({ includeExtensions: true });
    const project = fs.readFileSync(fixture.projectPath, "utf8");
    const monitorSetting = `CODE_SIGN_ENTITLEMENTS = App/${IOS_SCREEN_TIME_REQUIREMENTS.extensionEntitlementsRelativePaths.deviceActivityMonitor};`;
    const reportSetting = `CODE_SIGN_ENTITLEMENTS = App/${IOS_SCREEN_TIME_REQUIREMENTS.extensionEntitlementsRelativePaths.deviceActivityReport};`;
    fs.writeFileSync(
      fixture.projectPath,
      project
        .replace(monitorSetting, "SWAPPED_EXTENSION_ENTITLEMENT")
        .replace(reportSetting, monitorSetting)
        .replace("SWAPPED_EXTENSION_ENTITLEMENT", reportSetting),
    );

    const result = validateIosScreenTimeBuildWiring(fixture);

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain(
      "xcode-deviceactivity-extension-entitlements-build-settings",
    );
  });

  test("fails honestly when DeviceActivity extensions are not present", () => {
    const result = validateIosScreenTimeBuildWiring(
      writeFixture({ includeExtensions: false }),
    );

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toEqual(
      expect.arrayContaining([
        "deviceactivity-extension-info-plists",
        "xcode-deviceactivity-extension-targets",
        "xcode-deviceactivity-embedded-products",
        "deviceactivity-extension-entitlements",
        "xcode-deviceactivity-extension-entitlements-build-settings",
      ]),
    );
  });
});
