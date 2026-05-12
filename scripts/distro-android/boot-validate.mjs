#!/usr/bin/env node
/**
 * boot-validate.mjs — Validate that a booted brand-AOSP device is healthy.
 *
 * Brand-aware. Reads brand config (package name, app name, classPrefix,
 * envPrefix, productName) and runs a series of adb checks:
 *   - Boot properties (ro.<envPrefix>.product, <envPrefix>.boot_phase, …)
 *   - Package install path (/system/priv-app/<AppName>/)
 *   - HOME / DIALER / SMS / ASSISTANT role holders == brand package
 *   - Replacement intent resolutions for stripped stock apps
 *   - Forbidden stock packages absent
 *   - Granted permissions and appops
 *   - Logcat scrubbed for brand-introduced FATAL / SecurityException / avc denied
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadBrandFromArgv } from "./brand-config.mjs";

const REQUIRED_ROLES = [
  "android.app.role.HOME",
  "android.app.role.DIALER",
  "android.app.role.SMS",
  "android.app.role.ASSISTANT",
];

const REQUIRED_GRANTED_PERMISSIONS = [
  "android.permission.READ_CONTACTS",
  "android.permission.WRITE_CONTACTS",
  "android.permission.CALL_PHONE",
  "android.permission.READ_PHONE_STATE",
  "android.permission.ANSWER_PHONE_CALLS",
  "android.permission.READ_CALL_LOG",
  "android.permission.WRITE_CALL_LOG",
  "android.permission.READ_SMS",
  "android.permission.SEND_SMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.RECEIVE_MMS",
  "android.permission.RECEIVE_WAP_PUSH",
  "android.permission.POST_NOTIFICATIONS",
];

const FORBIDDEN_STOCK_PACKAGES = [
  "com.android.browser",
  "com.android.calendar",
  "com.android.camera2",
  "com.android.contacts",
  "com.android.deskclock",
  "com.android.dialer",
  "com.android.email",
  "com.android.gallery3d",
  "com.android.launcher3",
  "com.android.managedprovisioning",
  "com.android.messaging",
  "com.android.music",
  "com.android.provision",
  "com.google.android.apps.messaging",
  "com.google.android.apps.nexuslauncher",
  "com.google.android.dialer",
  "com.google.android.setupwizard",
  "org.lineageos.trebuchet",
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
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/boot-validate.mjs [--brand-config <PATH>] [--adb <ADB>] [--serial <SERIAL>] [--timeout-ms <MS>] [--json] [--skip-logcat]",
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

function runAdb(adb, serial, args) {
  return run(adb, adbArgs(serial, args));
}

function shell(adb, serial, command) {
  return runAdb(adb, serial, ["shell", command]);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBoot({ adb, serial, timeoutMs }) {
  runAdb(adb, serial, ["wait-for-device"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const completed = shell(adb, serial, "getprop sys.boot_completed").trim();
    if (completed === "1") {
      shell(adb, serial, "wm dismiss-keyguard");
      return;
    }
    await sleep(1_000);
  }
  throw new Error(
    `Device did not report sys.boot_completed=1 within ${timeoutMs}ms`,
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

function validatePackagePath(adb, serial, brand) {
  const pmPath = shell(adb, serial, `pm path ${brand.packageName}`);
  assertIncludes(
    pmPath,
    `/system/priv-app/${brand.appName}/`,
    `${brand.appName} package path`,
  );
  return pmPath;
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
 * For every system intent whose default app we stripped from
 * PRODUCT_PACKAGES, prove a brand activity is the resolver. Without
 * these assertions a stripped phone could pass HOME/Dialer/SMS role
 * validation while silently failing to open URLs / set alarms / take
 * photos — exactly the regression class this list catches.
 */
const REPLACEMENT_INTENT_RESOLUTIONS = [
  {
    label: "VIEW http",
    args: '-a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "http://example.com"',
  },
  {
    label: "VIEW https",
    args: '-a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "https://example.com"',
  },
  {
    label: "STILL_IMAGE_CAMERA",
    args: "-a android.media.action.STILL_IMAGE_CAMERA",
  },
  {
    label: "IMAGE_CAPTURE",
    args: "-a android.media.action.IMAGE_CAPTURE",
  },
  {
    label: "SET_ALARM",
    args: "-a android.intent.action.SET_ALARM",
  },
  {
    label: "SHOW_ALARMS",
    args: "-a android.intent.action.SHOW_ALARMS",
  },
  {
    label: "APP_CONTACTS launcher",
    args: "-a android.intent.action.MAIN -c android.intent.category.APP_CONTACTS",
  },
  {
    label: "APP_CALENDAR launcher",
    args: "-a android.intent.action.MAIN -c android.intent.category.APP_CALENDAR",
  },
];

function validateReplacementIntents(adb, serial, brand) {
  const resolutions = {};
  for (const { label, args } of REPLACEMENT_INTENT_RESOLUTIONS) {
    const resolved = shell(
      adb,
      serial,
      `cmd package resolve-activity --brief ${args}`,
    );
    if (!resolved.includes(brand.packageName)) {
      throw new Error(
        `Intent "${label}" did not resolve to ${brand.packageName}; got:\n${resolved}`,
      );
    }
    resolutions[label] = resolved;
  }
  return resolutions;
}

function validateRoles(adb, serial, brand) {
  const roles = {};
  for (const role of REQUIRED_ROLES) {
    const holders = shell(adb, serial, `cmd role get-role-holders ${role}`);
    assertIncludes(holders, brand.packageName, `${role} holder list`);
    roles[role] = holders;
  }
  return roles;
}

function validatePackageFlagsAndPermissions(adb, serial, brand) {
  const dump = shell(adb, serial, `dumpsys package ${brand.packageName}`);
  assertMatches(
    dump,
    /pkgFlags=\[[^\]]*\bSYSTEM\b/i,
    `${brand.appName} package flags`,
  );
  assertMatches(
    dump,
    /privateFlags=\[[^\]]*\bPRIVILEGED\b/i,
    `${brand.appName} private flags`,
  );
  for (const permission of REQUIRED_GRANTED_PERMISSIONS) {
    assertMatches(
      dump,
      new RegExp(`${escapeRegExp(permission)}[^\\n]*granted=true`, "i"),
      `${permission} grant`,
    );
  }
  return dump;
}

function validateAppOps(adb, serial, brand) {
  const usageStats = shell(
    adb,
    serial,
    `cmd appops get ${brand.packageName} GET_USAGE_STATS`,
  );
  assertMatches(usageStats, /\ballow\b/i, "GET_USAGE_STATS appop");
  return { GET_USAGE_STATS: usageStats };
}

function validateForbiddenPackages(adb, serial) {
  // pm list packages prints one `package:<name>` per line. Use a Set of
  // exact lines instead of substring matching: without this, looking for
  // `com.android.contacts` matches the unrelated `com.android.contactspicker`
  // (the system contact-picker UI), and `com.android.music` matches
  // `com.android.musicfx` (the equalizer service).
  const installed = new Set(
    shell(adb, serial, "pm list packages")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("package:"))
      .map((line) => line.slice("package:".length)),
  );
  const installedForbidden = FORBIDDEN_STOCK_PACKAGES.filter((pkg) =>
    installed.has(pkg),
  );
  if (installedForbidden.length > 0) {
    throw new Error(
      `Forbidden stock packages are installed: ${installedForbidden.join(", ")}`,
    );
  }
  return installedForbidden;
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
  const serial = options.serial || null;

  await waitForBoot({ adb, serial, timeoutMs: options.timeoutMs });

  const result = {
    adb,
    serial,
    product: validateProductProperty(adb, serial, brand),
    bootProperties: validateBootProperties(adb, serial, brand),
    packagePath: validatePackagePath(adb, serial, brand),
    homeResolution: validateHomeResolution(adb, serial, brand),
    replacementIntents: validateReplacementIntents(adb, serial, brand),
    roles: validateRoles(adb, serial, brand),
    appOps: validateAppOps(adb, serial, brand),
    forbiddenPackages: validateForbiddenPackages(adb, serial),
    logcat: options.skipLogcat ? "skipped" : validateLogcat(adb, serial, brand),
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

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
