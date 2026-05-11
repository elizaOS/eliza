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
 * The smoke creates a temporary SwiftPM XCTest package instead of editing the
 * checked-in Capacitor Xcode project. The package links the same
 * LlamaCpp.xcframework slot used by llama-cpp-capacitor, force-loads its
 * static archive, then runs these checks on the physical device:
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
  --keep-temp                 Keep the generated SwiftPM test package.
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

function runCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 120_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
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

function listPhysicalIosDevices() {
  const result = runCapture("xcrun", ["xctrace", "list", "devices"], {
    timeout: 90_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `[ios-smoke] xcrun xctrace list devices failed with ${result.status}\n${result.stderr}`,
    );
  }
  return { ...parseXctraceDevices(result.stdout), raw: result.stdout };
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
  if (existing) return existing;

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

function jsString(value) {
  return JSON.stringify(value);
}

function swiftArray(values) {
  return `[${values.map((value) => jsString(value)).join(", ")}]`;
}

function writeSmokePackage({
  tempDir,
  xcframework,
  frameworkBinary,
  skipVoiceAbi,
}) {
  const vendorDir = path.join(tempDir, "Vendor");
  const supportDir = path.join(
    tempDir,
    "Sources",
    "ElizaIosRuntimeSmokeSupport",
  );
  const testDir = path.join(tempDir, "Tests", "ElizaIosRuntimeSmokeTests");
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(supportDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });
  fs.symlinkSync(xcframework, path.join(vendorDir, "LlamaCpp.xcframework"), "dir");

  const forceLoadFlags = [
    "-Xlinker",
    "-force_load",
    "-Xlinker",
    frameworkBinary,
  ];
  fs.writeFileSync(
    path.join(tempDir, "Package.swift"),
    `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "ElizaIosRuntimeSmoke",
  platforms: [.iOS(.v14)],
  products: [
    .library(name: "ElizaIosRuntimeSmokeSupport", targets: ["ElizaIosRuntimeSmokeSupport"])
  ],
  targets: [
    .binaryTarget(name: "LlamaCpp", path: "Vendor/LlamaCpp.xcframework"),
    .target(
      name: "ElizaIosRuntimeSmokeSupport",
      dependencies: ["LlamaCpp"],
      linkerSettings: [
        .unsafeFlags(${swiftArray(forceLoadFlags)}, .when(platforms: [.iOS]))
      ]
    ),
    .testTarget(
      name: "ElizaIosRuntimeSmokeTests",
      dependencies: ["ElizaIosRuntimeSmokeSupport"]
    )
  ]
)
`,
  );

  fs.writeFileSync(
    path.join(supportDir, "SmokeSupport.swift"),
    `public enum ElizaIosRuntimeSmokeSupport {
  public static let linked = true
}
`,
  );

  const voiceSymbols = skipVoiceAbi ? [] : VOICE_ABI_SYMBOLS;
  fs.writeFileSync(
    path.join(testDir, "ElizaIosRuntimeSmokeTests.swift"),
    `import XCTest
import Metal
import Darwin
import ElizaIosRuntimeSmokeSupport

final class ElizaIosRuntimeSmokeTests: XCTestCase {
  private let llamaSymbols = ${swiftArray(LLAMA_SYMBOLS)}
  private let kernelSymbols = ${swiftArray(KERNEL_SYMBOLS)}
  private let voiceSymbols = ${swiftArray(voiceSymbols)}

  func testMetalDeviceIsAvailableOnPhysicalIos() throws {
    XCTAssertNil(ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"], "This smoke must run on physical iOS hardware, not a simulator.")
    let device = MTLCreateSystemDefaultDevice()
    XCTAssertNotNil(device, "MTLCreateSystemDefaultDevice returned nil; Metal is unavailable on this device/runtime.")
    XCTAssertFalse(device!.name.isEmpty, "Metal device name is empty.")
    XCTAssertTrue(ElizaIosRuntimeSmokeSupport.linked)
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
}
`,
  );
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
    "-packagePath",
    tempDir,
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

    const { device, devices } = resolveDevice(args.deviceId);
    const xcframework = path.resolve(ensureXcframework(args));
    const frameworkBinary = locateDeviceFrameworkBinary(xcframework);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-ios-smoke-"));
    const derivedDataPath =
      args.derivedDataPath ??
      path.join(tempDir, "DerivedData");
    const resultBundlePath =
      args.resultBundlePath ??
      path.join(tempDir, "ElizaIosRuntimeSmoke.xcresult");
    writeSmokePackage({
      tempDir,
      xcframework,
      frameworkBinary,
      skipVoiceAbi: args.skipVoiceAbi,
    });

    report = {
      ...report,
      status: "running",
      device,
      connectedPhysicalDeviceCount: devices.connected.length,
      offlinePhysicalDeviceCount: devices.offline.length,
      xcframework,
      frameworkBinary,
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
    runInherit("xcodebuild", xcodeArgs);

    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    writeReport(args.report, report);
    console.log("[ios-smoke] physical-device XCTest PASS");
  } catch (err) {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    report.error = err instanceof Error ? err.message : String(err);
    if (err?.devices) {
      report.connectedPhysicalDevices = err.devices.connected;
      report.offlinePhysicalDevices = err.devices.offline;
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
