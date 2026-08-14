/**
 * Regression tests for the bundle-preserving focused Android Playwright
 * entrypoint and the surviving device-CI shell-script call graph.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAndroidPlaywrightE2eArgs,
  verifyInstalledAndroidBuild,
} from "./android-playwright-e2e.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const tempDirs = [];
const CURRENT_COMMIT = "a".repeat(40);
const STALE_COMMIT = "b".repeat(40);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "android-playwright-e2e-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("focused Android Playwright bundle runner", () => {
  it("separates runner flags from Playwright arguments", () => {
    expect(
      parseAndroidPlaywrightE2eArgs([
        "--output",
        "/tmp/bundle",
        "--serial",
        "emulator-5554",
        "--no-wait",
        "test/android/example.android.spec.ts",
        "--grep",
        "smoke",
      ]),
    ).toEqual({
      output: "/tmp/bundle",
      serial: "emulator-5554",
      noWait: true,
      playwrightArgs: [
        "test/android/example.android.spec.ts",
        "--grep",
        "smoke",
      ],
    });
  });

  it("rejects missing runner option values", () => {
    expect(() => parseAndroidPlaywrightE2eArgs(["--output"])).toThrow(
      /--output requires a value/,
    );
    expect(() => parseAndroidPlaywrightE2eArgs(["--serial", "--grep"])).toThrow(
      /--serial requires a value/,
    );
  });

  it("accepts only the exact installed commit before Playwright starts", () => {
    const bundle = { build: {}, expectedCommit: CURRENT_COMMIT };
    expect(
      verifyInstalledAndroidBuild(bundle, {
        buildId: "build-current",
        commit: CURRENT_COMMIT,
      }),
    ).toEqual({ buildId: "build-current", commit: CURRENT_COMMIT });

    expect(() =>
      verifyInstalledAndroidBuild(
        { build: {}, expectedCommit: CURRENT_COMMIT },
        { buildId: "build-stale", commit: STALE_COMMIT },
      ),
    ).toThrow(/does not match expected HEAD/);
    expect(() =>
      verifyInstalledAndroidBuild(
        { build: {}, expectedCommit: CURRENT_COMMIT },
        { buildId: "build-short", commit: CURRENT_COMMIT.slice(0, 12) },
      ),
    ).toThrow(/not a full SHA-1/);
    expect(() =>
      verifyInstalledAndroidBuild(
        { build: {}, expectedCommit: CURRENT_COMMIT },
        null,
      ),
    ).toThrow(/not a full SHA-1/);
  });

  it("keeps every focused Android lane used by device CI behind a bundler", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(appDir, "package.json"), "utf8"),
    );
    const ciScripts = [
      ".github/scripts/android-device-e2e/route-coverage.sh",
      ".github/scripts/android-device-e2e/pr-device-smoke.sh",
    ];
    const invoked = new Set();
    for (const relativePath of ciScripts) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
      for (const match of source.matchAll(/test:e2e:android:[a-z-]+/g)) {
        invoked.add(match[0]);
      }
    }
    expect(invoked.size).toBeGreaterThan(0);
    for (const scriptName of invoked) {
      const command = packageJson.scripts[scriptName];
      expect(typeof command, `${scriptName} must exist`).toBe("string");
      expect(
        command.includes("node scripts/android-e2e.mjs") ||
          command.includes("node scripts/android-playwright-e2e.mjs"),
        `${scriptName} bypasses the device-e2e bundler`,
      ).toBe(true);
    }
  });

  it("finalizes a bundle and exits non-zero when device setup fails", () => {
    const root = tempDir();
    const output = path.join(root, "bundle");
    const emptyBin = path.join(root, "empty-bin");
    fs.mkdirSync(emptyBin);
    const result = spawnSync(
      process.execPath,
      [
        path.join(scriptsDir, "android-playwright-e2e.mjs"),
        "--output",
        output,
        "test/android/onboarding-to-home.android.spec.ts",
      ],
      {
        cwd: appDir,
        env: {
          HOME: root,
          PATH: emptyBin,
          ADB: path.join(root, "missing-adb"),
          ANDROID_HOME: path.join(root, "missing-sdk"),
          ANDROID_SDK_ROOT: path.join(root, "missing-sdk"),
        },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      `[android-playwright-e2e] bundle: ${output}`,
    );
    expect(fs.existsSync(path.join(output, "summary.json"))).toBe(true);
    expect(fs.existsSync(path.join(output, "junit.xml"))).toBe(true);
    expect(
      fs.readFileSync(path.join(output, "logs", "runner.log"), "utf8"),
    ).toContain("runner failure: adb not found");
    const summary = JSON.parse(
      fs.readFileSync(path.join(output, "summary.json"), "utf8"),
    );
    expect(summary.result).toBe("failed");
    expect(summary.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "resolve Android device",
          status: "failed",
        }),
      ]),
    );
  });
});
