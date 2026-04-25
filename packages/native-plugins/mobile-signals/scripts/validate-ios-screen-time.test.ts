import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IOS_SCREEN_TIME_REQUIREMENTS,
  validateIosScreenTimeBuildWiring,
} from "./validate-ios-screen-time.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-signals-ios-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function entitlementPlist(keys: string[]) {
  const entries = keys
    .map((key) => `\t<key>${key}</key>\n\t<true/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;
}

function provisioningProfilePlist(keys: string[]) {
  const entries = keys
    .map((key) => `\t\t<key>${key}</key>\n\t\t<true/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>Entitlements</key>
\t<dict>
${entries}
\t</dict>
</dict>
</plist>
`;
}

function validProject() {
  return `CODE_SIGN_ENTITLEMENTS = ${IOS_SCREEN_TIME_REQUIREMENTS.appEntitlementsRelativePath};\n`;
}

function validPodspec() {
  return "s.frameworks = 'UIKit', 'HealthKit', 'FamilyControls', 'DeviceActivity', 'Security'\n";
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("iOS Screen Time build validation", () => {
  it("passes the checked-in app entitlements, Xcode project, and podspec", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

    const result = validateIosScreenTimeBuildWiring({
      repoRootValue: repoRoot,
      provisioningProfilePath: "",
      requireProvisioningProfile: false,
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when the app entitlements omit the Family Controls key", () => {
    const dir = makeTempDir();
    const entitlementsPath = path.join(dir, "App.entitlements");
    const projectPath = path.join(dir, "project.pbxproj");
    const podspecPath = path.join(dir, "MobileSignals.podspec");

    writeFile(entitlementsPath, entitlementPlist([]));
    writeFile(projectPath, validProject());
    writeFile(podspecPath, validPodspec());

    const result = validateIosScreenTimeBuildWiring({
      entitlementsPath,
      projectPath,
      podspecPath,
      provisioningProfilePath: "",
      requireProvisioningProfile: false,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toContain(
      "app-entitlements",
    );
    expect(result.failures[0]?.message).toContain(
      IOS_SCREEN_TIME_REQUIREMENTS.entitlements.familyControls,
    );
  });

  it("fails when a supplied provisioning profile lacks Screen Time entitlements", () => {
    const dir = makeTempDir();
    const entitlementsPath = path.join(dir, "App.entitlements");
    const projectPath = path.join(dir, "project.pbxproj");
    const podspecPath = path.join(dir, "MobileSignals.podspec");
    const provisioningProfilePath = path.join(dir, "embedded.mobileprovision");

    writeFile(
      entitlementsPath,
      entitlementPlist(Object.values(IOS_SCREEN_TIME_REQUIREMENTS.entitlements)),
    );
    writeFile(projectPath, validProject());
    writeFile(podspecPath, validPodspec());
    writeFile(
      provisioningProfilePath,
      provisioningProfilePlist([]),
    );

    const result = validateIosScreenTimeBuildWiring({
      entitlementsPath,
      projectPath,
      podspecPath,
      provisioningProfilePath,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.id)).toEqual([
      "provisioning-entitlements",
    ]);
    expect(result.failures[0]?.message).toContain(
      IOS_SCREEN_TIME_REQUIREMENTS.entitlements.familyControls,
    );
  });
});
