/**
 * Pins the Android cloud-onboarding command to the cloud-only runtime contract
 * so it cannot wait for the local agent that cloud builds intentionally omit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(appRoot, "package.json"), "utf8"),
);

describe("Android cloud-onboarding command", () => {
  it("builds, installs, and drives first-run without a local-agent gate", () => {
    const command = packageJson.scripts["test:e2e:android:cloud-onboarding"];

    assert.match(command, /build:android:cloud:debug/);
    assert.match(command, /install:android:adb/);
    assert.match(command, /ELIZA_ANDROID_ALLOW_FIRST_RUN=1/);
    assert.match(command, /ELIZA_ANDROID_REQUIRE_AGENT=0/);
    assert.match(command, /cloud-onboarding\.android\.spec\.ts/);
  });
});
