#!/usr/bin/env node
/**
 * Snapshot the remaining readiness gates for the shared Eliza Cloud SMS gateway.
 *
 * This command is read-only: it does not send SMS and does not modify macOS,
 * Android, BlueBubbles, or cloud state.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const homepageScript = path.join(scriptDir, "check-homepage-public-readiness.mjs");
const installScript = path.join(scriptDir, "install-android-sms-gateway.mjs");
const adbPath = "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const bridgeUrl = "http://127.0.0.1:8795";
let blocked = false;

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

function printSection(title, result) {
  console.log(`\n=== ${title} ===`);
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.status !== 0) {
    console.error(`[sms-gateway-readiness] ${title} exited with ${result.status}`);
    blocked = true;
  }
}

function printAndroidState() {
  printSection("android doctor", run("node", [installScript, "--doctor"]));
  printSection("adb devices", run(adbPath, ["devices", "-l"]));
  printSection(
    "host usb",
    run("system_profiler", ["SPUSBDataType", "-detailLevel", "mini"]),
  );
}

function printBridgeState() {
  printSection("bluebubbles doctor", run("curl", ["-sS", `${bridgeUrl}/doctor`]));
  printSection(
    "bluebubbles pending replies",
    run("curl", ["-sS", `${bridgeUrl}/pending-replies`]),
  );
}

printSection("homepage public readiness", run("node", [homepageScript]));
printAndroidState();
printBridgeState();

if (blocked) {
  process.exitCode = 1;
}
