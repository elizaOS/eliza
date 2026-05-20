#!/usr/bin/env node
/**
 * Install and diagnose the Eliza Cloud Android SMS gateway APK.
 *
 * This script is intentionally narrow: it validates the same physical-device
 * prerequisites the gateway needs for end-to-end SMS verification, without
 * depending on the full local-agent Android build.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function resolveElizaWorkspaceRoot(startFile) {
  let current = path.dirname(fileURLToPath(startFile));
  while (true) {
    if (
      fs.existsSync(path.join(current, "package.json")) &&
      fs.existsSync(path.join(current, "packages", "app-core", "package.json")) &&
      fs.existsSync(path.join(current, "packages", "app", "package.json"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

const repoRoot = resolveElizaWorkspaceRoot(import.meta.url);
const generatedApk = path.join(
  repoRoot,
  "packages",
  "app",
  "android",
  "app",
  "build",
  "outputs",
  "apk",
  "debug",
  "app-debug.apk",
);
const preservedApk = path.join(
  repoRoot,
  ".eliza-local",
  "artifacts",
  "eliza-android-sms-gateway-debug.apk",
);
const packageName = "app.eliza";
const smsRole = "android.app.role.SMS";
const defaultCloudWebhookUrl =
  "https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles";
const defaultGatewayPhoneNumber = "+14159611510";
const defaultGatewayPhoneLabel = "Eliza Cloud Gateway (+14159611510)";

function usage() {
  return [
    "Usage: node packages/app-core/scripts/install-android-sms-gateway.mjs [options]",
    "",
    "Options:",
    "  --apk <path>           APK to install. Defaults to generated APK, then .eliza-local artifact.",
    "  --serial <serial>      adb serial. Defaults to the only connected device.",
    "  --adb <path>           adb binary. Defaults to Android SDK lookup or PATH.",
    "  --skip-install         Only run diagnostics.",
    "  --grant-role           Try cmd role add-role-holder for the SMS role.",
    "  --simulate <number>    On an emulator, inject an inbound SMS from this number.",
    "  --message <text>       Message body for --simulate.",
    "  --clear-logcat         Clear device logs before diagnostics/simulation.",
    "  --logcat-lines <n>     Dump relevant gateway logs after diagnostics. Defaults to 0.",
    "  --watch-logs <seconds> Stream relevant gateway logs for the given duration.",
    "  --print-apk            Print the resolved APK path and exit.",
    "  --doctor               Check local APK, adb, bridge, and device readiness.",
    "  --wait-device <seconds> Wait for an adb device before install/diagnostics.",
    "  --pair <endpoint>      Run adb pair before resolving the device. Use host:port or 'auto'.",
    "  --pair-code <code>     Wireless debugging pairing code for --pair.",
    "  --connect <endpoint>   Run adb connect before resolving the device. Use host:port or 'auto'.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    apk: null,
    adb: process.env.ADB || null,
    serial: process.env.ANDROID_SERIAL || null,
    install: true,
    grantRole: false,
    simulate: null,
    message: "hello from android sms gateway install smoke",
    clearLogcat: false,
    logcatLines: 0,
    watchLogsSeconds: 0,
    printApk: false,
    doctor: false,
    waitDeviceSeconds: 0,
    pairEndpoint: null,
    pairCode: process.env.ADB_PAIR_CODE || null,
    connectEndpoint: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--apk") args.apk = path.resolve(next());
    else if (arg === "--adb") args.adb = path.resolve(next());
    else if (arg === "--serial") args.serial = next();
    else if (arg === "--skip-install") args.install = false;
    else if (arg === "--grant-role") args.grantRole = true;
    else if (arg === "--simulate") args.simulate = next();
    else if (arg === "--message") args.message = next();
    else if (arg === "--clear-logcat") args.clearLogcat = true;
    else if (arg === "--logcat-lines") args.logcatLines = Number.parseInt(next(), 10);
    else if (arg === "--watch-logs") args.watchLogsSeconds = Number.parseInt(next(), 10);
    else if (arg === "--print-apk") args.printApk = true;
    else if (arg === "--doctor") args.doctor = true;
    else if (arg === "--wait-device") args.waitDeviceSeconds = Number.parseInt(next(), 10);
    else if (arg === "--pair") args.pairEndpoint = next();
    else if (arg === "--pair-code") args.pairCode = next();
    else if (arg === "--connect") args.connectEndpoint = next();
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return args;
}

function resolveApk(explicit) {
  if (explicit) return path.resolve(explicit);
  return firstExisting([generatedApk, preservedApk]) ?? generatedApk;
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if (allowFailure) return result;
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function firstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveAdb(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`adb not found: ${explicit}`);
    return explicit;
  }
  const fromSdk = firstExisting([
    process.env.ANDROID_HOME &&
      path.join(process.env.ANDROID_HOME, "platform-tools", "adb"),
    process.env.ANDROID_SDK_ROOT &&
      path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    "/opt/homebrew/share/android-commandlinetools/platform-tools/adb",
    path.join(process.env.HOME || "", "Library", "Android", "sdk", "platform-tools", "adb"),
  ]);
  if (fromSdk) return fromSdk;
  const pathResult = run("which", ["adb"], { allowFailure: true });
  if (pathResult.status === 0 && pathResult.stdout.trim()) {
    return pathResult.stdout.trim();
  }
  throw new Error("adb not found. Set --adb, ADB, ANDROID_HOME, or ANDROID_SDK_ROOT.");
}

function adbArgs(serial, args) {
  return serial ? ["-s", serial, ...args] : args;
}

function adb(adbPath, serial, args, options) {
  return run(adbPath, adbArgs(serial, args), options);
}

function listDevices(adbPath) {
  const result = run(adbPath, ["devices", "-l"]);
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\bdevice\b/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

function listWirelessAdbServices(adbPath) {
  const result = run(adbPath, ["mdns", "services"], { allowFailure: true });
  if (result.status !== 0) {
    return {
      ok: false,
      services: [],
      detail: result.stderr || result.stdout || "adb mdns services failed",
    };
  }

  const services = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("List of discovered"))
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        name: parts[0] ?? "",
        type: parts[1] ?? "",
        endpoint: parts[2] ?? "",
      };
    })
    .filter((service) => service.name && service.type && service.endpoint);

  return {
    ok: services.length > 0,
    services,
    detail:
      services.length > 0
        ? services
            .map((service) => `${service.name} ${service.type} ${service.endpoint}`)
            .join("; ")
        : "no wireless adb services discovered",
  };
}

function findWirelessAdbEndpoint(adbPath, serviceType) {
  const wirelessAdb = listWirelessAdbServices(adbPath);
  const match = wirelessAdb.services.find((service) =>
    service.type.includes(serviceType),
  );
  if (!match?.endpoint) {
    throw new Error(
      `No ${serviceType} wireless adb service discovered. Open Android Developer Options > Wireless debugging and choose "Pair device with pairing code".`,
    );
  }
  return match.endpoint;
}

function resolveWirelessEndpoint(adbPath, endpoint, serviceType) {
  if (endpoint === "auto") return findWirelessAdbEndpoint(adbPath, serviceType);
  if (!/^[^:]+:\d+$/.test(endpoint)) {
    throw new Error(`Wireless adb endpoint must be host:port or auto; received ${endpoint}`);
  }
  return endpoint;
}

function pairWirelessAdb({ adbPath, endpoint, code }) {
  if (!code) {
    throw new Error("--pair-code is required for --pair. The code is shown on the phone's Wireless debugging pairing screen.");
  }
  const resolved = resolveWirelessEndpoint(adbPath, endpoint, "_adb-tls-pairing");
  const result = run(adbPath, ["pair", resolved, code], { allowFailure: true });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0 || !/Successfully paired/i.test(output)) {
    throw new Error(`adb pair ${resolved} failed:\n${output || "no output"}`);
  }
  console.log(`[android-sms-gateway] Paired wireless adb endpoint ${resolved}.`);
}

function connectWirelessAdb({ adbPath, endpoint }) {
  const resolved = resolveWirelessEndpoint(adbPath, endpoint, "_adb-tls-connect");
  const result = run(adbPath, ["connect", resolved], { allowFailure: true });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0 || !/connected to|already connected/i.test(output)) {
    throw new Error(`adb connect ${resolved} failed:\n${output || "no output"}`);
  }
  console.log(`[android-sms-gateway] Connected wireless adb endpoint ${resolved}.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevice(adbPath, requested, timeoutSeconds) {
  if (requested) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() <= deadline) {
      const devices = listDevices(adbPath);
      if (devices.includes(requested)) return requested;
      await sleep(1000);
    }
    throw new Error(`Timed out waiting for adb device ${requested}`);
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const devices = listDevices(adbPath);
    if (devices.length === 1) return devices[0];
    if (devices.length > 1) {
      throw new Error(
        `Multiple adb devices are connected; pass --serial. Devices: ${devices.join(", ")}`,
      );
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting ${timeoutSeconds}s for an adb device`);
}

function resolveSerial(adbPath, requested) {
  if (requested) return requested;
  const devices = listDevices(adbPath);
  if (devices.length === 1) return devices[0];
  if (devices.length === 0) {
    throw new Error("No adb devices are connected. Connect an Android phone with USB debugging enabled.");
  }
  throw new Error(
    `Multiple adb devices are connected; pass --serial. Devices: ${devices.join(", ")}`,
  );
}

function shell(adbPath, serial, command, options = {}) {
  return adb(adbPath, serial, ["shell", command], options);
}

function printSection(title, value) {
  console.log(`\n[android-sms-gateway] ${title}`);
  if (value) console.log(value.trim());
}

function clearLogcat({ adbPath, serial }) {
  adb(adbPath, serial, ["logcat", "-c"], { allowFailure: true });
  console.log("[android-sms-gateway] Cleared device logcat buffer.");
}

function gatewayLogcatFilter() {
  return [
    "ElizaSmsGateway:D",
    "ElizaSmsReceiver:D",
    "WM-WorkerWrapper:I",
    "WM-Processor:I",
    "AndroidRuntime:E",
    "*:S",
  ];
}

function dumpGatewayLogs({ adbPath, serial, lines }) {
  if (lines <= 0) return;
  const result = adb(
    adbPath,
    serial,
    ["logcat", "-d", "-t", String(lines), "-v", "time", ...gatewayLogcatFilter()],
    { allowFailure: true },
  );
  printSection(
    `recent gateway logs (${lines} lines)`,
    result.status === 0 ? result.stdout : `unavailable: ${result.stderr || result.stdout}`,
  );
}

function watchGatewayLogs({ adbPath, serial, seconds }) {
  if (seconds <= 0) return;
  const result = spawnSync(
    adbPath,
    adbArgs(serial, ["logcat", "-v", "time", ...gatewayLogcatFilter()]),
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: seconds * 1000,
    },
  );
  printSection(
    `watched gateway logs (${seconds}s)`,
    result.stdout || result.stderr || "no matching log lines",
  );
}

function diagnose({ adbPath, serial }) {
  const packagePath = shell(adbPath, serial, `pm path ${packageName}`, {
    allowFailure: true,
  });
  printSection(
    "package",
    packagePath.status === 0 ? packagePath.stdout : `not installed: ${packagePath.stderr || packagePath.stdout}`,
  );

  const roles = shell(adbPath, serial, `cmd role get-role-holders ${smsRole}`, {
    allowFailure: true,
  });
  printSection(
    "sms role holders",
    roles.status === 0 ? roles.stdout : `unavailable: ${roles.stderr || roles.stdout}`,
  );

  const permissions = shell(
    adbPath,
    serial,
    `dumpsys package ${packageName} | sed -n '/runtime permissions:/,/install permissions:/p'`,
    { allowFailure: true },
  );
  printSection(
    "runtime permissions",
    permissions.status === 0 ? permissions.stdout : `unavailable: ${permissions.stderr || permissions.stdout}`,
  );

  const receivers = shell(
    adbPath,
    serial,
    `cmd package query-receivers --brief -a android.provider.Telephony.SMS_DELIVER ${packageName}`,
    { allowFailure: true },
  );
  printSection(
    "sms deliver receivers",
    receivers.status === 0 ? receivers.stdout : `unavailable: ${receivers.stderr || receivers.stdout}`,
  );
}

function install({ adbPath, serial, apk }) {
  if (!fs.existsSync(apk)) {
    throw new Error(`APK not found: ${apk}. Build it with: node packages/app-core/scripts/run-mobile-build.mjs android-sms-gateway`);
  }
  console.log(`[android-sms-gateway] Installing ${apk} on ${serial}`);
  adb(adbPath, serial, ["install", "-r", "-g", "-t", apk]);
}

function grantSmsRole({ adbPath, serial }) {
  const result = shell(
    adbPath,
    serial,
    `cmd role add-role-holder ${smsRole} ${packageName}`,
    { allowFailure: true },
  );
  printSection(
    "grant sms role",
    result.status === 0
      ? result.stdout || "role command completed"
      : `role command failed; set Eliza as the default SMS app in Android Settings: ${result.stderr || result.stdout}`,
  );
}

function simulateInboundSms({ adbPath, serial, number, message }) {
  if (!/^emulator-/.test(serial)) {
    throw new Error("--simulate only works on Android emulators; physical devices require a real inbound SMS.");
  }
  console.log(`[android-sms-gateway] Simulating inbound SMS from ${number}`);
  adb(adbPath, serial, ["emu", "sms", "send", number, message]);
}

function resolveAndroidBuildTool(toolName) {
  const sdkRoot =
    process.env.ANDROID_SDK_ROOT ||
    process.env.ANDROID_HOME ||
    "/opt/homebrew/share/android-commandlinetools";
  const buildToolsRoot = path.join(sdkRoot, "build-tools");
  if (!fs.existsSync(buildToolsRoot)) return null;
  const versions = fs
    .readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse();
  for (const version of versions) {
    const candidate = path.join(buildToolsRoot, version, toolName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readBridgeHealth() {
  const result = run(
    "curl",
    ["-sS", "--max-time", "5", "http://127.0.0.1:8795/doctor"],
    { allowFailure: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      ok: false,
      error: result.stderr || result.stdout || "bridge doctor request failed",
    };
  }
  try {
    return { ok: true, body: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function readGatewaySecret() {
  if (process.env.BLUEBUBBLES_GATEWAY_SECRET) {
    return process.env.BLUEBUBBLES_GATEWAY_SECRET;
  }
  const envFile = path.join(repoRoot, ".eliza-local", "bluebubbles-bridge.env");
  return parseDotenvFile(envFile).BLUEBUBBLES_GATEWAY_SECRET || "";
}

function runCloudWebhookSmoke() {
  const secret = readGatewaySecret();
  if (!secret) {
    return {
      ok: false,
      detail: "BLUEBUBBLES_GATEWAY_SECRET unavailable",
    };
  }

  const sender = `+1415555${Math.floor(Math.random() * 9000 + 1000)}`;
  const payload = {
    type: "new-message",
    data: {
      guid: `android-gateway-doctor-${Date.now()}`,
      text: "hello eliza from android gateway doctor",
      isFromMe: false,
      handle: {
        address: sender,
        service: "SMS",
      },
      chats: [
        {
          guid: `SMS;-;${sender}`,
          chatIdentifier: sender,
        },
      ],
      metadata: {
        localPhoneNumber: defaultGatewayPhoneNumber,
        phoneNumber: defaultGatewayPhoneNumber,
        phoneAccountId: defaultGatewayPhoneNumber,
        phoneAccountLabel: defaultGatewayPhoneLabel,
        androidSmsGateway: true,
      },
    },
  };
  const result = run(
    "curl",
    [
      "-sS",
      "--max-time",
      "15",
      "-X",
      "POST",
      defaultCloudWebhookUrl,
      "-H",
      "content-type: application/json",
      "-H",
      "x-eliza-bridge: android-sms",
      "-H",
      `x-eliza-gateway-secret: ${secret}`,
      "--data-binary",
      JSON.stringify(payload),
    ],
    { allowFailure: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      ok: false,
      detail: result.stderr || result.stdout || "cloud smoke request failed",
    };
  }

  try {
    const body = JSON.parse(result.stdout);
    return {
      ok:
        body.success === true &&
        body.handled === true &&
        body.gatewayDeviceRegistered === true &&
        typeof body.replyText === "string" &&
        body.replyText.length > 0,
      detail: `status=ok sender=${sender} reason=${body.reason ?? "unknown"} reply=${Boolean(body.replyText)}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectUsbDeviceNames(items, output = []) {
  if (!Array.isArray(items)) return output;
  for (const item of items) {
    if (item && typeof item === "object") {
      const name =
        item._name ||
        item["USB Product Name"] ||
        item["Product ID"] ||
        item["Vendor ID"];
      if (typeof name === "string" && name.trim()) output.push(name.trim());
      collectUsbDeviceNames(item._items, output);
    }
  }
  return output;
}

function summarizeUsbDevices(devices, emptyDetail) {
  const visible = devices
    .filter((name) => !/USB\s*(3\.|2\.|1\.|XHCI|Bus)/i.test(name))
    .slice(0, 10);
  if (visible.length === 0) {
    return { ok: false, detail: emptyDetail };
  }

  const phoneLike = visible.filter((name) =>
    /\b(Android|ADB|MTP|Pixel|Samsung|Galaxy|Motorola|Moto|OnePlus|Xiaomi|Redmi|OPPO|Vivo|Nothing|Nokia|Sony|LG|HTC|Huawei|iPhone)\b/i.test(
      name,
    ),
  );
  if (phoneLike.length > 0) {
    return { ok: true, detail: phoneLike.join(", ") };
  }

  return {
    ok: false,
    detail: `USB devices visible but none look like an Android phone: ${visible.join(", ")}`,
  };
}

function hostUsbInventoryFromSystemProfiler() {
  const result = run("system_profiler", ["SPUSBDataType", "-json"], {
    allowFailure: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      ok: false,
      detail: result.stderr || result.stdout || "system_profiler failed",
    };
  }
  try {
    const body = JSON.parse(result.stdout);
    return summarizeUsbDevices(
      collectUsbDeviceNames(body.SPUSBDataType),
      "no USB devices enumerated by macOS",
    );
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function hostUsbInventoryFromIoreg() {
  const result = run("ioreg", ["-p", "IOUSB", "-l", "-w", "0"], {
    allowFailure: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      ok: false,
      detail: result.stderr || result.stdout || "ioreg failed",
    };
  }
  const names = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const nameMatch = line.match(/"USB Product Name"\s*=\s*"([^"]+)"/);
    const registryMatch = line.match(/\+\-o\s+([^@<]+)@/);
    const name = nameMatch?.[1] ?? registryMatch?.[1];
    if (!name) continue;
    const trimmed = name.trim();
    if (!trimmed || /Root Hub|XHCI|\bUSB\s*(?:3\.|2\.|1\.|Bus)\b/i.test(trimmed)) continue;
    if (!names.includes(trimmed)) names.push(trimmed);
  }
  return summarizeUsbDevices(names, "no USB devices enumerated by ioreg");
}

function listHostUsbDevices() {
  if (process.platform !== "darwin") {
    return { ok: true, detail: "host USB inventory is only available on macOS" };
  }
  const profiler = hostUsbInventoryFromSystemProfiler();
  if (profiler.ok) return profiler;
  const ioreg = hostUsbInventoryFromIoreg();
  if (ioreg.ok) return ioreg;
  return {
    ok: false,
    detail: `${profiler.detail}; ${ioreg.detail}`,
  };
}

function apkManifestSummary(apk) {
  if (!fs.existsSync(apk)) {
    return {
      ok: false,
      details: [`APK missing: ${apk}`],
    };
  }

  const aapt = resolveAndroidBuildTool("aapt");
  if (!aapt) {
    return {
      ok: false,
      details: ["aapt not found under Android SDK build-tools"],
    };
  }

  const badging = run(aapt, ["dump", "badging", apk], { allowFailure: true });
  const manifest = run(aapt, ["dump", "xmltree", apk, "AndroidManifest.xml"], {
    allowFailure: true,
  });
  if (badging.status !== 0 || manifest.status !== 0) {
    return {
      ok: false,
      details: [
        badging.stderr || badging.stdout,
        manifest.stderr || manifest.stdout,
      ].filter(Boolean),
    };
  }

  const requiredPermissions = [
    "READ_SMS",
    "SEND_SMS",
    "RECEIVE_SMS",
    "RECEIVE_MMS",
    "RECEIVE_WAP_PUSH",
  ];
  const requiredManifestMarkers = [
    "app.eliza.ElizaSmsReceiver",
    "app.eliza.ElizaMmsReceiver",
    "app.eliza.ElizaSmsGatewayService",
    "app.eliza.ElizaRespondViaMessageService",
    "app.eliza.ElizaSmsComposeActivity",
    "android.provider.Telephony.SMS_DELIVER",
    "android.provider.Telephony.WAP_PUSH_DELIVER",
    "android.intent.action.RESPOND_VIA_MESSAGE",
    "android.intent.action.SENDTO",
  ];
  const missing = [
    ...requiredPermissions
      .filter((perm) => !badging.stdout.includes(`android.permission.${perm}`))
      .map((perm) => `permission:${perm}`),
    ...requiredManifestMarkers.filter((marker) => !manifest.stdout.includes(marker)),
  ];

  return {
    ok: missing.length === 0,
    details: missing.length > 0 ? missing : ["SMS gateway manifest surface is present"],
  };
}

function runDoctor({ apk, adbPath }) {
  const checks = [];
  checks.push({
    name: "apk",
    ok: fs.existsSync(apk),
    detail: apk,
  });
  const manifest = apkManifestSummary(apk);
  checks.push({
    name: "apk-manifest",
    ok: manifest.ok,
    detail: manifest.details.join("; "),
  });

  let devices = [];
  let adbDetail = adbPath;
  let wirelessAdb = { ok: false, services: [], detail: "not checked" };
  try {
    devices = listDevices(adbPath);
    wirelessAdb = listWirelessAdbServices(adbPath);
  } catch (error) {
    adbDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({
    name: "adb",
    ok: fs.existsSync(adbPath),
    detail: adbDetail,
  });
  checks.push({
    name: "adb-device",
    ok: devices.length > 0,
    detail: devices.length > 0 ? devices.join(", ") : "no connected adb devices",
  });
  checks.push({
    name: "adb-wireless",
    ok: wirelessAdb.ok,
    detail: wirelessAdb.detail,
  });
  const hostUsb = listHostUsbDevices();
  checks.push({
    name: "host-usb",
    ok: hostUsb.ok,
    detail: hostUsb.detail,
  });

  const bridge = readBridgeHealth();
  const bridgeBody = bridge.ok ? bridge.body : null;
  const bridgeChecks = Array.isArray(bridgeBody?.checks) ? bridgeBody.checks : [];
  const bridgeStatus = bridgeChecks.find((check) => check.name === "bridge");
  const bridgeOutbound = bridgeChecks.find((check) => check.name === "outbound");
  checks.push({
    name: "bridge",
    ok: bridge.ok && bridgeStatus?.status === "pass",
    detail: bridge.ok ? (bridgeStatus?.detail ?? `doctor status=${bridgeBody?.status ?? "unknown"}`) : bridge.error,
  });
  checks.push({
    name: "bridge-outbound",
    ok: bridgeOutbound?.status === "pass",
    detail: bridgeOutbound?.detail ?? "bridge doctor unavailable",
  });

  const cloudSmoke = runCloudWebhookSmoke();
  checks.push({
    name: "cloud-smoke",
    ok: cloudSmoke.ok,
    detail: cloudSmoke.detail,
  });

  for (const check of checks) {
    console.log(
      `[android-sms-gateway] ${check.ok ? "PASS" : "BLOCKED"} ${check.name}: ${check.detail}`,
    );
  }

  const deviceReady = checks.find((check) => check.name === "adb-device")?.ok;
  if (!deviceReady) {
    const pairing = wirelessAdb.services?.filter((service) =>
      service.type.includes("_adb-tls-pairing"),
    );
    const connect = wirelessAdb.services?.filter((service) =>
      service.type.includes("_adb-tls-connect"),
    );
    if (pairing?.length > 0) {
      console.log(
        `[android-sms-gateway] next: pair wireless debugging with: ADB_PAIR_CODE=<pairing-code> node packages/app-core/scripts/install-android-sms-gateway.mjs --pair ${pairing[0].endpoint} --connect auto --wait-device 60 --grant-role --clear-logcat --watch-logs 60`,
      );
    } else if (connect?.length > 0) {
      console.log(
        `[android-sms-gateway] next: wireless adb is advertising ${connect[0].endpoint}, but no device is connected. If connect fails, open Android Developer Options > Wireless debugging > Pair device with pairing code, then run ADB_PAIR_CODE=<pairing-code> bun run --cwd packages/app-core sms-gateway:pair.`,
      );
    }
    console.log(
      "[android-sms-gateway] next: connect an Android phone with USB debugging enabled, then run this script with --grant-role --clear-logcat --watch-logs 60.",
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertNonNegativeInteger(args.logcatLines, "--logcat-lines");
  assertNonNegativeInteger(args.watchLogsSeconds, "--watch-logs");
  assertNonNegativeInteger(args.waitDeviceSeconds, "--wait-device");
  const apk = resolveApk(args.apk);
  if (args.printApk) {
    console.log(apk);
    return;
  }
  const adbPath = resolveAdb(args.adb);
  if (args.doctor) {
    runDoctor({ apk, adbPath });
    return;
  }
  if (args.pairEndpoint) {
    pairWirelessAdb({
      adbPath,
      endpoint: args.pairEndpoint,
      code: args.pairCode,
    });
  }
  if (args.connectEndpoint || args.pairEndpoint) {
    connectWirelessAdb({
      adbPath,
      endpoint: args.connectEndpoint || "auto",
    });
  }
  const serial =
    args.waitDeviceSeconds > 0
      ? await waitForDevice(adbPath, args.serial, args.waitDeviceSeconds)
      : resolveSerial(adbPath, args.serial);
  if (args.clearLogcat) clearLogcat({ adbPath, serial });
  if (args.install) install({ adbPath, serial, apk });
  if (args.grantRole) grantSmsRole({ adbPath, serial });
  diagnose({ adbPath, serial });
  if (args.simulate) {
    simulateInboundSms({
      adbPath,
      serial,
      number: args.simulate,
      message: args.message,
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    diagnose({ adbPath, serial });
  }
  dumpGatewayLogs({ adbPath, serial, lines: args.logcatLines });
  watchGatewayLogs({ adbPath, serial, seconds: args.watchLogsSeconds });
  console.log(`\n[android-sms-gateway] Device checked: ${serial}`);
}

main().catch((error) => {
  console.error(`[android-sms-gateway] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
