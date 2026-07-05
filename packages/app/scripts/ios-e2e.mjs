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
//        --skip-local-chat  --skip-auth  --cloud
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNonVacuousPlan,
  buildAuthSmokeCommand,
  buildCloudProvisioningCommand,
  buildIosSimBuildCommand,
  buildLocalChatSmokeCommand,
  classifyStepExit,
  extractAppId,
  isAppInstalled,
  parseIosE2eArgs,
  planIosE2eSteps,
  resolveTargetDevice,
  selectBootedUdid,
} from "./ios-e2e-lib.mjs";
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

function readAppId() {
  const configPath = path.join(appDir, "app.config.ts");
  return extractAppId(fs.readFileSync(configPath, "utf8"));
}

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    cwd: appDir,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  const outcome = classifyStepExit(res.status);
  if (!outcome.ok) {
    throw new Error(`${cmd} ${args.join(" ")} ${outcome.reason}`);
  }
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
  assertInstalledIosAppRendererFresh({
    udid,
    bundleId: appId,
    repoRoot,
    log,
  });
}

function runStep(step, { udid, appId }) {
  switch (step.id) {
    case "build": {
      log("building the iOS Simulator app…");
      const build = buildIosSimBuildCommand();
      run(build.cmd, build.args);
      installBuiltSimulatorApp(udid, appId);
      return;
    }
    case "auth": {
      log(`${step.label}…`);
      const auth = buildAuthSmokeCommand(udid);
      run(auth.cmd, auth.args);
      return;
    }
    case "local-chat": {
      log(`${step.label}…`);
      const chat = buildLocalChatSmokeCommand();
      run(chat.cmd, chat.args);
      return;
    }
    case "cloud": {
      log(`${step.label}…`);
      const cloud = buildCloudProvisioningCommand();
      run(cloud.cmd, cloud.args);
      return;
    }
    default:
      throw new Error(`unknown orchestrator step: ${step.id}`);
  }
}

async function main() {
  const steps = planIosE2eSteps(flags);
  // Refuse a run that would print success without exercising any device path.
  assertNonVacuousPlan(steps);
  log(`plan: ${steps.map((s) => s.id).join(" → ")}`);

  const appId = readAppId();
  const udid = ensureSimulatorBooted(flags.device);
  log(`simulator udid=${udid}`);
  clearIosSmokeDefaults({ udid, bundleId: appId, log });
  try {
    for (const step of steps) {
      runStep(step, { udid, appId });
    }
    log("ALL iOS E2E PASSED ✅");
  } finally {
    clearIosSmokeDefaults({ udid, bundleId: appId, log });
  }
}
main().catch((error) => {
  console.error(`[ios-e2e] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
