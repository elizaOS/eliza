#!/usr/bin/env node
/**
 * Host-side LP3 wearable test operator for qualifying the physical pendant
 * transport lane. The script only drives the approved adb contract, Android
 * settings, WebView CDP, and token-free first-run remote-connect route, leaving
 * the human operator at Android permission, device chooser, or spoken phrase.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  discoverWebViewTarget,
  elizaRoot,
  resolveAdb,
} from "./lib/android-device.mjs";

export const DEFAULT_PACKAGE = "ai.elizaos.app";
export const LP3_MODEL = "TLP301";
export const LP3_PRODUCT_DEVICE = "LightPhoneIII";
export const HOST_AGENT_DEVICE_PORT = 31337;
export const DEFAULT_HOST_AGENT_PORT = 31338;
export const HOST_AGENT_HEALTH_PATH = "/api/health";
export const FIRST_RUN_REMOTE_DEEPLINK =
  "elizaos://first-run/runtime/remote?api=http%3A%2F%2F127.0.0.1%3A31337";
export const SETTINGS_DEEPLINK = "elizaos://settings";
export const CAPACITOR_ORIGIN = "https://localhost";
export const VOICE_SETTINGS_HASH = "#voice";
export const SHIM_ROUTES = [
  "GET /api/auth/status",
  "GET /api/status",
  "GET /api/first-run/status",
];
export const SHIM_BODY_BY_ROUTE = {
  "GET /api/auth/status": {
    required: false,
    authenticated: true,
    loginRequired: false,
    bootstrapRequired: false,
    localAccess: true,
    passwordConfigured: false,
    pairingEnabled: false,
    expiresAt: null,
  },
  "GET /api/status": {
    state: "running",
    agentName: "LP3 Transport Qualification",
    canRespond: true,
  },
  "GET /api/first-run/status": {
    complete: true,
    cloudProvisioned: false,
    deploymentTarget: "local",
  },
};

const MODES = new Set(["prepare-transport", "acceptance", "recover", "status"]);
const MUTATING_MODES = new Set(["prepare-transport", "recover"]);
const MAX_LOGCAT_LINES = 800;
const MAX_LOGCAT_BYTES = 96_000;
const MAX_TEXT_BYTES = 96_000;
const DEFAULT_CDP_PORT = 9222;
const HOST_STATE_ENV = "LP3_WEARABLE_HOST_STATE_FILE";
function isSensitiveKey(key) {
  if (String(key).includes("/")) return false;
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return /(?:^|_)(?:token|auth|credential|secret|password|session|bearer|body|api_key)(?:_|$)/.test(
    normalized,
  );
}
const HOST_AGENT_ARGS = [
  path.join(elizaRoot, "packages/app-core/scripts/run-node-tsx.mjs"),
  path.join(elizaRoot, "packages/app-core/scripts/serve-real-local-agent.ts"),
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stderr(message) {
  process.stderr.write(`${redactText(message)}\n`);
}

function numericPort(value, name) {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

export function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  const options = {
    mode,
    serial: null,
    packageName: null,
    color: false,
    allowUiShim: false,
    artifactDir: null,
    cdpPort: DEFAULT_CDP_PORT,
    startHostAgent: true,
    hostAgentPort: DEFAULT_HOST_AGENT_PORT,
    hostStateFile: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (i >= args.length) throw new Error(`${arg} requires a value`);
      return args[i];
    };
    if (arg === "--serial") options.serial = next();
    else if (arg === "--package") options.packageName = next();
    else if (arg === "--color") options.color = true;
    else if (arg === "--allow-ui-shim") options.allowUiShim = true;
    else if (arg === "--artifact-dir") options.artifactDir = next();
    else if (arg === "--cdp-port") options.cdpPort = numericPort(next(), arg);
    else if (arg === "--host-agent-port")
      options.hostAgentPort = numericPort(next(), arg);
    else if (arg === "--host-state-file") options.hostStateFile = next();
    else if (arg === "--no-start-host-agent") options.startHostAgent = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  validateOptions(options);
  return options;
}

export function validateOptions(options) {
  if (!MODES.has(options.mode)) {
    throw new Error(
      `Mode is required and must be one of: ${Array.from(MODES).join(", ")}`,
    );
  }
  if (!options.serial) throw new Error("--serial is required");
  if (!options.packageName) throw new Error("--package is required");
  if (options.packageName !== DEFAULT_PACKAGE) {
    throw new Error(
      `Refusing package ${options.packageName}; expected ${DEFAULT_PACKAGE}`,
    );
  }
  numericPort(options.cdpPort, "--cdp-port");
  numericPort(
    options.hostAgentPort ?? DEFAULT_HOST_AGENT_PORT,
    "--host-agent-port",
  );
  if (options.mode === "acceptance" && options.allowUiShim) {
    throw new Error("acceptance refuses --allow-ui-shim");
  }
  if (options.mode === "acceptance" && options.startHostAgent === true) {
    options.startHostAgent = false;
  }
  return options;
}

function adbCommandKey(args) {
  return args.join(" ");
}

function isPackageBaseApkPath(value) {
  return (
    typeof value === "string" &&
    value.endsWith("/base.apk") &&
    value.includes(DEFAULT_PACKAGE) &&
    value.startsWith("/data/app/")
  );
}

function isAllowedDeepLink(value) {
  return value === SETTINGS_DEEPLINK || value === FIRST_RUN_REMOTE_DEEPLINK;
}

function isAllowedActivityStart(args) {
  return (
    args.length === 6 &&
    args[0] === "shell" &&
    args[1] === "am" &&
    args[2] === "start" &&
    args[3] === "-W" &&
    args[4] === "-n" &&
    args[5] === `${DEFAULT_PACKAGE}/.MainActivity`
  );
}

function isAllowedDeepLinkStart(args) {
  return (
    args.length === 10 &&
    args[0] === "shell" &&
    args[1] === "am" &&
    args[2] === "start" &&
    args[3] === "-a" &&
    args[4] === "android.intent.action.VIEW" &&
    args[5] === "-c" &&
    args[6] === "android.intent.category.BROWSABLE" &&
    args[7] === "-d" &&
    isAllowedDeepLink(args[8]) &&
    args[9] === DEFAULT_PACKAGE
  );
}

export function assertAdbCommandSafe(
  { serial, packageName = DEFAULT_PACKAGE },
  args,
) {
  if (!serial) throw new Error("adb safety gate requires an explicit serial");
  if (packageName !== DEFAULT_PACKAGE) {
    throw new Error(`adb safety gate refuses package ${packageName}`);
  }
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("adb safety gate requires a non-empty args array");
  }
  if (args[0] !== "-s" || args[1] !== serial) {
    throw new Error("adb safety gate requires literal -s exact serial prefix");
  }

  args = args.slice(2);
  const joined = adbCommandKey(args);

  if (args.length === 1 && args[0] === "get-state") return true;
  if (args.length === 2 && args[0] === "logcat" && args[1] === "-c")
    return true;
  if (
    args.length === 4 &&
    args[0] === "logcat" &&
    args[1] === "-d" &&
    args[2] === "-t" &&
    args[3] === "800"
  )
    return true;

  if (args[0] === "forward") {
    if (
      args.length === 3 &&
      /^tcp:\d+$/.test(args[1]) &&
      /^localabstract:webview_devtools_remote_\d+$/.test(args[2])
    )
      return true;
    if (
      args.length === 3 &&
      args[1] === "--remove" &&
      /^tcp:\d+$/.test(args[2])
    )
      return true;
    throw new Error(`Unsafe adb forward command refused: ${joined}`);
  }

  if (
    args.length === 3 &&
    args[0] === "reverse" &&
    args[1] === "tcp:31337" &&
    /^tcp:\d+$/.test(args[2])
  )
    return true;
  if (
    args.length === 3 &&
    args[0] === "reverse" &&
    args[1] === "--remove" &&
    args[2] === "tcp:31337"
  )
    return true;

  if (args[0] !== "shell") {
    throw new Error(`Unsafe adb command refused: ${joined}`);
  }

  if (
    args.length === 3 &&
    args[1] === "getprop" &&
    new Set([
      "ro.product.model",
      "ro.product.product.name",
      "ro.product.device",
      "ro.build.fingerprint",
    ]).has(args[2])
  )
    return true;

  if (
    args.length === 4 &&
    args[1] === "dumpsys" &&
    args[2] === "package" &&
    args[3] === DEFAULT_PACKAGE
  )
    return true;
  if (
    args.length === 4 &&
    args[1] === "dumpsys" &&
    ((args[2] === "window" && args[3] === "windows") ||
      (args[2] === "activity" && args[3] === "activities"))
  )
    return true;

  if (
    args.length === 4 &&
    args[1] === "pm" &&
    args[2] === "path" &&
    args[3] === DEFAULT_PACKAGE
  )
    return true;
  if (
    args.length === 3 &&
    args[1] === "sha256sum" &&
    isPackageBaseApkPath(args[2])
  )
    return true;
  if (args.length === 3 && args[1] === "pidof" && args[2] === DEFAULT_PACKAGE)
    return true;

  if (args[1] === "settings") {
    const [, , op, namespace, key, value] = args;
    const allowedReads = new Set([
      "global show_external_tools",
      "system accessibility_color_mode",
    ]);
    const allowedWrites = new Map([
      ["global show_external_tools", "true"],
      ["system accessibility_color_mode", "1"],
    ]);
    const setting = `${namespace} ${key}`;
    if (op === "get" && allowedReads.has(setting) && args.length === 5)
      return true;
    if (
      op === "put" &&
      allowedWrites.get(setting) === value &&
      args.length === 6
    )
      return true;
    throw new Error(`Unsafe settings command refused: ${joined}`);
  }

  if (
    args.length === 4 &&
    args[1] === "am" &&
    args[2] === "force-stop" &&
    args[3] === DEFAULT_PACKAGE
  )
    return true;
  if (isAllowedActivityStart(args) || isAllowedDeepLinkStart(args)) return true;

  throw new Error(`Unsafe adb shell command refused: ${joined}`);
}

function defaultExec(bin, args) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function makeSafeAdb({
  serial,
  packageName = DEFAULT_PACKAGE,
  adbBin = "adb",
  exec = defaultExec,
}) {
  validateOptions({
    mode: "status",
    serial,
    packageName,
    cdpPort: DEFAULT_CDP_PORT,
    hostAgentPort: DEFAULT_HOST_AGENT_PORT,
    allowUiShim: false,
  });
  return (args, { allowFailure = false } = {}) => {
    const fullArgs = ["-s", serial, ...args];
    assertAdbCommandSafe({ serial, packageName }, fullArgs);
    const result = exec(adbBin, fullArgs);
    if (!allowFailure && result.status !== 0) {
      throw new Error(
        `adb ${redactText(args.join(" "))} failed: ${redactText(result.stderr || result.stdout)}`,
      );
    }
    return result.stdout ?? "";
  };
}

export function buildSettingsCommands({ color = false } = {}) {
  const commands = [
    ["shell", "settings", "put", "global", "show_external_tools", "true"],
    ["shell", "settings", "get", "global", "show_external_tools"],
  ];
  if (color) {
    commands.push(
      ["shell", "settings", "put", "system", "accessibility_color_mode", "1"],
      ["shell", "settings", "get", "system", "accessibility_color_mode"],
    );
  }
  return commands;
}

export function buildModePlan(options) {
  validateOptions(options);
  const base = {
    mode: options.mode,
    qualificationMode:
      options.mode === "acceptance"
        ? "full_e2e"
        : options.mode === "status"
          ? "read_only_status"
          : "transport_qualification_only",
    commands: [],
    shimRoutes: [],
    firstRunStorageMutation: false,
    startsManagedHost: false,
    usesAdbReverse: false,
    usesRemoteFirstRunDeepLink: false,
  };

  if (options.mode === "status") return base;

  if (MUTATING_MODES.has(options.mode)) {
    base.commands.push(...buildSettingsCommands({ color: options.color }));
  }

  if (options.mode === "prepare-transport") {
    base.startsManagedHost = options.startHostAgent !== false;
    base.usesAdbReverse = true;
    base.usesRemoteFirstRunDeepLink = true;
    base.commands.push(
      ["logcat", "-c"],
      ["shell", "am", "force-stop", DEFAULT_PACKAGE],
      ["shell", "am", "start", "-W", "-n", `${DEFAULT_PACKAGE}/.MainActivity`],
      [
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-c",
        "android.intent.category.BROWSABLE",
        "-d",
        FIRST_RUN_REMOTE_DEEPLINK,
        DEFAULT_PACKAGE,
      ],
    );
    base.commands.splice(
      3,
      0,
      ["reverse", "--remove", "tcp:31337"],
      ["reverse", "tcp:31337", "tcp:<host-agent-port>"],
    );
    if (options.allowUiShim) base.shimRoutes = [...SHIM_ROUTES];
  }

  if (options.mode === "recover") {
    base.startsManagedHost = options.startHostAgent !== false;
    base.usesAdbReverse = true;
    base.commands.push(
      ["shell", "am", "force-stop", DEFAULT_PACKAGE],
      ["shell", "am", "start", "-W", "-n", `${DEFAULT_PACKAGE}/.MainActivity`],
    );
    base.commands.push(
      ["reverse", "--remove", "tcp:31337"],
      ["reverse", "tcp:31337", "tcp:<host-agent-port>"],
    );
    if (options.allowUiShim) base.shimRoutes = [...SHIM_ROUTES];
  }

  if (options.mode === "acceptance") {
    base.commands.push([
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      `${DEFAULT_PACKAGE}/.MainActivity`,
    ]);
  }

  return base;
}

export function redactText(value) {
  let text = String(value ?? "");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    "[REDACTED_JWT]",
  );
  text = text.replace(
    /([?&](?:token|api[_-]?key|session|access[_-]?token|bearer|credential|code)=)[^&\s"']+/gi,
    "$1[REDACTED]",
  );
  text = text.replace(
    /\b(?:token|api[_-]?key|session|access[_-]?token|auth|credential|bearer|body)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
    (match) => match.replace(/[:=]\s*["']?.*$/, ": [REDACTED]"),
  );
  text = text.replace(/elizaos:\/\/[^\s"']+/gi, "elizaos://[REDACTED]");
  text = text.replace(/https?:\/\/[^\s"']+/gi, (url) => {
    try {
      const parsed = new URL(url);
      parsed.search = parsed.search ? "?[REDACTED]" : "";
      return parsed.toString();
    } catch {
      // error-policy:J3 untrusted diagnostic URL, fail closed to full redaction
      return "[REDACTED_URL]";
    }
  });
  text = text.replace(/\b[A-Za-z0-9+/]{120,}={0,2}\b/g, "[REDACTED_BLOB]");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    text = `${text.slice(0, MAX_TEXT_BYTES)}\n[TRUNCATED]`;
  }
  return text;
}

export function sanitizeForJson(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : sanitizeForJson(item),
      ]),
    );
  }
  return value;
}

function writeJsonStdout(value) {
  process.stdout.write(`${JSON.stringify(sanitizeForJson(value))}\n`);
}

function artifactDirFor(options) {
  const dir =
    options.artifactDir ??
    path.join(
      process.cwd(),
      "test-results",
      "lp3-wearable-operator",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function hostStateFileFor(options) {
  return (
    options.hostStateFile ??
    process.env[HOST_STATE_ENV] ??
    path.join(
      os.homedir(),
      ".eliza",
      "lp3-wearable-operator",
      "managed-host-agent-state.json",
    )
  );
}

function boundedText(text, maxBytes = MAX_LOGCAT_BYTES) {
  const redacted = redactText(text);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  return `${redacted.slice(0, maxBytes)}\n[TRUNCATED]`;
}

function boundedLines(text, maxLines = MAX_LOGCAT_LINES) {
  return boundedText(text).split(/\r?\n/).slice(-maxLines).join("\n");
}

function filterLogcat(text) {
  return boundedLines(
    String(text ?? "")
      .split(/\r?\n/)
      .filter((line) =>
        /ai\.elizaos\.app|pendant|wearable|bluetooth|gatt|webview|chromium/i.test(
          line,
        ),
      )
      .join("\n"),
  );
}

export function parsePackageInfo(text) {
  const versionName = text.match(/versionName=([^\s]+)/)?.[1] ?? null;
  const versionCode = text.match(/versionCode=(\d+)/)?.[1] ?? null;
  const debuggable = /\bDEBUGGABLE\b/.test(text);
  return { versionName, versionCode, debuggable };
}

export function assertLp3Identity({ model, product, device }) {
  if (
    model !== LP3_MODEL ||
    product !== LP3_PRODUCT_DEVICE ||
    device !== LP3_PRODUCT_DEVICE
  ) {
    throw new Error(
      `Refusing non-LP3 device: model=${model} product=${product} device=${device}`,
    );
  }
  return true;
}

function parsePermission(text, permission) {
  const escaped = permission.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}:\\s+granted=(true|false)`);
  const match = text.match(regex);
  return match ? match[1] === "true" : null;
}

export function parseSurfaceState(pageSnapshot) {
  if (pageSnapshot?.connectedVisible || pageSnapshot?.connectBusy)
    return "status_visible";
  if (pageSnapshot?.connectEnabled) return "connect_ready";
  if (pageSnapshot?.surfaceVisible) return "surface_visible";
  return "not_visible";
}

export function deriveNextHumanAction({
  wearableSurfaceState,
  foregroundScreen,
  startupRouteHealth,
  qualificationMode,
  mode,
  permissions = {},
}) {
  const unhealthy = Object.values(startupRouteHealth ?? {}).some(
    (route) => route && route.ok === false,
  );
  if (unhealthy)
    return `rerun ${mode === "acceptance" ? "prepare-transport" : mode} after fixing route/auth/startup health`;
  const screen = String(foregroundScreen ?? "").toLowerCase();
  if (
    screen.includes("permission") ||
    (permissions.RECORD_AUDIO === false &&
      ["surface_visible", "connect_ready", "status_visible"].includes(
        wearableSurfaceState,
      ))
  ) {
    return "approve the Android system permission prompt";
  }
  if (screen.includes("bluetooth") || screen.includes("chooser")) {
    return "select the LP3 wearable in the Android system device chooser";
  }
  if (
    wearableSurfaceState === "connect_ready" ||
    wearableSurfaceState === "status_visible"
  ) {
    return "speak one phrase to the LP3 wearable when prompted";
  }
  if (qualificationMode === "transport_qualification_only") {
    return "rerun recover with --allow-ui-shim";
  }
  return "rerun prepare-transport";
}

async function readDeviceAndPackage({ adb, packageName }) {
  const state = adb(["get-state"]).trim();
  if (state !== "device") throw new Error(`Device is not online: ${state}`);
  const model = adb(["shell", "getprop", "ro.product.model"]).trim();
  const product = adb(["shell", "getprop", "ro.product.product.name"]).trim();
  const device = adb(["shell", "getprop", "ro.product.device"]).trim();
  const build = adb(["shell", "getprop", "ro.build.fingerprint"]).trim();
  assertLp3Identity({ model, product, device });

  const packageDump = adb(["shell", "dumpsys", "package", packageName]);
  const packageInfo = parsePackageInfo(packageDump);
  if (!packageInfo.debuggable) {
    throw new Error(`Installed package ${packageName} is not debuggable`);
  }
  const baseApk = adb(["shell", "pm", "path", packageName])
    .split(/\r?\n/)
    .map((line) => line.replace(/^package:/, "").trim())
    .find((line) => line.endsWith("/base.apk") && line.includes(packageName));
  if (!baseApk)
    throw new Error(`Installed package ${packageName} has no base APK path`);
  const baseApkSha256 = adb(["shell", "sha256sum", baseApk])
    .trim()
    .split(/\s+/)[0];

  return {
    device: { model, product, device, build },
    package: { name: packageName, ...packageInfo, baseApkSha256 },
    packageDump,
  };
}

async function readStatus({
  adb,
  packageName,
  page = null,
  qualificationMode,
  shimRoutes,
  mode,
}) {
  const info = await readDeviceAndPackage({ adb, packageName });
  const packageDump = info.packageDump;
  const permissions = {
    BLUETOOTH_SCAN: parsePermission(
      packageDump,
      "android.permission.BLUETOOTH_SCAN",
    ),
    BLUETOOTH_CONNECT: parsePermission(
      packageDump,
      "android.permission.BLUETOOTH_CONNECT",
    ),
    RECORD_AUDIO: parsePermission(
      packageDump,
      "android.permission.RECORD_AUDIO",
    ),
  };
  const foregroundScreen =
    adb(["shell", "dumpsys", "window", "windows"], {
      allowFailure: true,
    }).match(/mCurrentFocus=([^\n]+)/)?.[1] ??
    adb(["shell", "dumpsys", "activity", "activities"], {
      allowFailure: true,
    }).match(/mResumedActivity: ([^\n]+)/)?.[1] ??
    "unknown";

  const startupRouteHealth = page
    ? await probeStartupRoutes(page)
    : Object.fromEntries(SHIM_ROUTES.map((route) => [route, null]));
  const pageSnapshot = page ? await snapshotWearableSurface(page) : null;
  const wearableSurfaceState = parseSurfaceState(pageSnapshot);
  const shimMarker = page ? await detectShimMarker(page) : false;
  const persistedLoopbackActiveServer = page
    ? await detectLoopbackActiveServer(page)
    : false;
  const effectiveQualificationMode =
    shimMarker || persistedLoopbackActiveServer
      ? "transport_qualification_only"
      : qualificationMode;
  const nextHumanAction = deriveNextHumanAction({
    wearableSurfaceState,
    foregroundScreen,
    startupRouteHealth,
    qualificationMode: effectiveQualificationMode,
    mode,
    permissions,
  });

  return {
    device: { serial: null, ...info.device },
    package: info.package,
    permissions,
    foregroundScreen,
    startupRouteHealth,
    qualificationMode: effectiveQualificationMode,
    shimRoutes: shimMarker ? [...SHIM_ROUTES] : shimRoutes,
    shimActive: shimMarker,
    persistedLoopbackActiveServer,
    wearableSurfaceState,
    nextHumanAction,
  };
}

export function validateRouteSemantics(route, status, body) {
  if (status !== 200) return false;
  if (route === "GET /api/auth/status") {
    return (
      body?.required === false &&
      body?.loginRequired !== true &&
      body?.bootstrapRequired !== true
    );
  }
  if (route === "GET /api/status") {
    return body?.state === "running" && body?.canRespond !== false;
  }
  if (route === "GET /api/first-run/status") {
    return (
      body?.complete === true &&
      (body?.deploymentTarget === undefined ||
        body.deploymentTarget === "local")
    );
  }
  return false;
}

async function probeStartupRoutes(page) {
  const raw = await page.evaluate(async (routes) => {
    const result = {};
    let apiBase = window.localStorage?.getItem?.("elizaos_api_base") || "";
    if (!apiBase) {
      try {
        const activeServer = JSON.parse(
          window.localStorage?.getItem?.("elizaos:active-server") || "null",
        );
        if (typeof activeServer?.apiBase === "string") {
          apiBase = activeServer.apiBase;
        }
      } catch {
        // error-policy:J3 malformed persisted server metadata, use app origin
        apiBase = "";
      }
    }
    if (!apiBase && typeof window.__ELIZAOS_API_BASE__ === "string") {
      apiBase = window.__ELIZAOS_API_BASE__;
    }
    for (const route of routes) {
      const [method, routePath] = route.split(" ");
      try {
        const agentRequest = window.Capacitor?.Plugins?.Agent?.request;
        if (
          window.__LP3_TRANSPORT_QUALIFICATION_SHIM__ &&
          typeof agentRequest === "function"
        ) {
          const nativeResponse = await agentRequest({
            method,
            path: routePath,
          });
          result[route] = {
            status: nativeResponse.status,
            body: JSON.parse(nativeResponse.body || "null"),
          };
          continue;
        }
        const target = new URL(routePath, apiBase || window.location.origin);
        const response = await fetch(target.toString(), { method });
        const contentType = response.headers.get("content-type") || "";
        const body = contentType.includes("json")
          ? await response.json()
          : null;
        result[route] = { status: response.status, body };
      } catch {
        // error-policy:J6 bounded status probe records failure without a body
        result[route] = { status: 0, body: null };
      }
    }
    return result;
  }, SHIM_ROUTES);

  return Object.fromEntries(
    Object.entries(raw).map(([route, value]) => [
      route,
      {
        status: value.status,
        ok: validateRouteSemantics(route, value.status, value.body),
      },
    ]),
  );
}

async function snapshotWearableSurface(page) {
  return page.evaluate(() => {
    const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);
    const connect = byTestId("pendant-connect");
    return {
      surfaceVisible: Boolean(byTestId("pendant-settings")),
      connectVisible: Boolean(connect),
      connectEnabled: Boolean(
        connect &&
          !connect.disabled &&
          connect.getAttribute("aria-disabled") !== "true",
      ),
      connectBusy: Boolean(
        connect &&
          (connect.disabled ||
            connect.getAttribute("aria-disabled") === "true"),
      ),
      connectedVisible: Boolean(byTestId("pendant-disconnect")),
      statusText: byTestId("pendant-status")?.textContent ?? "",
    };
  });
}

async function detectShimMarker(page) {
  return page.evaluate(() =>
    Boolean(window.__LP3_TRANSPORT_QUALIFICATION_SHIM__),
  );
}

async function detectLoopbackActiveServer(page) {
  return page.evaluate(() => {
    const keys = ["elizaos:active-server", "elizaos_api_base"];
    for (const key of keys) {
      const value = window.localStorage?.getItem?.(key);
      if (typeof value === "string" && value.includes("127.0.0.1:31337"))
        return true;
    }
    return false;
  });
}

function wrapPuppeteerPage(page) {
  return {
    evaluate: (...args) => page.evaluate(...args),
    addInitScript: (fn, arg) => page.evaluateOnNewDocument(fn, arg),
    reload: (options) => page.reload(options),
    url: () => page.url(),
    locator: (selector) => ({
      waitFor: ({ state, timeout }) =>
        page.waitForSelector(selector, {
          visible: state === "visible",
          hidden: state === "hidden",
          timeout,
        }),
      scrollIntoViewIfNeeded: () =>
        page.$eval(selector, (element) =>
          element.scrollIntoView({ block: "center", inline: "nearest" }),
        ),
      click: () => page.click(selector),
      count: async () => ((await page.$(selector)) ? 1 : 0),
      screenshot: async (options) => {
        const handle = await page.$(selector);
        if (!handle) throw new Error(`missing screenshot surface ${selector}`);
        return handle.screenshot(options);
      },
    }),
  };
}

async function attachPage({ adb, cdpPort }) {
  const { default: puppeteer } = await import("puppeteer-core");
  const pid = adb(["shell", "pidof", DEFAULT_PACKAGE]).trim();
  if (!/^\d+$/.test(pid)) {
    throw new Error("App process is not running; cannot attach WebView CDP");
  }
  let ownsForward = false;
  let browser = null;
  try {
    adb([
      "forward",
      `tcp:${cdpPort}`,
      `localabstract:webview_devtools_remote_${pid}`,
    ]);
    ownsForward = true;
    const target = await discoverWebViewTarget(cdpPort, { timeoutMs: 45_000 });
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${cdpPort}`,
      defaultViewport: null,
    });
    const pages = await browser.pages();
    const rawPage =
      pages.find((candidate) => candidate.url() === target.url) ??
      pages.find((candidate) => candidate.url().startsWith(CAPACITOR_ORIGIN)) ??
      pages[0];
    if (!rawPage)
      throw new Error("CDP attached but no WebView page was available");
    return {
      browser,
      page: wrapPuppeteerPage(rawPage),
      cleanup: async () => {
        // error-policy:J6 disconnect only; never send Browser.close to the app
        browser.disconnect();
        if (ownsForward) {
          adb(["forward", "--remove", `tcp:${cdpPort}`], {
            allowFailure: true,
          });
        }
      },
    };
  } catch (error) {
    // error-policy:J6 disconnect only before rethrowing attach failure
    browser?.disconnect?.();
    if (ownsForward) {
      adb(["forward", "--remove", `tcp:${cdpPort}`], { allowFailure: true });
    }
    throw error;
  }
}

export async function applyStatusShim(page) {
  await page.addInitScript(
    ({ routes, bodies }) => {
      const allowed = new Set(routes);
      const bodyByRoute = bodies;
      window.__LP3_TRANSPORT_QUALIFICATION_SHIM__ = true;
      const responseBodyFor = (method, pathname) => {
        const key = `${String(method || "GET").toUpperCase()} ${pathname}`;
        return allowed.has(key) ? bodyByRoute[key] : null;
      };

      const patchAgentRequest = (agent) => {
        if (!agent || typeof agent.request !== "function") return agent;
        if (agent.request.__lp3TransportQualificationShim) return agent;
        const originalAgentRequest = agent.request.bind(agent);
        const request = async (options = {}) => {
          const pathname = new URL(
            String(options.path || "/"),
            window.location.origin,
          ).pathname;
          const body = responseBodyFor(options.method, pathname);
          if (body) {
            return {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            };
          }
          return originalAgentRequest(options);
        };
        request.__lp3TransportQualificationShim = true;
        window.__LP3_TRANSPORT_QUALIFICATION_AGENT_PATCHED__ = true;
        return new Proxy(agent, {
          get: (target, property, receiver) =>
            property === "request"
              ? request
              : Reflect.get(target, property, receiver),
        });
      };
      const patchCapacitor = (capacitor) => {
        if (!capacitor || typeof capacitor !== "object") return;
        const plugins = capacitor.Plugins;
        patchAgentRequest(plugins?.Agent);
        if (plugins && !plugins.__lp3TransportQualificationAgentSlotShim) {
          const descriptor = Object.getOwnPropertyDescriptor(plugins, "Agent");
          if (!descriptor || descriptor.configurable) {
            let agentValue = patchAgentRequest(plugins.Agent);
            Object.defineProperty(plugins, "Agent", {
              configurable: false,
              enumerable: true,
              get: () => agentValue,
              set: (next) => {
                agentValue = patchAgentRequest(next);
              },
            });
            plugins.__lp3TransportQualificationAgentSlotShim = true;
          }
        }
        if (
          typeof capacitor.registerPlugin === "function" &&
          !capacitor.registerPlugin.__lp3TransportQualificationShim
        ) {
          const originalRegisterPlugin =
            capacitor.registerPlugin.bind(capacitor);
          const registerPlugin = (name, ...args) => {
            const plugin = originalRegisterPlugin(name, ...args);
            return name === "Agent" ? patchAgentRequest(plugin) : plugin;
          };
          registerPlugin.__lp3TransportQualificationShim = true;
          capacitor.registerPlugin = registerPlugin;
        }
      };

      let capacitorValue = window.Capacitor;
      patchCapacitor(capacitorValue);
      if (!capacitorValue) {
        Object.defineProperty(window, "Capacitor", {
          configurable: true,
          enumerable: true,
          get: () => capacitorValue,
          set: (next) => {
            capacitorValue = next;
            patchCapacitor(next);
          },
        });
      }

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const request = new Request(input, init);
        const url = new URL(request.url, window.location.origin);
        const body = responseBodyFor(request.method, url.pathname);
        if (body) {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(input, init);
      };
    },
    { routes: SHIM_ROUTES, bodies: SHIM_BODY_BY_ROUTE },
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const startupState = await page.evaluate(() => {
      if (
        document.querySelector(
          "[data-testid=settings-shell], [data-testid=home-screen]",
        )
      ) {
        return "ready";
      }
      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry startup",
      );
      if (retry) {
        retry.click();
        return "retried";
      }
      return "pending";
    });
    if (startupState === "ready") break;
    await sleep(startupState === "retried" ? 2_000 : 250);
  }
}

async function navigateBySpaHash(page) {
  await page.evaluate((hash) => {
    if (window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, VOICE_SETTINGS_HASH);
}

async function navigateWearableSurface({ page, adb, useShim }) {
  if (useShim) await applyStatusShim(page);
  adb([
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-c",
    "android.intent.category.BROWSABLE",
    "-d",
    SETTINGS_DEEPLINK,
    DEFAULT_PACKAGE,
  ]);
  await sleep(1_000);
  await navigateBySpaHash(page);
  const surface = page.locator("[data-testid=pendant-settings]");
  await surface.waitFor({ state: "visible", timeout: 45_000 });
  await surface.scrollIntoViewIfNeeded();
  const snapshot = await snapshotWearableSurface(page);
  if (snapshot.connectedVisible) return "already_connected";
  if (snapshot.connectEnabled) {
    const connect = page.locator("[data-testid=pendant-connect]");
    await connect.scrollIntoViewIfNeeded();
    await connect.click();
    return "connect_clicked";
  }
  return "surface_visible";
}

function fetchJson(url, { timeoutMs = 2_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 32_000)
          request.destroy(new Error("health body too large"));
      });
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(body || "{}"),
          });
        } catch (error) {
          // error-policy:J1 preserve malformed health response as a rejection
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("health timed out")));
    request.on("error", reject);
  });
}

async function checkHostHealth(port) {
  const result = await fetchJson(
    `http://127.0.0.1:${port}${HOST_AGENT_HEALTH_PATH}`,
  );
  return result.status >= 200 && result.status < 300;
}

async function ensureManagedHostFirstRunComplete(port) {
  const statusUrl = `http://127.0.0.1:${port}/api/first-run/status`;
  let status = await fetchJson(statusUrl);
  if (status.status >= 200 && status.status < 300 && status.body?.complete) {
    return;
  }

  const response = await fetch(`http://127.0.0.1:${port}/api/first-run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-ElizaOS-Client-Id": "lp3-wearable-operator",
    },
    body: JSON.stringify({ name: "LP3 Transport Qualification" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `managed host first-run failed with status ${response.status}`,
    );
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    status = await fetchJson(statusUrl);
    if (status.status >= 200 && status.status < 300 && status.body?.complete) {
      return;
    }
    await sleep(500);
  }
  throw new Error("managed host first-run did not become complete");
}

function readPidCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // error-policy:J6 absent managed PID is a normal stale-state condition
    return false;
  }
}

function hasManagedHostOwnership(state) {
  const pid = Number(state?.pid);
  const port = Number(state?.port);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!Number.isInteger(port) || port <= 0) return false;
  if (state?.owner !== "lp3-wearable-operator") return false;
  if (!pidExists(pid)) return false;
  const command = readPidCommand(pid);
  return (
    command.includes("run-node-tsx.mjs") &&
    command.includes("serve-real-local-agent.ts")
  );
}

export async function verifyManagedHostState(state) {
  return hasManagedHostOwnership(state) && checkHostHealth(Number(state.port));
}

async function stopOwnedManagedHost(state) {
  if (!hasManagedHostOwnership(state)) {
    throw new Error(
      "refusing to stop a host process without verified ownership",
    );
  }
  process.kill(Number(state.pid), "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!pidExists(Number(state.pid))) return;
    await sleep(250);
  }
  throw new Error("owned unhealthy managed host did not stop");
}

async function waitForManagedHost(port, pid, attempts = 45) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!pidExists(pid)) throw new Error("managed host exited before health");
    // error-policy:J6 transient health failures are bounded by this retry loop
    if (await checkHostHealth(port).catch(() => false)) return true;
    await sleep(1_000);
  }
  throw new Error("timed out waiting for managed host health");
}

export async function startOrReuseManagedHost({
  options,
  artifactDir,
  spawnImpl = spawn,
} = {}) {
  const stateFile = hostStateFileFor(options);
  const port = options.hostAgentPort ?? DEFAULT_HOST_AGENT_PORT;
  if (fs.existsSync(stateFile)) {
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      // error-policy:J3 stale/corrupt ownership metadata cannot prove ownership
      fs.rmSync(stateFile, { force: true });
    }
    if (state) {
      const owned = hasManagedHostOwnership(state);
      if (owned && state.port !== port) {
        throw new Error(
          `managed host already owns a different port (${state.port})`,
        );
      }
      // error-policy:J6 owned health failure triggers bounded safe replacement
      if (owned && (await checkHostHealth(port).catch(() => false))) {
        await ensureManagedHostFirstRunComplete(state.port);
        return {
          reused: true,
          pid: state.pid,
          hostPort: state.port,
          stateFile,
        };
      }
      if (owned) {
        await stopOwnedManagedHost(state);
      } else if (pidExists(Number(state.pid))) {
        throw new Error(
          "managed host state points to a live process without verified ownership",
        );
      }
      fs.rmSync(stateFile, { force: true });
    }
  }

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, "managed-host-agent.log");
  const logFd = fs.openSync(logPath, "a");
  try {
    const child = spawnImpl(process.execPath, HOST_AGENT_ARGS, {
      cwd: elizaRoot,
      detached: true,
      env: {
        ...process.env,
        ELIZA_API_PORT: String(port),
        ELIZA_PAIRING_DISABLED: "1",
        HOST: "127.0.0.1",
      },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref?.();
    if (!child.pid) throw new Error("managed host did not expose a pid");
    const state = {
      pid: child.pid,
      port,
      command: process.execPath,
      args: HOST_AGENT_ARGS,
      cwd: elizaRoot,
      logPath,
      createdAt: new Date().toISOString(),
      owner: "lp3-wearable-operator",
    };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    try {
      await waitForManagedHost(port, child.pid);
      await ensureManagedHostFirstRunComplete(port);
    } catch (error) {
      // error-policy:J1 roll back only the child/state this invocation owns
      fs.rmSync(stateFile, { force: true });
      child.kill?.();
      throw error;
    }
    return {
      reused: false,
      pid: child.pid,
      hostPort: port,
      stateFile,
      logPath,
    };
  } finally {
    fs.closeSync(logFd);
  }
}

function bindHostReverse(adb, hostPort) {
  adb(["reverse", "--remove", "tcp:31337"], { allowFailure: true });
  adb(["reverse", "tcp:31337", `tcp:${hostPort}`]);
}

async function ensureManagedHostOrFallback({ options, artifactDir }) {
  if (!options.startHostAgent) {
    // error-policy:J6 an absent optional external host is handled below
    if (await checkHostHealth(options.hostAgentPort).catch(() => false)) {
      return { hostPort: options.hostAgentPort, external: true };
    }
    if (options.allowUiShim) {
      return { hostPort: options.hostAgentPort, fallbackShim: true };
    }
    throw new Error("external host agent is not healthy");
  }
  try {
    return await startOrReuseManagedHost({ options, artifactDir });
  } catch (error) {
    // error-policy:J1 explicit --allow-ui-shim authorizes this bounded fallback
    if (options.allowUiShim) {
      stderr(
        `managed host unavailable; using explicit UI shim fallback: ${error.message}`,
      );
      return {
        hostPort: options.hostAgentPort,
        failed: true,
        fallbackShim: true,
      };
    }
    throw error;
  }
}

function assertStartupRoutesHealthy(startupRouteHealth, label) {
  const unhealthy = Object.entries(startupRouteHealth).filter(
    ([, route]) => !route?.ok,
  );
  if (unhealthy.length > 0) {
    throw new Error(`${label} startup route semantics failed`);
  }
}

async function maybeWriteScreenshot({ page, artifactDir }) {
  const snapshot = await snapshotWearableSurface(page);
  if (!snapshot.surfaceVisible) return null;
  if (
    (await page.locator("[data-testid=pendant-last-transcript]").count()) > 0
  ) {
    return null;
  }
  const screenshotPath = path.join(artifactDir, "wearable-surface.jpg");
  await page.locator("[data-testid=pendant-settings]").screenshot({
    path: screenshotPath,
    type: "jpeg",
    quality: 82,
  });
  return screenshotPath;
}

function writeResultArtifact(artifactDir, result) {
  fs.writeFileSync(
    path.join(artifactDir, "result-redacted.json"),
    JSON.stringify(sanitizeForJson(result), null, 2),
  );
}

function writeLogcatArtifact({ adb, artifactDir, mode }) {
  if (!MUTATING_MODES.has(mode)) return null;
  const logcat = adb(["logcat", "-d", "-t", "800"], { allowFailure: true });
  const logPath = path.join(artifactDir, "logcat-filtered-redacted.txt");
  fs.writeFileSync(logPath, filterLogcat(logcat));
  return logPath;
}

async function runOperator(options) {
  const artifactDir = artifactDirFor(options);
  const adbBin = resolveAdb();
  const adb = makeSafeAdb({
    serial: options.serial,
    packageName: options.packageName,
    adbBin,
  });
  const plan = buildModePlan(options);
  let attach = null;
  let shimRoutes = [];

  try {
    await readDeviceAndPackage({ adb, packageName: options.packageName });

    if (options.mode === "status") {
      try {
        attach = await attachPage({ adb, cdpPort: options.cdpPort });
      } catch (error) {
        // error-policy:J4 status can report device/package state without CDP
        stderr(`status CDP attach unavailable: ${error.message}`);
      }
      const status = await readStatus({
        adb,
        packageName: options.packageName,
        page: attach?.page ?? null,
        qualificationMode: "read_only_status",
        shimRoutes,
        mode: options.mode,
      });
      status.device.serial = options.serial;
      const result = { ok: true, mode: options.mode, artifactDir, ...status };
      writeResultArtifact(artifactDir, result);
      writeJsonStdout(result);
      return;
    }

    if (MUTATING_MODES.has(options.mode)) {
      for (const command of buildSettingsCommands({ color: options.color }))
        adb(command);
    }

    let forceShim = false;
    if (options.mode === "prepare-transport") {
      adb(["logcat", "-c"]);
      adb(["shell", "am", "force-stop", DEFAULT_PACKAGE]);
      adb([
        "shell",
        "am",
        "start",
        "-W",
        "-n",
        `${DEFAULT_PACKAGE}/.MainActivity`,
      ]);
      const host = await ensureManagedHostOrFallback({ options, artifactDir });
      if (host.fallbackShim) {
        forceShim = true;
      } else {
        bindHostReverse(adb, host.hostPort);
        adb([
          "shell",
          "am",
          "start",
          "-a",
          "android.intent.action.VIEW",
          "-c",
          "android.intent.category.BROWSABLE",
          "-d",
          FIRST_RUN_REMOTE_DEEPLINK,
          DEFAULT_PACKAGE,
        ]);
        await sleep(1_500);
      }
    } else if (options.mode === "recover") {
      adb(["shell", "am", "force-stop", DEFAULT_PACKAGE]);
      adb([
        "shell",
        "am",
        "start",
        "-W",
        "-n",
        `${DEFAULT_PACKAGE}/.MainActivity`,
      ]);
      const host = await ensureManagedHostOrFallback({ options, artifactDir });
      if (host.fallbackShim) {
        forceShim = true;
      } else {
        bindHostReverse(adb, host.hostPort);
      }
    } else if (options.mode === "acceptance") {
      adb([
        "shell",
        "am",
        "start",
        "-W",
        "-n",
        `${DEFAULT_PACKAGE}/.MainActivity`,
      ]);
    }

    attach = await attachPage({ adb, cdpPort: options.cdpPort });
    let useShim = forceShim;
    if (options.allowUiShim) shimRoutes = [...SHIM_ROUTES];

    let startupRouteHealth = await probeStartupRoutes(attach.page);
    if (options.mode === "acceptance") {
      if (await detectShimMarker(attach.page)) {
        throw new Error("acceptance refuses an active UI status shim");
      }
      if (await detectLoopbackActiveServer(attach.page)) {
        throw new Error(
          "acceptance refuses the transport-qualification host lane",
        );
      }
      assertStartupRoutesHealthy(startupRouteHealth, "acceptance");
    } else if (options.mode === "prepare-transport") {
      try {
        assertStartupRoutesHealthy(startupRouteHealth, "prepare-transport");
      } catch (error) {
        // error-policy:J1 explicit --allow-ui-shim gates the qualification retry
        if (!options.allowUiShim) throw error;
        useShim = true;
      }
    } else if (options.allowUiShim) {
      useShim = Object.values(startupRouteHealth).some((route) => !route?.ok);
    }

    let navigationResult;
    try {
      navigationResult = await navigateWearableSurface({
        page: attach.page,
        adb,
        useShim,
      });
    } catch (error) {
      // error-policy:J1 retry is explicit, bounded, and forbidden in acceptance
      if (options.allowUiShim && !useShim && options.mode !== "acceptance") {
        stderr(
          `wearable surface unavailable; retrying with explicit UI shim: ${error.message}`,
        );
        useShim = true;
        navigationResult = await navigateWearableSurface({
          page: attach.page,
          adb,
          useShim,
        });
      } else {
        throw error;
      }
    }
    startupRouteHealth = await probeStartupRoutes(attach.page);
    if (options.mode === "acceptance") {
      assertStartupRoutesHealthy(startupRouteHealth, "acceptance");
    }

    const screenshotPath = await maybeWriteScreenshot({
      page: attach.page,
      artifactDir,
    });
    const status = await readStatus({
      adb,
      packageName: options.packageName,
      page: attach.page,
      qualificationMode: plan.qualificationMode,
      shimRoutes: useShim ? shimRoutes : [],
      mode: options.mode,
    });
    status.device.serial = options.serial;
    const result = {
      ok: true,
      mode: options.mode,
      artifactDir,
      qualificationMode: plan.qualificationMode,
      navigationResult,
      screenshotPath,
      ...status,
    };
    writeLogcatArtifact({ adb, artifactDir, mode: options.mode });
    writeResultArtifact(artifactDir, result);
    writeJsonStdout(result);
  } catch (error) {
    // error-policy:J1 operator boundary emits one redacted machine result
    const message = error instanceof Error ? error.message : String(error);
    writeLogcatArtifact({ adb, artifactDir, mode: options.mode });
    const result = {
      ok: false,
      mode: options.mode,
      artifactDir,
      qualificationMode: plan.qualificationMode,
      nextHumanAction:
        options.mode === "acceptance"
          ? "rerun prepare-transport"
          : `rerun ${options.mode}`,
      error: message,
    };
    writeResultArtifact(artifactDir, result);
    writeJsonStdout(result);
    process.exitCode = 1;
  } finally {
    // error-policy:J6 best-effort cleanup removes only this invocation's forward
    await attach?.cleanup?.().catch((error) => {
      stderr(`CDP cleanup failed: ${error.message}`);
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let parsed = null;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    // error-policy:J3 untrusted CLI input becomes one machine-readable failure
    writeJsonStdout({
      ok: false,
      mode: null,
      error: error instanceof Error ? error.message : String(error),
      nextHumanAction: "rerun operator with valid arguments",
    });
    process.exitCode = 1;
  }
  if (parsed) {
    // error-policy:J1 last-resort async boundary preserves one-JSON stdout
    runOperator(parsed).catch((error) => {
      writeJsonStdout({
        ok: false,
        mode: parsed.mode,
        error: error instanceof Error ? error.message : String(error),
        nextHumanAction: `rerun ${parsed.mode}`,
      });
      process.exitCode = 1;
    });
  }
}
