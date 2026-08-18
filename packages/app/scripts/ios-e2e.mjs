#!/usr/bin/env node
/**
 * Orchestrates iOS Simulator build, install, auth, local-chat, and optional
 * cloud verification into one exact-head evidence bundle. Recording begins
 * before the selected app-verification legs so the walkthrough shows the
 * behavior under test rather than a post-test relaunch.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyIosSimulatorSchemeApproval,
  assertNonVacuousPlan,
  buildAuthSmokeCommand,
  buildCloudProvisioningCommand,
  buildIosSimBuildCommand,
  buildLocalChatSmokeCommand,
  classifyIosSimulatorSchemeDispatch,
  extractAppIdentity,
  iosSimulatorSchemeApproval,
  isAppInstalled,
  parseAuthSmokeResult,
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
  getDeviceE2eBundleFinalizationError,
  recordBundleArtifact,
  recordBundleRunnerFailure,
  runBundledCommand,
  setBundleBuild,
  setBundleDevice,
  startBundleStep,
} from "./lib/device-e2e-bundle.mjs";
import { normalizedImageDifference } from "./lib/device-image.mjs";
import { acquireDeviceLease } from "./lib/device-lease.mjs";
import {
  assertCandidateIosAppRendererFresh,
  assertInstalledIosAppRendererFresh,
} from "./lib/ios-renderer-stamp.mjs";
import { clearIosSmokeDefaults } from "./lib/ios-sim-defaults-hygiene.mjs";
import { findLatestBuiltIosSimulatorApp } from "./lib/ios-simulator-app-product.mjs";
import { startIosSimulatorVideo } from "./lib/ios-simulator-capture.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = path.resolve(appDir, "..", "..");
const flags = parseIosE2eArgs(process.argv);
const log = (m) => console.log(`[ios-e2e] ${m}`);

function readAppIdentity() {
  const configPath = path.join(appDir, "app.config.ts");
  return extractAppIdentity(fs.readFileSync(configPath, "utf8"));
}

function run(bundle, name, cmd, args, env = {}) {
  return runBundledCommand(bundle, name, cmd, args, {
    cwd: appDir,
    env,
    onFailure: (step, error) => captureIosFailure(bundle, step, error),
  });
}

let activeIosContext = { udid: null, appId: null };

function captureIosFailure(bundle, step, error) {
  const { udid, appId } = activeIosContext;
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
            ...(appId
              ? [
                  "--predicate",
                  `process == "App" OR (process == "launchd_sim" AND eventMessage CONTAINS "${appId}")`,
                ]
              : []),
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

async function recordSimulatorVideo(bundle, udid, appId, loadedScreenPath) {
  const recording = startIosSimulatorVideo({
    target: udid,
    artifactDir: bundle.rawDir,
    filename: "ios-final.mp4",
    log,
  });
  const readinessPath = path.join(bundle.rawDir, "ios-walkthrough-ready.png");
  const readinessReport = path.join(
    bundle.reportsDir,
    "ios-walkthrough-readiness.json",
  );
  const threshold = 0.04;
  const timeoutMs = 20_000;
  const startedAt = Date.now();
  try {
    // A static Simulator screen can be encoded as one 0.067s frame. Relaunch
    // the real app, then keep recording until its pixels match the already
    // captured loaded state. This rejects black/splash-only videos while
    // bounding readiness independently of codec validation.
    trySimctl(["terminate", udid, appId]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    simctl(["launch", udid, appId]);
    let difference = Number.POSITIVE_INFINITY;
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      simctl(["io", udid, "screenshot", "--type=png", readinessPath]);
      difference = await normalizedImageDifference(
        loadedScreenPath,
        readinessPath,
      );
      log(`walkthrough readiness visual difference=${difference.toFixed(4)}`);
      if (difference <= threshold) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        fs.writeFileSync(
          readinessReport,
          `${JSON.stringify(
            {
              result: "passed",
              normalizedDifference: difference,
              threshold,
              elapsedMs: Date.now() - startedAt,
            },
            null,
            2,
          )}\n`,
        );
        recordBundleArtifact(bundle, readinessReport, "log");
        return await recording.stop();
      }
    }
    throw new Error(
      `iOS walkthrough did not reach the loaded reference screen within ${timeoutMs}ms (difference=${difference.toFixed(4)}, threshold=${threshold})`,
    );
  } catch (error) {
    await recording.stop();
    throw error;
  }
}

function captureSimulatorLog(bundle, udid, appId) {
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
      "--predicate",
      `process == "App" OR (process == "launchd_sim" AND eventMessage CONTAINS "${appId}")`,
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

function installBuiltSimulatorApp(udid, appId, expectedCommit) {
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
    expectedCommit,
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
    expectedCommit,
  });
}

function ensureSimulatorSchemeApproval(udid, appId, urlScheme) {
  const approval = iosSimulatorSchemeApproval({
    homeDir: os.homedir(),
    udid,
    urlScheme,
    appId,
  });
  fs.mkdirSync(path.dirname(approval.plistPath), { recursive: true });
  const readEntries = () => {
    if (!fs.existsSync(approval.plistPath)) return {};
    const raw = execFileSync(
      "plutil",
      ["-convert", "json", "-o", "-", approval.plistPath],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `Simulator scheme-approval plist was not an object: ${approval.plistPath}`,
      );
    }
    return parsed;
  };
  const existingEntries = readEntries();
  const mutation = applyIosSimulatorSchemeApproval(existingEntries, approval);
  if (mutation.changed) {
    execFileSync(
      "plutil",
      ["-convert", "binary1", "-o", approval.plistPath, "-"],
      { input: JSON.stringify(mutation.entries) },
    );
  }
  const callbackDisposition = classifyIosSimulatorSchemeDispatch(
    readEntries(),
    approval,
  );
  if (callbackDisposition !== "deliver-to-app") {
    throw new Error(
      `LaunchServices did not persist the ${urlScheme} simulator callback approval`,
    );
  }
  return {
    ...approval,
    previousAppId: mutation.previousAppId,
    changed: mutation.changed,
    callbackDisposition,
  };
}

function rebootSimulatorAfterSchemeApproval(udid) {
  simctl(["shutdown", udid]);
  simctl(["boot", udid]);
  simctl(["bootstatus", udid, "-b"]);
}

function runStep(bundle, step, { udid, appId, urlScheme }) {
  switch (step.id) {
    case "build": {
      log("building the iOS Simulator app…");
      const build = buildIosSimBuildCommand();
      run(bundle, step.label, build.cmd, build.args);
      return;
    }
    case "install": {
      const installStep = startBundleStep(bundle, step.label);
      try {
        const stamp = installBuiltSimulatorApp(
          udid,
          appId,
          bundle.expectedCommit,
        );
        const approval = ensureSimulatorSchemeApproval(udid, appId, urlScheme);
        if (approval.changed) {
          log(
            `rebooting simulator so LaunchServices loads ${urlScheme} scheme approval`,
          );
          rebootSimulatorAfterSchemeApproval(udid);
        }
        const approvalReport = path.join(
          bundle.reportsDir,
          "ios-scheme-approval.json",
        );
        fs.writeFileSync(
          approvalReport,
          `${JSON.stringify(
            {
              appId: approval.appId,
              urlScheme,
              approvalKey: approval.key,
              previousAppId: approval.previousAppId,
              changed: approval.changed,
              callbackDisposition: approval.callbackDisposition,
              rebooted: approval.changed,
              plist: path.basename(approval.plistPath),
              verifiedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
        );
        recordBundleArtifact(bundle, approvalReport, "log", installStep);
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
      const result = run(bundle, step.label, auth.cmd, auth.args);
      const evidenceDir = path.join(bundle.root, "test-results", "auth");
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(
        path.join(evidenceDir, "result.json"),
        `${JSON.stringify(parseAuthSmokeResult(result.stdout), null, 2)}\n`,
      );
      return;
    }
    case "local-chat": {
      log(`${step.label}…`);
      const chat = buildLocalChatSmokeCommand();
      run(bundle, step.label, chat.cmd, chat.args, {
        ELIZA_DEVICE_E2E_ARTIFACT_DIR: path.join(bundle.root, "test-results"),
        ELIZA_IOS_ARTIFACT_DIR: path.join(bundle.root, "test-results", "ios"),
        ELIZA_IOS_FULL_BUN_SMOKE_EVIDENCE_DIR: path.join(
          bundle.root,
          "test-results",
          "ios-full-bun",
        ),
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
  let finalizationError = null;
  let lease = null;
  let udid = null;
  let appId = null;
  let urlScheme = null;
  let testedFlowRecording = null;

  try {
    const steps = planIosE2eSteps(flags);
    // Refuse a run that would print success without exercising any device path.
    assertNonVacuousPlan(steps);
    log(`plan: ${steps.map((s) => s.id).join(" → ")}`);

    ({ appId, urlScheme } = readAppIdentity());
    const bootStep = startBundleStep(bundle, "boot iOS Simulator");
    try {
      udid = ensureSimulatorBooted(flags.device);
      activeIosContext = { udid, appId };
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
      if (step.verification && !testedFlowRecording) {
        testedFlowRecording = startIosSimulatorVideo({
          target: udid,
          artifactDir: bundle.rawDir,
          filename: "ios-tested-flow.mp4",
          log,
        });
      }
      runStep(bundle, step, { udid, appId, urlScheme });
    }
    if (testedFlowRecording) {
      const recording = testedFlowRecording;
      testedFlowRecording = null;
      const videoPath = await recording.stop();
      if (!videoPath) {
        throw new Error("iOS tested-flow recording did not finalize");
      }
      recordBundleArtifact(bundle, videoPath, "video");
    }
    finalResult = "passed";
    log("ALL iOS E2E PASSED ✅");
  } catch (error) {
    finalError = error;
    recordBundleRunnerFailure(bundle, error);
  } finally {
    if (testedFlowRecording) {
      const recording = testedFlowRecording;
      testedFlowRecording = null;
      try {
        const videoPath = await recording.stop();
        if (videoPath) recordBundleArtifact(bundle, videoPath, "video");
      } catch (error) {
        bundle.warnings.push(
          `iOS tested-flow recording finalization failed: ${error?.message ?? error}`,
        );
      }
    }
    if (udid && appId) {
      let loadedScreenPath = null;
      try {
        loadedScreenPath = captureSimulatorScreenshot(bundle, udid);
        recordBundleArtifact(bundle, loadedScreenPath, "screenshot");
      } catch (error) {
        // error-policy:J7 Bundle capture is diagnostic; preserve the runner result.
        bundle.warnings.push(
          `final iOS screenshot failed: ${error?.message ?? error}`,
        );
      }
      try {
        if (loadedScreenPath) {
          const video = await recordSimulatorVideo(
            bundle,
            udid,
            appId,
            loadedScreenPath,
          );
          if (video) recordBundleArtifact(bundle, video, "video");
        } else {
          bundle.warnings.push(
            "final iOS video failed: loaded reference screenshot is unavailable",
          );
        }
      } catch (error) {
        // error-policy:J7 Bundle capture is diagnostic; preserve the runner result.
        bundle.warnings.push(
          `final iOS video failed: ${error?.message ?? error}`,
        );
      }
      try {
        recordBundleArtifact(
          bundle,
          captureSimulatorLog(bundle, udid, appId),
          "log",
        );
      } catch (error) {
        // error-policy:J7 Bundle capture is diagnostic; preserve the runner result.
        bundle.warnings.push(
          `final iOS log capture failed: ${error?.message ?? error}`,
        );
      }
    }
    if (udid && appId) {
      try {
        clearIosSmokeDefaults({ udid, bundleId: appId, log });
      } catch (error) {
        bundle.warnings.push(
          `iOS smoke-default cleanup failed: ${error?.message ?? error}`,
        );
      }
    }
    try {
      lease?.release();
    } catch (error) {
      bundle.warnings.push(
        `iOS simulator lease release failed: ${error?.message ?? error}`,
      );
    }
    const bundleRoot = finalizeDeviceE2eBundle(bundle, finalResult, {
      sourceDirs: flags.artifactSources,
      requiredEvidence: {
        buildId: true,
        commit: true,
        inlineScreenshot: true,
        inlineVideo: true,
        logs: true,
      },
    });
    finalizationError = getDeviceE2eBundleFinalizationError(bundle);
    if (finalError) {
      const block = formatFailureForensicsBlock(bundle, finalError);
      if (block) process.stderr.write(`\n${block}`);
    }
    log(`bundle: ${bundleRoot}`);
  }
  if (finalError) throw finalError;
  if (finalizationError) throw finalizationError;
}
main().catch((error) => {
  console.error(`[ios-e2e] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
