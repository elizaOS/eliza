/**
 * Pins the Android cloud-onboarding command to the cloud-only runtime contract
 * so it cannot wait for the local agent that cloud builds intentionally omit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
);

describe("Android cloud-onboarding command", () => {
  it("builds, installs, and drives authenticated chat without a local-agent gate", () => {
    const command = packageJson.scripts["test:e2e:android:cloud-onboarding"];

    expect(command).toMatch(/build:android:cloud:debug/);
    expect(command).toMatch(/install:android:adb/);
    expect(command).toMatch(/ELIZA_ANDROID_ALLOW_FIRST_RUN=1/);
    expect(command).toMatch(/ELIZA_ANDROID_REQUIRE_AGENT=0/);
    expect(command).toMatch(/ELIZA_ANDROID_CLEAR_APP_DATA=1/);
    expect(command).toMatch(/cloud-onboarding\.android\.spec\.ts/);
  });

  it("keeps the browser-handoff smoke distinct from authenticated onboarding", () => {
    const command =
      packageJson.scripts["test:e2e:android:cloud-browser-handoff"];

    expect(command).toMatch(/build:android:cloud:debug/);
    expect(command).toMatch(/ELIZA_ANDROID_REQUIRE_AGENT=0/);
    expect(command).toMatch(/ELIZA_ANDROID_CLEAR_APP_DATA=1/);
    expect(command).toMatch(/cloud-browser-handoff\.android\.spec\.ts/);
  });

  it("uses only the documented Keystore-backed live-device credential", () => {
    const spec = fs.readFileSync(
      path.join(appRoot, "test/android/cloud-onboarding.android.spec.ts"),
      "utf8",
    );

    expect(spec).toContain("ELIZA_CLOUD_AUTH_TOKEN");
    expect(spec).toContain("ElizaSecureCredentials");
    expect(spec).toContain('trace: "off"');
    expect(spec).not.toContain("ELIZA_E2E_WALLET_PK");
    expect(spec).not.toContain("eliza:e2e-wallet:pk");
  });
});
