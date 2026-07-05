#!/usr/bin/env node
/** Supports app-core build, packaging, or development orchestration for mobile auth simulator smoke mjs. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url, {
  fallbackToCwd: true,
});
const appDir = resolveMainAppDir(repoRoot, "app");
const HANDLER_RESULT_KEY = "eliza:mobile-auth-smoke:result";
const HANDLER_SMOKE_ID_PARAM = "mobileAuthSmokeId";

function parseArgs(argv) {
  const options = {
    platform: "both",
    registrationOnly: false,
    device: "booted",
    serial: process.env.ANDROID_SERIAL ?? "",
    path: "auth/callback",
    query: "state=simulator-oauth-state&code=simulator-oauth-code",
    url: "",
    smokeId:
      process.env.ELIZA_MOBILE_AUTH_SMOKE_ID ??
      `mobile-auth-${Date.now().toString(36)}`,
    handlerTimeoutMs: Number.parseInt(
      process.env.ELIZA_MOBILE_AUTH_HANDLER_TIMEOUT_MS ?? "30000",
      10,
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--platform":
        options.platform = argv[++index] ?? "";
        break;
      case "--registration-only":
        options.registrationOnly = true;
        break;
      case "--device":
        options.device = argv[++index] ?? "";
        break;
      case "--serial":
        options.serial = argv[++index] ?? "";
        break;
      case "--path":
        options.path = argv[++index] ?? "";
        break;
      case "--query":
        options.query = argv[++index] ?? "";
        break;
      case "--url":
        options.url = argv[++index] ?? "";
        break;
      case "--smoke-id":
        options.smokeId = argv[++index] ?? "";
        break;
      case "--handler-timeout-ms":
        options.handlerTimeoutMs = Number.parseInt(argv[++index] ?? "", 10);
        break;
      case "--help":
      case "-h":
        printUsageAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsageAndExit() {
  console.log(`usage: node mobile-auth-simulator-smoke.mjs [options]

Options:
  --platform ios|android|both   Platform to exercise. Default: both
  --registration-only           Validate native callback registration only
  --device <id|booted>          iOS simulator target. Default: booted
  --serial <adb-serial>         Android emulator/device serial
  --path <path>                 Callback path. Default: auth/callback
  --query <query>               Callback query. Default: state=...&code=...
  --url <url>                   Full callback URL override
  --smoke-id <id>               Unique handler result id. Default: generated
  --handler-timeout-ms <ms>     Wait for in-app handler result. Default: 30000`);
  process.exit(0);
}

function readAppIdentity() {
  const cfgPath = path.join(appDir, "app.config.ts");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`app.config.ts not found at ${cfgPath}`);
  }
  const src = fs.readFileSync(cfgPath, "utf8");
  const appId = src.match(/appId:\s*["']([^"']+)["']/)?.[1];
  const appName = src.match(/appName:\s*["']([^"']+)["']/)?.[1];
  const urlScheme = src.match(/urlScheme:\s*["']([^"']+)["']/)?.[1] ?? appId;
  if (!appId || !appName) {
    throw new Error("Could not parse appId/appName from app.config.ts");
  }
  return { appId, appName, urlScheme };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected native file to exist: ${filePath}`);
  }
}

function assertIosRegistration(app) {
  const plistPath = path.join(appDir, "ios", "App", "App", "Info.plist");
  assertFileExists(plistPath);
  const plist = fs.readFileSync(plistPath, "utf8");
  const schemeRe = new RegExp(
    `<key>CFBundleURLTypes</key>[\\s\\S]*?<string>${escapeRegExp(
      app.urlScheme,
    )}</string>`,
  );
  if (!schemeRe.test(plist)) {
    throw new Error(
      `iOS Info.plist does not register ${app.urlScheme} as a CFBundleURLTypes scheme: ${plistPath}`,
    );
  }
  return { platform: "ios", file: plistPath, scheme: app.urlScheme };
}

function assertAndroidRegistration(app) {
  const manifestPath = path.join(
    appDir,
    "android",
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  const stringsPath = path.join(
    appDir,
    "android",
    "app",
    "src",
    "main",
    "res",
    "values",
    "strings.xml",
  );
  assertFileExists(manifestPath);
  assertFileExists(stringsPath);

  const manifest = fs.readFileSync(manifestPath, "utf8");
  const strings = fs.readFileSync(stringsPath, "utf8");
  const mainActivity = manifest.match(
    /<activity\b(?=[\s\S]*?android:name="\.?MainActivity")[\s\S]*?<\/activity>/m,
  )?.[0];
  if (!mainActivity) {
    throw new Error(`Android MainActivity missing from ${manifestPath}`);
  }
  const stringsSchemeRe = new RegExp(
    `<string name="custom_url_scheme">${escapeRegExp(app.urlScheme)}</string>`,
  );
  const hasScheme =
    mainActivity.includes('android:scheme="@string/custom_url_scheme"') ||
    mainActivity.includes(`android:scheme="${app.urlScheme}"`);
  if (
    !mainActivity.includes("android.intent.action.VIEW") ||
    !mainActivity.includes("android.intent.category.DEFAULT") ||
    !mainActivity.includes("android.intent.category.BROWSABLE") ||
    !hasScheme ||
    (!stringsSchemeRe.test(strings) &&
      mainActivity.includes('android:scheme="@string/custom_url_scheme"'))
  ) {
    throw new Error(
      `Android MainActivity does not register the ${app.urlScheme} callback scheme: ${manifestPath}`,
    );
  }
  return { platform: "android", file: manifestPath, scheme: app.urlScheme };
}

function requestedPlatforms(platform) {
  switch (platform) {
    case "ios":
      return ["ios"];
    case "android":
      return ["android"];
    case "both":
      return ["ios", "android"];
    default:
      throw new Error(
        `Invalid --platform value "${platform}". Expected ios, android, or both.`,
      );
  }
}

function buildCallbackUrl(app, options) {
  if (options.url) {
    return withHandlerSmokeId(options.url, options.smokeId);
  }
  const callbackPath = options.path.replace(/^\/+/, "");
  const query = options.query.replace(/^\?/, "");
  return withHandlerSmokeId(
    `${app.urlScheme}://${callbackPath}${query ? `?${query}` : ""}`,
    options.smokeId,
  );
}

function withHandlerSmokeId(url, smokeId) {
  if (!smokeId) return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has(HANDLER_SMOKE_ID_PARAM)) {
    parsed.searchParams.set(HANDLER_SMOKE_ID_PARAM, smokeId);
  }
  return parsed.toString();
}

function runCommand(command, args, label) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? "";
    const stdout = error?.stdout?.toString?.() ?? "";
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${label} failed${detail ? `:\n${detail}` : ""}`);
  }
}

function tryRunCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runIosSimulator(app, url, options) {
  const device = options.device || "booted";
  const appContainer = runCommand(
    "xcrun",
    ["simctl", "get_app_container", device, app.appId, "app"],
    `iOS app lookup for ${app.appId}`,
  ).trim();
  let installedUrlTypes = "";
  try {
    installedUrlTypes = runCommand(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleURLTypes", path.join(appContainer, "Info.plist")],
      `iOS installed URL scheme lookup for ${app.appId}`,
    );
  } catch {
    installedUrlTypes = "";
  }
  if (!installedUrlTypes.includes(app.urlScheme)) {
    throw new Error(
      `Installed iOS app ${app.appId} does not include the ${app.urlScheme} URL scheme. Rebuild and reinstall the app on the simulator before rerunning this smoke test.`,
    );
  }
  runCommand(
    "xcrun",
    ["simctl", "launch", device, app.appId],
    `iOS app launch for ${app.appId}`,
  );
  runCommand(
    "xcrun",
    ["simctl", "openurl", device, url],
    `iOS callback openurl for ${url}`,
  );
  return { platform: "ios", device, openedUrl: url };
}

function preferenceNativeKeys(key) {
  return [`CapacitorStorage.${key}`, key];
}

function iosPreferencesDomainPath(device, appId) {
  const container = tryRunCommand("xcrun", [
    "simctl",
    "get_app_container",
    device,
    appId,
    "data",
  ]);
  if (!container) return null;
  return path.join(container, "Library", "Preferences", appId);
}

function readIosPreference(device, appId, key) {
  const nativeKeys = preferenceNativeKeys(key);
  const domainPath = iosPreferencesDomainPath(device, appId);
  if (domainPath) {
    const plist = `${domainPath}.plist`;
    if (fs.existsSync(plist)) {
      const json = tryRunCommand("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        plist,
      ]);
      if (json) {
        try {
          const parsed = JSON.parse(json);
          for (const nativeKey of nativeKeys) {
            if (typeof parsed[nativeKey] === "string") {
              return parsed[nativeKey];
            }
          }
        } catch {
          // Fall through to defaults read.
        }
      }
    }
    for (const nativeKey of nativeKeys) {
      const value = tryRunCommand("defaults", ["read", domainPath, nativeKey]);
      if (value !== null) return value;
    }
  }

  for (const nativeKey of nativeKeys) {
    const value = tryRunCommand("xcrun", [
      "simctl",
      "spawn",
      device,
      "defaults",
      "read",
      appId,
      nativeKey,
    ]);
    if (value !== null) return value;
  }
  return null;
}

function resolveAdb() {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME
      ? path.join(process.env.ANDROID_HOME, "platform-tools", "adb")
      : "",
    process.env.ANDROID_SDK_ROOT
      ? path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb")
      : "",
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    "adb",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      runCommand(candidate, ["version"], `adb check (${candidate})`);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("adb not found. Set ADB or ANDROID_HOME before running.");
}

function resolveAndroidSerial(adb, requestedSerial) {
  if (requestedSerial) return requestedSerial;
  const output = runCommand(adb, ["devices"], "adb devices");
  const devices = output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
  if (devices.length === 0) {
    throw new Error("No Android emulator/device is connected.");
  }
  return devices[0];
}

function shellSingleQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runAndroidSimulator(app, url, options) {
  const adb = resolveAdb();
  const serial = resolveAndroidSerial(adb, options.serial);
  runCommand(
    adb,
    [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      `${app.appId}/.MainActivity`,
    ],
    `Android app launch for ${app.appId}`,
  );
  const callbackCommand = [
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    shellSingleQuote(url),
    app.appId,
  ].join(" ");
  const output = runCommand(
    adb,
    ["-s", serial, "shell", callbackCommand],
    `Android callback intent for ${url}`,
  );
  if (
    !/Status:\s*ok/i.test(output) ||
    (!output.includes(`cmp=${app.appId}/`) &&
      !output.includes(`Activity: ${app.appId}/`))
  ) {
    throw new Error(
      `Android callback did not resolve to ${app.appId}. am start output:\n${output}`,
    );
  }
  return { platform: "android", serial, openedUrl: url };
}

function decodeXmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readAndroidPreference(adb, serial, appId, key) {
  const xml = tryRunCommand(adb, [
    "-s",
    serial,
    "shell",
    "run-as",
    appId,
    "cat",
    "shared_prefs/CapacitorStorage.xml",
  ]);
  if (!xml) return null;
  for (const nativeKey of preferenceNativeKeys(key)) {
    const keyPattern = escapeRegExp(nativeKey);
    const match = xml.match(
      new RegExp(`<string\\s+name="${keyPattern}">([\\s\\S]*?)</string>`),
    );
    if (match) return decodeXmlEntities(match[1]);
  }
  return null;
}

function parseHandlerResult(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function pollHandlerResult(readPreference, options, platform) {
  const deadline = Date.now() + options.handlerTimeoutMs;
  let lastRaw = "";
  while (Date.now() <= deadline) {
    lastRaw = readPreference(HANDLER_RESULT_KEY) ?? "";
    const parsed = parseHandlerResult(lastRaw);
    if (parsed?.smokeId === options.smokeId) {
      if (parsed.ok !== true || parsed.callbackHandled !== true) {
        throw new Error(
          `${platform} auth callback handler reported failure: ${lastRaw}`,
        );
      }
      if (parsed.classification !== "invalid-grant") {
        throw new Error(
          `${platform} auth callback handler did not classify synthetic code/state as invalid-grant: ${lastRaw}`,
        );
      }
      return parsed;
    }
    await sleep(500);
  }
  throw new Error(
    `${platform} auth callback handler did not write ${HANDLER_RESULT_KEY} for smokeId=${options.smokeId}. Last result: ${lastRaw || "<none>"}`,
  );
}

async function runPlatformSimulator(app, url, options, platform) {
  if (platform === "ios") {
    const delivery = runIosSimulator(app, url, options);
    const handlerResult = await pollHandlerResult(
      (key) => readIosPreference(delivery.device, app.appId, key),
      options,
      "iOS",
    );
    return { ...delivery, handlerResult };
  }

  const delivery = runAndroidSimulator(app, url, options);
  const adb = resolveAdb();
  const handlerResult = await pollHandlerResult(
    (key) => readAndroidPreference(adb, delivery.serial, app.appId, key),
    options,
    "Android",
  );
  return { ...delivery, handlerResult };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (
    !Number.isFinite(options.handlerTimeoutMs) ||
    options.handlerTimeoutMs <= 0
  ) {
    throw new Error("--handler-timeout-ms must be a positive number");
  }
  const app = readAppIdentity();
  const platforms = requestedPlatforms(options.platform);
  const registrationResults = platforms.map((platform) =>
    platform === "ios"
      ? assertIosRegistration(app)
      : assertAndroidRegistration(app),
  );
  const url = buildCallbackUrl(app, options);

  console.log(
    `[mobile-auth-smoke] ${app.appName} (${app.appId}) callback URL: ${url}`,
  );

  if (options.registrationOnly) {
    console.log(
      JSON.stringify(
        {
          appDir,
          app,
          registrationOnly: true,
          registrations: registrationResults,
        },
        null,
        2,
      ),
    );
    return;
  }

  const simulatorResults = [];
  for (const platform of platforms) {
    simulatorResults.push(
      await runPlatformSimulator(app, url, options, platform),
    );
  }

  console.log(
    JSON.stringify(
      {
        appDir,
        app,
        smokeId: options.smokeId,
        handlerResultKey: HANDLER_RESULT_KEY,
        registrations: registrationResults,
        simulators: simulatorResults,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
