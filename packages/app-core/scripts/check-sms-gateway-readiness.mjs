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
const adbPath = "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const bridgeUrl = "http://127.0.0.1:8795";
const cloudSmokeUrl =
  "https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles";

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
  }
}

function printAdbState() {
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

function printCloudSmoke() {
  const sender = `+1415555${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
  const payload = JSON.stringify({
    type: "message",
    message_id: `readiness-${Date.now()}`,
    chat_id: `SMS;-;${sender}`,
    from: sender,
    to: "+14159611510",
    text: "readiness smoke",
    timestamp: new Date().toISOString(),
  });
  printSection(
    "production cloud smoke",
    run("curl", [
      "-sS",
      "-X",
      "POST",
      cloudSmokeUrl,
      "-H",
      "content-type: application/json",
      "--data",
      payload,
    ]),
  );
}

printSection("homepage public readiness", run("node", [homepageScript]));
printAdbState();
printBridgeState();
printCloudSmoke();
