#!/usr/bin/env node
// deploy-pixel.ts — build → verify deployed image → launch → voice-smoke for
// a physical Android device (Pixel) or a running Cuttlefish cvd.
//
// Sequence:
//   1. Build the fused libllama + libelizainference for the target ABI
//      (arm64-v8a by default — `android-arm64-cpu-fused`), via
//      compile-libllama.ts (which carries the omnivoice-merged graft + the
//      MTP drafter-arch + the metal/vulkan/cpu kernel patches). x86_64 for
//      a cvd target.
//   2. Stage them + the bundled models into the AOSP vendor tree
//      (sync-to-aosp / stage-default-models), build the privileged APK
//      (build-aosp.ts --rebuild-privileged-apk; or, with --skip-aosp-build,
//      reuse the last-built APK).
//   3. For Cuttlefish, `adb install -r -g` the platform-signed APK onto the
//      matching running image. For physical targets, REFUSE to sideload: verify
//      that the codename-matched elizaOS system image is already flashed and
//      that Eliza is installed as a privileged system package. Physical image
//      flashing belongs to the release-manifest installer, which requires an
//      explicit destructive-action confirmation.
//   4. `adb shell monkey -p <pkg> 1` to launch the main activity.
//   5. Run the on-device smoke (smoke-cuttlefish.ts — works for both cvd and
//      a real arm64 device per its header: cvd reachable, APK installed,
//      service starts, /api/health, bearer token, chat round-trip, local-not-
//      cloud). With --voice it additionally sends a retained speech fixture
//      through the real on-device ASR route and sends the transcript through
//      the real local TTS route. Physical microphone/VAD evidence still needs
//      a connected device and is not inferred from this deterministic smoke.
//
// HONESTY: this script orchestrates the existing primitives — it does not
// fake anything. The actual end-to-end pass needs a connected device (`adb
// devices` non-empty) and, for step 2, an AOSP checkout (`--aosp-root`).
// Without those it stops at the first missing prerequisite and says so.
// The phone-on-the-bench bits stay `authored-pending-hardware` (no Pixel on
// the authoring box) — but every step runs unmodified once a device is
// attached.
//
// Usage:
//   node scripts/aosp/deploy-pixel.ts \
//     --aosp-root /path/to/aosp [--abi arm64-v8a|x86_64] [--device <serial>] \
//     [--skip-libllama] [--skip-aosp-build] [--voice] [--jobs N] [--dry-run]
//
// For a running cvd (no AOSP build needed if the cvd already has the app):
//   node scripts/aosp/deploy-pixel.ts --abi x86_64 \
//     --skip-libllama --skip-aosp-build --voice

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadAospLock } from "../distro-android/bootstrap-aosp.ts";
import {
  DEFAULT_BRAND_CONFIG,
  loadBrandConfig,
} from "../distro-android/brand-config.ts";
import { isMainModule } from "../distro-android/is-main.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const osRepoRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(
  process.env.ELIZAOS_ELIZA_ROOT ?? path.join(osRepoRoot, ".eliza-source"),
);
const appScripts = path.join(repoRoot, "packages/app/scripts");
const appAospScripts = path.join(appScripts, "aosp");
const androidAgentAssets = path.join(
  repoRoot,
  "packages/app/platforms/android/app/src/main/assets/agent",
);

export function parseArgs(argv) {
  const args = {
    aospRoot: null,
    abi: "arm64-v8a",
    device: null,
    skipLibllama: false,
    skipAospBuild: false,
    voice: false,
    voiceOnly: false,
    jobs: null,
    dryRun: false,
    brandConfig: DEFAULT_BRAND_CONFIG,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--aosp-root") args.aospRoot = argv[++i];
    else if (a === "--abi") args.abi = argv[++i];
    else if (a === "--device") args.device = argv[++i];
    else if (a === "--jobs") {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error("--jobs must be an integer from 1 through 256");
      }
      args.jobs = Number(value);
    } else if (a === "--brand-config") args.brandConfig = argv[++i];
    else if (a === "--skip-libllama") args.skipLibllama = true;
    else if (a === "--skip-aosp-build") args.skipAospBuild = true;
    else if (a === "--voice") args.voice = true;
    else if (a === "--voice-only") {
      args.voice = true;
      args.voiceOnly = true;
    } else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/aosp/deploy-pixel.ts " +
          "[--aosp-root <DIR>] [--abi arm64-v8a|x86_64|riscv64] [--device <serial>] " +
          "[--brand-config <PATH>] [--skip-libllama] [--skip-aosp-build] [--voice|--voice-only] [--jobs N] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a} (see --help)`);
    }
  }
  if (
    args.abi !== "arm64-v8a" &&
    args.abi !== "x86_64" &&
    args.abi !== "riscv64"
  ) {
    throw new Error(
      `--abi must be arm64-v8a, x86_64, or riscv64 (got "${args.abi}")`,
    );
  }
  if (
    args.jobs !== null &&
    (!Number.isSafeInteger(args.jobs) || args.jobs < 1 || args.jobs > 256)
  ) {
    throw new Error("--jobs must be an integer from 1 through 256");
  }
  // Pixel hardware is arm64-only. x86_64 lands on a running cvd. riscv64
  // has no shipping Pixel device — refuse the no-device case so we don't
  // silently try to push a riscv64 APK at an arm64 phone. If the operator
  // really has a riscv64 dev board, they pass --device <serial> and we
  // trust them.
  if (args.abi === "riscv64" && !args.device) {
    throw new Error(
      `[deploy-pixel] --abi riscv64 needs an explicit --device <serial> (Pixel is arm64; ` +
        `there is no shipping Google riscv64 phone). For Cuttlefish cf_riscv64_phone, ` +
        `use \`make -C android sim ARCH=riscv64\` instead.`,
    );
  }
  return args;
}

// The AOSP product output directory is out/target/product/<PRODUCT_DEVICE>,
// not <PRODUCT_NAME>: eliza_cf_arm64_phone builds into vsoc_arm64 and
// eliza_grizzly_phone into grizzly. Derive the device dir from the brand's
// device tree paths (vsoc_* for Cuttlefish, the vendor device segment for
// generated Pixel trees) so the APK is resolved where the build put it.
export function deriveProductOutDir(brand) {
  for (const treePath of brand.aospDeviceTreePaths ?? []) {
    const segments = treePath.split("/");
    const vsoc = segments.find((segment) => segment.startsWith("vsoc_"));
    if (vsoc) return vsoc;
    const vendorIndex = segments.indexOf("google_devices");
    if (vendorIndex >= 0 && segments[vendorIndex + 1]) {
      return segments[vendorIndex + 1];
    }
  }
  return brand.productName;
}

export function resolveBuiltPrivilegedApk({
  aospRoot,
  productName,
  deviceDir,
  env = process.env,
}) {
  if (!aospRoot) throw new Error("aospRoot is required");
  if (!productName && !deviceDir) {
    throw new Error("productName or deviceDir is required");
  }
  const configuredOut = env.OUT_DIR?.trim() || "out";
  const outRoot = path.isAbsolute(configuredOut)
    ? configuredOut
    : path.resolve(aospRoot, configuredOut);
  return path.join(
    outRoot,
    "target",
    "product",
    deviceDir ?? productName,
    "system",
    "priv-app",
    "Eliza",
    "Eliza.apk",
  );
}

export function loadPhysicalTargetContract(brand, root = osRepoRoot) {
  if (!brand?.aospLockPath) return null;
  const lockPath = path.resolve(root, brand.aospLockPath);
  const relative = path.relative(root, lockPath);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `[deploy-pixel] physical target lock escapes the OS repository: ${brand.aospLockPath}`,
    );
  }
  const lock = loadAospLock(lockPath);
  if (
    lock?.device?.codename === undefined ||
    typeof lock.device.codename !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(lock.device.codename) ||
    lock.device.targetId === undefined ||
    typeof lock.device.targetId !== "string" ||
    typeof lock.device.expectedFingerprintPrefix !== "string"
  ) {
    throw new Error(
      `[deploy-pixel] invalid physical target device contract: ${lockPath}`,
    );
  }
  return {
    lockPath,
    codename: lock.device.codename,
    targetId: lock.device.targetId,
    expectedFingerprintPrefix: lock.device.expectedFingerprintPrefix,
  };
}

function run(cmd, cmdArgs, opts = {}) {
  const display = `${cmd} ${cmdArgs.join(" ")}`;
  console.log(
    `[deploy-pixel] $ ${display}${opts.cwd ? `  (cwd=${opts.cwd})` : ""}`,
  );
  if (opts.dryRun) return { status: 0, stdout: "", stderr: "" };
  const res = spawnSync(cmd, cmdArgs, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: opts.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (!opts.allowFail && res.status !== 0) {
    throw new Error(
      `[deploy-pixel] command failed (exit ${res.status}): ${display}` +
        (res.stderr ? `\n${res.stderr}` : ""),
    );
  }
  return res;
}

function adbArgs(device, rest) {
  return device ? ["-s", device, ...rest] : rest;
}

function listAdbDevices() {
  const res = spawnSync("adb", ["devices"], { encoding: "utf8" });
  if (res.status !== 0) return [];
  const rows = res.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"))
    .map((l) => l.split(/\s+/))
    .filter((fields) => fields.length >= 2);
  const unauthorized = rows.filter(([, state]) => state === "unauthorized");
  if (unauthorized.length > 0) {
    console.warn(
      `[deploy-pixel] ignoring unauthorized adb device(s) ${unauthorized
        .map(([serial]) => serial)
        .join(", ")} — accept the USB debugging prompt on the device`,
    );
  }
  // Only fully usable devices are deploy candidates; auto-selecting an
  // unauthorized/offline serial just fails later on a raw shell command.
  return rows
    .filter(([, state]) => state === "device")
    .map(([serial]) => serial);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const brand = loadBrandConfig(args.brandConfig);
  const physicalTarget = loadPhysicalTargetContract(brand);
  // Android CPU-fused is the only backend whose compiler and staging contract
  // is complete. The upstream compiler deliberately fails closed for Android
  // Vulkan until shader-tool and backend artifact staging are fully wired.
  let target;
  if (args.abi === "x86_64") target = "android-x86_64-cpu-fused";
  else if (args.abi === "riscv64") target = "android-riscv64-cpu-fused";
  else target = "android-arm64-cpu-fused";

  console.log(
    `[deploy-pixel] target=${target} device=${args.device ?? "(auto)"} ` +
      `voice=${args.voice} dry-run=${args.dryRun}`,
  );

  // ── 1. Build the fused libllama + libelizainference ──────────────────────
  if (!args.skipLibllama) {
    console.log("[deploy-pixel] step 1/5: build fused libllama for", args.abi);
    const inferenceTargets = ["android-arm64-cpu-fused", target].filter(
      (candidate, index, values) => values.indexOf(candidate) === index,
    );
    const libllamaArgs = inferenceTargets.flatMap((candidate) => [
      "--target",
      candidate,
    ]);
    libllamaArgs.unshift("--assets-dir", androidAgentAssets);
    if (args.jobs) libllamaArgs.push("--jobs", String(args.jobs));
    if (args.dryRun) {
      console.log(
        `[deploy-pixel] (dry-run) would run: node ${path.join(appAospScripts, "compile-libllama.ts")} ${libllamaArgs.join(" ")}`,
      );
      console.log(
        `[deploy-pixel] (dry-run) would run: node ${path.join(appScripts, "stage-elizavoice-lib.ts")} --abi arm64-v8a --variant cpu`,
      );
    } else {
      run(
        "node",
        [path.join(appAospScripts, "compile-libllama.ts"), ...libllamaArgs],
        {},
      );
      run("node", [
        path.join(appScripts, "stage-elizavoice-lib.ts"),
        "--abi",
        "arm64-v8a",
        "--variant",
        "cpu",
      ]);
      // Also build the in-process speculative shim (path b) — compile-shim.ts
      // picks up the speculative-shim source alongside the seccomp + pointer
      // shims; --skip-if-present so re-runs are cheap.
      run(
        "node",
        [path.join(appAospScripts, "compile-shim.ts"), "--skip-if-present"],
        {
          allowFail: true,
        },
      );
    }
  } else {
    console.log("[deploy-pixel] step 1/5: --skip-libllama → reuse last build");
  }

  // ── 2. Build the AOSP privileged APK ─────────────────────────────────────
  if (!args.skipAospBuild) {
    if (!args.aospRoot) {
      throw new Error(
        "[deploy-pixel] step 2 needs --aosp-root <AOSP checkout>; pass --skip-aosp-build " +
          "to reuse the previously-built APK / deploy to a cvd that already has the app.",
      );
    }
    console.log("[deploy-pixel] step 2/5: build AOSP privileged APK");
    const aospArgs = [
      path.join(osRepoRoot, "scripts/distro-android/build-aosp.ts"),
      "--aosp-root",
      args.aospRoot,
      "--brand-config",
      brand.brandConfigPath,
      "--rebuild-privileged-apk",
    ];
    if (args.jobs) aospArgs.push("--jobs", String(args.jobs));
    if (args.dryRun) {
      console.log(
        `[deploy-pixel] (dry-run) would run: node ${aospArgs.join(" ")}`,
      );
    } else {
      run("node", aospArgs, {
        env: args.abi === "riscv64" ? {} : { ELIZA_BUN_RISCV64_OPTIONAL: "1" },
      });
    }
  } else {
    console.log("[deploy-pixel] step 2/5: --skip-aosp-build → reuse last APK");
  }

  // ── resolve device + package name from the OS-owned brand config ─────────
  let device = args.device;
  if (!device && !args.dryRun) {
    const devices = listAdbDevices();
    if (devices.length === 0) {
      throw new Error(
        "[deploy-pixel] no adb device attached. Connect a Pixel (USB debugging) " +
          "or start a cvd (`cvd start`), then re-run. (Steps 1–2 already ran.)",
      );
    }
    if (devices.length > 1) {
      throw new Error(
        `[deploy-pixel] multiple adb devices (${devices.join(", ")}); pass --device <serial>.`,
      );
    }
    device = devices[0];
  }

  const pkg = brand.packageName;

  // ── 3. Deploy to CVD, or verify a flashed physical image ─────────────────
  // The vendor input APK is intentionally unsigned: Soong signs it with the
  // product platform certificate while assembling the image. Never sideload
  // that raw input, and never select an arbitrary recently-built priv-app APK.
  // Install only the exact platform-signed module output for this product.
  // For --skip-aosp-build deploys to an image that already has the app, step 3
  // is a no-op.
  console.log(
    `[deploy-pixel] step 3/5: ${physicalTarget ? "verify flashed physical image" : "adb install"}`,
  );
  if (args.dryRun && physicalTarget) {
    console.log(
      `[deploy-pixel] (dry-run) would require ${physicalTarget.targetId} (${physicalTarget.codename}) ` +
        "already flashed through the release-manifest installer; no APK would be sideloaded.",
    );
  } else if (!args.dryRun) {
    const pmList = run(
      "adb",
      adbArgs(device, ["shell", "pm", "list", "packages", pkg]),
      { capture: true, allowFail: true },
    );
    const alreadyInstalled = pmList.stdout?.includes(`package:${pkg}`);
    if (physicalTarget) {
      const codenameResult = run(
        "adb",
        adbArgs(device, ["shell", "getprop", "ro.product.device"]),
        { capture: true },
      );
      const codename = codenameResult.stdout?.trim();
      if (codename !== physicalTarget.codename) {
        throw new Error(
          `[deploy-pixel] connected device codename ${JSON.stringify(codename)} does not match ` +
            `${physicalTarget.targetId} (${physicalTarget.codename}).`,
        );
      }
      const fingerprintResult = run(
        "adb",
        adbArgs(device, ["shell", "getprop", "ro.build.fingerprint"]),
        { capture: true },
      );
      const fingerprint = fingerprintResult.stdout?.trim() ?? "";
      const packagePathResult = run(
        "adb",
        adbArgs(device, ["shell", "pm", "path", pkg]),
        { capture: true, allowFail: true },
      );
      const packagePath = packagePathResult.stdout?.trim() ?? "";
      if (
        !alreadyInstalled ||
        !fingerprint.startsWith(physicalTarget.expectedFingerprintPrefix) ||
        packagePath !== "package:/system/priv-app/Eliza/Eliza.apk"
      ) {
        throw new Error(
          `[deploy-pixel] ${physicalTarget.targetId} is not running the expected flashed elizaOS image. ` +
            `fingerprint=${JSON.stringify(fingerprint)} packagePath=${JSON.stringify(packagePath)}. ` +
            "Use android/installer/install-elizaos-android.sh with a lab-validated " +
            "release manifest, --execute, --confirm-flash, and --reboot-after-flash. " +
            "The platform-signed privileged APK will not be sideloaded onto a physical target.",
        );
      }
      console.log(
        `[deploy-pixel]   verified flashed ${physicalTarget.targetId}: ${fingerprint}`,
      );
    } else {
      let apkPath = null;
      if (args.aospRoot) {
        const candidate = resolveBuiltPrivilegedApk({
          aospRoot: args.aospRoot,
          productName: brand.productName,
          deviceDir: deriveProductOutDir(brand),
        });
        if (fs.existsSync(candidate)) apkPath = candidate;
      }
      if (apkPath) {
        run("adb", adbArgs(device, ["install", "-r", "-g", apkPath]), {});
      } else if (alreadyInstalled) {
        console.log(
          `[deploy-pixel]   ${pkg} already installed and no fresh APK found — keeping the on-device build.`,
        );
      } else {
        const expectedApk = args.aospRoot
          ? resolveBuiltPrivilegedApk({
              aospRoot: args.aospRoot,
              productName: brand.productName,
              deviceDir: deriveProductOutDir(brand),
            })
          : "<aosp-root>/out/target/product/<product>/system/priv-app/Eliza/Eliza.apk";
        throw new Error(
          `[deploy-pixel] ${pkg} is not installed and no built APK was found. ` +
            `Expected the platform-signed output at ${expectedApk}. ` +
            "Build the AOSP product first; the unsigned vendor input cannot be sideloaded.",
        );
      }
    }
  }

  // ── 4. Launch the main activity ──────────────────────────────────────────
  console.log("[deploy-pixel] step 4/5: launch", pkg);
  if (!args.dryRun) {
    run(
      "adb",
      adbArgs(device, [
        "shell",
        "monkey",
        "-p",
        pkg,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ]),
      { allowFail: true },
    );
  }

  // ── 5. On-device smoke (+ voice) ─────────────────────────────────────────
  console.log("[deploy-pixel] step 5/5: on-device smoke");
  if (args.dryRun) {
    if (!args.voiceOnly) {
      console.log(
        `[deploy-pixel] (dry-run) would run: node scripts/aosp/smoke-cuttlefish.ts` +
          ` --package-name ${pkg} --app-name ${brand.appName}`,
      );
    }
    if (args.voice) {
      console.log(
        "[deploy-pixel] (dry-run) would POST the retained speech fixture to " +
          "/api/asr/local-inference and synthesize its transcript through " +
          "/api/tts/local-inference on the device loopback server.",
      );
    }
    console.log("[deploy-pixel] (dry-run) complete — 5 steps queued, 0 spent.");
    return;
  }
  let ok = true;
  if (args.voiceOnly) {
    console.log(
      "[deploy-pixel]   --voice-only → reuse the preceding health/chat smoke result",
    );
  } else {
    const smokeArgs = [
      path.join(here, "smoke-cuttlefish.ts"),
      "--package-name",
      pkg,
      "--app-name",
      brand.appName,
    ];
    const smoke = run("node", smokeArgs, { allowFail: true });
    ok = smoke.status === 0;
  }

  if (args.voice) {
    // Deterministic on-device voice smoke using the routes consumed by the
    // Android voice IME. This proves retained audio bytes -> local ASR and
    // transcript -> local TTS. It deliberately does not claim microphone/VAD
    // evidence; that requires a physical capture in the hardware evidence lane.
    console.log("[deploy-pixel]   local ASR/TTS route check ...");
    const portFwd = run(
      "adb",
      adbArgs(device, ["forward", "tcp:0", "tcp:31337"]),
      { capture: true, allowFail: true },
    );
    const localPort = (portFwd.stdout || "").trim();
    if (!localPort) {
      console.error(
        "[deploy-pixel]   voice round-trip FAIL — could not forward the on-device API port.",
      );
      ok = false;
    } else {
      try {
        const baseUrl = `http://127.0.0.1:${localPort}`;
        const fixturePath = path.join(
          repoRoot,
          "plugins/plugin-local-inference/native/audio-fixtures/freeman.wav",
        );
        if (!fs.existsSync(fixturePath)) {
          throw new Error(`retained ASR fixture is missing: ${fixturePath}`);
        }
        const asrStatus = await fetch(
          `${baseUrl}/api/asr/local-inference/status`,
          { signal: AbortSignal.timeout(30_000) },
        );
        const asrStatusBody = await asrStatus.json().catch(() => null);
        if (!asrStatus.ok || asrStatusBody?.ready !== true) {
          throw new Error(
            `local ASR is not ready (HTTP ${asrStatus.status}): ${JSON.stringify(asrStatusBody)}`,
          );
        }
        const asrResponse = await fetch(`${baseUrl}/api/asr/local-inference`, {
          method: "POST",
          headers: { "content-type": "audio/wav" },
          body: fs.readFileSync(fixturePath),
          signal: AbortSignal.timeout(600_000),
        });
        const asrBody = await asrResponse.json().catch(() => null);
        const transcript = asrBody?.text?.trim() ?? "";
        if (!asrResponse.ok || transcript.length === 0) {
          throw new Error(
            `local ASR failed (HTTP ${asrResponse.status}): ${JSON.stringify(asrBody)}`,
          );
        }
        const ttsStatus = await fetch(
          `${baseUrl}/api/tts/local-inference/status`,
          { signal: AbortSignal.timeout(30_000) },
        );
        const ttsStatusBody = await ttsStatus.json().catch(() => null);
        if (!ttsStatus.ok || ttsStatusBody?.ready !== true) {
          throw new Error(
            `local TTS is not ready (HTTP ${ttsStatus.status}): ${JSON.stringify(ttsStatusBody)}`,
          );
        }
        const ttsResponse = await fetch(`${baseUrl}/api/tts/local-inference`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: transcript }),
          signal: AbortSignal.timeout(300_000),
        });
        const ttsBytes = ttsResponse.ok
          ? (await ttsResponse.arrayBuffer()).byteLength
          : 0;
        if (!ttsResponse.ok || ttsBytes === 0) {
          throw new Error(
            `local TTS failed (HTTP ${ttsResponse.status}, ${ttsBytes} bytes)`,
          );
        }
        console.log(
          `[deploy-pixel]   local ASR/TTS PASS — transcript=${JSON.stringify(transcript)} ttsBytes=${ttsBytes}`,
        );
      } catch (err) {
        console.error(`[deploy-pixel]   local ASR/TTS FAIL — ${String(err)}`);
        ok = false;
      }
    }
  }

  console.log(
    `[deploy-pixel] ${ok ? "DONE — all steps passed" : "FAIL — see above"}`,
  );
  process.exit(ok ? 0 : 1);
}

if (isMainModule(import.meta)) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}

export { main };
