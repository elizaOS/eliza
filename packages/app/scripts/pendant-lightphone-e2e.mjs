#!/usr/bin/env node
/**
 * Physical LP3 qualification evidence harness for issue #15744.
 *
 * The CLI drives only host-side adb capture around an explicit APK and serial.
 * It never changes product implementation, never grants permissions, and never
 * performs destructive device operations unless --clean-install is explicitly
 * passed for this app package.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAdb } from "./lib/android-device.mjs";
import { ISSUE_EVIDENCE_DIR, REPO_ROOT } from "./lib/issue-evidence.mjs";

const ISSUE = "15744";
const PREFIX = `${ISSUE}-pendant-lightphone`;
const APP_ID = "ai.elizaos.app";
const MAX_SCREENRECORD_SECONDS = 180;
const SESSION_DIR = path.join(
  os.tmpdir(),
  "elizaos-issue-15744-pendant-sessions",
);
const APP_UNINSTALL_NOT_INSTALLED = /(?:not installed|Unknown package)/i;
const DEFAULT_LOGCAT_FILTER =
  /(ai\.elizaos\.app|eliza|capacitor|bluetooth|ble|nearby|androidruntime|fatal exception|permission)/i;
const PERMISSION_STATE_PATTERN = new RegExp(
  [
    "permission",
    "install permissions",
    "runtime permissions",
    "BLUETOOTH",
    "NEARBY",
    "ACCESS_FINE_LOCATION",
    "RECORD_AUDIO",
    "granted=",
    "flags=",
  ].join("|"),
  "i",
);
const FORBIDDEN_COMMAND_TOKENS = [
  "fastboot",
  "edl",
  "root",
  "su",
  "reboot",
  "wipe",
];
const FORBIDDEN_SHELL_SEQUENCES = [/^pm\s+grant\b/i, /^pm\s+clear\b/i];

export class HarnessError extends Error {
  constructor(message, context = undefined) {
    super(message);
    this.name = "HarnessError";
    this.context = context;
  }
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const [subcommand = "help", ...rest] = argv;
  const flags = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      flags._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const value =
      eq === -1
        ? rest[i + 1] && !rest[i + 1].startsWith("--")
          ? rest[++i]
          : true
        : token.slice(eq + 1);
    if (flags[key] === undefined) {
      flags[key] = value;
    } else if (Array.isArray(flags[key])) {
      flags[key].push(value);
    } else {
      flags[key] = [flags[key], value];
    }
  }
  return { subcommand, flags };
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

export function sanitizeToken(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

export function sessionPathForSerial(serial) {
  mkdirSync(SESSION_DIR, { recursive: true });
  return path.join(SESSION_DIR, `${PREFIX}-${sanitizeToken(serial)}.json`);
}

function normalizedCommandToken(token) {
  return path.basename(String(token).trim()).toLowerCase();
}

function shellWords(args) {
  return args.map((arg) => String(arg).trim()).filter(Boolean);
}

export function assertSafeCommandInvocation(command, args = []) {
  const tokens = [command, ...args].map(normalizedCommandToken);
  for (const forbidden of FORBIDDEN_COMMAND_TOKENS) {
    if (tokens.includes(forbidden)) {
      throw new HarnessError(`refusing forbidden command token: ${forbidden}`);
    }
  }
  assertSafeAdbInvocation(args);
}

export function assertSafeAdbInvocation(args) {
  const shellIndex = args.indexOf("shell");
  if (shellIndex === -1) return;
  const shellArgs = shellWords(args.slice(shellIndex + 1));
  const shellText = shellArgs.join(" ");
  const shellTokens = shellArgs.map(normalizedCommandToken);
  for (const forbidden of FORBIDDEN_COMMAND_TOKENS) {
    if (shellTokens.includes(forbidden)) {
      throw new HarnessError(
        `refusing forbidden adb shell token: ${forbidden}`,
      );
    }
  }
  for (const pattern of FORBIDDEN_SHELL_SEQUENCES) {
    if (pattern.test(shellText)) {
      throw new HarnessError(
        `refusing forbidden adb shell command: ${shellText}`,
      );
    }
  }
}

function runFile(command, args, options = {}) {
  assertSafeCommandInvocation(command, args);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
  });
  if (options.allowFailure) return result;
  if (result.status !== 0) {
    throw new HarnessError(`${command} ${args.join(" ")} failed`, {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
}

function adbDevice(adb, serial, args, options = {}) {
  return runFile(adb, ["-s", serial, ...args], options);
}

function commandExists(command) {
  const probe = spawnSync(
    process.platform === "win32" ? "where" : "command",
    [
      process.platform === "win32" ? command : "-v",
      ...(process.platform === "win32" ? [] : [command]),
    ],
    {
      shell: true,
      stdio: "ignore",
    },
  );
  return probe.status === 0;
}

function findAndroidTool(name) {
  if (commandExists(name)) return name;
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Android", "Sdk"),
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Android", "sdk")
      : "",
  ].filter(Boolean);
  for (const sdkRoot of sdkRoots) {
    const buildTools = path.join(sdkRoot, "build-tools");
    if (!existsSync(buildTools)) continue;
    const versions = readdirSync(buildTools).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(
        buildTools,
        version,
        process.platform === "win32" ? `${name}.bat` : name,
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HarnessError(`missing required --${name}`);
  }
  return value;
}

function createArtifactDir(kind = "") {
  const suffix = kind ? `-${sanitizeToken(kind)}` : "";
  const dir = path.join(
    ISSUE_EVIDENCE_DIR,
    `${PREFIX}${suffix}-${timestamp()}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function verifySerialOnline(adb, serial) {
  const devices = runFile(adb, ["devices"]).stdout;
  const online = devices
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([id, state]) => id && state === "device")
    .map(([id]) => id);
  if (!online.includes(serial)) {
    throw new HarnessError(`serial ${serial} is not online`, { online });
  }
}

function collectDeviceMetadata(adb, serial, artifactDir) {
  const propKeys = [
    "ro.product.model",
    "ro.product.product.name",
    "ro.product.name",
    "ro.product.device",
    "ro.build.fingerprint",
    "ro.build.display.id",
    "ro.build.version.sdk",
    "ro.build.version.release",
    "ro.product.cpu.abi",
  ];
  const props = {};
  for (const key of propKeys) {
    props[key] = adbDevice(adb, serial, [
      "shell",
      "getprop",
      key,
    ]).stdout.trim();
  }
  const allProps = adbDevice(adb, serial, ["shell", "getprop"], {
    maxBuffer: 8 * 1024 * 1024,
  }).stdout;
  writeFileSync(path.join(artifactDir, "device-getprop.txt"), allProps, "utf8");
  const bluetoothManager = adbDevice(
    adb,
    serial,
    ["shell", "dumpsys", "bluetooth_manager"],
    { allowFailure: true, maxBuffer: 8 * 1024 * 1024 },
  );
  writeFileSync(
    path.join(artifactDir, "bluetooth-manager.txt"),
    `${bluetoothManager.stdout ?? ""}${bluetoothManager.stderr ?? ""}`,
    "utf8",
  );
  const bluetoothService = adbDevice(
    adb,
    serial,
    ["shell", "dumpsys", "bluetooth_manager", "--proto"],
    {
      allowFailure: true,
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(artifactDir, "bluetooth-manager-proto.bin"),
    bluetoothService.stdout ?? Buffer.alloc(0),
  );
  const bluetoothSettings = adbDevice(
    adb,
    serial,
    ["shell", "settings", "get", "global", "bluetooth_on"],
    { allowFailure: true, maxBuffer: 1024 * 1024 },
  );
  writeJson(path.join(artifactDir, "device-metadata.json"), {
    serial,
    capturedAt: new Date().toISOString(),
    props,
    bluetooth: {
      adapterSettingBluetoothOn: (bluetoothSettings.stdout ?? "").trim(),
      dumpsysBluetoothManagerStatus: bluetoothManager.status,
      dumpsysBluetoothManagerProtoStatus: bluetoothService.status,
      note: "Read-only Bluetooth adapter/service inspection; no adapter or permission mutations were performed.",
    },
  });
  return props;
}

function inspectLocalApk(apkPath, artifactDir) {
  const absolute = path.resolve(apkPath);
  if (!existsSync(absolute)) {
    throw new HarnessError(`APK does not exist: ${absolute}`);
  }
  const aapt = findAndroidTool("aapt2") ?? findAndroidTool("aapt");
  const apksigner = findAndroidTool("apksigner");
  const info = {
    path: absolute,
    size: statSync(absolute).size,
    sha256: sha256File(absolute),
    tools: { aapt: Boolean(aapt), apksigner: Boolean(apksigner) },
  };
  if (aapt) {
    const badging = runFile(aapt, ["dump", "badging", absolute], {
      allowFailure: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(
      path.join(artifactDir, "local-apk-badging.txt"),
      `${badging.stdout ?? ""}${badging.stderr ?? ""}`,
      "utf8",
    );
    const packageMatch = badging.stdout?.match(/package:\s+name='([^']+)'/);
    const versionNameMatch = badging.stdout?.match(/versionName='([^']*)'/);
    const versionCodeMatch = badging.stdout?.match(/versionCode='([^']*)'/);
    info.packageName = packageMatch?.[1] ?? null;
    info.versionName = versionNameMatch?.[1] ?? null;
    info.versionCode = versionCodeMatch?.[1] ?? null;
  }
  if (apksigner) {
    const certs = runFile(
      apksigner,
      ["verify", "--print-certs", "--verbose", absolute],
      { allowFailure: true, maxBuffer: 16 * 1024 * 1024 },
    );
    writeFileSync(
      path.join(artifactDir, "local-apk-signing-certs.txt"),
      `${certs.stdout ?? ""}${certs.stderr ?? ""}`,
      "utf8",
    );
    info.signingCertSummary = (certs.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => /certificate|signer|SHA-256/i.test(line))
      .slice(0, 40);
  }
  if (info.packageName && info.packageName !== APP_ID) {
    throw new HarnessError("local APK package does not match app identity", {
      expected: APP_ID,
      actual: info.packageName,
    });
  }
  writeJson(path.join(artifactDir, "local-apk.json"), info);
  copyFileSync(absolute, path.join(artifactDir, "local-input.apk"));
  return info;
}

function installApk(adb, serial, apkPath, cleanInstall, artifactDir) {
  if (cleanInstall) {
    const warning = [
      "WARNING: --clean-install requested.",
      `This uninstalls only ${APP_ID} and deletes that app's data before install.\n`,
    ].join(" ");
    writeFileSync(path.join(artifactDir, "clean-install-warning.txt"), warning);
    process.stderr.write(warning);
    const uninstall = adbDevice(adb, serial, ["uninstall", APP_ID], {
      allowFailure: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(
      path.join(artifactDir, "adb-uninstall.txt"),
      `${uninstall.stdout ?? ""}${uninstall.stderr ?? ""}`,
      "utf8",
    );
    const uninstallText = `${uninstall.stdout ?? ""}\n${uninstall.stderr ?? ""}`;
    if (
      uninstall.status !== 0 &&
      !APP_UNINSTALL_NOT_INSTALLED.test(uninstallText)
    ) {
      throw new HarnessError(`adb uninstall ${APP_ID} failed`, {
        stdout: uninstall.stdout,
        stderr: uninstall.stderr,
      });
    }
  }
  const result = adbDevice(adb, serial, ["install", "-r", apkPath], {
    allowFailure: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(
    path.join(artifactDir, "adb-install.txt"),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
    "utf8",
  );
  if (result.status !== 0) {
    throw new HarnessError("adb install -r failed", {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}

function parsePmPath(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .find(
      (entry) => entry.startsWith("package:") && entry.endsWith("base.apk"),
    );
  return line ? line.replace(/^package:/, "").trim() : null;
}

function pullInstalledBaseApk(adb, serial, basePath, artifactDir) {
  const out = path.join(artifactDir, "installed-base.apk");
  const pull = adbDevice(adb, serial, ["pull", basePath, out], {
    allowFailure: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (pull.status !== 0 || !existsSync(out)) {
    throw new HarnessError("failed to pull installed base.apk for exact hash", {
      basePath,
      stdout: pull.stdout,
      stderr: pull.stderr,
    });
  }
  return out;
}

function inspectInstalledPackage(adb, serial, localApkInfo, artifactDir) {
  const dumpsys = adbDevice(
    adb,
    serial,
    ["shell", "dumpsys", "package", APP_ID],
    {
      maxBuffer: 32 * 1024 * 1024,
    },
  ).stdout;
  writeFileSync(path.join(artifactDir, "dumpsys-package.txt"), dumpsys, "utf8");
  const pmPath = adbDevice(adb, serial, ["shell", "pm", "path", APP_ID]).stdout;
  writeFileSync(path.join(artifactDir, "pm-path.txt"), pmPath, "utf8");
  const basePath = parsePmPath(pmPath);
  if (!basePath) {
    throw new HarnessError(
      `could not resolve installed base.apk for ${APP_ID}`,
    );
  }
  const baseApk = pullInstalledBaseApk(adb, serial, basePath, artifactDir);
  const installedSha256 = sha256File(baseApk);
  if (installedSha256 !== localApkInfo.sha256) {
    throw new HarnessError("installed base.apk hash differs from local APK", {
      local: localApkInfo.sha256,
      installed: installedSha256,
    });
  }
  const versionName =
    dumpsys.match(/versionName=([^\s]+)/)?.[1] ??
    dumpsys.match(/versionName\s*:\s*([^\s]+)/)?.[1] ??
    null;
  const versionCode =
    dumpsys.match(/versionCode=(\d+)/)?.[1] ??
    dumpsys.match(/versionCode\s*:\s*(\d+)/)?.[1] ??
    null;
  const signerLines = dumpsys
    .split(/\r?\n/)
    .filter((line) => /Signing|signing|certificate|SHA-256|digest/i.test(line))
    .slice(0, 120);
  const apksigner = findAndroidTool("apksigner");
  let installedSigningCertSummary = [];
  if (apksigner) {
    const certs = runFile(
      apksigner,
      ["verify", "--print-certs", "--verbose", baseApk],
      { allowFailure: true, maxBuffer: 16 * 1024 * 1024 },
    );
    writeFileSync(
      path.join(artifactDir, "installed-base-apk-signing-certs.txt"),
      `${certs.stdout ?? ""}${certs.stderr ?? ""}`,
      "utf8",
    );
    installedSigningCertSummary = (certs.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => /certificate|signer|SHA-256/i.test(line))
      .slice(0, 40);
  }
  const info = {
    packageName: APP_ID,
    versionName,
    versionCode,
    basePath,
    installedBaseApkSha256: installedSha256,
    matchesLocalApkSha256: installedSha256 === localApkInfo.sha256,
    signingSummaryFromDumpsys: signerLines,
    installedSigningCertSummary,
  };
  writeJson(path.join(artifactDir, "installed-package.json"), info);
  return info;
}

function setExternalToolsProp(adb, serial, artifactDir) {
  adbDevice(adb, serial, [
    "shell",
    "setprop",
    "LIGHTOS_SHOW_EXTERNAL_TOOLS",
    "1",
  ]);
  const readback = adbDevice(adb, serial, [
    "shell",
    "getprop",
    "LIGHTOS_SHOW_EXTERNAL_TOOLS",
  ]).stdout.trim();
  const info = {
    property: "LIGHTOS_SHOW_EXTERNAL_TOOLS",
    expected: "1",
    readback,
  };
  writeJson(path.join(artifactDir, "lightos-show-external-tools.json"), info);
  if (readback !== "1") {
    throw new HarnessError(
      "LIGHTOS_SHOW_EXTERNAL_TOOLS readback mismatch",
      info,
    );
  }
  return info;
}

function inspectPermissions(adb, serial, artifactDir) {
  const appops = adbDevice(
    adb,
    serial,
    ["shell", "cmd", "appops", "get", APP_ID],
    {
      allowFailure: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(artifactDir, "appops.txt"),
    `${appops.stdout ?? ""}${appops.stderr ?? ""}`,
    "utf8",
  );
  const packageDump = readFileSync(
    path.join(artifactDir, "dumpsys-package.txt"),
    "utf8",
  );
  writeFileSync(
    path.join(artifactDir, "package-permissions-full.txt"),
    packageDump
      .split(/\r?\n/)
      .filter((line) => PERMISSION_STATE_PATTERN.test(line))
      .join("\n"),
    "utf8",
  );
  const permissionLines = packageDump
    .split(/\r?\n/)
    .filter((line) => PERMISSION_STATE_PATTERN.test(line));
  writeJson(path.join(artifactDir, "permissions-inspection.json"), {
    note: "Read-only inspection. This harness never grants permissions or accepts UX permission prompts.",
    permissionLines,
    appopsStatus: appops.status,
    appopsLines: `${appops.stdout ?? ""}${appops.stderr ?? ""}`
      .split(/\r?\n/)
      .filter(Boolean),
  });
}

function captureStaticArtifacts(adb, serial, artifactDir, label) {
  const hierarchyRemote = `/sdcard/window-${sanitizeToken(label)}-${Date.now()}.xml`;
  adbDevice(adb, serial, ["shell", "uiautomator", "dump", hierarchyRemote], {
    allowFailure: true,
  });
  adbDevice(
    adb,
    serial,
    [
      "pull",
      hierarchyRemote,
      path.join(artifactDir, `${label}-uiautomator.xml`),
    ],
    { allowFailure: true },
  );
  adbDevice(adb, serial, ["shell", "rm", "-f", hierarchyRemote], {
    allowFailure: true,
  });
  const screenshot = spawnSync(
    adb,
    ["-s", serial, "exec-out", "screencap", "-p"],
    {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (screenshot.status === 0 && screenshot.stdout?.length) {
    writeFileSync(
      path.join(artifactDir, `${label}-screenshot.png`),
      screenshot.stdout,
    );
  }
  const logcat = adbDevice(
    adb,
    serial,
    ["logcat", "-d", "-t", "800", "-v", "threadtime"],
    {
      allowFailure: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(artifactDir, `${label}-logcat-snapshot.txt`),
    filterLogcat(logcat.stdout ?? ""),
    "utf8",
  );
  const settings = adbDevice(
    adb,
    serial,
    ["shell", "settings", "list", "global"],
    {
      allowFailure: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(artifactDir, `${label}-settings-global.txt`),
    settings.stdout ?? "",
    "utf8",
  );
}

export function filterLogcat(
  input,
  pattern = DEFAULT_LOGCAT_FILTER,
  maxBytes = 24 * 1024 * 1024,
) {
  let written = 0;
  const lines = [];
  for (const line of String(input).split(/\r?\n/)) {
    if (!pattern.test(line)) continue;
    const size = Buffer.byteLength(`${line}\n`);
    if (written + size > maxBytes) break;
    lines.push(line);
    written += size;
  }
  return `${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

function processIdentity(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  const procDir = `/proc/${numericPid}`;
  try {
    const cmdline = readFileSync(path.join(procDir, "cmdline"), "utf8")
      .split("\0")
      .filter(Boolean);
    const stat = readFileSync(path.join(procDir, "stat"), "utf8");
    const afterComm = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return {
      pid: numericPid,
      cmdline,
      procStartTime: afterComm[19] ?? null,
      source: "procfs",
    };
  } catch {
    const ps = spawnSync("ps", ["-p", String(numericPid), "-o", "args="], {
      encoding: "utf8",
    });
    if (ps.status !== 0 || !ps.stdout.trim()) return null;
    return {
      pid: numericPid,
      cmdline: ps.stdout.trim().split(/\s+/),
      procStartTime: null,
      source: "ps",
    };
  }
}

export function processMatchesSession(current, expected) {
  if (!current || !expected) return false;
  if (current.pid !== expected.pid) return false;
  if (
    expected.procStartTime &&
    current.procStartTime &&
    current.procStartTime !== expected.procStartTime
  ) {
    return false;
  }
  const cmdline = current.cmdline.join("\0");
  for (const needle of expected.contains ?? []) {
    if (!cmdline.includes(needle)) return false;
  }
  return true;
}

function spawnDetachedCapture(
  command,
  args,
  { stdoutPath, stderrPath, contains },
) {
  assertSafeCommandInvocation(command, args);
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  let child;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  child.unref();
  const identity = processIdentity(child.pid);
  return {
    pid: child.pid,
    command,
    args,
    stdoutPath,
    stderrPath,
    startedAt: new Date().toISOString(),
    identity: {
      ...identity,
      contains,
    },
  };
}

function startRawLogcat(adb, serial, artifactDir) {
  const stdoutPath = path.join(artifactDir, "logcat-raw-live.txt");
  const stderrPath = path.join(artifactDir, "logcat-raw-live.stderr.txt");
  const args = ["-s", serial, "logcat", "-v", "threadtime"];
  const capture = spawnDetachedCapture(adb, args, {
    stdoutPath,
    stderrPath,
    contains: [path.basename(adb), serial, "logcat", "threadtime"],
  });
  writeJson(path.join(artifactDir, "logcat-process.json"), capture);
  return capture;
}

function startScreenrecord(adb, serial, artifactDir) {
  const remote = `/sdcard/${PREFIX}-${sanitizeToken(serial)}-${Date.now()}.mp4`;
  const stdoutPath = path.join(artifactDir, "screenrecord.stdout.txt");
  const stderrPath = path.join(artifactDir, "screenrecord.stderr.txt");
  adbDevice(adb, serial, ["shell", "rm", "-f", remote], { allowFailure: true });
  const args = [
    "-s",
    serial,
    "shell",
    "screenrecord",
    "--bit-rate",
    "4000000",
    "--time-limit",
    String(MAX_SCREENRECORD_SECONDS),
    remote,
  ];
  const capture = spawnDetachedCapture(adb, args, {
    stdoutPath,
    stderrPath,
    contains: [path.basename(adb), serial, "screenrecord", remote],
  });
  const result = { ...capture, remote };
  writeJson(path.join(artifactDir, "screenrecord-remote.json"), result);
  return result;
}

function signalVerifiedCapture(capture, signal = "SIGINT") {
  if (!capture?.pid) return false;
  const current = processIdentity(capture.pid);
  if (!processMatchesSession(current, capture.identity)) {
    return false;
  }
  try {
    process.kill(capture.pid, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function removeRemoteFile(adb, serial, remote) {
  if (!remote?.startsWith(`/sdcard/${PREFIX}-`)) return;
  adbDevice(adb, serial, ["shell", "rm", "-f", remote], {
    allowFailure: true,
  });
}

function launchApp(adb, serial, artifactDir) {
  const result = adbDevice(
    adb,
    serial,
    [
      "shell",
      "monkey",
      "-p",
      APP_ID,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ],
    { allowFailure: true, maxBuffer: 2 * 1024 * 1024 },
  );
  writeFileSync(
    path.join(artifactDir, "launch.txt"),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
    "utf8",
  );
  if (result.status !== 0) {
    throw new HarnessError(`failed to launch ${APP_ID}`, {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}

export function buildManifest(artifactDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name === "artifact-manifest.json") continue;
      files.push({
        path: path.relative(artifactDir, full).replaceAll(path.sep, "/"),
        size: statSync(full).size,
        sha256: sha256File(full),
      });
    }
  };
  walk(artifactDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    issue: `https://github.com/elizaOS/eliza/issues/${ISSUE}`,
    artifactDir,
    generatedAt: new Date().toISOString(),
    files,
  };
  writeJson(path.join(artifactDir, "artifact-manifest.json"), manifest);
  return manifest;
}

async function startCommand(flags) {
  const serial = requireFlag(flags, "serial");
  const apkPath = path.resolve(requireFlag(flags, "apk"));
  const artifactDir = createArtifactDir();
  const adb = resolveAdb();
  verifySerialOnline(adb, serial);
  const sessionPath = sessionPathForSerial(serial);
  if (existsSync(sessionPath)) {
    throw new HarnessError(`active session already exists for ${serial}`, {
      sessionPath,
    });
  }

  let logcat;
  let screenrecord;
  const cleanup = () => {
    signalVerifiedCapture(logcat);
    signalVerifiedCapture(screenrecord);
    if (screenrecord?.remote) {
      writeJson(path.join(artifactDir, "screenrecord-recovery.json"), {
        status: "start-interrupted-remote-preserved",
        remote: screenrecord.remote,
        serial,
      });
    }
    rmSync(sessionPath, { force: true });
  };
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  try {
    const localApk = inspectLocalApk(apkPath, artifactDir);
    collectDeviceMetadata(adb, serial, artifactDir);
    installApk(
      adb,
      serial,
      apkPath,
      flags["clean-install"] === true,
      artifactDir,
    );
    const installed = inspectInstalledPackage(
      adb,
      serial,
      localApk,
      artifactDir,
    );
    setExternalToolsProp(adb, serial, artifactDir);
    inspectPermissions(adb, serial, artifactDir);
    launchApp(adb, serial, artifactDir);
    captureStaticArtifacts(adb, serial, artifactDir, "start");
    logcat = startRawLogcat(adb, serial, artifactDir);
    screenrecord = startScreenrecord(adb, serial, artifactDir);
    const session = {
      issue: ISSUE,
      serial,
      appId: APP_ID,
      artifactDir,
      startedAt: new Date().toISOString(),
      adb,
      localApk,
      installed,
      logcat,
      screenrecord,
      hostPid: process.pid,
      sessionPath,
    };
    writeJson(sessionPath, session);
    buildManifest(artifactDir);
    console.log(`LP3 session started: ${artifactDir}`);
    console.log(`Session file: ${sessionPath}`);
  } catch (error) {
    cleanup();
    throw error;
  }
}

function statusCommand(flags) {
  const serial = flags.serial;
  if (typeof serial === "string") {
    const file = sessionPathForSerial(serial);
    console.log(
      existsSync(file)
        ? readFileSync(file, "utf8")
        : `No session for ${serial}`,
    );
    return;
  }
  mkdirSync(SESSION_DIR, { recursive: true });
  const sessions = readdirSync(SESSION_DIR).filter((name) =>
    name.endsWith(".json"),
  );
  console.log(JSON.stringify({ sessions }, null, 2));
}

async function stopCommand(flags) {
  const serial = requireFlag(flags, "serial");
  const sessionPath = sessionPathForSerial(serial);
  if (!existsSync(sessionPath)) {
    throw new HarnessError(`no active session for ${serial}`);
  }
  const session = readJson(sessionPath);
  if (session.serial !== serial) {
    throw new HarnessError("session serial mismatch", { serial, session });
  }
  const adb = session.adb || resolveAdb();
  const stopped = {
    logcat: signalVerifiedCapture(session.logcat),
    screenrecord: signalVerifiedCapture(session.screenrecord),
  };
  await Promise.all([
    session.logcat?.pid ? waitForProcessExit(session.logcat.pid, 3000) : true,
    session.screenrecord?.pid
      ? waitForProcessExit(session.screenrecord.pid, 5000)
      : true,
  ]);
  if (session.screenrecord?.remote) {
    const out = path.join(session.artifactDir, "screenrecord.mp4");
    const pull = adbDevice(
      adb,
      serial,
      ["pull", session.screenrecord.remote, out],
      {
        allowFailure: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    writeFileSync(
      path.join(session.artifactDir, "screenrecord-pull.txt"),
      `${pull.stdout ?? ""}${pull.stderr ?? ""}`,
      "utf8",
    );
    if (pull.status === 0 && existsSync(out) && statSync(out).size > 0) {
      removeRemoteFile(adb, serial, session.screenrecord.remote);
    } else {
      writeJson(path.join(session.artifactDir, "screenrecord-recovery.json"), {
        status: "pull-failed-remote-preserved",
        remote: session.screenrecord.remote,
        serial,
      });
    }
  }
  if (session.logcat?.stdoutPath && existsSync(session.logcat.stdoutPath)) {
    writeFileSync(
      path.join(session.artifactDir, "logcat-filtered-live.txt"),
      filterLogcat(readFileSync(session.logcat.stdoutPath, "utf8")),
      "utf8",
    );
  }
  captureStaticArtifacts(adb, serial, session.artifactDir, "stop");
  writeJson(path.join(session.artifactDir, "session-final.json"), {
    ...session,
    stoppedProcesses: stopped,
    stoppedAt: new Date().toISOString(),
  });
  buildManifest(session.artifactDir);
  rmSync(sessionPath, { force: true });
  console.log(`LP3 session stopped and finalized: ${session.artifactDir}`);
}

async function captureCommand(flags) {
  const duration = Number(flags.duration ?? 30);
  if (!Number.isFinite(duration) || duration < 1) {
    throw new HarnessError("--duration must be a positive number of seconds");
  }
  if (duration > MAX_SCREENRECORD_SECONDS) {
    throw new HarnessError(
      `--duration cannot exceed Android screenrecord's ${MAX_SCREENRECORD_SECONDS}-second limit`,
    );
  }
  await startCommand(flags);
  await new Promise((resolve) => setTimeout(resolve, duration * 1000));
  await stopCommand(flags);
}

export function validateReport(report, artifactRoot = ISSUE_EVIDENCE_DIR) {
  const failures = [];
  const root = path.resolve(artifactRoot);
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    failures.push("artifact root does not exist");
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, failures: ["report must be an object"] };
  }
  if (!Array.isArray(report.checkpoints)) {
    failures.push("report.checkpoints must be an array");
    return { ok: false, failures };
  }
  const ids = new Set();
  for (const checkpoint of report.checkpoints) {
    if (
      !checkpoint ||
      typeof checkpoint !== "object" ||
      Array.isArray(checkpoint)
    ) {
      failures.push("checkpoint must be an object");
      continue;
    }
    if (typeof checkpoint.id !== "string" || !checkpoint.id.trim()) {
      failures.push("checkpoint.id must be a non-empty string");
      continue;
    }
    if (ids.has(checkpoint.id)) {
      failures.push(`${checkpoint.id}: duplicate checkpoint id`);
    }
    ids.add(checkpoint.id);
    const status = checkpoint.status;
    const proof = checkpoint.proof ?? "physical";
    const artifacts = checkpoint.artifacts ?? [];
    if (!["pass", "fail", "unverified"].includes(status)) {
      failures.push(
        `${checkpoint.id}: status must be pass, fail, or unverified`,
      );
    }
    if (!["physical", "supplemental"].includes(proof)) {
      failures.push(`${checkpoint.id}: proof must be physical or supplemental`);
    }
    if (!Array.isArray(artifacts)) {
      failures.push(`${checkpoint.id}: artifacts must be an array`);
      continue;
    }
    if (proof === "physical" && status === "pass" && artifacts.length === 0) {
      failures.push(`${checkpoint.id}: physical pass requires artifacts`);
    }
    for (const artifact of artifacts) {
      const artifactPathValue =
        typeof artifact === "string" ? artifact : artifact?.path;
      if (typeof artifactPathValue !== "string" || !artifactPathValue.trim()) {
        failures.push(`${checkpoint.id}: artifact path must be a string`);
        continue;
      }
      if (
        proof === "physical" &&
        status === "pass" &&
        (typeof artifact !== "object" ||
          typeof artifact.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/i.test(artifact.sha256))
      ) {
        failures.push(
          `${checkpoint.id}: physical pass artifact ${artifactPathValue} requires sha256`,
        );
      }
      const artifactPath = path.resolve(root, artifactPathValue);
      const relative = path.relative(root, artifactPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        failures.push(`${checkpoint.id}: artifact escapes evidence root`);
      } else if (!existsSync(artifactPath)) {
        failures.push(
          `${checkpoint.id}: missing artifact ${artifactPathValue}`,
        );
      } else {
        const stat = lstatSync(artifactPath);
        if (stat.isSymbolicLink()) {
          const target = realpathSync(artifactPath);
          const realRelative = path.relative(realRoot, target);
          if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
            failures.push(
              `${checkpoint.id}: artifact symlink escapes evidence root`,
            );
          }
        }
        if (
          typeof artifact === "object" &&
          artifact.sha256 &&
          sha256File(artifactPath) !== artifact.sha256
        ) {
          failures.push(
            `${checkpoint.id}: sha256 mismatch for ${artifactPathValue}`,
          );
        }
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

function templateReport() {
  return {
    issue: `https://github.com/elizaOS/eliza/issues/${ISSUE}`,
    generatedAt: new Date().toISOString(),
    checkpoints: [
      {
        id: "lp3-physical-device-and-apk",
        proof: "physical",
        status: "unverified",
        artifacts: [],
        notes:
          "Device model/build/API/ABI plus local and installed APK hashes/signing.",
      },
      {
        id: "lp3-physical-bluetooth-permissions",
        proof: "physical",
        status: "unverified",
        artifacts: [],
        notes:
          "Read-only dumpsys/appops inspection. No pm grant or UX auto-accept.",
      },
      {
        id: "lp3-physical-launch-and-capture",
        proof: "physical",
        status: "unverified",
        artifacts: [],
        notes: "Screenshots, UIAutomator, bounded logcat, screen recording.",
      },
      {
        id: "desktop-sol-dev-browser-evidence",
        proof: "supplemental",
        status: "unverified",
        artifacts: [],
        notes:
          "Actual sol-dev browser logs, HAR/trace, screenshots/video, and bounded/redacted transcript/session artifacts. Does not prove physical pairing.",
      },
      {
        id: "desktop-sol-dev-manual-web-bluetooth",
        proof: "physical",
        status: "unverified",
        artifacts: [],
        notes:
          "Manual Web Bluetooth picker checkpoint. Browser automation is not physical pairing proof.",
      },
      {
        id: "supplemental-emulation",
        proof: "supplemental",
        status: "unverified",
        artifacts: [],
        notes:
          "Deterministic browser/protocol faults. Not physical BLE/LP3 proof.",
      },
    ],
  };
}

function reportCommand(flags) {
  const out =
    typeof flags.output === "string"
      ? path.resolve(flags.output)
      : path.join(ISSUE_EVIDENCE_DIR, `${PREFIX}-report-${timestamp()}.json`);
  const relative = path.relative(path.resolve(ISSUE_EVIDENCE_DIR), out);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(out).startsWith(`${PREFIX}-report`)
  ) {
    throw new HarnessError(
      `report output must be a ${PREFIX}-report*.json file under ${ISSUE_EVIDENCE_DIR}`,
    );
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeJson(out, templateReport());
  console.log(out);
}

function validateCommand(flags) {
  const reportPath = path.resolve(requireFlag(flags, "report"));
  const result = validateReport(readJson(reportPath), ISSUE_EVIDENCE_DIR);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function usage() {
  console.log(`Usage:
  node scripts/pendant-lightphone-e2e.mjs start --serial <adb-serial> --apk <apk> [--clean-install]
  node scripts/pendant-lightphone-e2e.mjs stop --serial <adb-serial>
  node scripts/pendant-lightphone-e2e.mjs status [--serial <adb-serial>]
  node scripts/pendant-lightphone-e2e.mjs capture --serial <adb-serial> --apk <apk> --duration <seconds>
  node scripts/pendant-lightphone-e2e.mjs report [--output <report.json>]
  node scripts/pendant-lightphone-e2e.mjs validate --report <report.json>

Safety: no implicit serial/APK, no fastboot/EDL/root/reboot/wipe/pm clear, no permission grants.`);
}

async function main(argv = process.argv.slice(2)) {
  const { subcommand, flags } = parseCliArgs(argv);
  switch (subcommand) {
    case "start":
      return startCommand(flags);
    case "stop":
      return stopCommand(flags);
    case "status":
      return statusCommand(flags);
    case "capture":
      return captureCommand(flags);
    case "report":
      return reportCommand(flags);
    case "validate":
      return validateCommand(flags);
    case "help":
    case "--help":
    case "-h":
      return usage();
    default:
      throw new HarnessError(`unknown subcommand: ${subcommand}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[pendant-lightphone-e2e] ${error.message}`);
    if (error.context) console.error(JSON.stringify(error.context, null, 2));
    process.exit(1);
  });
}
