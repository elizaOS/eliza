import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  IOS_SCREEN_TIME_REQUIREMENTS,
  validateIosScreenTimeBuildWiring,
} from "./validate-ios-screen-time.mjs";

const tempRoots = [];

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
${IOS_SCREEN_TIME_REQUIREMENTS.extensionTargets.deviceActivityReport}.appex;`
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
  }

  return { appRootPath: appRoot, entitlementsPath, projectPath, podspecPath };
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
  test("passes when app entitlements, frameworks, extension plists, and project products are present", () => {
    const result = validateIosScreenTimeBuildWiring(
      writeFixture({ includeExtensions: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks.map((check) => check.id)).toContain(
      "deviceactivity-extension-info-plists",
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
      ]),
    );
  });
});
