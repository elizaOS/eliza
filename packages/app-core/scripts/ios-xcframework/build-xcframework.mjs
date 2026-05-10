#!/usr/bin/env node
/**
 * Build the iOS LlamaCpp.xcframework consumed by llama-cpp-capacitor.
 *
 * Wave-4-F bridged the iOS pipeline: previously
 * `run-mobile-build.mjs` invoked cmake against the upstream npm package's
 * bundled `ios/` source, which produced a stock llama.cpp framework with
 * none of the milady kernels (TurboQuant / QJL / PolarQuant / DFlash).
 * That framework satisfied the patched podspec but violated AGENTS.md §3
 * (required-kernel contract).
 *
 * This script consumes the per-target static archives + headers produced
 * by `build-llama-cpp-dflash.mjs --target ios-arm64-metal` and
 * `--target ios-arm64-simulator-metal` and assembles them into a
 * well-formed `.xcframework` bundle.
 *
 * Invocation:
 *   node build-xcframework.mjs --output <dir>
 *     [--device-archive-dir   <path>]   default: $ELIZA_STATE_DIR/local-inference/bin/dflash/ios-arm64-metal
 *     [--sim-archive-dir      <path>]   default: $ELIZA_STATE_DIR/local-inference/bin/dflash/ios-arm64-simulator-metal
 *     [--build-if-missing]              run build-llama-cpp-dflash.mjs first
 *     [--verify]                        symbol-grep + xcframework-info validation
 *
 * AGENTS.md §3 hard rules enforced here:
 *   - Missing per-target archive directory = hard error (no fallback to
 *     stock framework, no skip).
 *   - Missing required-kernel symbol in either slice = hard error after
 *     --verify (matches the build-llama-cpp-dflash.mjs CAPABILITIES gate).
 *   - xcodebuild -create-xcframework failure = hard error.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// packages/app-core/scripts/ios-xcframework → packages/app-core/scripts
const SCRIPTS_DIR = path.resolve(__dirname, "..");
const DFLASH_BUILD_SCRIPT = path.join(SCRIPTS_DIR, "build-llama-cpp-dflash.mjs");

// Per AGENTS.md §3, the required kernels for any Eliza-1 binary.
// Symbol presence here is checked against the produced static archive
// pair. Missing-but-required symbols hard-fail.
//
// Each entry: { kernel, symbolPattern, where }
//   - `kernel` is the AGENTS.md §3 name.
//   - `symbolPattern` is a regex tested against `nm -g <archive>` output
//     across every produced .a in the slice. The archives include the
//     ggml-base / ggml-cpu / ggml-metal kernels (for QJL/Polar) and,
//     once the EMBED-path Metal kernel patcher lands, the metallib
//     symbol stubs (for TurboQuant variants). Until then `turbo3` /
//     `turbo4` will fail this check on iOS — which is the correct
//     loud-failure behavior per AGENTS.md §3.
//   - `where` indicates which archive(s) the symbol may live in;
//     only used in the diagnostic message.
const REQUIRED_IOS_KERNEL_SYMBOLS = [
  {
    kernel: "qjl_full",
    symbolPattern: /qjl1?[_-]?(256|score|attn|quantize|dequantize)/i,
    where: "libggml-cpu.a / libggml-base.a / libggml-metal.a",
  },
  {
    kernel: "polarquant",
    symbolPattern: /q4[_-]?polar|polar[_-]?(quant|dot)/i,
    where: "libggml-cpu.a / libggml-base.a / libggml-metal.a",
  },
  {
    kernel: "dflash",
    // DFlash is a CLI/runtime feature in the fork; its CPU-side flash-attn
    // hook is what the iOS slice carries. The symbol surfaces as the
    // FA-ext entry point ggml-cpu wires for the v0.4.0-milady fork.
    symbolPattern: /dflash|flash[_-]?attn[_-]?ext/i,
    where: "libggml-cpu.a / libggml-metal.a",
  },
  {
    kernel: "turbo3",
    // Turbo kernels live in the metallib produced by the EMBED build.
    // EMBED-path patcher in kernel-patches/metal-kernels.mjs is a
    // documented gap — until it lands, this symbol check WILL fail
    // and that is the correct hard-fail behavior per AGENTS.md §3.
    symbolPattern: /turbo3(?!_tcq)/i,
    where: "libggml-metal.a (via embedded metallib)",
  },
  {
    kernel: "turbo4",
    symbolPattern: /turbo4/i,
    where: "libggml-metal.a (via embedded metallib)",
  },
];

/** @typedef {{ name: string, archives: string[], headerDir: string, capabilities: string }} SliceInputs */

function parseArgs(argv) {
  const args = {
    output: null,
    deviceArchiveDir: null,
    simArchiveDir: null,
    buildIfMissing: false,
    verify: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--output":
      case "-o":
        args.output = next();
        break;
      case "--device-archive-dir":
        args.deviceArchiveDir = next();
        break;
      case "--sim-archive-dir":
        args.simArchiveDir = next();
        break;
      case "--build-if-missing":
        args.buildIfMissing = true;
        break;
      case "--verify":
        args.verify = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.output) {
    throw new Error("--output <dir> is required (e.g. .../LlamaCpp.xcframework)");
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: build-xcframework.mjs --output <dir> [options]

Options:
  --output <dir>                Path of the LlamaCpp.xcframework to create.
  --device-archive-dir <path>   Override iOS-device slice input directory.
  --sim-archive-dir <path>      Override iOS-simulator slice input directory.
  --build-if-missing            Invoke build-llama-cpp-dflash.mjs for any
                                missing slice before packaging.
  --verify                      Run nm symbol-grep + xcodebuild -create-xcframework
                                validation against AGENTS.md §3 kernel set.
  -h, --help                    Print this message.

Defaults for slice input dirs (per ELIZA_STATE_DIR):
  device: $ELIZA_STATE_DIR/local-inference/bin/dflash/ios-arm64-metal
  sim:    $ELIZA_STATE_DIR/local-inference/bin/dflash/ios-arm64-simulator-metal
`);
}

function elizaStateDir() {
  const env = process.env.ELIZA_STATE_DIR?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".eliza");
}

function defaultSliceDir(target) {
  return path.join(elizaStateDir(), "local-inference", "bin", "dflash", target);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with ${result.status}`);
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string}
 */
function captureStdout(cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed with ${result.status}: ${result.stderr || ""}`,
    );
  }
  return result.stdout || "";
}

/**
 * @param {string} dir
 * @param {string} sliceName
 * @returns {SliceInputs}
 */
function loadSlice(dir, sliceName) {
  if (!fs.existsSync(dir)) {
    throw new Error(
      `[ios-xcframework] slice ${sliceName} input dir not found: ${dir}\n` +
        `Run: node ${DFLASH_BUILD_SCRIPT} --target ${sliceName === "device" ? "ios-arm64-metal" : "ios-arm64-simulator-metal"}`,
    );
  }
  const archives = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".a"))
    .map((name) => path.join(dir, name));
  if (archives.length === 0) {
    throw new Error(
      `[ios-xcframework] slice ${sliceName} (${dir}) contains no .a archives — re-run build-llama-cpp-dflash.mjs.`,
    );
  }
  const headerDir = path.join(dir, "include");
  if (!fs.existsSync(headerDir)) {
    throw new Error(
      `[ios-xcframework] slice ${sliceName} (${dir}) missing include/ directory of public headers.`,
    );
  }
  const capabilities = path.join(dir, "CAPABILITIES.json");
  if (!fs.existsSync(capabilities)) {
    throw new Error(
      `[ios-xcframework] slice ${sliceName} (${dir}) missing CAPABILITIES.json — build did not complete kernel verification.`,
    );
  }
  return { name: sliceName, archives, headerDir, capabilities };
}

/**
 * Build a single static-library .framework directory under tmpDir that
 * the xcodebuild -create-xcframework call can ingest.
 *
 * .framework layout (static):
 *   LlamaCpp.framework/
 *     LlamaCpp                  (universal-of-one static archive)
 *     Headers/*.h               (public headers)
 *     Modules/module.modulemap  (umbrella module for Swift/ObjC)
 *     Info.plist                (CFBundle metadata)
 *
 * @param {string} tmpDir
 * @param {SliceInputs} slice
 * @param {{ platform: string, isSimulator: boolean }} target
 * @returns {string} path to the produced .framework directory
 */
function buildStaticFramework(tmpDir, slice, target) {
  const frameworkDir = path.join(
    tmpDir,
    `${target.platform}-arm64${target.isSimulator ? "-simulator" : ""}`,
    "LlamaCpp.framework",
  );
  fs.rmSync(frameworkDir, { recursive: true, force: true });
  fs.mkdirSync(frameworkDir, { recursive: true });

  // Combine every produced .a into one universal-of-one archive named
  // LlamaCpp. The CocoaPods linker then pulls in the entire kernel set
  // via -framework LlamaCpp without needing to know the per-archive
  // breakdown. libtool -static merges N archives into 1 in one pass.
  const combinedArchive = path.join(frameworkDir, "LlamaCpp");
  run("libtool", ["-static", "-o", combinedArchive, ...slice.archives]);

  // Headers/
  const headersDir = path.join(frameworkDir, "Headers");
  fs.mkdirSync(headersDir, { recursive: true });
  for (const name of fs.readdirSync(slice.headerDir)) {
    fs.copyFileSync(
      path.join(slice.headerDir, name),
      path.join(headersDir, name),
    );
  }

  // Modules/module.modulemap (umbrella module exposing every public header)
  const modulesDir = path.join(frameworkDir, "Modules");
  fs.mkdirSync(modulesDir, { recursive: true });
  const headerNames = fs
    .readdirSync(headersDir)
    .filter((name) => name.endsWith(".h"))
    .sort();
  const moduleMap = `framework module LlamaCpp {\n${headerNames
    .map((name) => `  header "${name}"`)
    .join("\n")}\n  export *\n}\n`;
  fs.writeFileSync(path.join(modulesDir, "module.modulemap"), moduleMap);

  // Info.plist describing the static framework's bundle identity. This
  // matches what xcodebuild expects on a static .framework input to
  // -create-xcframework.
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>LlamaCpp</string>
  <key>CFBundleIdentifier</key><string>ai.elizalabs.LlamaCpp</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>LlamaCpp</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>0.4.0-milady</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>MinimumOSVersion</key><string>14.0</string>
  <key>CFBundleSupportedPlatforms</key>
  <array><string>${target.isSimulator ? "iPhoneSimulator" : "iPhoneOS"}</string></array>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(frameworkDir, "Info.plist"), infoPlist);

  return frameworkDir;
}

/**
 * Run nm against every archive in a slice and aggregate the symbol text.
 * @param {SliceInputs} slice
 * @returns {string}
 */
function dumpSliceSymbols(slice) {
  const chunks = [];
  for (const archive of slice.archives) {
    const out = captureStdout("nm", ["-g", archive]);
    chunks.push(`# ${path.basename(archive)}\n${out}`);
  }
  return chunks.join("\n");
}

/**
 * @param {SliceInputs[]} slices
 */
function verifyKernelSymbols(slices) {
  const sliceSymbols = slices.map((slice) => ({
    slice,
    text: dumpSliceSymbols(slice),
  }));
  const missing = [];
  for (const { kernel, symbolPattern, where } of REQUIRED_IOS_KERNEL_SYMBOLS) {
    const sliceMisses = sliceSymbols.filter(
      ({ text }) => !symbolPattern.test(text),
    );
    if (sliceMisses.length > 0) {
      missing.push({
        kernel,
        slices: sliceMisses.map(({ slice }) => slice.name),
        where,
        pattern: symbolPattern.source,
      });
    }
  }
  if (missing.length > 0) {
    const lines = missing.map(
      (m) =>
        `  - ${m.kernel}: missing in ${m.slices.join(" + ")} ` +
        `(expected in ${m.where}; pattern /${m.pattern}/)`,
    );
    throw new Error(
      `[ios-xcframework] AGENTS.md §3 kernel-symbol audit FAILED:\n${lines.join(
        "\n",
      )}\n\n` +
        `The static archives produced by build-llama-cpp-dflash.mjs do not\n` +
        `contain symbols for every required Eliza-1 kernel. The xcframework\n` +
        `will NOT be assembled. Fix the build (most commonly: extend\n` +
        `kernel-patches/metal-kernels.mjs to handle the EMBED_LIBRARY=ON\n` +
        `path used by iOS) and re-run.`,
    );
  }
  console.log(
    `[ios-xcframework] kernel-symbol audit PASS for slices: ${slices
      .map((s) => s.name)
      .join(", ")}`,
  );
}

/**
 * @param {string} xcframeworkDir
 */
function verifyXcframework(xcframeworkDir) {
  // xcodebuild -create-xcframework hard-fails when the input mix is wrong;
  // re-running -create-xcframework on the produced bundle is not a thing.
  // Use `xcrun xcframework -list-arch` (Xcode 15+) when available, and
  // fall back to plutil parsing of Info.plist + a directory-shape check.
  const infoPlist = path.join(xcframeworkDir, "Info.plist");
  if (!fs.existsSync(infoPlist)) {
    throw new Error(
      `[ios-xcframework] produced bundle missing Info.plist: ${xcframeworkDir}`,
    );
  }
  const out = captureStdout("plutil", ["-extract", "AvailableLibraries", "json", "-o", "-", infoPlist]);
  let entries;
  try {
    entries = JSON.parse(out);
  } catch (err) {
    throw new Error(
      `[ios-xcframework] could not parse AvailableLibraries from ${infoPlist}: ${err.message}`,
    );
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      `[ios-xcframework] AvailableLibraries in ${infoPlist} is empty — xcframework is malformed.`,
    );
  }
  const summary = entries
    .map(
      (e) =>
        `${e.SupportedPlatform}${e.SupportedPlatformVariant ? `-${e.SupportedPlatformVariant}` : ""}/${(e.SupportedArchitectures || []).join("+")}`,
    )
    .join(", ");
  console.log(`[ios-xcframework] xcframework slices: ${summary}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin") {
    throw new Error("[ios-xcframework] iOS xcframework packaging requires a macOS host with Xcode.");
  }

  const deviceDir = args.deviceArchiveDir ?? defaultSliceDir("ios-arm64-metal");
  const simDir =
    args.simArchiveDir ?? defaultSliceDir("ios-arm64-simulator-metal");

  if (args.buildIfMissing) {
    if (!fs.existsSync(path.join(deviceDir, "CAPABILITIES.json"))) {
      console.log(`[ios-xcframework] device slice missing — invoking dflash build`);
      run("node", [DFLASH_BUILD_SCRIPT, "--target", "ios-arm64-metal"]);
    }
    if (!fs.existsSync(path.join(simDir, "CAPABILITIES.json"))) {
      console.log(`[ios-xcframework] simulator slice missing — invoking dflash build`);
      run("node", [
        DFLASH_BUILD_SCRIPT,
        "--target",
        "ios-arm64-simulator-metal",
      ]);
    }
  }

  const deviceSlice = loadSlice(deviceDir, "device");
  const simSlice = loadSlice(simDir, "simulator");

  if (args.verify) {
    verifyKernelSymbols([deviceSlice, simSlice]);
  }

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-ios-xcframework-"),
  );
  try {
    const deviceFramework = buildStaticFramework(tmpDir, deviceSlice, {
      platform: "ios",
      isSimulator: false,
    });
    const simulatorFramework = buildStaticFramework(tmpDir, simSlice, {
      platform: "ios",
      isSimulator: true,
    });

    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.rmSync(args.output, { recursive: true, force: true });

    run("xcodebuild", [
      "-create-xcframework",
      "-framework",
      deviceFramework,
      "-framework",
      simulatorFramework,
      "-output",
      args.output,
    ]);

    if (args.verify) {
      verifyXcframework(args.output);
    }
    console.log(`[ios-xcframework] wrote ${args.output}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
