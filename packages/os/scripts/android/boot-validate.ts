#!/usr/bin/env node
/**
 * boot-validate.ts — Validate that a booted brand-AOSP device is healthy.
 *
 * Brand-aware. Reads brand config (package name, app name, classPrefix,
 * envPrefix, productName) and runs a series of adb checks:
 *   - Boot properties (ro.<envPrefix>.product, <envPrefix>.boot_phase, …)
 *   - Nonprivileged launcher install path (/product/app/<AppName>/ or, on a
 *     system-only GSI, /system/app/<AppName>/), SYSTEM and not PRIVILEGED
 *   - HOME and ASSISTANT role holders == brand package; HOME resolves to it
 *   - A stock system HOME remains installed as the recovery path
 *   - The reviewed first-boot grants are granted; no privileged permission is
 *   - Logcat scrubbed for brand-introduced FATAL / SecurityException / avc denied
 *
 * Dialer and SMS are not preassigned by the nonprivileged-launcher profile, so
 * their holders are recorded but not required.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.ts";
import { imageProduct, loadImagesPolicy } from "./image-launcher.ts";

const REQUIRED_ROLES = ["android.app.role.HOME", "android.app.role.ASSISTANT"];
/** Recorded only: the image leaves these with the stock apps. */
const RECORDED_ROLES = ["android.app.role.DIALER", "android.app.role.SMS"];

/** Declared by the APK, never granted to a nonprivileged launcher image. */
export const UNGRANTED_PRIVILEGED_PERMISSIONS = [
  "android.permission.MANAGE_APP_OPS_MODES",
  "android.permission.INJECT_EVENTS",
  "android.permission.READ_FRAME_BUFFER",
  "android.permission.REAL_GET_TASKS",
  "android.permission.MANAGE_VIRTUAL_MACHINE",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the brand-scoped logcat failure patterns. Stock AOSP cuttlefish
 * has its own boot noise that does not indicate a problem with this
 * brand — broad pattern matching there just creates false positives.
 * We scope each pattern to the brand's blast radius.
 */
function logcatFailurePatterns(brand) {
  const pkg = escapeRegExp(brand.packageName);
  const cls = escapeRegExp(brand.classPrefix);
  const lower = escapeRegExp(brand.brand);
  return [
    new RegExp(`FATAL EXCEPTION[^\\n]*${pkg}`, "i"),
    new RegExp(`Process: ${pkg}`, "i"),
    new RegExp(`SecurityException[^\\n]*(${cls}|${pkg})`, "i"),
    new RegExp(`${cls}[A-Za-z]*Receiver[^\\n]*SecurityException`, "i"),
    new RegExp(
      `avc:\\s+denied[^\\n]*(scontext|tcontext)=u:[a-z_]*:${lower}`,
      "i",
    ),
    /privapp-permissions/i,
    /Privileged permission.*not in privapp-permissions/i,
  ];
}

function brandBootProperties(brand) {
  // <propertyPrefix>.boot_phase is intentionally non-ro so init.<brand>.rc
  // can re-set it at each phase. ro.* is immutable after first set.
  return {
    "ro.setupwizard.mode": "DISABLED",
    [`${brand.propertyPrefix}.boot_phase`]: "completed",
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export function parseSubArgs(argv) {
  const args = {
    adb: process.env.ADB || null,
    serial: process.env.ANDROID_SERIAL || null,
    timeoutMs: 180_000,
    json: false,
    skipLogcat: false,
    expectedAbi: null,
  };

  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--adb") {
      args.adb = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--serial" || arg === "-s") {
      args.serial = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(readFlagValue(arg, i), 10);
      i += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--skip-logcat") {
      args.skipLogcat = true;
    } else if (arg === "--expected-abi") {
      args.expectedAbi = readFlagValue(arg, i);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/android/boot-validate.ts [--brand-config <PATH>] [--adb <ADB>] [--serial <SERIAL>] [--timeout-ms <MS>] [--json] [--skip-logcat] [--expected-abi <ABI>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }

  return args;
}

export function resolveAdb(explicitAdb = null) {
  if (explicitAdb) {
    if (!fs.existsSync(explicitAdb)) {
      throw new Error(`ADB does not exist: ${explicitAdb}`);
    }
    return explicitAdb;
  }

  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ].filter(Boolean);

  for (const sdkRoot of sdkRoots) {
    const candidate = path.join(sdkRoot, "platform-tools", "adb");
    if (fs.existsSync(candidate)) return candidate;
  }

  const result = spawnSync("adb", ["version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  if (!result.error) return "adb";

  throw new Error(
    "Could not find adb. Set --adb, ADB, ANDROID_HOME, or ANDROID_SDK_ROOT.",
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function adbArgs(serial, args) {
  return serial ? ["-s", serial, ...args] : args;
}

export function parseAdbDevicesOutput(output) {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/, 2))
    .filter(([serial, state]) => Boolean(serial && state))
    .map(([serial, state]) => ({ serial, state }));
}

export function selectBrandDeviceSerial(observations, expectedProduct) {
  const matches = observations.filter(
    ({ state, product }) => state === "device" && product === expectedProduct,
  );
  if (matches.length > 1) {
    throw new Error(
      `Multiple booted devices report the expected product ${expectedProduct}: ${matches
        .map(({ serial }) => serial)
        .join(", ")}`,
    );
  }
  return matches[0]?.serial ?? null;
}

function runAdb(adb, serial, args) {
  return run(adb, adbArgs(serial, args));
}

function shell(adb, serial, command) {
  return runAdb(adb, serial, ["shell", command]);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function probeProductProperty(adb, serial, property) {
  const result = spawnSync(
    adb,
    ["-s", serial, "shell", `getprop ${property}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    },
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

async function waitForBrandDevice({ adb, brand, deadline }) {
  const property = `ro.${brand.propertyPrefix}.product`;
  let observed = [];
  while (Date.now() < deadline) {
    observed = parseAdbDevicesOutput(run(adb, ["devices"]));
    const candidates = observed.map(({ serial, state }) => ({
      serial,
      state,
      product:
        state === "device" ? probeProductProperty(adb, serial, property) : null,
    }));
    const serial = selectBrandDeviceSerial(candidates, brand.productName);
    if (serial) return serial;
    await sleep(1_000);
  }
  const summary = observed.length
    ? observed.map(({ serial, state }) => `${serial} (${state})`).join(", ")
    : "none";
  throw new Error(
    `No adb device reported ${property}=${brand.productName} before timeout; observed: ${summary}`,
  );
}

async function waitForBoot({ adb, serial, deadline }) {
  runAdb(adb, serial, ["wait-for-device"]);
  while (Date.now() < deadline) {
    const completed = shell(adb, serial, "getprop sys.boot_completed").trim();
    if (completed === "1") {
      shell(adb, serial, "wm dismiss-keyguard");
      return;
    }
    await sleep(1_000);
  }
  throw new Error(
    `Device ${serial} did not report sys.boot_completed=1 before timeout`,
  );
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} does not include ${needle}`);
  }
}

function assertMatches(value, pattern, label) {
  if (!pattern.test(value)) {
    throw new Error(`${label} did not match ${pattern}`);
  }
}

/**
 * When `--expected-abi` is set, assert the device's CPU architecture
 * matches the abi/abilist/uname triad so a wrong-arch image fails closed
 * instead of passing the brand-level checks on the wrong CPU. When omitted,
 * the x86_64/arm64 callers are unaffected. This is the canonical home of
 * the Cuttlefish arch-triad assertion.
 */
function validateExpectedAbi(adb, serial, expectedAbi) {
  const abi = shell(adb, serial, "getprop ro.product.cpu.abi").trim();
  if (abi !== expectedAbi) {
    throw new Error(
      `ro.product.cpu.abi must be ${expectedAbi}; found ${abi || "<empty>"}`,
    );
  }
  const abilist = shell(adb, serial, "getprop ro.product.cpu.abilist").trim();
  if (!abilist.split(",").includes(expectedAbi)) {
    throw new Error(
      `ro.product.cpu.abilist must contain ${expectedAbi}; found ${abilist || "<empty>"}`,
    );
  }
  const unameM = shell(adb, serial, "uname -m").trim();
  if (unameM !== expectedAbi) {
    throw new Error(
      `uname -m must be ${expectedAbi}; found ${unameM || "<empty>"}`,
    );
  }
  return { abi, abilist, unameM };
}

function validateProductProperty(adb, serial, brand) {
  const prop = `ro.${brand.propertyPrefix}.product`;
  const product = shell(adb, serial, `getprop ${prop}`);
  if (product !== brand.productName) {
    throw new Error(
      `${prop} must be ${brand.productName}; found ${product || "<empty>"}`,
    );
  }
  return product;
}

function validateBootProperties(adb, serial, brand) {
  const expectedProps = brandBootProperties(brand);
  const properties = {};
  for (const [name, expected] of Object.entries(expectedProps)) {
    const actual = shell(adb, serial, `getprop ${name}`).trim();
    if (actual !== expected) {
      throw new Error(
        `${name} must be ${expected}; found ${actual || "<empty>"}`,
      );
    }
    properties[name] = actual;
  }
  return properties;
}

export function assertAndroidSetupState(settings) {
  for (const name of ["device_provisioned", "user_setup_complete"]) {
    if (settings[name] !== "1") {
      throw new Error(
        `${name} must be 1 when the setup wizard is disabled; found ${settings[name] || "<empty>"}`,
      );
    }
  }
  return settings;
}

function validateAndroidSetupState(adb, serial) {
  return assertAndroidSetupState({
    device_provisioned: shell(
      adb,
      serial,
      "settings get global device_provisioned",
    ).trim(),
    user_setup_complete: shell(
      adb,
      serial,
      "settings --user current get secure user_setup_complete",
    ).trim(),
  });
}

/** The exact nonprivileged install path from the reviewed image policy. */
export function assertLauncherPackagePath(pmPath, installPath) {
  const paths = pmPath
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length));
  if (paths.length !== 1 || paths[0] !== installPath) {
    throw new Error(
      `Launcher must be installed only at ${installPath}; found ${paths.join(", ") || "<none>"}`,
    );
  }
  if (/\/priv-app\//.test(paths[0]))
    throw new Error("Launcher must not be a priv-app");
  return paths[0];
}

function validatePackagePath(adb, serial, brand) {
  return assertLauncherPackagePath(
    shell(adb, serial, `pm path ${brand.packageName}`),
    imageProduct(loadImagesPolicy(), brand).installPath,
  );
}

function validateHomeResolution(adb, serial, brand) {
  const resolved = shell(
    adb,
    serial,
    "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME",
  );
  assertIncludes(resolved, brand.packageName, "HOME activity resolution");
  return resolved;
}

/**
 * Stock apps stay installed under the nonprivileged-launcher profile. At least
 * one system HOME activity from another package must remain as the recovery
 * path when the launcher is disabled or replaced.
 */
export function assertRecoveryHome(queryOutput, packageName) {
  const others = queryOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z][\w.]*\/[.A-Za-z][\w.$]*$/.test(line))
    .map((line) => line.split("/")[0])
    .filter((owner) => owner !== packageName);
  if (!others.length)
    throw new Error("No recovery HOME activity remains besides the launcher");
  return [...new Set(others)];
}

function validateRecoveryHome(adb, serial, brand) {
  return assertRecoveryHome(
    shell(
      adb,
      serial,
      "cmd package query-activities --brief --components -a android.intent.action.MAIN -c android.intent.category.HOME",
    ),
    brand.packageName,
  );
}

export function assertRoleHolders(holders, packageName) {
  for (const role of REQUIRED_ROLES) {
    const owners = String(holders[role] ?? "")
      .split(/[\s;,]+/)
      .filter(Boolean);
    if (!owners.includes(packageName))
      throw new Error(`${role} holder list does not include ${packageName}`);
  }
  return holders;
}

function validateRoles(adb, serial, brand) {
  const roles = {};
  for (const role of [...REQUIRED_ROLES, ...RECORDED_ROLES]) {
    roles[role] = shell(adb, serial, `cmd role get-role-holders ${role}`);
  }
  return assertRoleHolders(roles, brand.packageName);
}

/**
 * SYSTEM but not PRIVILEGED, the reviewed first-boot grants granted, and no
 * privileged permission granted.
 */
export function assertNonprivilegedPackageDump(
  dump,
  brand,
  defaultPermissions,
) {
  assertMatches(
    dump,
    /pkgFlags=\[[^\]]*\bSYSTEM\b/i,
    `${brand.appName} package flags`,
  );
  if (/privateFlags=\[[^\]]*\bPRIVILEGED\b/i.test(dump))
    throw new Error(`${brand.appName} must not be a privileged app`);
  for (const permission of defaultPermissions) {
    assertMatches(
      dump,
      new RegExp(`${escapeRegExp(permission)}[^\\n]*granted=true`, "i"),
      `${permission} grant`,
    );
  }
  for (const permission of UNGRANTED_PRIVILEGED_PERMISSIONS) {
    if (
      new RegExp(`${escapeRegExp(permission)}[^\\n]*granted=true`, "i").test(
        dump,
      )
    )
      throw new Error(`${permission} must not be granted to the launcher`);
  }
  return dump;
}

function validatePackageFlagsAndPermissions(adb, serial, brand) {
  return assertNonprivilegedPackageDump(
    shell(adb, serial, `dumpsys package ${brand.packageName}`),
    brand,
    loadImagesPolicy().defaultPermissions,
  );
}

function validateLogcat(adb, serial, brand) {
  const logcat = runAdb(adb, serial, ["logcat", "-d", "-v", "brief"]);
  const patterns = logcatFailurePatterns(brand);
  const failures = patterns.flatMap((pattern) =>
    logcat
      .split(/\r?\n/)
      .filter((line) => pattern.test(line))
      .slice(0, 20),
  );
  if (failures.length > 0) {
    throw new Error(
      `Boot log contains failure markers:\n${failures.join("\n")}`,
    );
  }
  return "clean";
}

export async function validateBootedDevice(options, brand) {
  const adb = resolveAdb(options.adb);
  const deadline = Date.now() + options.timeoutMs;
  const serial =
    options.serial || (await waitForBrandDevice({ adb, brand, deadline }));

  await waitForBoot({ adb, serial, deadline });

  const result = {
    adb,
    serial,
    product: validateProductProperty(adb, serial, brand),
    bootProperties: validateBootProperties(adb, serial, brand),
    setupState: validateAndroidSetupState(adb, serial),
    packagePath: validatePackagePath(adb, serial, brand),
    homeResolution: validateHomeResolution(adb, serial, brand),
    recoveryHome: validateRecoveryHome(adb, serial, brand),
    roles: validateRoles(adb, serial, brand),
    logcat: options.skipLogcat ? "skipped" : validateLogcat(adb, serial, brand),
    ...(options.expectedAbi
      ? { abi: validateExpectedAbi(adb, serial, options.expectedAbi) }
      : {}),
  };

  validatePackageFlagsAndPermissions(adb, serial, brand);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const args = parseSubArgs(remaining);
  const result = await validateBootedDevice(args, brand);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[distro-android:boot-validate] Booted ${brand.distroName} device checks passed.`,
    );
  }
}

if (import.meta.main) {
  await main();
}
