// Shared Android device helpers for the mobile e2e harness.
//
// Resolves adb / emulator / avdmanager cross-platform (ANDROID_HOME,
// ANDROID_SDK_ROOT, PATH, common macOS/Linux/Windows locations), boots an AVD
// on demand, installs/launches the app, wires adb port forwards, and discovers
// the debuggable WebView CDP target. All device-driving scripts (the local-chat
// smoke, the adb installer, the Playwright Android config) build on this so the
// SDK/adb resolution lives in exactly one place and runs on Linux CI, a mac, or
// Windows without hardcoded "~/Library/Android/sdk" paths.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WINDOWS = process.platform === "win32";
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..", "..");
const elizaRoot = path.resolve(here, "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// App identity (read from app.config.ts so this works for any white-labelled
// app, not just elizaOS).
// ---------------------------------------------------------------------------
function readAppConfigValue(key, fallback) {
  try {
    const source = fs.readFileSync(path.join(appDir, "app.config.ts"), "utf8");
    const match = source.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`));
    if (match) return match[1];
  } catch {
    // fall through to fallback
  }
  return fallback;
}

export const APP_ID =
  process.env.ELIZA_APP_ID?.trim() ||
  readAppConfigValue("appId", "ai.elizaos.app");
export const MAIN_ACTIVITY = `${APP_ID}/.MainActivity`;
/** Port the on-device agent serves its Hono API on (loopback). */
export const AGENT_API_PORT = 31337;

const APK_CANDIDATES = [
  path.join(
    elizaRoot,
    "packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk",
  ),
  path.join(appDir, "android/app/build/outputs/apk/debug/app-debug.apk"),
];

// ---------------------------------------------------------------------------
// SDK binary resolution
// ---------------------------------------------------------------------------
function sdkRoots() {
  const home = os.homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    IS_WINDOWS ? path.join(home, "AppData", "Local", "Android", "Sdk") : "",
    process.platform === "darwin"
      ? path.join(home, "Library", "Android", "sdk")
      : "",
    path.join(home, "Android", "Sdk"),
    "/usr/local/lib/android/sdk",
    "/opt/android-sdk",
  ].filter(Boolean);
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function probe(bin, args) {
  try {
    execFileSync(bin, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveSdkBinary({ name, subdirs, envOverride, probeArgs }) {
  const direct = envOverride ? process.env[envOverride] : undefined;
  if (direct && fs.existsSync(direct)) return direct;

  const exe = IS_WINDOWS ? `${name}.exe` : name;
  const bat = IS_WINDOWS ? `${name}.bat` : name;
  const candidates = [];
  for (const root of sdkRoots()) {
    for (const subdir of subdirs) {
      candidates.push(path.join(root, subdir, exe));
      if (bat !== exe) candidates.push(path.join(root, subdir, bat));
    }
  }
  const found = firstExisting(candidates);
  if (found) return found;

  const onPath = IS_WINDOWS ? `${name}.exe` : name;
  if (probe(onPath, probeArgs)) return onPath;
  return null;
}

export function resolveAdb() {
  const adb = resolveSdkBinary({
    name: "adb",
    subdirs: ["platform-tools"],
    envOverride: "ADB",
    probeArgs: ["version"],
  });
  if (!adb) {
    throw new Error(
      "adb not found. Install Android SDK platform-tools or set ANDROID_HOME / ANDROID_SDK_ROOT / ADB so adb is resolvable.",
    );
  }
  return adb;
}

export function resolveEmulator() {
  return resolveSdkBinary({
    name: "emulator",
    subdirs: ["emulator"],
    envOverride: "ANDROID_EMULATOR",
    probeArgs: ["-version"],
  });
}

// ---------------------------------------------------------------------------
// adb command helpers
// ---------------------------------------------------------------------------
export function adb(adbBin, args, options = {}) {
  return execFileSync(adbBin, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    ...options,
  });
}

export function adbDevice(adbBin, serial, args, options) {
  return adb(adbBin, ["-s", serial, ...args], options);
}

export function adbTry(adbBin, args, options = {}) {
  try {
    return adb(adbBin, args, options);
  } catch {
    return "";
  }
}

export function listDevices(adbBin) {
  return adbTry(adbBin, ["devices"])
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
}

export function resolveSerial(adbBin, requested) {
  if (requested) return requested;
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  const devices = listDevices(adbBin);
  if (devices.length === 0) {
    throw new Error(
      "No Android device/emulator in `device` state. Boot an emulator (or call ensureEmulatorBooted) or pass --serial.",
    );
  }
  // Prefer an emulator (the simulator/CI target) when several devices are
  // attached, so the harness doesn't accidentally drive a plugged-in phone.
  return devices.find((s) => s.startsWith("emulator-")) ?? devices[0];
}

/**
 * Connect Playwright's Android driver to a single device, selected by the same
 * rules as resolveSerial (explicit serial → emulator → first), and close the
 * others. `android` is the `_android` export from @playwright/test, passed in
 * so this lib stays free of a Playwright import for the non-Playwright scripts.
 */
export async function connectPlaywrightDevice(android, requestedSerial) {
  const devices = await android.devices();
  if (devices.length === 0) {
    throw new Error(
      "Playwright _android found no devices. Is adb on PATH / is a device attached?",
    );
  }
  const wanted = requestedSerial ?? process.env.ANDROID_SERIAL ?? null;
  let chosen;
  if (wanted) {
    chosen = devices.find((d) => d.serial() === wanted);
  } else {
    chosen =
      devices.find((d) => d.serial().startsWith("emulator-")) ?? devices[0];
  }
  for (const d of devices) {
    if (d !== chosen) await d.close().catch(() => {});
  }
  if (!chosen) {
    throw new Error(
      `No Playwright Android device with serial ${wanted}. Available: ${devices
        .map((d) => d.serial())
        .join(", ")}`,
    );
  }
  return chosen;
}

export function listAvds(emulatorBin) {
  if (!emulatorBin) return [];
  try {
    return execFileSync(emulatorBin, ["-list-avds"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bootCompleted(adbBin, serial) {
  return (
    adbTry(adbBin, [
      "-s",
      serial,
      "shell",
      "getprop",
      "sys.boot_completed",
    ]).trim() === "1"
  );
}

/**
 * Ensure a booted emulator is available. Reuses any already-attached device,
 * otherwise boots `avd` (or the first Pixel/available AVD) headless and waits
 * for boot completion. Returns the device serial. Throws loudly if no device
 * can be obtained (so a CI lane that should have an emulator fails visibly).
 */
/**
 * Suppress system error/ANR dialogs on the test device. On a software-GPU
 * emulator under load, the Pixel Launcher / SystemUI routinely ANR; the dialog
 * window then HOLDS INPUT FOCUS, so every `adb shell input` swipe/tap goes to
 * the dialog and the app under test receives ZERO input events (observed as
 * `mCurrentFocus=… Application Not Responding: …nexuslauncher` while a touch
 * spec's page recorder counted 0 events). Standard Android CI hardening.
 */
function suppressErrorDialogs(adbBin, serial, log = () => {}) {
  const ok = adbTry(adbBin, [
    "-s",
    serial,
    "shell",
    "settings",
    "put",
    "global",
    "hide_error_dialogs",
    "1",
  ]);
  if (ok) log(`error/ANR dialogs suppressed on ${serial}`);
}

export async function ensureEmulatorBooted({
  adb: adbBin = resolveAdb(),
  emulator = resolveEmulator(),
  avd,
  timeoutMs = 240_000,
  log = () => {},
} = {}) {
  const existing = listDevices(adbBin);
  if (existing.length > 0) {
    const serial = process.env.ANDROID_SERIAL ?? existing[0];
    log(`reusing attached device ${serial}`);
    suppressErrorDialogs(adbBin, serial, log);
    return serial;
  }

  if (!emulator) {
    throw new Error(
      "No emulator running and the `emulator` binary was not found. Install the Android SDK emulator or boot a device manually.",
    );
  }

  const avds = listAvds(emulator);
  const chosen = avd ?? avds.find((n) => /pixel/i.test(n)) ?? avds[0] ?? null;
  if (!chosen) {
    throw new Error(
      "No Android AVD configured. Create one with `avdmanager create avd` or Android Studio Device Manager.",
    );
  }

  log(`booting emulator AVD ${chosen}`);
  const logFile = path.join(os.tmpdir(), `eliza-emulator-${chosen}.log`);
  const out = fs.openSync(logFile, "a");
  // The embedded on-device agent (bun + a 1,270,808,512-byte GGUF) needs real
  // headroom; a stock 2GB AVD OOM-thrashes during model load/inference. Give
  // the test emulator 6GB RAM + 4 cores unless overridden.
  const memoryMb = process.env.ELIZA_EMULATOR_MEMORY_MB ?? "6144";
  const cores = process.env.ELIZA_EMULATOR_CORES ?? "4";
  // The on-device agent's bun + llama-cpp are compiled with -mavx2 -mfma -mf16c,
  // but the emulator's default CPU model hides those → SIGILL in llama on model
  // load. A hand-rolled `qemu64,+avx2,...` model satisfies llama but gives BUN an
  // inconsistent CPUID (minimal base + bolted-on leaves): bun's runtime init reads
  // CPUID and emits an instruction the synthetic model doesn't back, so bun dies
  // with an "invalid opcode" SIGILL ~1s in — BEFORE model load, 0-byte agent.log,
  // no tombstone (looks like an OOM but isn't). `-cpu host` (full KVM passthrough)
  // fixes both: the guest gets the REAL, self-consistent host CPUID and every
  // instruction executes natively on the host core, so bun boots ("WELCOME TO
  // ELIZA", plugin-sql + plugin-local-inference load) AND llama still sees AVX2.
  // Verified on a KVM host: `-cpu host` boots the agent; `qemu64,+avx2` SIGILLs.
  // Requires KVM (`-accel on` below); a TCG-only host must override this with a
  // synthetic model via ELIZA_EMULATOR_QEMU_CPU (and accept the bun fragility).
  // Must come last -- everything after `-qemu` is forwarded to qemu. macOS
  // arm64 emulator builds do not know the Linux/KVM-only `host` CPU model, so
  // keep that default to Linux and let other hosts use the emulator default
  // unless explicitly overridden.
  const qemuCpu =
    process.env.ELIZA_EMULATOR_QEMU_CPU ??
    (process.platform === "linux" ? "host" : "");
  const qemuArgs = qemuCpu ? ["-qemu", "-cpu", qemuCpu] : [];
  const child = spawn(
    emulator,
    [
      "-avd",
      chosen,
      "-no-window",
      "-no-snapshot-load",
      "-no-snapshot-save",
      "-no-boot-anim",
      "-no-audio",
      "-gpu",
      "swiftshader_indirect",
      "-memory",
      memoryMb,
      "-cores",
      cores,
      "-netdelay",
      "none",
      "-netspeed",
      "full",
      "-accel",
      "on",
      ...qemuArgs,
    ],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(3_000);
    const devices = listDevices(adbBin);
    if (devices.length > 0 && bootCompleted(adbBin, devices[0])) {
      log(`emulator ${devices[0]} boot completed (log: ${logFile})`);
      suppressErrorDialogs(adbBin, devices[0], log);
      return devices[0];
    }
  }
  throw new Error(
    `Emulator ${chosen} did not finish booting within ${timeoutMs}ms (log: ${logFile}).`,
  );
}

// ---------------------------------------------------------------------------
// App install / launch / forwards
// ---------------------------------------------------------------------------
export function resolveApk(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw new Error(`APK not found: ${resolved}`);
    return resolved;
  }
  const found = APK_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `No debug APK found. Build one first:\n  ELIZA_MOBILE_REPO_ROOT=${elizaRoot} ELIZA_WEBVIEW_DEBUG=1 bun run --cwd packages/app build:android\nLooked in:\n  ${APK_CANDIDATES.join("\n  ")}`,
    );
  }
  return found;
}

export function isInstalled(adbBin, serial) {
  return adbTry(adbBin, [
    "-s",
    serial,
    "shell",
    "pm",
    "list",
    "packages",
    APP_ID,
  ]).includes(APP_ID);
}

export function installApk(adbBin, serial, apk) {
  adbDevice(adbBin, serial, ["install", "-r", "-d", apk], { stdio: "inherit" });
}

export function clearAppData(adbBin, serial) {
  adbDevice(adbBin, serial, ["shell", "pm", "clear", APP_ID], {
    stdio: "inherit",
  });
}

export function launchApp(adbBin, serial) {
  adbDevice(adbBin, serial, ["shell", "am", "force-stop", APP_ID]);
  adbDevice(
    adbBin,
    serial,
    ["shell", "am", "start", "-W", "-n", MAIN_ACTIVITY],
    {
      stdio: "inherit",
    },
  );
}

/**
 * Bring the app to the foreground WITHOUT force-stopping it. Used by the
 * Playwright fixture so it doesn't tear down an established agent/device-bridge
 * connection just to attach to the WebView.
 */
export function foregroundApp(adbBin, serial) {
  adbDevice(adbBin, serial, ["shell", "am", "start", "-n", MAIN_ACTIVITY], {
    stdio: "pipe",
  });
}

export function appPid(adbBin, serial) {
  return adbTry(adbBin, ["-s", serial, "shell", "pidof", APP_ID]).trim();
}

/**
 * Make an emulator able to run the embedded on-device agent. On a stock image
 * the app runs as `untrusted_app`, and SELinux (enforcing) blocks the bundled
 * bun runtime's syscalls (e.g. ioctl on its log), so the agent never becomes
 * healthy. Branded AOSP devices run the agent privileged and don't need this;
 * for a test emulator we `adb root` + `setenforce 0`. No-op (best-effort) on
 * physical devices, which must already be branded/privileged.
 */
export async function ensureEmulatorPermissive(
  adbBin,
  serial,
  { log = () => {} } = {},
) {
  if (!serial.startsWith("emulator-")) {
    log(`skipping setenforce on non-emulator device ${serial}`);
    return false;
  }
  adbTry(adbBin, ["-s", serial, "root"], { stdio: "pipe" });
  await delay(2_000);
  adbTry(adbBin, ["-s", serial, "wait-for-device"]);
  adbTry(adbBin, ["-s", serial, "shell", "setenforce", "0"]);
  const mode = adbTry(adbBin, ["-s", serial, "shell", "getenforce"]).trim();
  log(`SELinux mode on ${serial}: ${mode || "unknown"}`);
  return /permissive/i.test(mode);
}

export function adbForward(adbBin, serial, localPort, remoteSpec) {
  adbTry(adbBin, ["-s", serial, "forward", "--remove", `tcp:${localPort}`], {
    stdio: "ignore",
  });
  adb(adbBin, ["-s", serial, "forward", `tcp:${localPort}`, remoteSpec]);
}

export function adbRemoveForward(adbBin, serial, localPort) {
  adbTry(adbBin, ["-s", serial, "forward", "--remove", `tcp:${localPort}`], {
    stdio: "ignore",
  });
}

export function forwardAgentApi(adbBin, serial, localPort = AGENT_API_PORT) {
  adbForward(adbBin, serial, localPort, `tcp:${AGENT_API_PORT}`);
  return localPort;
}

/**
 * adb reverse: make the device's `127.0.0.1:<devicePort>` connect to the host's
 * `<hostPort>`. Used to point the WebView at a real agent running on the dev
 * host (route coverage on an emulator where the embedded agent can't run).
 */
export function adbReverse(adbBin, serial, devicePort, hostPort = devicePort) {
  adbTry(adbBin, ["-s", serial, "reverse", "--remove", `tcp:${devicePort}`], {
    stdio: "ignore",
  });
  adb(adbBin, [
    "-s",
    serial,
    "reverse",
    `tcp:${devicePort}`,
    `tcp:${hostPort}`,
  ]);
}

export function forwardWebViewCdp(adbBin, serial, localPort, pid) {
  const resolvedPid = pid ?? appPid(adbBin, serial);
  if (!resolvedPid) {
    throw new Error("App process is not running; cannot forward WebView CDP.");
  }
  adbForward(
    adbBin,
    serial,
    localPort,
    `localabstract:webview_devtools_remote_${resolvedPid}`,
  );
  return localPort;
}

/**
 * Discover the debuggable WebView page target via the CDP /json endpoint.
 * Prefers the https://localhost Capacitor origin. Throws with a pointed
 * message if no target appears (the usual cause is an APK built without
 * ELIZA_WEBVIEW_DEBUG=1).
 */
export async function discoverWebViewTarget(
  localPort,
  { timeoutMs = 30_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${localPort}/json`).then(
        (res) => res.json(),
      );
      const pages = Array.isArray(targets)
        ? targets.filter((t) => t.type === "page" || t.webSocketDebuggerUrl)
        : [];
      const target =
        pages.find((t) => t.url?.startsWith("https://localhost")) ?? pages[0];
      if (target?.webSocketDebuggerUrl) return target;
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw new Error(
    `No debuggable WebView target on port ${localPort} within ${timeoutMs}ms. ` +
      "Was the APK built with ELIZA_WEBVIEW_DEBUG=1?" +
      (lastError ? ` Last error: ${lastError.message}` : ""),
  );
}

export { appDir, elizaRoot };
