#!/usr/bin/env node
// iOS end-to-end orchestrator (macOS only — uses `xcrun simctl`). Mirrors
// android-e2e.mjs for the iOS Simulator. The iOS WebView (WKWebView) is not
// CDP-drivable like Android, so there is no Playwright route-coverage sweep;
// instead this proves the device-level real paths and fails LOUDLY:
//   1. A simulator is booted (boots one if needed).
//   2. The app is built + installed.
//   3. Local route: on-device agent + smallest model + real chat round-trip
//      (mobile-local-chat-smoke ios full-bun path).
//   4. Deep-link / auth-callback registration + drive (mobile-auth-simulator).
//   5. (optional) Cloud route: real provisioning probe.
//
// Flags: --device <name|udid>  --app-path <App.app>  --skip-build
//        --skip-local-chat  --skip-auth  --cloud  --no-wait  --output <dir>
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNonVacuousPlan,
  buildAuthSmokeCommand,
  buildCloudProvisioningCommand,
  buildIosSimBuildCommand,
  buildLocalChatSmokeCommand,
  extractAppId,
  isAppInstalled,
  parseIosE2eArgs,
  planIosE2eSteps,
  resolveTargetDevice,
  selectBootedUdid,
} from "./ios-e2e-lib.mjs";
import {
  captureFailureForensics,
  createDeviceE2eBundle,
  finalizeDeviceE2eBundle,
  finishBundleStep,
  formatFailureForensicsBlock,
  recordBundleArtifact,
  runBundledCommand,
  setBundleBuild,
  setBundleDevice,
  startBundleStep,
} from "./lib/device-e2e-bundle.mjs";
import { acquireDeviceLease } from "./lib/device-lease.mjs";
import {
  assertCandidateIosAppRendererFresh,
  assertInstalledIosAppRendererFresh,
} from "./lib/ios-renderer-stamp.mjs";
import { clearIosSmokeDefaults } from "./lib/ios-sim-defaults-hygiene.mjs";
import { findLatestBuiltIosSimulatorApp } from "./lib/ios-simulator-app-product.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = path.resolve(appDir, "..", "..");
const flags = parseIosE2eArgs(process.argv);
const log = (m) => console.log(`[ios-e2e] ${m}`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readAppId() {
  const configPath = path.join(appDir, "app.config.ts");
  return extractAppId(fs.readFileSync(configPath, "utf8"));
}

function run(bundle, name, cmd, args, env = {}) {
  runBundledCommand(bundle, name, cmd, args, {
    cwd: appDir,
    env,
    onFailure: (step, error) => captureIosFailure(bundle, step, error),
  });
}

let activeIosContext = { udid: null };

function captureIosFailure(bundle, step, error) {
  const { udid } = activeIosContext;
  return captureFailureForensics(
    bundle,
    step,
    ({ failureDir }) => {
      const files = [];
      const causePath = path.join(failureDir, "failure-cause.txt");
      fs.writeFileSync(causePath, `${error?.message ?? error}\n`);
      files.push(causePath);
      if (udid) {
        const screenshotPath = path.join(failureDir, "screen.png");
        simctl(["io", udid, "screenshot", "--type=png", screenshotPath]);
        files.push(screenshotPath);
        const logPath = path.join(failureDir, "ios-sim.log");
        const result = spawnSync(
          "xcrun",
          [
            "simctl",
            "spawn",
            udid,
            "log",
            "show",
            "--style",
            "compact",
            "--last",
            "2m",
          ],
          { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
        );
        fs.writeFileSync(
          logPath,
          result.status === 0
            ? result.stdout
            : result.stderr || `simctl log show exited with ${result.status}\n`,
        );
        files.push(logPath);
      }
      return files;
    },
    error,
  );
}

function failIosStep(bundle, step, error) {
  captureIosFailure(bundle, step, error);
  finishBundleStep(bundle, step, "failed", error);
}

function simctl(args) {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8" });
}

function trySimctl(args) {
  try {
    return simctl(args).trim();
  } catch {
    return null;
  }
}

function captureSimulatorScreenshot(bundle, udid) {
  const outPath = path.join(bundle.rawDir, "ios-final.png");
  simctl(["io", udid, "screenshot", "--type=png", outPath]);
  return outPath;
}

async function recordSimulatorVideo(bundle, udid, durationSeconds = 3) {
  const outPath = path.join(bundle.rawDir, "ios-final.mov");
  const recorder = spawn(
    "xcrun",
    [
      "simctl",
      "io",
      udid,
      "recordVideo",
      "--codec",
      "h264",
      "--force",
      outPath,
    ],
    { stdio: "ignore" },
  );
  await delay(Math.max(1, durationSeconds) * 1000);
  recorder.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => recorder.once("close", resolve)),
    delay(5_000),
  ]);
  if (!fs.existsSync(outPath)) return null;
  return outPath;
}

function captureSimulatorLog(bundle, udid) {
  const outPath = path.join(bundle.logsDir, "ios-sim.log");
  const result = spawnSync(
    "xcrun",
    [
      "simctl",
      "spawn",
      udid,
      "log",
      "show",
      "--style",
      "compact",
      "--last",
      "5m",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  fs.writeFileSync(
    outPath,
    result.status === 0
      ? result.stdout
      : result.stderr || `simctl log show exited with ${result.status}\n`,
  );
  return outPath;
}

function bootedUdid() {
  const raw = trySimctl(["list", "devices", "booted", "--json"]);
  if (!raw) return null;
  return selectBootedUdid(JSON.parse(raw));
}

function ensureSimulatorBooted(deviceName) {
  if (process.platform !== "darwin") {
    throw new Error("iOS e2e requires macOS (xcrun simctl).");
  }
  const existing = bootedUdid();
  if (existing) {
    log(`reusing booted simulator ${existing}`);
    return existing;
  }
  const target = resolveTargetDevice(deviceName);
  log(`booting simulator ${target}`);
  try {
    simctl(["boot", target]);
  } catch (error) {
    throw new Error(
      `Could not boot simulator "${target}": ${error.message}. List devices with \`xcrun simctl list devices\`.`,
    );
  }
  execFileSync("open", ["-a", "Simulator"], { stdio: "ignore" });
  const udid = bootedUdid();
  if (!udid) throw new Error(`Simulator ${target} did not reach Booted state.`);
  return udid;
}

function installBuiltSimulatorApp(udid, appId) {
  const appPath = flags.appPath ?? findLatestBuiltIosSimulatorApp();
  if (!appPath) {
    throw new Error(
      "Could not find a Debug-iphonesimulator App.app after build. Pass --app-path or inspect Xcode DerivedData.",
    );
  }

  assertCandidateIosAppRendererFresh({
    appPath,
    bundleId: appId,
    repoRoot,
    log,
  });
  trySimctl(["terminate", udid, appId]);
  trySimctl(["uninstall", udid, appId]);
  log(`installing built simulator app ${appPath}`);
  simctl(["install", udid, appPath]);
  const installed = trySimctl(["get_app_container", udid, appId, "app"]);
  if (!isAppInstalled(installed)) {
    throw new Error(`${appId} was not installed after simctl install.`);
  }
  return assertInstalledIosAppRendererFresh({
    udid,
    bundleId: appId,
    repoRoot,
    log,
  });
}

function runStep(bundle, step, { udid, appId }) {
  switch (step.id) {
    case "build": {
      log("building the iOS Simulator app…");
      const build = buildIosSimBuildCommand();
      run(bundle, step.label, build.cmd, build.args);
      const installStep = startBundleStep(bundle, "install iOS Simulator app");
      try {
        const stamp = installBuiltSimulatorApp(udid, appId);
        setBundleBuild(bundle, {
          buildId: stamp?.buildId ?? null,
          commit: stamp?.commit ?? null,
        });
        finishBundleStep(bundle, installStep, "passed");
      } catch (error) {
        failIosStep(bundle, installStep, error);
        throw error;
      }
      return;
    }
    case "auth": {
      log(`${step.label}…`);
      const auth = buildAuthSmokeCommand(udid);
      run(bundle, step.label, auth.cmd, auth.args);
      return;
    }
    case "local-chat": {
      log(`${step.label}…`);
      const chat = buildLocalChatSmokeCommand();
      run(bundle, step.label, chat.cmd, chat.args, {
        ELIZA_DEVICE_E2E_ARTIFACT_DIR: path.join(bundle.root, "test-results"),
        ELIZA_IOS_ARTIFACT_DIR: path.join(bundle.root, "test-results", "ios"),
      });
      return;
    }
    case "cloud": {
      log(`${step.label}…`);
      const cloud = buildCloudProvisioningCommand();
      run(bundle, step.label, cloud.cmd, cloud.args);
      return;
    }
    default:
      throw new Error(`unknown orchestrator step: ${step.id}`);
  }
}

async function main() {
  const bundle = createDeviceE2eBundle({
    appDir,
    lane: "ios-sim",
    outputDir: flags.output,
  });
  let finalResult = "failed";
  let finalError = null;
  let lease = null;
  let udid = null;
  let appId = null;

  try {
    const steps = planIosE2eSteps(flags);
    // Refuse a run that would print success without exercising any device path.
    assertNonVacuousPlan(steps);
    log(`plan: ${steps.map((s) => s.id).join(" → ")}`);

    appId = readAppId();
    const bootStep = startBundleStep(bundle, "boot iOS Simulator");
    try {
      udid = ensureSimulatorBooted(flags.device);
      activeIosContext = { udid };
      finishBundleStep(bundle, bootStep, "passed");
    } catch (error) {
      failIosStep(bundle, bootStep, error);
      throw error;
    }
    log(`simulator udid=${udid}`);
    setBundleDevice(bundle, { udid, kind: "ios-simulator" });
    lease = await acquireDeviceLease(`ios:${udid}`, {
      waitMs: flags.noWait ? 0 : undefined,
      log,
    });

    clearIosSmokeDefaults({ udid, bundleId: appId, log });
    for (const step of steps) {
      runStep(bundle, step, { udid, appId });
    }
    finalResult = "passed";
    log("ALL iOS E2E PASSED ✅");
  } catch (error) {
    finalError = error;
    throw error;
  } finally {
    if (udid && appId) {
      try {
        recordBundleArtifact(
          bundle,
          captureSimulatorScreenshot(bundle, udid),
          "screenshot",
        );
      } catch (error) {
        // error-policy:J7 Bundle capture is diagnostic; preserve the runner result.
        bundle.warnings.push(
          `final iOS screenshot failed: ${error?.message ?? error}`,
        );
      }
      try {
        const video = await recordSimulatorVideo(bundle, udid);
        if (video) recordBundleArtifact(bundle, video, "video");
      } catch (error) {
        // error-policy:J7 Bundle capture is diagnostic; preserve the runner result.
        bundle.warnings.push(
          `final iOS video failed: ${error?.message ?? error}`,
        );
      }
      try {
        recordBundleArtifact(bundle, captureSimulatorLog(bundle, udid), "log");
      } catch (error) {
        // error-policy:J7 Bundle capture is diagnostic; preserve the runner result.
        bundle.warnings.push(
          `final iOS log capture failed: ${error?.message ?? error}`,
        );
      }
    }
    if (udid && appId) {
      clearIosSmokeDefaults({ udid, bundleId: appId, log });
    }
    lease?.release();
    const bundleRoot = finalizeDeviceE2eBundle(bundle, finalResult);
    if (finalError) {
      const block = formatFailureForensicsBlock(bundle, finalError);
      if (block) process.stderr.write(`\n${block}`);
    }
    log(`bundle: ${bundleRoot}`);
  }
}
main().catch((error) => {
  console.error(`[ios-e2e] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
