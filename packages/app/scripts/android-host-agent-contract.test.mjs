/**
 * Contract coverage for hermetic host-agent ownership in the Android device
 * bundle workflow and orchestrator.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..", "..", "..");
const runner = fs.readFileSync(
  path.join(scriptsDir, "android-e2e.mjs"),
  "utf8",
);
const androidHarness = fs.readFileSync(
  path.join(
    repoRoot,
    "packages",
    "app",
    "test",
    "android",
    "android-harness.ts",
  ),
  "utf8",
);
const workflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "device-e2e.yml"),
  "utf8",
);
const appPackage = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "packages", "app", "package.json"),
    "utf8",
  ),
);

describe("Android device-e2e host-agent contract", () => {
  it("makes the exact-head workflow opt into runner-owned host lifecycle", () => {
    expect(workflow).toContain('ELIZA_ANDROID_BACKEND: "host"');
    expect(workflow).toContain('ELIZA_ANDROID_MANAGE_HOST_AGENT: "1"');
  });

  it("checks out the pinned native source required by the iOS simulator build", () => {
    expect(workflow).toContain(
      "git submodule update --init --depth 1 plugins/plugin-local-inference/native/llama.cpp",
    );
  });

  it("provisions native media probes for iOS evidence validation", () => {
    expect(workflow).toContain("brew install ffmpeg");
    expect(workflow).toContain("ELIZA_FFMPEG_BIN=$(brew --prefix)/bin/ffmpeg");
    expect(workflow).toContain(
      "ELIZA_FFPROBE_BIN=$(brew --prefix)/bin/ffprobe",
    );
  });

  it("starts the required real host agent on the Android loopback port", () => {
    expect(runner).toContain(
      'process.env.ELIZA_ANDROID_MANAGE_HOST_AGENT === "1"',
    );
    expect(runner).toContain("startDeviceE2eHostAgent({");
    expect(runner).toContain("artifactDir: bundle.logsDir");
    expect(runner).toContain("requestedPort: 31337");
  });

  it("always tears down the runner-owned host agent", () => {
    expect(runner).toContain("if (hostAgent) {");
    expect(runner).toContain("await hostAgent.stop()");
    expect(runner.indexOf("await hostAgent.stop()")).toBeGreaterThan(
      runner.indexOf("} finally {"),
    );
  });

  it("bounds the complete route sweep without selecting unrelated device suites", () => {
    expect(runner).toContain('"test/android/route-coverage.android.spec.ts"');
    expect(runner).toContain('"test/android/console-sweep.android.spec.ts"');
    expect(runner).toContain("{ timeoutMs: 20 * 60_000 }");
    expect(runner).not.toContain('"stage Android voice models"');
  });

  it("navigates through the privileged shell event instead of raw view history", () => {
    expect(androidHarness).toContain('new CustomEvent("eliza:navigate:view"');
    expect(androidHarness).not.toContain(
      'window.history.pushState({}, "", path)',
    );
  });

  it("owns the image decoder imported by the Android route suite", () => {
    expect(appPackage.devDependencies.pngjs).toBe("^7.0.0");
    expect(appPackage.devDependencies["@types/pngjs"]).toBe("^6.0.5");
  });
});
