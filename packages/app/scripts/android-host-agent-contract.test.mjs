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
const workflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "device-e2e.yml"),
  "utf8",
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
});
