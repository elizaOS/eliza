#!/usr/bin/env node
// Validate a booted AOSP system-app device or cuttlefish instance:
// confirms the privileged APK is installed, holds the required roles,
// has the documented permissions granted, and that the variant's
// product property and replacement intent resolvers are in place.
//
// Reads packageName + productName + variantName from `app.config.ts >
// aosp:`. Pass `--app-config <PATH>` to override the config location.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./lib/load-variant-config.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

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

/**
 * Build the per-variant property map. The vendor-specific
 * `<propertyPrefix>.boot_phase` property is set by the variant's
 * `init.<vendorDir>.rc`; the framework's `ro.setupwizard.mode` is
 * universal. propertyPrefix defaults to vendorDir for forks that
 * follow the common convention, but Milady-style forks (vendor dir
 * "milady", property namespace "miladyos") declare it separately.
 */
function requiredBootProperties(propertyPrefix) {
  return {
    "ro.setupwizard.mode": "DISABLED",
    // <propertyPrefix>.boot_phase is intentionally non-ro so
    // init.<vendorDir>.rc can re-set it at each phase. ro.* is
    // immutable after first set.
    [`${propertyPrefix}.boot_phase`]: "completed",
  };
}

/**
 * Build the per-variant logcat failure-pattern list. We scope every
 * pattern by the variant's package + vendor name so the validator
 * doesn't false-positive on stock AOSP cuttlefish noise (SystemUI
 * keyguard NPE, statsbootstrap avc denials, etc.).
 */
export function buildLogcatFailurePatterns({ packageName, vendorDir }) {
  const escPkg = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // ClassName prefix used by the variant's templated Java overlay
  // (e.g. `AcmeDialActivity`, `AcmeSmsReceiver` for a fork named
  // "acme"). Capitalize the vendor's first character — the AOSP
  // overlay pattern in
  // run-mobile-build.mjs:overlayAndroid() does the same.
  const classPrefix =
    vendorDir.length > 0
      ? vendorDir[0].toUpperCase() + vendorDir.slice(1).toLowerCase()
      : vendorDir;
  return [
    new RegExp(`FATAL EXCEPTION[^\\n]*${escPkg}`, "i"),
    new RegExp(`Process: ${escPkg}`, "i"),
    new RegExp(`SecurityException[^\\n]*(${classPrefix}|${escPkg})`, "i"),
    new RegExp(`${classPrefix}[A-Za-z]*Receiver[^\\n]*SecurityException`, "i"),
    new RegExp(
      `avc:\\s+denied[^\\n]*(scontext|tcontext)=u:[a-z_]*:${vendorDir}`,
      "i",
    ),
    /privapp-permissions/i,
    /Privileged permission.*not in privapp-permissions/i,
  ];
}

export function parseArgs(argv) {
  const args = {
    adb: process.env.ADB || null,
    serial: process.env.ANDROID_SERIAL || null,
    timeoutMs: 180_000,
    json: false,
    skipLogcat: false,
    appConfigPath: null,
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
    } else if (arg === "--app-config") {
      args.appConfigPath = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/boot-validate.mjs [--adb <ADB>] [--serial <SERIAL>] [--timeout-ms <MS>] [--json] [--skip-logcat] [--app-config <PATH>]",
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

function validateProductProperty(adb, serial, variant) {
  // The variant's `vendorDir` doubles as the system-property
  // namespace. e.g. `ro.acmeos.product` = "acme_cf_x86_64_phone"
  // on a fork called Acme.
  const propName = `ro.${variant.vendorDir}os.product`;
  const product = shell(adb, serial, `getprop ${propName}`);
  if (!product.startsWith(variant.productName)) {
    throw new Error(
      `${propName} must start with ${variant.productName}; found ${product || "<empty>"}`,
    );
  }
  return product;
}

function validateBootProperties(adb, serial, variant) {
  const properties = {};
  for (const [name, expected] of Object.entries(
    requiredBootProperties(variant.propertyPrefix ?? variant.vendorDir),
  )) {
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

function validatePackagePath(adb, serial, variant) {
  const pmPath = shell(adb, serial, `pm path ${variant.packageName}`);
  assertIncludes(
    pmPath,
    `/system/priv-app/${variant.appName}/`,
    `${variant.appName} package path`,
  );
  return pmPath;
}

function validateHomeResolution(adb, serial, variant) {
  const resolved = shell(
    adb,
    serial,
    "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME",
  );
  assertIncludes(resolved, variant.packageName, "HOME activity resolution");
  return resolved;
}

/**
 * For every system intent whose default app we stripped from
 * PRODUCT_PACKAGES, prove a variant activity is the resolver. Without
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

function validateReplacementIntents(adb, serial, variant) {
  const resolutions = {};
  for (const { label, args } of REPLACEMENT_INTENT_RESOLUTIONS) {
    const resolved = shell(
      adb,
      serial,
      `cmd package resolve-activity --brief ${args}`,
    );
    if (!resolved.includes(variant.packageName)) {
      throw new Error(
        `Intent "${label}" did not resolve to ${variant.packageName}; got:\n${resolved}`,
      );
    }
    resolutions[label] = resolved;
  }
  return resolutions;
}

function validateRoles(adb, serial, variant) {
  const roles = {};
  for (const role of REQUIRED_ROLES) {
    const holders = shell(adb, serial, `cmd role get-role-holders ${role}`);
    assertIncludes(holders, variant.packageName, `${role} holder list`);
    roles[role] = holders;
  }
  return roles;
}

function validatePackageFlagsAndPermissions(adb, serial, variant) {
  const dump = shell(adb, serial, `dumpsys package ${variant.packageName}`);
  assertMatches(
    dump,
    /pkgFlags=\[[^\]]*\bSYSTEM\b/i,
    `${variant.appName} package flags`,
  );
  assertMatches(
    dump,
    /privateFlags=\[[^\]]*\bPRIVILEGED\b/i,
    `${variant.appName} private flags`,
  );
  for (const permission of REQUIRED_GRANTED_PERMISSIONS) {
    assertMatches(
      dump,
      new RegExp(
        `${permission.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*granted=true`,
        "i",
      ),
      `${permission} grant`,
    );
  }
  return dump;
}

function validateAppOps(adb, serial, variant) {
  const usageStats = shell(
    adb,
    serial,
    `cmd appops get ${variant.packageName} GET_USAGE_STATS`,
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

function validateLogcat(adb, serial, variant) {
  const logcat = runAdb(adb, serial, ["logcat", "-d", "-v", "brief"]);
  const patterns = buildLogcatFailurePatterns({
    packageName: variant.packageName,
    vendorDir: variant.vendorDir,
  });
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

/**
 * Resolve the variant from the host's `app.config.ts` for callers that
 * use the JS API directly (e.g. `e2e-validate.mjs`). Throws when no
 * AOSP variant is declared — boot validation is meaningless without
 * one.
 */
export function loadVariantOrThrow({ appConfigPath }) {
  if (!fs.existsSync(appConfigPath)) {
    throw new Error(
      `[boot-validate] app.config.ts not found at ${appConfigPath}.`,
    );
  }
  const variant = loadAospVariantConfig({ appConfigPath });
  if (!variant) {
    throw new Error(
      `[boot-validate] No \`aosp:\` block in ${appConfigPath}; ` +
        `boot validation requires a variant.`,
    );
  }
  return variant;
}

export async function validateBootedDevice(options) {
  const adb = resolveAdb(options.adb);
  const serial = options.serial || null;

  // The variant can be passed in directly (test path / programmatic
  // caller) or resolved from disk (CLI path).
  const variant =
    options.variant ??
    loadVariantOrThrow({
      appConfigPath: resolveAppConfigPath({
        repoRoot,
        flagValue: options.appConfigPath,
      }),
    });

  await waitForBoot({ adb, serial, timeoutMs: options.timeoutMs });

  const result = {
    adb,
    serial,
    product: validateProductProperty(adb, serial, variant),
    bootProperties: validateBootProperties(adb, serial, variant),
    packagePath: validatePackagePath(adb, serial, variant),
    homeResolution: validateHomeResolution(adb, serial, variant),
    replacementIntents: validateReplacementIntents(adb, serial, variant),
    roles: validateRoles(adb, serial, variant),
    appOps: validateAppOps(adb, serial, variant),
    forbiddenPackages: validateForbiddenPackages(adb, serial),
    logcat: options.skipLogcat
      ? "skipped"
      : validateLogcat(adb, serial, variant),
  };

  validatePackageFlagsAndPermissions(adb, serial, variant);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await validateBootedDevice(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("[aosp:boot-validate] Booted device checks passed.");
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
