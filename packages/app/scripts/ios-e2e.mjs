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
// Flags: --device <name|udid>  --skip-build  --skip-local-chat  --skip-auth
//        --cloud
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const has = (f) => process.argv.includes(f);
const val = (f, fb) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : fb;
};
const log = (m) => console.log(`[ios-e2e] ${m}`);

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    cwd: appDir,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${res.status}`);
  }
}

function simctl(args) {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8" });
}

function bootedUdid() {
  try {
    const json = JSON.parse(simctl(["list", "devices", "booted", "--json"]));
    for (const runtime of Object.values(json.devices ?? {})) {
      const device = runtime.find((d) => d.state === "Booted");
      if (device) return device.udid;
    }
  } catch {
    /* none booted */
  }
  return null;
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
  const target = deviceName ?? "iPhone 16 Pro";
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

async function main() {
  const udid = ensureSimulatorBooted(val("--device"));
  log(`simulator udid=${udid}`);

  if (has("--skip-build")) {
    log("skipping build (--skip-build)");
  } else {
    log("building + installing the iOS Simulator app…");
    run("bun", ["run", "build:ios:local:sim"]);
  }

  if (!has("--skip-auth")) {
    log("auth route: deep-link / callback registration + drive…");
    run("node", [
      "../../packages/app-core/scripts/mobile-auth-simulator-smoke.mjs",
      "--platform",
      "ios",
      "--device",
      udid,
    ]);
  }

  if (!has("--skip-local-chat")) {
    log("local route: on-device agent + smallest model + real chat…");
    run("node", [
      "scripts/mobile-local-chat-smoke.mjs",
      "--platform",
      "ios",
      "--require-installed",
      "--ios-select-local",
      "--ios-full-bun-smoke",
    ]);
  }

  if (has("--cloud")) {
    log("cloud route: real provisioning probe…");
    run("node", ["scripts/cloud-provisioning-e2e.mjs"]);
  }

  log("ALL iOS E2E PASSED ✅");
}

main().catch((error) => {
  console.error(`[ios-e2e] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
