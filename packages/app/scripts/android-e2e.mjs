#!/usr/bin/env node
// Android end-to-end orchestrator. Single entrypoint that brings the device into
// a known-good state and runs the real-backend e2e suites, surfacing every
// failure loudly (non-zero exit). Steps:
//   1. Ensure an emulator/device is attached (boots an AVD with adequate RAM if
//      none is running) and, for emulators, SELinux is permissive so the
//      embedded on-device agent can run.
//   2. Ensure the WebView-debuggable debug APK is installed.
//   3. Local route: bring up the on-device agent + smallest model and assert a
//      real chat round-trip (mobile-local-chat-smoke). Loud fail if the local
//      runtime or model does not come up.
//   4. Playwright route coverage: drive the real WebView across every route.
//   5. (optional) Cloud route: real Hetzner provisioning probe.
//
// Flags: --serial <s>  --skip-local-chat  --skip-route-coverage  --cloud
//        --build (build the APK first)  --no-emulator-boot
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureEmulatorBooted,
  ensureEmulatorPermissive,
  installApk,
  isInstalled,
  resolveAdb,
  resolveApk,
  resolveSerial,
} from "./lib/android-device.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const elizaRoot = path.resolve(appDir, "..", "..");

const has = (flag) => process.argv.includes(flag);
const val = (flag, fb) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fb;
};
const log = (m) => console.log(`[android-e2e] ${m}`);

// Smallest local tier; same id the smoke + catalog use.
const SMOKE_MODEL = {
  id: "eliza-1-0_8b",
  file: "eliza-1-0_8b-32k.gguf",
  url: "https://huggingface.co/elizaos/eliza-1/resolve/main/bundles/0_8b/text/eliza-1-0_8b-32k.gguf?download=true",
  cacheDir: path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".cache/eliza/android-smoke-models",
  ),
};

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

// Node's fetch chokes on the HF Xet LFS redirect; curl handles it. Pre-cache the
// model so the smoke reuses it offline instead of failing on the redirect.
function ensureSmokeModelCached() {
  const dest = path.join(SMOKE_MODEL.cacheDir, SMOKE_MODEL.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log(`smoke model cached: ${dest}`);
    return dest;
  }
  fs.mkdirSync(SMOKE_MODEL.cacheDir, { recursive: true });
  log(`downloading smoke model ${SMOKE_MODEL.id} via curl…`);
  execFileSync("curl", ["-fsSL", "-o", dest, SMOKE_MODEL.url], {
    stdio: "inherit",
  });
  return dest;
}

async function main() {
  const adb = resolveAdb();

  let serial = val("--serial", process.env.ANDROID_SERIAL);
  if (!has("--no-emulator-boot")) {
    serial = await ensureEmulatorBooted({ adb, avd: val("--avd"), log });
  }
  serial = resolveSerial(adb, serial);
  process.env.ANDROID_SERIAL = serial;
  log(`device serial=${serial}`);

  await ensureEmulatorPermissive(adb, serial, { log });

  if (has("--build")) {
    log("building WebView-debuggable APK…");
    run("bun", ["run", "build:android"], {
      ELIZA_MOBILE_REPO_ROOT: elizaRoot,
      ELIZA_WEBVIEW_DEBUG: "1",
      ELIZA_BUN_RISCV64_OPTIONAL: "1",
      ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB: "1",
    });
  }
  if (!isInstalled(adb, serial)) {
    const apk = resolveApk(process.env.ELIZA_ANDROID_APK);
    log(`installing ${apk}`);
    installApk(adb, serial, apk);
  }

  if (!has("--skip-local-chat")) {
    const modelPath = ensureSmokeModelCached();
    log("local route: on-device agent + smallest model + real chat…");
    run(
      "node",
      [
        "scripts/mobile-local-chat-smoke.mjs",
        "--platform",
        "android",
        "--require-installed",
        "--live",
        "--android-select-local",
        "--android-stage-smoke-model",
        "--serial",
        serial,
      ],
      { ANDROID_SMOKE_MODEL_PATH: modelPath, ANDROID_SERIAL: serial },
    );
  }

  if (!has("--skip-route-coverage")) {
    log("route coverage: driving every route on the real WebView…");
    run("node", [
      "scripts/run-ui-playwright.mjs",
      "--config",
      "playwright.android.config.ts",
    ]);
  }

  if (has("--cloud")) {
    log(
      "cloud route: real Hetzner provisioning probe (loud-fails if it can't)…",
    );
    run("node", ["scripts/cloud-provisioning-e2e.mjs"]);
  }

  log("ALL ANDROID E2E PASSED ✅");
}

main().catch((error) => {
  console.error(`[android-e2e] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
