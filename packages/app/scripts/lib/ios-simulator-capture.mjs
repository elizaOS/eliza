/**
 * Shared script library for Ios Simulator Capture capture and packaging
 * helpers used by app automation.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function runXcrun(args, options = {}) {
  return spawnSync("xcrun", args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function simctlJson(args) {
  const result = runXcrun(["simctl", ...args]);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function bootedIosSimulatorUdid() {
  const json = simctlJson(["list", "devices", "booted", "--json"]);
  for (const devices of Object.values(json?.devices ?? {})) {
    const booted = devices.find((device) => device.state === "Booted");
    if (booted?.udid) return booted.udid;
  }
  return null;
}

export function availableIosSimulators() {
  const json = simctlJson(["list", "devices", "available", "--json"]);
  const simulators = [];
  for (const devices of Object.values(json?.devices ?? {})) {
    for (const device of devices) {
      if (device.isAvailable === false) continue;
      simulators.push(device);
    }
  }
  return simulators;
}

export function iosSimulatorAvailabilityReason({ deviceName } = {}) {
  if (process.platform !== "darwin") {
    return "iOS simulator capture requires macOS.";
  }
  const probe = runXcrun(["simctl", "help"]);
  if (probe.status !== 0) {
    return "xcrun simctl is not available. Install Xcode command line tools.";
  }
  if (bootedIosSimulatorUdid()) return null;
  const available = availableIosSimulators();
  if (available.length === 0) {
    return "No available iOS simulator is installed.";
  }
  if (deviceName && !available.some((device) => device.name === deviceName)) {
    return `Requested iOS simulator "${deviceName}" is not available.`;
  }
  return null;
}

export function ensureBootedIosSimulator({ deviceName, log = () => {} } = {}) {
  const reason = iosSimulatorAvailabilityReason({ deviceName });
  if (reason) throw new Error(reason);

  const existing = bootedIosSimulatorUdid();
  if (existing) {
    log(`reusing booted iOS simulator ${existing}`);
    return existing;
  }

  const available = availableIosSimulators();
  const target =
    (deviceName && available.find((device) => device.name === deviceName)) ||
    available.find((device) => device.name === "iPhone 16 Pro") ||
    available[0];
  if (!target) throw new Error("No iOS simulator target is available.");

  log(`booting iOS simulator ${target.name} (${target.udid})`);
  const boot = runXcrun(["simctl", "boot", target.udid], { stdio: "inherit" });
  if (boot.status !== 0) {
    throw new Error(
      `xcrun simctl boot ${target.udid} exited with ${boot.status}`,
    );
  }
  spawnSync("open", ["-a", "Simulator"], { stdio: "ignore" });

  const udid = bootedIosSimulatorUdid();
  if (!udid) {
    throw new Error(`Simulator ${target.name} did not reach Booted state.`);
  }
  return udid;
}

export function captureIosSimulatorScreenshot({
  target = "booted",
  artifactDir,
  filename = "screenshot.png",
  log = () => {},
}) {
  if (!artifactDir) {
    throw new Error("artifactDir is required for iOS simulator screenshot");
  }
  fs.mkdirSync(artifactDir, { recursive: true });
  const localPath = path.join(artifactDir, filename);
  fs.rmSync(localPath, { force: true });
  const result = runXcrun(["simctl", "io", target, "screenshot", localPath], {
    stdio: "pipe",
  });
  if (result.status !== 0 || !isNonEmptyFile(localPath)) {
    const detail = result.stderr?.trim();
    throw new Error(
      `simctl screenshot failed for ${target}${detail ? `: ${detail}` : ""}`,
    );
  }
  log(`wrote iOS simulator screenshot: ${localPath}`);
  return localPath;
}

export function startIosSimulatorVideo({
  target = "booted",
  artifactDir,
  filename = "recording.mov",
  log = () => {},
}) {
  if (!artifactDir) {
    throw new Error("artifactDir is required for iOS simulator video");
  }
  fs.mkdirSync(artifactDir, { recursive: true });
  const localPath = path.join(artifactDir, filename);
  fs.rmSync(localPath, { force: true });
  const child = spawn(
    "xcrun",
    ["simctl", "io", target, "recordVideo", localPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    stderr += `${error.message}\n`;
  });
  log(`started iOS simulator recording for ${target}: ${localPath}`);

  return {
    localPath,
    child,
    async stop() {
      if (child.exitCode === null) child.kill("SIGINT");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        delay(3_000),
      ]);
      if (!isNonEmptyFile(localPath)) {
        if (stderr.trim())
          log(`iOS simulator recording stderr: ${stderr.trim()}`);
        return null;
      }
      log(`wrote iOS simulator recording: ${localPath}`);
      return localPath;
    },
  };
}
