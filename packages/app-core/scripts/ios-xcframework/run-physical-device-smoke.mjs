#!/usr/bin/env node
/**
 * Physical iOS runtime smoke for the Eliza-1 local-inference xcframework.
 *
 * This is intentionally device-only. Simulator and macOS Metal runs prove
 * shader correctness, but they do not prove the Capacitor-consumed iOS
 * artifact can link, launch, and resolve the required runtime symbols on a
 * real iPhone/iPad. If no physical iOS device is attached, this script exits
 * non-zero with an explicit diagnostic.
 *
 * The smoke creates a temporary hosted iOS XCTest project instead of editing
 * the checked-in Capacitor Xcode project. Physical iOS devices cannot run
 * SwiftPM tool-hosted tests, so the generated project contains a tiny host app
 * plus a unit-test bundle. The host app links the same LlamaCpp.xcframework
 * slot used by llama-cpp-capacitor, force-loads its static archive, then runs
 * these checks on the physical device:
 *
 *   - Metal is available through MTLCreateSystemDefaultDevice().
 *   - LlamaCpp bridge symbols resolve.
 *   - QJL / Polar / DFlash runtime symbols resolve.
 *   - libelizainference voice ABI symbols resolve, unless explicitly disabled
 *     with --skip-voice-abi for diagnosis.
 *
 * No model weights are bundled here, so this does not claim text/voice
 * numerical generation. It is the device-runtime gate that must pass before a
 * real Eliza-1 bundle smoke can run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const APP_DIR = path.join(REPO_ROOT, "packages", "app");
const XCFRAMEWORK_BUILD_SCRIPT = path.join(__dirname, "build-xcframework.mjs");

const LLAMA_SYMBOLS = [
  "llama_init_context",
  "llama_release_context",
  "llama_completion",
  "llama_stop_completion",
  "llama_get_formatted_chat",
  "llama_toggle_native_log",
  "llama_embedding",
  "llama_embedding_register_context",
  "llama_embedding_unregister_context",
  "llama_get_model_info",
  "llama_get_context_ptr",
  "llama_get_last_error",
  "llama_free_string",
];

const KERNEL_SYMBOLS = [
  "ggml_attn_score_qjl",
  "ggml_compute_forward_attn_score_qjl",
  "dequantize_row_qjl1_256",
  "quantize_qjl1_256",
  "dequantize_row_q4_polar",
  "quantize_q4_polar",
  "llama_decode",
];

const VOICE_ABI_SYMBOLS = [
  "eliza_inference_abi_version",
  "eliza_inference_create",
  "eliza_inference_destroy",
  "eliza_inference_mmap_acquire",
  "eliza_inference_mmap_evict",
  "eliza_inference_tts_synthesize",
  "eliza_inference_asr_transcribe",
  "eliza_inference_free_string",
];

const EXIT = {
  noDevice: 20,
  missingXcframework: 21,
  localPreflight: 22,
  xcodebuildFailed: 23,
};

const XCODEBUILD_TIMEOUT_MS = 15 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    xcframework: null,
    deviceId: null,
    buildIfMissing: false,
    skipVoiceAbi: false,
    keepTemp: false,
    report: null,
    derivedDataPath: null,
    resultBundlePath: null,
    developmentTeam: process.env.ELIZA_IOS_DEVELOPMENT_TEAM ?? null,
    xcodebuildArgs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} requires a value`);
      return argv[i];
    };
    switch (a) {
      case "--xcframework":
        args.xcframework = next();
        break;
      case "--device-id":
        args.deviceId = next();
        break;
      case "--build-if-missing":
        args.buildIfMissing = true;
        break;
      case "--skip-voice-abi":
        args.skipVoiceAbi = true;
        break;
      case "--keep-temp":
        args.keepTemp = true;
        break;
      case "--report":
        args.report = next();
        break;
      case "--derived-data-path":
        args.derivedDataPath = next();
        break;
      case "--result-bundle-path":
        args.resultBundlePath = next();
        break;
      case "--development-team":
        args.developmentTeam = next();
        break;
      case "--xcodebuild-arg":
        args.xcodebuildArgs.push(next());
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs [options]

Runs a physical-device XCTest smoke against the Eliza-1 LlamaCpp.xcframework.
This command refuses to run against simulators.

Options:
  --xcframework <path>        LlamaCpp.xcframework to test. Defaults to the
                              llama-cpp-capacitor xcframework slot, then the
                              smoke output under $ELIZA_STATE_DIR.
  --device-id <udid>          Physical iPhone/iPad UDID. If omitted, the first
                              connected physical iOS device is used.
  --build-if-missing          Build/package the xcframework first if missing.
  --development-team <team>   Apple Developer Team ID for XCTest signing.
                              Defaults to ELIZA_IOS_DEVELOPMENT_TEAM.
  --skip-voice-abi            Diagnostic only: do not require libelizainference
                              voice ABI symbols. Default is to require them.
  --derived-data-path <path>  Override xcodebuild DerivedData path.
  --result-bundle-path <path> Override xcodebuild result bundle path.
  --xcodebuild-arg <arg>      Append one raw xcodebuild argument. Repeatable.
  --report <path>             Write a JSON report after success/failure.
  --keep-temp                 Keep the generated temporary XCTest project.
  -h, --help                  Print this message.

Typical device run:
  ELIZA_IOS_DEVELOPMENT_TEAM=ABCDE12345 \\
    node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \\
      --build-if-missing \\
      --report packages/inference/reports/porting/2026-05-11/ios_device_smoke.json
`);
}

function elizaStateDir() {
  const env = process.env.ELIZA_STATE_DIR?.trim();
  return env || path.join(os.homedir(), ".eliza");
}

function defaultSmokeXcframeworkPath() {
  return path.join(
    elizaStateDir(),
    "local-inference",
    "bin",
    "dflash",
    "ios-physical-smoke",
    "LlamaCpp.xcframework",
  );
}

function defaultXcframeworkCandidates() {
  return [
    path.join(
      APP_DIR,
      "node_modules",
      "llama-cpp-capacitor",
      "ios",
      "Frameworks-xcframework",
      "LlamaCpp.xcframework",
    ),
    path.join(
      REPO_ROOT,
      "node_modules",
      "llama-cpp-capacitor",
      "ios",
      "Frameworks-xcframework",
      "LlamaCpp.xcframework",
    ),
    defaultSmokeXcframeworkPath(),
  ];
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function detectDefaultDevelopmentTeam() {
  const candidates = [
    path.join(APP_DIR, "ios", "App", "App.xcodeproj", "project.pbxproj"),
    path.join(
      REPO_ROOT,
      "packages",
      "app-core",
      "platforms",
      "ios",
      "App",
      "App.xcodeproj",
      "project.pbxproj",
    ),
  ];
  for (const candidate of candidates) {
    try {
      const text = fs.readFileSync(candidate, "utf8");
      const match = text.match(/DEVELOPMENT_TEAM\s*=\s*([A-Z0-9]+);/);
      if (match?.[1]) return match[1];
    } catch {
      // Keep looking; a missing app checkout should not block smoke setup.
    }
  }
  return null;
}

function runCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 120_000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function summarizeText(text, maxChars = 16_000) {
  if (!text || text.length <= maxChars) return text ?? "";
  return text.slice(text.length - maxChars);
}

function commandMetadata(cmd, args, opts = {}) {
  const result = runCapture(cmd, args, opts);
  return {
    command: [cmd, ...args],
    status: result.status,
    signal: result.signal,
    stdout: summarizeText(result.stdout, 4_000),
    stderr: summarizeText(result.stderr, 4_000),
    error: result.error ? String(result.error) : null,
  };
}

function runInherit(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with ${result.status}`);
  }
}

function ensureTool(name) {
  const result = runCapture("xcrun", ["--find", name], { timeout: 30_000 });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`[ios-smoke] required Xcode tool not found via xcrun: ${name}`);
  }
}

function parsePlistJson(plistPath) {
  const result = runCapture("plutil", ["-convert", "json", "-o", "-", plistPath], {
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw Object.assign(
      new Error(
        `[ios-smoke] failed to parse ${plistPath} with plutil\n${result.stderr}`,
      ),
      { exitCode: EXIT.localPreflight },
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw Object.assign(
      new Error(`[ios-smoke] malformed JSON from plutil for ${plistPath}: ${err}`),
      { exitCode: EXIT.localPreflight },
    );
  }
}

function validateXcframeworkDeviceSlice(xcframework) {
  const infoPlist = path.join(xcframework, "Info.plist");
  if (!fs.existsSync(infoPlist)) {
    throw Object.assign(
      new Error(`[ios-smoke] xcframework is missing Info.plist: ${infoPlist}`),
      { exitCode: EXIT.localPreflight },
    );
  }
  const info = parsePlistJson(infoPlist);
  const libraries = Array.isArray(info.AvailableLibraries)
    ? info.AvailableLibraries
    : [];
  const deviceLibraries = libraries.filter((library) => {
    const platform = library.SupportedPlatform;
    const variant = library.SupportedPlatformVariant;
    const archs = Array.isArray(library.SupportedArchitectures)
      ? library.SupportedArchitectures
      : [];
    return platform === "ios" && !variant && archs.includes("arm64");
  });
  if (deviceLibraries.length !== 1) {
    throw Object.assign(
      new Error(
        `[ios-smoke] xcframework must contain exactly one ios arm64 physical-device slice; found ${deviceLibraries.length} in ${infoPlist}`,
      ),
      { exitCode: EXIT.localPreflight, xcframeworkInfo: info },
    );
  }
  const library = deviceLibraries[0];
  const libraryPath = path.join(xcframework, library.LibraryIdentifier);
  if (!fs.existsSync(libraryPath)) {
    throw Object.assign(
      new Error(`[ios-smoke] xcframework device slice path is missing: ${libraryPath}`),
      { exitCode: EXIT.localPreflight, xcframeworkInfo: info },
    );
  }
  return { infoPlist, library };
}

function parseXctraceDevices(text) {
  /** @type {{ section: string, name: string, version: string | null, id: string }[]} */
  const connected = [];
  /** @type {{ section: string, name: string, version: string | null, id: string }[]} */
  const offline = [];
  let section = "";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sectionMatch = line.match(/^==\s*(.+?)\s*==$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const m = line.match(/^(.+?)\s+\(([^()]*)\)\s+\(([0-9A-Fa-f-]{8,})\)$/);
    if (!m) continue;
    const [, name, version, id] = m;
    const isIosPhysicalName = /\b(iPhone|iPad|iPod)\b/i.test(name);
    if (!isIosPhysicalName) continue;
    const record = { section, name, version, id };
    if (section === "Devices") connected.push(record);
    if (section === "Devices Offline") offline.push(record);
  }
  return { connected, offline };
}

function parseDevicectlDevices(text) {
  /** @type {{ section: string, name: string, version: string | null, id: string, hostname?: string, state?: string, model?: string, idSource?: string }[]} */
  const connected = [];
  /** @type {{ section: string, name: string, version: string | null, id: string, hostname?: string, state?: string, model?: string, idSource?: string }[]} */
  const offline = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^-+$/.test(line) || /^Name\s+Hostname\s+Identifier\s+State\s+Model/i.test(line)) {
      continue;
    }
    const cols = line.split(/\s{2,}/).map((part) => part.trim());
    if (cols.length < 5) continue;
    const [name, hostname, id, state, model] = cols;
    const isIosPhysical =
      /\b(iPhone|iPad|iPod)\b/i.test(name) || /\b(iPhone|iPad|iPod)\b/i.test(model);
    if (!isIosPhysical) continue;
    const record = {
      section: "CoreDevice",
      name,
      version: null,
      id,
      hostname,
      state,
      model,
      idSource: "devicectl",
    };
    if (/(available|connected)/i.test(state) && !/unavailable|offline|disconnected/i.test(state)) {
      connected.push(record);
    } else {
      offline.push(record);
    }
  }
  return { connected, offline };
}

function mergeDeviceLists(primary, secondary) {
  const byId = new Map();
  for (const record of [...primary, ...secondary]) {
    if (!byId.has(record.id)) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}

function listPhysicalIosDevices() {
  const xctrace = runCapture("xcrun", ["xctrace", "list", "devices"], {
    timeout: 90_000,
  });
  if (xctrace.status !== 0) {
    throw new Error(
      `[ios-smoke] xcrun xctrace list devices failed with ${xctrace.status}\n${xctrace.stderr}`,
    );
  }
  const xctraceDevices = parseXctraceDevices(xctrace.stdout);
  const devicectl = runCapture("xcrun", ["devicectl", "list", "devices"], {
    timeout: 90_000,
  });
  const coreDevices =
    devicectl.status === 0 ? parseDevicectlDevices(devicectl.stdout) : { connected: [], offline: [] };
  return {
    connected: mergeDeviceLists(xctraceDevices.connected, coreDevices.connected),
    offline: mergeDeviceLists(xctraceDevices.offline, coreDevices.offline),
    raw: xctrace.stdout,
    xctraceRaw: xctrace.stdout,
    devicectlRaw: devicectl.stdout,
    devicectlError:
      devicectl.status === 0
        ? null
        : devicectl.error
          ? String(devicectl.error)
          : devicectl.stderr,
  };
}

function resolveDevice(deviceId) {
  const devices = listPhysicalIosDevices();
  if (deviceId) {
    const exact = devices.connected.find((d) => d.id === deviceId);
    if (exact) return { device: exact, devices };
    const offline = devices.offline.find((d) => d.id === deviceId);
    const suffix = offline
      ? `\nRequested device is present but offline: ${offline.name} (${offline.version}) ${offline.id}`
      : "";
    throw Object.assign(
      new Error(
        `[ios-smoke] requested physical iOS device is not connected: ${deviceId}${suffix}`,
      ),
      { exitCode: EXIT.noDevice, devices },
    );
  }
  if (devices.connected.length > 0) {
    return { device: devices.connected[0], devices };
  }
  const offlineLines = devices.offline.length
    ? `\nOffline physical iOS devices seen:\n${devices.offline
        .map((d) => `  - ${d.name} (${d.version ?? "unknown"}) ${d.id}`)
        .join("\n")}`
    : "";
  throw Object.assign(
    new Error(
      `[ios-smoke] no connected physical iOS device found. Connect, unlock, trust the iPhone/iPad, enable Developer Mode, then rerun.${offlineLines}`,
    ),
    { exitCode: EXIT.noDevice, devices },
  );
}

function ensureXcframework(args) {
  if (args.xcframework) {
    const resolved = path.resolve(args.xcframework);
    if (!fs.existsSync(resolved)) {
      throw Object.assign(
        new Error(`[ios-smoke] --xcframework path does not exist: ${resolved}`),
        { exitCode: EXIT.missingXcframework },
      );
    }
    return resolved;
  }

  const existing = firstExisting(defaultXcframeworkCandidates());
  if (existing) {
    try {
      locateDeviceFrameworkBinary(existing);
      return existing;
    } catch (err) {
      if (!args.buildIfMissing) throw err;
      console.warn(
        `[ios-smoke] existing LlamaCpp.xcframework is not device-smokeable; rebuilding into smoke output: ${err.message}`,
      );
    }
  }

  if (!args.buildIfMissing) {
    throw Object.assign(
      new Error(
        `[ios-smoke] LlamaCpp.xcframework not found in default locations:\n` +
          defaultXcframeworkCandidates().map((p) => `  - ${p}`).join("\n") +
          `\nRun with --build-if-missing, or pass --xcframework <path>.`,
      ),
      { exitCode: EXIT.missingXcframework },
    );
  }

  const output = defaultSmokeXcframeworkPath();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  runInherit("node", [
    XCFRAMEWORK_BUILD_SCRIPT,
    "--output",
    output,
    "--build-if-missing",
    "--verify",
  ]);
  return output;
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

function locateDeviceFrameworkBinary(xcframework) {
  const binaries = walkFiles(xcframework).filter(
    (file) =>
      path.basename(file) === "LlamaCpp" &&
      /LlamaCpp\.framework[/\\]LlamaCpp$/.test(file),
  );
  const exact = binaries.find((file) =>
    file.split(path.sep).includes("ios-arm64"),
  );
  if (exact) return exact;
  const nonsim = binaries.find((file) => !/simulator/i.test(file));
  if (nonsim) return nonsim;
  throw Object.assign(
    new Error(
      `[ios-smoke] could not locate an iOS-device LlamaCpp.framework/LlamaCpp binary under ${xcframework}`,
    ),
    { exitCode: EXIT.localPreflight },
  );
}

function classifyXcodebuildFailure(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/invalid option|Usage: xcodebuild/i.test(text)) return "xcodebuild-invocation";
  if (/Developer Mode/i.test(text)) return "developer-mode-disabled";
  if (/device .*not trusted|not trusted by this computer|trust this computer/i.test(text)) {
    return "device-not-trusted";
  }
  if (/Tool-hosted testing is unavailable on device destinations|Select a host application for the test target/i.test(text)) {
    return "requires-host-app-test-target";
  }
  if (/not paired|pair/i.test(text)) return "device-not-paired";
  if (/locked/i.test(text)) return "device-locked";
  if (/No profiles for|requires a provisioning profile|Signing for .* requires a development team|Code signing/i.test(text)) {
    return "code-signing";
  }
  if (/The device .* is not available|Unable to find a destination|Ineligible destinations/i.test(text)) {
    return "device-destination-unavailable";
  }
  if (/duplicate symbol|duplicate symbols/i.test(text)) {
    return "duplicate-static-linkage";
  }
  if (/framework 'Accelerate' not found|Undefined symbol: _(?:cblas_|vDSP_)/i.test(text)) {
    return "missing-system-framework-linkage";
  }
  if (/Crash:\s+ElizaIosRuntimeSmokeHost\s+at\s+eliza_ios_ffi_abi_smoke_run|testLibElizaInferenceAbiV1CallsMatchHeader.*Failed|unexpected exit, crash, or test timeout/i.test(text)) {
    return "voice-abi-runtime-crash";
  }
  const undefinedSymbolFailure = /Undefined symbols|symbol\(s\) not found|ld: symbol/i.test(text);
  const missingVoiceAbi =
    undefinedSymbolFailure &&
    /_eliza_inference_(?:abi_version|create|destroy|mmap_acquire|mmap_evict|tts_synthesize|asr_transcribe|free_string)\b/i.test(text);
  const missingCapacitorBridge =
    undefinedSymbolFailure &&
    /_llama_(?:init_context|release_context|completion|stop_completion|get_formatted_chat|toggle_native_log|embedding|embedding_register_context|embedding_unregister_context|get_model_info|get_context_ptr|get_last_error|free_string)\b/i.test(text);
  if (missingVoiceAbi && missingCapacitorBridge) {
    return "missing-capacitor-bridge-and-voice-abi-symbols";
  }
  if (missingVoiceAbi) return "missing-voice-abi-symbols";
  if (missingCapacitorBridge) return "missing-capacitor-bridge-symbols";
  if (/symbol\(s\) not found|Undefined symbols|Missing required Eliza-1 iOS runtime symbols/i.test(text)) {
    return "runtime-symbol-resolution";
  }
  return "xcodebuild-failed";
}

function runXcodebuildForReport(xcodeArgs, { cwd }) {
  const result = runCapture("xcodebuild", xcodeArgs, {
    cwd,
    timeout: XCODEBUILD_TIMEOUT_MS,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return {
    command: ["xcodebuild", ...xcodeArgs],
    cwd,
    status: result.status,
    signal: result.signal,
    stdoutTail: summarizeText(result.stdout),
    stderrTail: summarizeText(result.stderr),
    error: result.error ? String(result.error) : null,
    failureCategory:
      result.status === 0 && !result.signal && !result.error
        ? null
        : classifyXcodebuildFailure(result),
  };
}

function jsString(value) {
  return JSON.stringify(value);
}

function swiftArray(values) {
  return `[${values.map((value) => jsString(value)).join(", ")}]`;
}

function yamlList(values, indent = 10) {
  const pad = " ".repeat(indent);
  return values.map((value) => `${pad}- ${jsString(value)}`).join("\n");
}

function hostRuntimeLinkerFlags({ frameworkBinary, symbols }) {
  const flags = [
    "$(inherited)",
    "-framework",
    "Accelerate",
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
    "-framework",
    "MetalKit",
  ];
  for (const symbol of symbols) {
    flags.push("-u", `_${symbol}`);
  }
  flags.push(frameworkBinary);
  return flags;
}

function writeSmokeProject({
  tempDir,
  xcframework,
  frameworkBinary,
  skipVoiceAbi,
  developmentTeam,
}) {
  const vendorDir = path.join(tempDir, "Vendor");
  const hostDir = path.join(tempDir, "Sources", "HostApp");
  const testDir = path.join(tempDir, "Tests", "ElizaIosRuntimeSmokeTests");
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(hostDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });
  fs.symlinkSync(xcframework, path.join(vendorDir, "LlamaCpp.xcframework"), "dir");
  fs.copyFileSync(
    path.join(__dirname, "..", "omnivoice-fuse", "ffi.h"),
    path.join(testDir, "ffi.h"),
  );

  fs.writeFileSync(
    path.join(hostDir, "AppDelegate.swift"),
    `import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    true
  }
}
`,
  );

  fs.writeFileSync(
    path.join(hostDir, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleName</key><string>ElizaIosRuntimeSmokeHost</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>UIApplicationSceneManifest</key>
  <dict>
    <key>UIApplicationSupportsMultipleScenes</key><false/>
  </dict>
</dict>
</plist>
`,
  );

  const voiceSymbols = skipVoiceAbi ? [] : VOICE_ABI_SYMBOLS;
  const requiredRuntimeSymbols = [...LLAMA_SYMBOLS, ...KERNEL_SYMBOLS, ...voiceSymbols];
  const hostOtherLdFlags = hostRuntimeLinkerFlags({
    frameworkBinary,
    symbols: requiredRuntimeSymbols,
  });
  const testOtherLdFlags = [
    "$(inherited)",
    "-framework",
    "Foundation",
    "-framework",
    "Metal",
  ];
  fs.writeFileSync(
    path.join(testDir, "ElizaFfiAbiSmoke.h"),
    `#pragma once

#ifdef __cplusplus
extern "C" {
#endif

char * eliza_ios_ffi_abi_smoke_run(const char * bundle_dir);
void eliza_ios_ffi_abi_smoke_free(char * message);

#ifdef __cplusplus
}
#endif
`,
  );
  fs.writeFileSync(
    path.join(testDir, "ElizaFfiAbiSmoke.c"),
    `#include "ElizaFfiAbiSmoke.h"
#include "ffi.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char * smoke_strdup(const char * s) {
    const char * value = s ? s : "";
    const size_t len = strlen(value);
    char * out = (char *) malloc(len + 1);
    if (!out) return NULL;
    memcpy(out, value, len + 1);
    return out;
}

static char * smoke_message(const char * prefix, const char * detail) {
    const char * p = prefix ? prefix : "failure";
    const char * d = detail ? detail : "";
    const size_t len = strlen(p) + strlen(d) + 3;
    char * out = (char *) malloc(len);
    if (!out) return NULL;
    snprintf(out, len, "%s: %s", p, d);
    return out;
}

static void clear_error(char ** err) {
    if (err && *err) {
        eliza_inference_free_string(*err);
        *err = NULL;
    }
}

char * eliza_ios_ffi_abi_smoke_run(const char * bundle_dir) {
    const char * version = eliza_inference_abi_version();
    if (!version || strcmp(version, "1") != 0) {
        return smoke_message("bad ABI version", version ? version : "(null)");
    }

    char * err = NULL;
    EliInferenceContext * ctx = eliza_inference_create(bundle_dir, &err);
    if (!ctx) {
        char * out = smoke_message("create failed", err);
        clear_error(&err);
        return out;
    }

    int rc = eliza_inference_mmap_acquire(ctx, "text", &err);
    if (rc != ELIZA_OK) {
        char * out = smoke_message("mmap_acquire(text) failed", err);
        clear_error(&err);
        eliza_inference_destroy(ctx);
        return out;
    }
    clear_error(&err);

    rc = eliza_inference_mmap_acquire(ctx, "tts", &err);
    if (rc >= 0) {
        clear_error(&err);
        eliza_inference_destroy(ctx);
        return smoke_strdup("mmap_acquire(tts) unexpectedly succeeded for an empty test bundle");
    }
    if (!err || err[0] == '\\0') {
        clear_error(&err);
        eliza_inference_destroy(ctx);
        return smoke_strdup("mmap_acquire(tts) failed without an out_error diagnostic");
    }
    clear_error(&err);

    float pcm_out[64] = {0};
    const char * text = "hello";
    rc = eliza_inference_tts_synthesize(
        ctx,
        text,
        strlen(text),
        NULL,
        pcm_out,
        sizeof(pcm_out) / sizeof(pcm_out[0]),
        &err);
    if (rc >= 0) {
        clear_error(&err);
        eliza_inference_destroy(ctx);
        return smoke_strdup("tts_synthesize unexpectedly succeeded for an empty test bundle");
    }
    if (!err || err[0] == '\\0') {
        clear_error(&err);
        eliza_inference_destroy(ctx);
        return smoke_strdup("tts_synthesize failed without an out_error diagnostic");
    }
    clear_error(&err);

    float pcm_in[8] = {0};
    char transcript[64] = {0};
    rc = eliza_inference_asr_transcribe(
        ctx,
        pcm_in,
        sizeof(pcm_in) / sizeof(pcm_in[0]),
        16000,
        transcript,
        sizeof(transcript),
        &err);
    if (rc >= 0) {
        clear_error(&err);
        eliza_inference_destroy(ctx);
        return smoke_strdup("asr_transcribe unexpectedly succeeded for an empty test bundle");
    }
    if (!err || err[0] == '\\0') {
        clear_error(&err);
        eliza_inference_destroy(ctx);
        return smoke_strdup("asr_transcribe failed without an out_error diagnostic");
    }
    clear_error(&err);

    rc = eliza_inference_mmap_evict(ctx, "text", &err);
    if (rc != ELIZA_OK) {
        char * out = smoke_message("mmap_evict(text) failed", err);
        clear_error(&err);
        eliza_inference_destroy(ctx);
        return out;
    }
    clear_error(&err);

    eliza_inference_destroy(ctx);
    return NULL;
}

void eliza_ios_ffi_abi_smoke_free(char * message) {
    free(message);
}
`,
  );
  fs.writeFileSync(
    path.join(testDir, "ElizaIosRuntimeSmokeTests.swift"),
`import XCTest
import Metal
import Darwin

final class ElizaIosRuntimeSmokeTests: XCTestCase {
  private let llamaSymbols: [String] = ${swiftArray(LLAMA_SYMBOLS)}
  private let kernelSymbols: [String] = ${swiftArray(KERNEL_SYMBOLS)}
  private let voiceSymbols: [String] = ${swiftArray(voiceSymbols)}

  func testMetalDeviceIsAvailableOnPhysicalIos() throws {
    XCTAssertNil(ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"], "This smoke must run on physical iOS hardware, not a simulator.")
    let device = MTLCreateSystemDefaultDevice()
    XCTAssertNotNil(device, "MTLCreateSystemDefaultDevice returned nil; Metal is unavailable on this device/runtime.")
    XCTAssertFalse(device!.name.isEmpty, "Metal device name is empty.")
  }

  func testLlamaKernelAndVoiceSymbolsResolve() throws {
    var missing: [String] = []
    for symbol in llamaSymbols + kernelSymbols + voiceSymbols {
      if dlsym(UnsafeMutableRawPointer(bitPattern: -2), symbol) == nil {
        missing.append(symbol)
      }
    }
    XCTAssertTrue(
      missing.isEmpty,
      "Missing required Eliza-1 iOS runtime symbols: \\(missing.joined(separator: \", \")). This is a runtime failure, not a shader-fixture failure."
    )
  }

  func testLibElizaInferenceAbiV1CallsMatchHeader() throws {
    let bundleDir = NSTemporaryDirectory().appending("/eliza-ios-ffi-empty-bundle-\\(UUID().uuidString)")
    try FileManager.default.createDirectory(atPath: bundleDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: bundleDir) }

    let failure = bundleDir.withCString { cBundleDir in
      eliza_ios_ffi_abi_smoke_run(cBundleDir)
    }
    if let failure {
      let message = String(cString: failure)
      eliza_ios_ffi_abi_smoke_free(failure)
      XCTFail(message)
    }
  }
}
`,
  );

  fs.writeFileSync(
    path.join(tempDir, "project.yml"),
    `name: ElizaIosRuntimeSmoke
options:
  bundleIdPrefix: ai.elizalabs
settings:
  base:
    CODE_SIGN_STYLE: Automatic
    IPHONEOS_DEPLOYMENT_TARGET: "14.0"
    ${developmentTeam ? `DEVELOPMENT_TEAM: ${developmentTeam}` : ""}
targets:
  ElizaIosRuntimeSmokeHost:
    type: application
    platform: iOS
    deploymentTarget: "14.0"
    sources:
      - Sources/HostApp
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ai.elizalabs.ElizaIosRuntimeSmokeHost
        INFOPLIST_FILE: Sources/HostApp/Info.plist
        OTHER_LDFLAGS:
${yamlList(hostOtherLdFlags)}
  ElizaIosRuntimeSmokeTests:
    type: bundle.unit-test
    platform: iOS
    deploymentTarget: "14.0"
    sources:
      - Tests/ElizaIosRuntimeSmokeTests
    dependencies:
      - target: ElizaIosRuntimeSmokeHost
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: ai.elizalabs.ElizaIosRuntimeSmokeTests
        GENERATE_INFOPLIST_FILE: YES
        TEST_HOST: "$(BUILT_PRODUCTS_DIR)/ElizaIosRuntimeSmokeHost.app/ElizaIosRuntimeSmokeHost"
        BUNDLE_LOADER: "$(TEST_HOST)"
        SWIFT_OBJC_BRIDGING_HEADER: Tests/ElizaIosRuntimeSmokeTests/ElizaFfiAbiSmoke.h
        HEADER_SEARCH_PATHS:
          - "$(SRCROOT)/Tests/ElizaIosRuntimeSmokeTests"
        OTHER_LDFLAGS:
${yamlList(testOtherLdFlags)}
schemes:
  ElizaIosRuntimeSmoke:
    build:
      targets:
        ElizaIosRuntimeSmokeHost: all
        ElizaIosRuntimeSmokeTests: [test]
    test:
      targets:
        - ElizaIosRuntimeSmokeTests
`,
  );

  runInherit("xcrun", ["xcodegen", "generate"], { cwd: tempDir });
}

function writeReport(reportPath, report) {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
}

function buildXcodeArgs({
  tempDir,
  device,
  args,
  derivedDataPath,
  resultBundlePath,
}) {
  const xcodeArgs = [
    "test",
    "-project",
    path.join(tempDir, "ElizaIosRuntimeSmoke.xcodeproj"),
    "-scheme",
    "ElizaIosRuntimeSmoke",
    "-destination",
    `platform=iOS,id=${device.id}`,
    "-derivedDataPath",
    derivedDataPath,
    "-resultBundlePath",
    resultBundlePath,
    "CODE_SIGNING_ALLOWED=YES",
  ];
  if (args.developmentTeam) {
    xcodeArgs.push(`DEVELOPMENT_TEAM=${args.developmentTeam}`);
  }
  xcodeArgs.push(...args.xcodebuildArgs);
  return xcodeArgs;
}

async function main() {
  const startedAt = new Date().toISOString();
  const args = parseArgs(process.argv.slice(2));
  let tempDir = null;
  let report = {
    status: "not-started",
    startedAt,
    finishedAt: null,
    device: null,
    xcframework: null,
    skippedVoiceAbi: args.skipVoiceAbi,
    failClosed: {
      physicalDeviceOnly: true,
      requiresIosArm64XcframeworkSlice: true,
      requiresRuntimeSymbols: true,
      requiresVoiceAbi: !args.skipVoiceAbi,
      capturesXcodebuildOutput: true,
    },
    toolchain: null,
    xcodebuild: null,
    blocker: null,
    resultBundlePath: null,
    derivedDataPath: null,
  };

  try {
    if (process.platform !== "darwin") {
      throw Object.assign(
        new Error("[ios-smoke] physical iOS smoke requires macOS with Xcode."),
        { exitCode: EXIT.localPreflight },
      );
    }
    ensureTool("xcodebuild");
    ensureTool("xctrace");
    ensureTool("plutil");
    ensureTool("xcodegen");
    if (!args.developmentTeam) {
      args.developmentTeam = detectDefaultDevelopmentTeam();
    }

    const toolchain = {
      xcodebuild: commandMetadata("xcodebuild", ["-version"], { timeout: 30_000 }),
      xctrace: commandMetadata("xcrun", ["xctrace", "version"], {
        timeout: 30_000,
      }),
    };

    const { device, devices } = resolveDevice(args.deviceId);
    const xcframework = path.resolve(ensureXcframework(args));
    const xcframeworkDeviceSlice = validateXcframeworkDeviceSlice(xcframework);
    const frameworkBinary = locateDeviceFrameworkBinary(xcframework);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-ios-smoke-"));
    const derivedDataPath =
      args.derivedDataPath ??
      path.join(tempDir, "DerivedData");
    const resultBundlePath =
      args.resultBundlePath ??
      path.join(tempDir, "ElizaIosRuntimeSmoke.xcresult");
    writeSmokeProject({
      tempDir,
      xcframework,
      frameworkBinary,
      skipVoiceAbi: args.skipVoiceAbi,
      developmentTeam: args.developmentTeam,
    });

    report = {
      ...report,
      status: "running",
      toolchain,
      device,
      connectedPhysicalDeviceCount: devices.connected.length,
      offlinePhysicalDeviceCount: devices.offline.length,
      xcframework,
      xcframeworkDeviceSlice,
      frameworkBinary,
      developmentTeam: args.developmentTeam,
      tempPackage: tempDir,
      derivedDataPath,
      resultBundlePath,
      requiredSymbols: {
        llama: LLAMA_SYMBOLS,
        kernels: KERNEL_SYMBOLS,
        voiceAbi: args.skipVoiceAbi ? [] : VOICE_ABI_SYMBOLS,
      },
    };

    const xcodeArgs = buildXcodeArgs({
      tempDir,
      device,
      args,
      derivedDataPath,
      resultBundlePath,
    });
    console.log(
      `[ios-smoke] running physical-device XCTest on ${device.name} (${device.version ?? "unknown"}) ${device.id}`,
    );
    console.log(`[ios-smoke] xcframework: ${xcframework}`);
    report.xcodebuild = runXcodebuildForReport(xcodeArgs, { cwd: tempDir });
    if (report.xcodebuild.status !== 0 || report.xcodebuild.signal || report.xcodebuild.error) {
      report.blocker = {
        category: report.xcodebuild.failureCategory,
        detail: "xcodebuild test did not complete successfully; see xcodebuild stdoutTail/stderrTail in this report.",
      };
      throw Object.assign(
        new Error(
          `[ios-smoke] xcodebuild failed: ${report.xcodebuild.failureCategory}`,
        ),
        { exitCode: EXIT.xcodebuildFailed },
      );
    }

    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    writeReport(args.report, report);
    console.log("[ios-smoke] physical-device XCTest PASS");
  } catch (err) {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    report.error = err instanceof Error ? err.message : String(err);
    if (!report.blocker) {
      report.blocker = {
        category:
          err?.exitCode === EXIT.noDevice
            ? "no-connected-physical-device"
            : err?.exitCode === EXIT.missingXcframework
              ? "missing-xcframework"
              : err?.exitCode === EXIT.localPreflight
                ? "local-preflight"
                : "unknown",
        detail: report.error,
      };
    }
    if (err?.devices) {
      report.connectedPhysicalDevices = err.devices.connected;
      report.offlinePhysicalDevices = err.devices.offline;
    }
    if (err?.xcframeworkInfo) {
      report.xcframeworkInfo = err.xcframeworkInfo;
    }
    writeReport(args.report, report);
    process.stderr.write(`${report.error}\n`);
    process.exit(err?.exitCode ?? EXIT.xcodebuildFailed);
  } finally {
    if (tempDir && !args.keepTemp) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else if (tempDir) {
      console.log(`[ios-smoke] kept temp package at ${tempDir}`);
    }
  }
}

main();
