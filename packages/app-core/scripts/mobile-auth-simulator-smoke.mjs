#!/usr/bin/env node
/** Supports app-core build, packaging, or development orchestration for mobile auth simulator smoke mjs. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY = "eliza:auth-callback-smoke:request";
const IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY = "eliza:auth-callback-smoke:result";
const IOS_AUTH_CALLBACK_ATTEMPTS = Number.parseInt(
  process.env.IOS_AUTH_CALLBACK_SMOKE_ATTEMPTS ?? "60",
  10,
);
const IOS_AUTH_CALLBACK_DELAY_MS = Number.parseInt(
  process.env.IOS_AUTH_CALLBACK_SMOKE_DELAY_MS ?? "1000",
  10,
);

// Resolve the app directory this smoke should target. When this elizaOS
// checkout is nested inside a consumer monorepo that wraps it as `eliza/`,
// `resolveRepoRootFromImportMeta` (by design for consumer wrappers) walks up
// to the OUTER repo, so `resolveMainAppDir` audits the consumer's manifest
// and fires the consumer's URL scheme (e.g. `milady://auth/callback`) instead
// of this repo's `ai.elizaos.app` / `elizaos://`. Mirror the Android build
// lane's `ELIZA_MOBILE_REPO_ROOT` pin (run-mobile-build.mjs) and add an
// explicit `--app-dir` override so each repo's `test:sim:auth:*` lane
// deterministically targets its own app. Precedence:
//   --app-dir  >  ELIZA_MOBILE_REPO_ROOT  >  repo-root walk.
export function resolveTargetAppDir(cliAppDir) {
  if (cliAppDir) {
    return { appDir: path.resolve(cliAppDir), source: "--app-dir" };
  }
  const pinned = process.env.ELIZA_MOBILE_REPO_ROOT?.trim();
  if (pinned) {
    const pinnedRoot = path.resolve(pinned);
    return {
      appDir: resolveMainAppDir(pinnedRoot, "app"),
      source: "ELIZA_MOBILE_REPO_ROOT",
      repoRoot: pinnedRoot,
    };
  }
  const repoRoot = resolveRepoRootFromImportMeta(import.meta.url, {
    fallbackToCwd: true,
  });
  return {
    appDir: resolveMainAppDir(repoRoot, "app"),
    source: "repo-root-walk",
    repoRoot,
  };
}

export function parseArgs(argv) {
  const options = {
    platform: "both",
    registrationOnly: false,
    device: "booted",
    serial: process.env.ANDROID_SERIAL ?? "",
    path: "auth/callback",
    query: "state=simulator-oauth-state&code=simulator-oauth-code",
    url: "",
    appDir: "",
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
      case "--app-dir":
        options.appDir = argv[++index] ?? "";
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
  --app-dir <dir>               Pin the target app directory (overrides
                                ELIZA_MOBILE_REPO_ROOT and the repo-root walk)`);
  process.exit(0);
}

function readAppIdentity(appDir) {
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

function assertIosRegistration(app, appDir) {
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

function assertAndroidRegistration(app, appDir) {
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

export function buildCallbackUrl(app, options) {
  if (options.url) return options.url;
  const callbackPath = options.path.replace(/^\/+/, "");
  const query = options.query.replace(/^\?/, "");
  return `${app.urlScheme}://${callbackPath}${query ? `?${query}` : ""}`;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preferenceNativeKeys(key) {
  return [`CapacitorStorage.${key}`, key];
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

function iosPrefsDomainPath(device, appId) {
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

function writeIosPreference(device, appId, key, value) {
  for (const nativeKey of preferenceNativeKeys(key)) {
    runCommand(
      "xcrun",
      [
        "simctl",
        "spawn",
        device,
        "defaults",
        "write",
        appId,
        nativeKey,
        "-string",
        value,
      ],
      `iOS preference write for ${key}`,
    );
  }
}

function readIosPreference(device, appId, key) {
  const domainPath = iosPrefsDomainPath(device, appId);
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
          for (const nativeKey of preferenceNativeKeys(key)) {
            if (typeof parsed[nativeKey] === "string") return parsed[nativeKey];
          }
        } catch {
          // Fall through to defaults read.
        }
      }
    }
    for (const nativeKey of preferenceNativeKeys(key)) {
      const value = tryRunCommand("defaults", ["read", domainPath, nativeKey]);
      if (value !== null) return value;
    }
  }

  for (const nativeKey of preferenceNativeKeys(key)) {
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

function deleteIosPreference(device, appId, key) {
  for (const nativeKey of preferenceNativeKeys(key)) {
    tryRunCommand("xcrun", [
      "simctl",
      "spawn",
      device,
      "defaults",
      "delete",
      appId,
      nativeKey,
    ]);
  }
  const domainPath = iosPrefsDomainPath(device, appId);
  if (domainPath) {
    for (const nativeKey of preferenceNativeKeys(key)) {
      tryRunCommand("defaults", ["delete", domainPath, nativeKey]);
    }
  }
}

function flushIosPreferences(device) {
  tryRunCommand("xcrun", ["simctl", "spawn", device, "killall", "cfprefsd"]);
}

export function expectedAuthCallbackFromUrl(url) {
  const parsed = new URL(url);
  return {
    path: [parsed.host, parsed.pathname.replace(/^\/+|\/+$/g, "")]
      .filter(Boolean)
      .join("/"),
    state: parsed.searchParams.get("state") ?? "",
    code: parsed.searchParams.get("code") ?? "",
  };
}

function armIosAuthCallbackSmoke(device, app, url) {
  const expected = expectedAuthCallbackFromUrl(url);
  deleteIosPreference(device, app.appId, IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY);
  writeIosPreference(
    device,
    app.appId,
    IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY,
    JSON.stringify({
      expected,
      armedAt: new Date().toISOString(),
    }),
  );
  writeIosPreference(
    device,
    app.appId,
    IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY,
    JSON.stringify({
      ok: false,
      phase: "requested",
      expected,
      updatedAt: new Date().toISOString(),
    }),
  );
  flushIosPreferences(device);
  return expected;
}

async function pollIosAuthCallbackSmoke(device, app, expected) {
  let lastRaw = "";
  for (let attempt = 1; attempt <= IOS_AUTH_CALLBACK_ATTEMPTS; attempt += 1) {
    lastRaw =
      readIosPreference(
        device,
        app.appId,
        IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY,
      ) ?? "";
    if (lastRaw) {
      let parsed = null;
      try {
        parsed = JSON.parse(lastRaw);
      } catch {
        parsed = null;
      }
      if (parsed?.ok === true) {
        if (parsed.path !== expected.path) {
          throw new Error(
            `iOS auth callback path mismatch: expected ${expected.path}, got ${parsed.path}`,
          );
        }
        if (parsed.state !== expected.state || parsed.code !== expected.code) {
          throw new Error(
            `iOS auth callback query mismatch: expected state/code ${expected.state}/${expected.code}, got ${parsed.state}/${parsed.code}`,
          );
        }
        return parsed;
      }
      if (parsed?.phase === "failed" || parsed?.error) {
        throw new Error(`iOS auth callback smoke failed: ${lastRaw}`);
      }
    }
    await sleep(IOS_AUTH_CALLBACK_DELAY_MS);
  }
  throw new Error(
    `iOS auth callback smoke timed out after ${IOS_AUTH_CALLBACK_ATTEMPTS} attempts. Last result: ${lastRaw || "<none>"}`,
  );
}

async function runIosSimulator(app, url, options) {
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
  const expected = armIosAuthCallbackSmoke(device, app, url);
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
  const handled = await pollIosAuthCallbackSmoke(device, app, expected);
  return {
    platform: "ios",
    device,
    openedUrl: url,
    handled,
  };
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

// Parse the winning component from `cmd package resolve-activity` output.
// We invoke it with `--brief`, which prints the resolved component as a bare
// `<package>/<activity>` line (e.g. `ai.elizaos.app/.MainActivity`), or
// `No activity found` when nothing handles the intent. To stay robust across
// Android/adb versions we also accept the verbose `ResolveInfo` form:
//   `packageName=<pkg>` is the PACKAGE identity (preferred),
//   `name=<...>` is the ACTIVITY CLASS (NOT the package — must not be mistaken
//   for the package), and `<pkg>/<activity>` may also appear inline.
// Returns the resolved package identity (bare `<pkg>` or `<pkg>/<activity>`),
// or "" when unresolved. Pure so it is unit-testable without a device.
export function parseResolvedActivity(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // `--brief` line: a bare `<pkg>/<activity>` component (contains a `/`, no `=`).
  for (const line of lines) {
    if (
      line.includes("/") &&
      !line.includes("=") &&
      !/\s/.test(line) &&
      /^[A-Za-z0-9_.]+\//.test(line)
    ) {
      return line;
    }
  }
  // Verbose form: packageName= is authoritative for the package identity.
  const packageName = output.match(/\bpackageName=([^\s]+)/)?.[1];
  if (packageName) return packageName;
  // Verbose ResolveInfo often embeds the component as `<pkg>/<activity>` after
  // the flags; capture that (but NOT a bare `name=` activity class).
  const inlineComponent = output.match(
    /\b([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/,
  )?.[1];
  if (inlineComponent) return inlineComponent;
  return "";
}

// Whether a resolved component belongs to the expected package. Pure/testable.
export function resolvedActivityMatchesApp(resolvedName, appId) {
  return resolvedName.startsWith(`${appId}/`) || resolvedName === appId;
}

// Assert the deep link resolves to the EXPECTED package before we fire it.
// Without this the callback leg is effectively fire-and-forget: `am start`
// with a VIEW intent will happily launch whatever app claims the scheme, so
// a wrong-target run (consumer app registering the same-shaped scheme, or a
// nested-checkout mis-resolution) exits 0 silently. `cmd package
// resolve-activity` names the winning component up front so a mismatch fails
// loudly. Returns the resolved component string for the JSON result.
function assertAndroidResolvesToPackage(adb, serial, app, url) {
  const resolveCommand = [
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    shellSingleQuote(url),
  ].join(" ");
  const output = runCommand(
    adb,
    ["-s", serial, "shell", resolveCommand],
    `Android resolve-activity for ${url}`,
  );
  const resolvedName = parseResolvedActivity(output);
  if (!resolvedActivityMatchesApp(resolvedName, app.appId)) {
    throw new Error(
      `Android deep link ${url} does not resolve to ${app.appId} ` +
        `(resolved to "${resolvedName || "<none>"}"). resolve-activity output:\n${output}`,
    );
  }
  return resolvedName;
}

function runAndroidSimulator(app, url, options) {
  const adb = resolveAdb();
  const serial = resolveAndroidSerial(adb, options.serial);
  // Preflight: the scheme must resolve to OUR package, not a consumer app
  // that also claims it. Fails loudly on a wrong-target topology.
  const resolvedActivity = assertAndroidResolvesToPackage(
    adb,
    serial,
    app,
    url,
  );
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
  return {
    platform: "android",
    serial,
    openedUrl: url,
    resolvedActivity,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { appDir, source: appDirSource } = resolveTargetAppDir(options.appDir);
  const app = readAppIdentity(appDir);
  const platforms = requestedPlatforms(options.platform);
  const registrationResults = platforms.map((platform) =>
    platform === "ios"
      ? assertIosRegistration(app, appDir)
      : assertAndroidRegistration(app, appDir),
  );
  const url = buildCallbackUrl(app, options);

  console.log(
    `[mobile-auth-smoke] ${app.appName} (${app.appId}) scheme=${app.urlScheme} ` +
      `appDir=${appDir} (${appDirSource}) callback URL: ${url}`,
  );

  if (options.registrationOnly) {
    console.log(
      JSON.stringify(
        {
          appDir,
          appDirSource,
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
      platform === "ios"
        ? await runIosSimulator(app, url, options)
        : runAndroidSimulator(app, url, options),
    );
  }

  console.log(
    JSON.stringify(
      {
        appDir,
        appDirSource,
        app,
        registrations: registrationResults,
        simulators: simulatorResults,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
