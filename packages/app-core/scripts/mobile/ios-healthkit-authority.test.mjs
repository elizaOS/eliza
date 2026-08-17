/** Tests HealthKit build authority against deterministic provisioning profiles. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertIosHealthKitBuildAuthority } from "./ios-healthkit-authority.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeProfile({
  applicationIdentifier = "TEAM123.ai.elizaos.app",
  healthKit = true,
  backgroundDelivery = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "healthkit-profile-"));
  tempDirs.push(dir);
  const profilePath = path.join(dir, "profile.mobileprovision");
  fs.writeFileSync(
    profilePath,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Entitlements</key><dict>
<key>application-identifier</key><string>${applicationIdentifier}</string>
<key>com.apple.developer.healthkit</key>${healthKit ? "<true/>" : "<false/>"}
<key>com.apple.developer.healthkit.background-delivery</key>${backgroundDelivery ? "<true/>" : "<false/>"}
</dict>
</dict></plist>`,
  );
  return profilePath;
}

describe("assertIosHealthKitBuildAuthority", () => {
  it("keeps disabled builds independent of signing material", () => {
    expect(() =>
      assertIosHealthKitBuildAuthority({
        enabled: false,
        appId: "ai.elizaos.app",
      }),
    ).not.toThrow();
  });

  it("accepts an enabled profile bound to the app with both entitlements", () => {
    expect(() =>
      assertIosHealthKitBuildAuthority({
        enabled: true,
        appId: "ai.elizaos.app",
        provisioningProfilePath: writeProfile(),
      }),
    ).not.toThrow();
  });

  it("rejects enabled builds without an explicit provisioning profile", () => {
    expect(() =>
      assertIosHealthKitBuildAuthority({
        enabled: true,
        appId: "ai.elizaos.app",
      }),
    ).toThrow(/requires MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE/);
  });

  it("rejects profiles missing either required entitlement", () => {
    expect(() =>
      assertIosHealthKitBuildAuthority({
        enabled: true,
        appId: "ai.elizaos.app",
        provisioningProfilePath: writeProfile({ healthKit: false }),
      }),
    ).toThrow(/com\.apple\.developer\.healthkit/);
    expect(() =>
      assertIosHealthKitBuildAuthority({
        enabled: true,
        appId: "ai.elizaos.app",
        provisioningProfilePath: writeProfile({ backgroundDelivery: false }),
      }),
    ).toThrow(/background-delivery/);
  });

  it("rejects a profile issued for another bundle", () => {
    expect(() =>
      assertIosHealthKitBuildAuthority({
        enabled: true,
        appId: "ai.elizaos.app",
        provisioningProfilePath: writeProfile({
          applicationIdentifier: "TEAM123.example.other",
        }),
      }),
    ).toThrow(/does not match ai\.elizaos\.app/);
  });
});
