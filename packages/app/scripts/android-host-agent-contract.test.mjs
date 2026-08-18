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
const focusedRunner = fs.readFileSync(
  path.join(scriptsDir, "android-playwright-e2e.mjs"),
  "utf8",
);
const iosRunner = fs.readFileSync(path.join(scriptsDir, "ios-e2e.mjs"), "utf8");
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
const androidGlobalSetup = fs.readFileSync(
  path.join(repoRoot, "packages", "app", "test", "android", "global-setup.ts"),
  "utf8",
);
const onboardingSpec = fs.readFileSync(
  path.join(
    repoRoot,
    "packages",
    "app",
    "test",
    "android",
    "onboarding-to-home.android.spec.ts",
  ),
  "utf8",
);
const routeCoverageSpec = fs.readFileSync(
  path.join(
    repoRoot,
    "packages",
    "app",
    "test",
    "android",
    "route-coverage.android.spec.ts",
  ),
  "utf8",
);
const taskCoordinatorRegistration = fs.readFileSync(
  path.join(
    repoRoot,
    "plugins",
    "plugin-task-coordinator",
    "src",
    "register.ts",
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
    expect(workflow).toContain("--start-host-agent --host-emulator-probes");
  });

  it("builds the exact APK before launching the resource-constrained emulator", () => {
    expect(workflow).toContain("name: Build exact-head Android APK");
    expect(workflow).toContain("bun run --cwd packages/app build:android");
    expect(workflow).toContain(
      "android-e2e.mjs --skip-build --skip-local-chat --no-emulator-boot",
    );
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

  it("starts the required real host agent on an atomically allocated port", () => {
    expect(runner).toContain('has("--start-host-agent")');
    expect(runner).toContain("startDeviceE2eHostAgent({");
    expect(runner).toContain("artifactDir: bundle.logsDir");
    expect(runner).toContain(
      'requestedPort: val(\n            "--host-agent-port",\n            process.env.ELIZA_ANDROID_HOST_AGENT_PORT',
    );
    expect(runner).toContain(
      "process.env.ELIZA_ANDROID_HOST_AGENT_PORT = String(hostAgent.port)",
    );
    expect(runner).not.toContain("requestedPort: 31337");
  });

  it("always tears down the runner-owned host agent", () => {
    expect(runner).toContain("if (hostAgent) {");
    expect(runner).toContain("await hostAgent.stop()");
    expect(runner.indexOf("await hostAgent.stop()")).toBeGreaterThan(
      runner.indexOf("} finally {"),
    );
  });

  it("bounds the complete route sweep without selecting unrelated device suites", () => {
    expect(runner).toContain(
      '"test/android/onboarding-to-home.android.spec.ts"',
    );
    expect(runner).toContain('"test/android/route-coverage.android.spec.ts"');
    expect(runner).toContain(
      '"test/android/native-plugin-view-smoke.android.spec.ts"',
    );
    expect(runner).not.toContain(
      '"test/android/console-sweep.android.spec.ts"',
    );
    expect(runner).toContain("{ timeoutMs: 20 * 60_000 }");
    expect(runner).toContain("if (!hostEmulatorProbes && !arm64LocalProbes)");
  });

  it("captures installed-app media before a later Android probe can fail", () => {
    const preflight = runner.indexOf("captureAndroidPreflightEvidence(");
    const routeRun = runner.indexOf('"Android route coverage"');
    expect(preflight).toBeGreaterThan(-1);
    expect(routeRun).toBeGreaterThan(preflight);
    expect(runner).toContain('filename: "android-preflight.mp4"');
    expect(runner).toContain('filename: "android-preflight.png"');
  });

  it("records focused Android and iOS evidence around the tested flow", () => {
    expect(
      focusedRunner.indexOf('filename: "android-tested-flow.mp4"'),
    ).toBeLessThan(focusedRunner.indexOf('"Android Playwright device tests"'));
    const recordingStart = iosRunner.indexOf("if (step.verification");
    expect(recordingStart).toBeGreaterThan(-1);
    expect(recordingStart).toBeLessThan(
      iosRunner.indexOf("runStep(bundle, step", recordingStart),
    );
    expect(iosRunner).toContain('filename: "ios-tested-flow.mp4"');
    expect(runner).toContain('ELIZA_ANDROID_PARENT_RECORDING: "1"');
    expect(focusedRunner).toContain('ELIZA_ANDROID_PARENT_RECORDING: "1"');
  });

  it("navigates through the privileged shell event instead of raw view history", () => {
    expect(androidHarness).toContain('new CustomEvent("eliza:navigate:view"');
    expect(androidHarness).not.toContain(
      'window.history.pushState({}, "", path)',
    );
  });

  it("pre-grants feature permissions so native prompts cannot mask route results", () => {
    expect(androidGlobalSetup).toContain("android.permission.READ_CALL_LOG");
    expect(androidGlobalSetup).toContain("android.permission.READ_CONTACTS");
    expect(androidGlobalSetup).toContain("android.permission.READ_SMS");
  });

  it("waits for the deterministic reply instead of accepting a late greeting", () => {
    expect(onboardingSpec).toContain('challengeToken: "STREAM_E2E_OK"');
  });

  it("enables developer mode before sweeping developer-only routes", () => {
    const seed = routeCoverageSpec.indexOf("page.addInitScript");
    const reload = routeCoverageSpec.indexOf(
      'page.reload({ waitUntil: "domcontentloaded" })',
    );
    expect(seed).toBeGreaterThan(-1);
    expect(routeCoverageSpec).toContain(
      'localStorage.setItem("eliza:developerMode", "1")',
    );
    expect(reload).toBeGreaterThan(seed);
    expect(routeCoverageSpec).not.toContain(
      "page.evaluate(() => {\n      localStorage.setItem",
    );
  });

  it("bundles the developer route locally under the native executable-code policy", () => {
    expect(taskCoordinatorRegistration).toContain("registerAppShellPage({");
    expect(taskCoordinatorRegistration).toContain('id: "orchestrator"');
    expect(taskCoordinatorRegistration).toContain('path: "/orchestrator"');
    expect(taskCoordinatorRegistration).toContain('viewKind: "developer"');
    expect(taskCoordinatorRegistration).toContain(
      'import("./OrchestratorView.tsx")',
    );
  });

  it("owns the image decoder imported by the Android route suite", () => {
    expect(appPackage.devDependencies.pngjs).toBe("^7.0.0");
    expect(appPackage.devDependencies["@types/pngjs"]).toBe("^6.0.5");
  });
});
