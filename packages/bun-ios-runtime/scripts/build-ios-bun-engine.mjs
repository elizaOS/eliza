#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const defaultSourceDir = path.join(packageRoot, "vendor", "bun");
const defaultArtifact = path.join(
  packageRoot,
  "artifacts",
  "ElizaBunEngine.xcframework",
);
const shimSource = path.join(
  packageRoot,
  "Sources",
  "ElizaBunEngineShim",
  "eliza_bun_engine_shim.c",
);
const patchesDir = path.join(packageRoot, "patches");
const bunIosPatch = path.join(patchesDir, "dannote-bun-ios-nojit.patch");
const webKitIosPatch = path.join(
  patchesDir,
  "webkit-ios-simulator-nojit.patch",
);
const frameworkName = "ElizaBunEngine";
const requiredSymbols = [
  "_eliza_bun_engine_abi_version",
  "_eliza_bun_engine_last_error",
  "_eliza_bun_engine_start",
  "_eliza_bun_engine_stop",
  "_eliza_bun_engine_call",
  "_eliza_bun_engine_free",
];
const allowedExportedSymbols = new Set(requiredSymbols);

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg === name) return "1";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding,
    maxBuffer: options.maxBuffer,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}`,
    );
  }
  return result;
}

function runCapture(command, args, options = {}) {
  return run(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
  });
}

function targetInfo(raw) {
  const target = raw === "device" ? "device" : "simulator";
  return target === "device"
    ? {
        target,
        zigTarget: "aarch64-ios",
        sdk: "iphoneos",
        platform: "iOS",
        cmakeBuildDirName: "ios-device",
        webkitStageName: "ios-webkit-device",
        clangTarget: "arm64-apple-ios16.0",
        rustTarget: "aarch64-apple-ios",
        minVersionFlag: "-miphoneos-version-min=16.0",
        xcframeworkLibraryIdentifier: "ios-arm64",
        sourceToolchainName: "ios-device.cmake",
      }
    : {
        target,
        zigTarget: "aarch64-ios-simulator",
        sdk: "iphonesimulator",
        platform: "iOS Simulator",
        cmakeBuildDirName: "ios-simulator",
        webkitStageName: "ios-webkit-simulator",
        clangTarget: "arm64-apple-ios16.0-simulator",
        rustTarget: "aarch64-apple-ios-sim",
        minVersionFlag: "-mios-simulator-version-min=16.0",
        xcframeworkLibraryIdentifier: "ios-arm64-simulator",
        sourceToolchainName: "ios-simulator.cmake",
      };
}

function fail(message) {
  console.error(`[bun-ios-runtime] ${message}`);
  process.exit(1);
}

const info = targetInfo(argValue("--target", "simulator"));
const verifyOnly = process.argv.includes("--verify-only");
const packageOnly = process.argv.includes("--package-only");
const rebuild = process.argv.includes("--rebuild");
const backend = (
  argValue("--backend", process.env.ELIZA_BUN_IOS_BUILD_BACKEND || "auto") ||
  "auto"
).toLowerCase();
const sourceDir = path.resolve(
  process.env.ELIZA_BUN_IOS_SOURCE_DIR || defaultSourceDir,
);
const artifact = path.resolve(
  process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK || defaultArtifact,
);

function firstExisting(paths) {
  return (
    paths.find((candidate) => candidate && fs.existsSync(candidate)) ?? null
  );
}

function generatedToolchainPath(info) {
  return path.join(
    packageRoot,
    "build",
    "toolchains",
    `${info.cmakeBuildDirName}.cmake`,
  );
}

function ensureGeneratedToolchain(info) {
  const out = generatedToolchainPath(info);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const cmakeIosSdkPathVariable = `\${IOS_SDK_PATH}`;
  const contents = [
    "set(CMAKE_SYSTEM_NAME iOS)",
    "set(CMAKE_SYSTEM_PROCESSOR arm64)",
    `set(CMAKE_OSX_SYSROOT ${info.sdk})`,
    "set(CMAKE_OSX_ARCHITECTURES arm64)",
    "set(CMAKE_OSX_DEPLOYMENT_TARGET 16.0)",
    `set(CMAKE_C_COMPILER_TARGET ${info.clangTarget})`,
    `set(CMAKE_CXX_COMPILER_TARGET ${info.clangTarget})`,
    "",
    "execute_process(",
    `  COMMAND xcrun --sdk ${info.sdk} --show-sdk-path`,
    "  OUTPUT_VARIABLE IOS_SDK_PATH",
    "  OUTPUT_STRIP_TRAILING_WHITESPACE",
    ")",
    `set(ENV{IOS_SYSROOT} "${cmakeIosSdkPathVariable}")`,
    "",
  ].join("\n");
  fs.writeFileSync(out, contents);
  return out;
}

function resolveCmakeToolchain(info) {
  return path.resolve(
    process.env.ELIZA_BUN_IOS_CMAKE_TOOLCHAIN_FILE ||
      firstExisting([
        path.join(sourceDir, "cmake", "toolchains", info.sourceToolchainName),
        path.join(sourceDir, "cmake", "toolchains", "ios.cmake"),
      ]) ||
      ensureGeneratedToolchain(info),
  );
}

function validateEngineBinary(binary) {
  const nm = runCapture("nm", ["-gU", binary]);
  const output = `${nm.stdout}\n${nm.stderr}`;
  const missing = requiredSymbols.filter((symbol) => !output.includes(symbol));
  if (missing.length > 0) {
    fail(`${binary} is missing required ABI symbols: ${missing.join(", ")}`);
  }
  const exportedSymbols = output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).at(-1))
    .filter((symbol) => symbol?.startsWith("_"));
  const unexpected = exportedSymbols.filter(
    (symbol) => !allowedExportedSymbols.has(symbol),
  );
  if (unexpected.length > 0) {
    fail(
      `${binary} exports non-ABI symbols: ${unexpected
        .slice(0, 24)
        .join(", ")}${unexpected.length > 24 ? ", ..." : ""}`,
    );
  }
}

function parsePlistJson(plistPath) {
  const result = runCapture("plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    plistPath,
  ]);
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    fail(
      `failed to parse ${plistPath} as JSON plist: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function resolveXcframeworkBinary(root, targetInfo = info) {
  const infoPlist = path.join(root, "Info.plist");
  if (!fs.existsSync(infoPlist)) {
    fail(`${root} is missing Info.plist`);
  }
  const plist = parsePlistJson(infoPlist);
  const libraries = Array.isArray(plist.AvailableLibraries)
    ? plist.AvailableLibraries
    : [];
  const wantSimulator = targetInfo.sdk === "iphonesimulator";
  const library = libraries.find((entry) => {
    if (!entry || entry.SupportedPlatform !== "ios") return false;
    return wantSimulator
      ? entry.SupportedPlatformVariant === "simulator"
      : !entry.SupportedPlatformVariant;
  });
  if (!library?.LibraryIdentifier) {
    const requested = wantSimulator ? "iOS Simulator" : "iOS device";
    const available = libraries
      .map((entry) =>
        `${entry?.SupportedPlatform ?? "unknown"}${
          entry?.SupportedPlatformVariant
            ? `-${entry.SupportedPlatformVariant}`
            : ""
        }/${entry?.LibraryIdentifier ?? "missing-id"}`,
      )
      .join(", ");
    fail(
      `${root} does not contain the requested ${requested} ${frameworkName} library. Available: ${available || "none"}`,
    );
  }
  const libraryPath =
    typeof library.LibraryPath === "string"
      ? library.LibraryPath
      : `${frameworkName}.framework`;
  const binary = path.join(
    root,
    library.LibraryIdentifier,
    libraryPath,
    frameworkName,
  );
  if (!fs.existsSync(binary)) {
    fail(
      `${root} selected ${library.LibraryIdentifier}, but ${binary} does not exist`,
    );
  }
  return { binary, libraryIdentifier: library.LibraryIdentifier };
}

function findFrameworkBinaries(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === `${frameworkName}.framework`) {
          const binary = path.join(p, frameworkName);
          if (fs.existsSync(binary)) found.push(binary);
        }
        stack.push(p);
      }
    }
  }
  return found;
}

function validateXcframework(root) {
  const selected = resolveXcframeworkBinary(root, info);
  validateEngineBinary(selected.binary);
  const binaries = findFrameworkBinaries(root);
  if (binaries.length === 0) {
    fail(
      `${root} does not contain ${frameworkName}.framework/${frameworkName}`,
    );
  }
  for (const binary of binaries) validateEngineBinary(binary);
  console.log(
    `[bun-ios-runtime] Validated ${selected.libraryIdentifier} ABI symbols`,
  );
}

if (fs.existsSync(artifact) && !rebuild) {
  validateXcframework(artifact);
  console.log(`[bun-ios-runtime] Found ${artifact}`);
  process.exit(0);
}

if (verifyOnly) {
  fail(
    `missing ${artifact}; build the Bun fork first or set ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK`,
  );
}

if (!fs.existsSync(sourceDir)) {
  fail(
    [
      `Bun source checkout not found at ${sourceDir}.`,
      "Set ELIZA_BUN_IOS_SOURCE_DIR to an elizaos/bun checkout, or clone the fork there.",
      "The public https://github.com/elizaos/bun repository is not currently available,",
      "and upstream oven-sh/bun does not ship an iOS target.",
    ].join(" "),
  );
}

if (
  !fs.existsSync(path.join(sourceDir, "build.zig")) &&
  !fs.existsSync(path.join(sourceDir, "CMakeLists.txt"))
) {
  fail(
    `${sourceDir} does not look like a Bun source checkout (missing build.zig and CMakeLists.txt)`,
  );
}

function patchCheck(root, patchFile, reverse = false) {
  const args = reverse
    ? ["apply", "--reverse", "--check", patchFile]
    : ["apply", "--check", patchFile];
  return spawnSync("git", args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function applyPatchIfNeeded(root, patchFile, label) {
  if (process.env.ELIZA_BUN_IOS_SKIP_SOURCE_PATCHES === "1") return;
  if (!fs.existsSync(patchFile)) return;
  if (!fs.existsSync(path.join(root, ".git"))) {
    console.warn(
      `[bun-ios-runtime] Skipping ${label} source patch; ${root} is not a git checkout`,
    );
    return;
  }

  const forward = patchCheck(root, patchFile);
  if (forward.status === 0) {
    console.log(`[bun-ios-runtime] Applying ${label} source patch`);
    run("git", ["apply", patchFile], { cwd: root });
    return;
  }

  const reverse = patchCheck(root, patchFile, true);
  if (reverse.status === 0) {
    console.log(`[bun-ios-runtime] ${label} source patch already applied`);
    return;
  }

  fail(
    [
      `Cannot apply ${label} source patch ${patchFile}.`,
      forward.stderr?.trim() || forward.stdout?.trim() || "git apply --check failed",
    ].join("\n"),
  );
}

function applyBundledSourcePatches() {
  applyPatchIfNeeded(sourceDir, bunIosPatch, "Bun iOS/no-JIT");
  const webKitSourceDir =
    process.env.ELIZA_BUN_IOS_WEBKIT_SOURCE_DIR ||
    process.env.ELIZA_WEBKIT_SOURCE_DIR;
  if (webKitSourceDir) {
    applyPatchIfNeeded(
      path.resolve(webKitSourceDir),
      webKitIosPatch,
      "WebKit iOS Simulator/no-JIT",
    );
  }
}

applyBundledSourcePatches();

const explicitCommand = process.env.ELIZA_BUN_IOS_BUILD_COMMAND;
const env = {
  ...process.env,
  ELIZA_BUN_IOS_TARGET: info.target,
  ELIZA_BUN_IOS_ZIG_TARGET: info.zigTarget,
  ELIZA_BUN_IOS_SDK: info.sdk,
  ELIZA_BUN_IOS_PLATFORM: info.platform,
  ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK: artifact,
};

function selectBackend() {
  if (explicitCommand) return "custom";
  if (backend === "cmake" || backend === "zig") return backend;
  if (backend !== "auto") {
    fail(`unknown --backend=${backend}; expected auto, cmake, or zig`);
  }
  if (fs.existsSync(path.join(sourceDir, "CMakeLists.txt"))) return "cmake";
  return "zig";
}

function parseExtraArgs(value) {
  if (!value) return [];
  return (
    value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
      if (
        (part.startsWith('"') && part.endsWith('"')) ||
        (part.startsWith("'") && part.endsWith("'"))
      ) {
        return part.slice(1, -1);
      }
      return part;
    }) ?? []
  );
}

function stageWebKitIfRequested(info) {
  const webkitBuildDir = process.env.ELIZA_BUN_IOS_WEBKIT_BUILD_DIR;
  const webkitPath = process.env.ELIZA_BUN_IOS_WEBKIT_PATH;
  if (webkitPath) {
    const resolved = path.resolve(webkitPath);
    validateStagedWebKit(resolved);
    return resolved;
  }

  const staged = path.join(sourceDir, "build", info.webkitStageName);
  if (!webkitBuildDir) {
    if (fs.existsSync(path.join(staged, "lib", "libJavaScriptCore.a"))) {
      validateStagedWebKit(staged);
      writeWebKitPackageMarker(staged);
      return staged;
    }
    fail(
      [
        "CMake iOS Bun builds require a static iOS JavaScriptCore/WebKit build.",
        `Expected ${path.join(staged, "lib", "libJavaScriptCore.a")}, or set:`,
        "  ELIZA_BUN_IOS_WEBKIT_BUILD_DIR=/path/to/WebKit/build-ios-{device,simulator}",
        "  ELIZA_BUN_IOS_WEBKIT_PATH=/path/with/include-and-lib",
        "Build WebKit/JSC with ENABLE_JIT=OFF, ENABLE_WEBASSEMBLY=ON, and ENABLE_C_LOOP=OFF first.",
      ].join("\n"),
    );
  }

  const src = path.resolve(webkitBuildDir);
  const srcLib = path.join(src, "lib");
  const headerRoots = [
    path.join(src, "JavaScriptCore", "Headers"),
    path.join(src, "JavaScriptCore", "PrivateHeaders"),
    path.join(src, "WTF", "Headers"),
    path.join(src, "bmalloc", "Headers"),
    path.join(src, "ICU", "Headers"),
  ];
  if (!fs.existsSync(srcLib) || !fs.existsSync(headerRoots[0])) {
    fail(
      `ELIZA_BUN_IOS_WEBKIT_BUILD_DIR must contain lib/ and JavaScriptCore/Headers/ (${src})`,
    );
  }

  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(path.join(staged, "lib"), { recursive: true });
  fs.mkdirSync(path.join(staged, "include"), { recursive: true });
  for (const entry of fs.readdirSync(srcLib)) {
    if (entry.endsWith(".a")) {
      fs.copyFileSync(
        path.join(srcLib, entry),
        path.join(staged, "lib", entry),
      );
    }
  }
  for (const headerRoot of headerRoots) {
    if (fs.existsSync(headerRoot)) {
      fs.cpSync(headerRoot, path.join(staged, "include"), { recursive: true });
    }
  }
  const cmakeConfig = path.join(src, "cmakeconfig.h");
  if (fs.existsSync(cmakeConfig)) {
    fs.copyFileSync(cmakeConfig, path.join(staged, "include", "cmakeconfig.h"));
  }
  validateStagedWebKit(staged);
  writeWebKitPackageMarker(staged);
  return staged;
}

function validateStagedWebKit(webkitPath) {
  const candidates = [
    path.join(webkitPath, "include", "cmakeconfig.h"),
    path.join(webkitPath, "cmakeconfig.h"),
    path.join(webkitPath, "CMakeCache.txt"),
  ].filter((file) => fs.existsSync(file));
  for (const file of candidates) {
    const contents = fs.readFileSync(file, "utf8");
    if (
      /#\s*define\s+ENABLE_WEBASSEMBLY\s+0\b/.test(contents) ||
      /^ENABLE_WEBASSEMBLY(?::BOOL)?=(?:0|OFF|FALSE)$/im.test(contents)
    ) {
      fail(
        `${file} has ENABLE_WEBASSEMBLY=0/OFF; iOS Bun JSC must be staged with WebAssembly enabled`,
      );
    }
    if (
      /#\s*define\s+ENABLE_C_LOOP\s+1\b/.test(contents) ||
      /^ENABLE_C_LOOP(?::BOOL)?=(?:1|ON|TRUE)$/im.test(contents)
    ) {
      fail(
        `${file} has ENABLE_C_LOOP=1/ON; iOS Bun JSC must be staged with ENABLE_C_LOOP=OFF`,
      );
    }
  }
}

function webKitVersion() {
  const setupWebKit = path.join(sourceDir, "cmake", "tools", "SetupWebKit.cmake");
  if (!fs.existsSync(setupWebKit)) return "local-ios-jsc";
  const contents = fs.readFileSync(setupWebKit, "utf8");
  const match = contents.match(/set\(WEBKIT_VERSION\s+([^)]+)\)/);
  return match?.[1]?.trim() || "local-ios-jsc";
}

function writeWebKitPackageMarker(webkitPath) {
  const marker = path.join(webkitPath, "package.json");
  const version = process.env.ELIZA_BUN_IOS_WEBKIT_VERSION || webKitVersion();
  fs.writeFileSync(
    marker,
    `${JSON.stringify({ name: "bun-webkit-ios-local", version }, null, 2)}\n`,
  );
}

function collectStaticInputs(buildDir, webkitPath) {
  const inputs = [];
  const objectDir = path.join(buildDir, "CMakeFiles", "bun-profile.dir");
  const bunZigObject = path.join(buildDir, "bun-zig.o");
  const bundledArchive = path.join(buildDir, "libeliza-bun-profile.a");
  const cmakeArchive = path.join(buildDir, "libbun-profile.a");

  if (fs.existsSync(cmakeArchive)) {
    inputs.push({ kind: "force", path: cmakeArchive });
  } else if (fs.existsSync(objectDir) && fs.existsSync(bunZigObject)) {
    const objects = runCapture("find", [
      objectDir,
      "-name",
      "*.o",
      "-type",
      "f",
    ]);
    const objectPaths = objects.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    if (objectPaths.length === 0) {
      fail(`no Bun object files found under ${objectDir}`);
    }
    run("ar", ["rcs", bundledArchive, ...objectPaths, bunZigObject]);
    inputs.push({ kind: "force", path: bundledArchive });
  } else {
    fail(
      `CMake build did not produce ${cmakeArchive} or ${objectDir} + bun-zig.o`,
    );
  }

  const optionalInputs = [
    path.join(
      buildDir,
      "mimalloc",
      "CMakeFiles",
      "mimalloc-obj.dir",
      "src",
      "static.c.o",
    ),
    path.join(buildDir, "boringssl", "libcrypto.a"),
    path.join(buildDir, "boringssl", "libssl.a"),
    path.join(buildDir, "boringssl", "libdecrepit.a"),
    path.join(buildDir, "brotli", "libbrotlicommon.a"),
    path.join(buildDir, "brotli", "libbrotlidec.a"),
    path.join(buildDir, "brotli", "libbrotlienc.a"),
    path.join(buildDir, "cares", "lib", "libcares.a"),
    path.join(buildDir, "highway", "libhwy.a"),
    path.join(buildDir, "libdeflate", "libdeflate.a"),
    path.join(buildDir, "lshpack", "libls-hpack.a"),
    path.join(buildDir, "zlib", "libz.a"),
    path.join(buildDir, "libarchive", "libarchive", "libarchive.a"),
    path.join(buildDir, "hdrhistogram", "src", "libhdr_histogram_static.a"),
    path.join(buildDir, "zstd", "lib", "libzstd.a"),
    path.join(
      buildDir,
      "lolhtml",
      "aarch64-apple-ios",
      "release",
      "liblolhtml.a",
    ),
    path.join(
      buildDir,
      "lolhtml",
      "aarch64-apple-ios-sim",
      "release",
      "liblolhtml.a",
    ),
    path.join(webkitPath, "lib", "libJavaScriptCore.a"),
    path.join(webkitPath, "lib", "libWTF.a"),
    path.join(webkitPath, "lib", "libbmalloc.a"),
  ];
  for (const input of optionalInputs) {
    if (fs.existsSync(input)) inputs.push({ kind: "normal", path: input });
  }
  return inputs;
}

function writeFrameworkMetadata(frameworkDir) {
  fs.mkdirSync(path.join(frameworkDir, "Headers"), { recursive: true });
  fs.mkdirSync(path.join(frameworkDir, "Modules"), { recursive: true });
  fs.copyFileSync(
    path.join(
      packageRoot,
      "Sources",
      "ElizaBunEngineShim",
      "eliza_bun_engine.h",
    ),
    path.join(frameworkDir, "Headers", "ElizaBunEngine.h"),
  );
  fs.writeFileSync(
    path.join(frameworkDir, "Modules", "module.modulemap"),
    [
      `framework module ${frameworkName} {`,
      '  umbrella header "ElizaBunEngine.h"',
      "  export *",
      "  module * { export * }",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(frameworkDir, "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>CFBundleDevelopmentRegion</key><string>en</string>",
      "  <key>CFBundleExecutable</key><string>ElizaBunEngine</string>",
      "  <key>CFBundleIdentifier</key><string>ai.eliza.ElizaBunEngine</string>",
      "  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>",
      "  <key>CFBundleName</key><string>ElizaBunEngine</string>",
      "  <key>CFBundlePackageType</key><string>FMWK</string>",
      "  <key>CFBundleShortVersionString</key><string>0.0.0</string>",
      "  <key>CFBundleVersion</key><string>0</string>",
      "  <key>MinimumOSVersion</key><string>16.0</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
}

function linkFramework({ buildDir, webkitPath, info }) {
  if (!fs.existsSync(shimSource)) {
    fail(`missing Eliza Bun engine shim source at ${shimSource}`);
  }
  const stageRoot = path.join(
    packageRoot,
    "build",
    info.cmakeBuildDirName,
    "framework",
  );
  const frameworkDir = path.join(stageRoot, `${frameworkName}.framework`);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(frameworkDir, { recursive: true });
  writeFrameworkMetadata(frameworkDir);
  const exportedSymbolsList = path.join(stageRoot, "exported-symbols.txt");
  fs.writeFileSync(exportedSymbolsList, `${requiredSymbols.join("\n")}\n`);

  const sdkPath = runCapture("xcrun", [
    "--sdk",
    info.sdk,
    "--show-sdk-path",
  ]).stdout.trim();
  const binary = path.join(frameworkDir, frameworkName);
  const staticInputs = collectStaticInputs(buildDir, webkitPath);
  const linkArgs = [
    "-dynamiclib",
    "-target",
    info.clangTarget,
    "-isysroot",
    sdkPath,
    info.minVersionFlag,
    "-fapplication-extension",
    "-fvisibility=hidden",
    "-I",
    path.join(sourceDir, "src", "ios"),
    "-I",
    path.join(webkitPath, "include"),
    "-install_name",
    `@rpath/${frameworkName}.framework/${frameworkName}`,
    `-Wl,-exported_symbols_list,${exportedSymbolsList}`,
    "-o",
    binary,
    shimSource,
  ];
  for (const input of staticInputs) {
    if (input.kind === "force" && input.path.endsWith(".a")) {
      linkArgs.push("-Wl,-force_load", input.path);
    } else {
      linkArgs.push(input.path);
    }
  }
  linkArgs.push(
    "-lc++",
    "-lobjc",
    "-licucore",
    "-lresolv",
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    "-framework",
    "SystemConfiguration",
  );
  run("xcrun", ["--sdk", info.sdk, "clang", ...linkArgs]);
  validateEngineBinary(binary);
  return frameworkDir;
}

function createXcframework(frameworkDir) {
  fs.rmSync(artifact, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  run("xcodebuild", [
    "-create-xcframework",
    "-framework",
    frameworkDir,
    "-output",
    artifact,
  ]);
  validateXcframework(artifact);
}

function buildWithCmake() {
  if (!fs.existsSync(path.join(sourceDir, "CMakeLists.txt"))) {
    fail(`${sourceDir} does not support the CMake iOS build backend`);
  }
  const webkitPath = stageWebKitIfRequested(info);
  const toolchain = resolveCmakeToolchain(info);
  const buildDir = path.resolve(
    process.env.ELIZA_BUN_IOS_BUILD_DIR ||
      path.join(packageRoot, "build", info.cmakeBuildDirName, "bun"),
  );
  if (packageOnly) {
    console.log(
      `[bun-ios-runtime] Packaging existing Bun CMake output from ${buildDir}`,
    );
    const frameworkDir = linkFramework({ buildDir, webkitPath, info });
    createXcframework(frameworkDir);
    return;
  }
  if (rebuild) fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  prepareBunSourceForCmake();
  patchBunSetupZigForWrapper();
  const zigWrapper = ensureZigBuildWrapper(buildDir);
  const buildEnv = {
    ...env,
    ELIZA_BUN_IOS_ZIG_EXECUTABLE: zigWrapper,
  };

  console.log(
    `[bun-ios-runtime] Configuring Bun CMake backend for ${info.platform}`,
  );
  run(
    "cmake",
    [
      "-S",
      sourceDir,
      "-B",
      buildDir,
      "-G",
      process.env.ELIZA_BUN_IOS_CMAKE_GENERATOR || "Ninja",
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
      "-DCMAKE_SYSTEM_NAME=iOS",
      "-DCMAKE_SYSTEM_PROCESSOR=arm64",
      `-DCMAKE_OSX_SYSROOT=${info.sdk}`,
      "-DCMAKE_OSX_ARCHITECTURES=arm64",
      "-DCMAKE_OSX_DEPLOYMENT_TARGET=16.0",
      `-DCMAKE_C_COMPILER_TARGET=${info.clangTarget}`,
      `-DCMAKE_CXX_COMPILER_TARGET=${info.clangTarget}`,
      "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY",
      "-DENABLE_LLVM=OFF",
      `-DWEBKIT_PATH=${webkitPath}`,
      ...parseExtraArgs(process.env.ELIZA_BUN_IOS_CMAKE_ARGS),
    ],
    { cwd: sourceDir, env: buildEnv },
  );

  console.log(`[bun-ios-runtime] Building Bun CMake target in ${buildDir}`);
  run("cmake", ["--build", buildDir, "--config", "Release"], {
    cwd: sourceDir,
    env: buildEnv,
  });

  if (fs.existsSync(artifact)) {
    validateXcframework(artifact);
    return;
  }
  const frameworkDir = linkFramework({ buildDir, webkitPath, info });
  createXcframework(frameworkDir);
}

function patchBunSetupZigForWrapper() {
  const setupZig = path.join(sourceDir, "cmake", "tools", "SetupZig.cmake");
  if (!fs.existsSync(setupZig)) return;
  const marker = "ELIZA_BUN_IOS_ZIG_EXECUTABLE";
  let contents = fs.readFileSync(setupZig, "utf8");
  if (contents.includes(marker)) return;
  const original = [
    "setx(ZIG_PATH ${VENDOR_PATH}/zig)",
    "",
    "if(WIN32)",
    "  setx(ZIG_EXECUTABLE ${ZIG_PATH}/zig.exe)",
    "else()",
    "  setx(ZIG_EXECUTABLE ${ZIG_PATH}/zig)",
    "endif()",
  ].join("\n");
  const replacement = [
    "setx(ZIG_PATH ${VENDOR_PATH}/zig)",
    "",
    "if(DEFINED ENV{ELIZA_BUN_IOS_ZIG_EXECUTABLE})",
    "  setx(ZIG_EXECUTABLE $ENV{ELIZA_BUN_IOS_ZIG_EXECUTABLE})",
    "elseif(WIN32)",
    "  setx(ZIG_EXECUTABLE ${ZIG_PATH}/zig.exe)",
    "else()",
    "  setx(ZIG_EXECUTABLE ${ZIG_PATH}/zig)",
    "endif()",
  ].join("\n");
  if (!contents.includes(original)) {
    fail(`cannot patch ${setupZig}; expected ZIG_EXECUTABLE block was not found`);
  }
  contents = contents.replace(original, replacement);
  fs.writeFileSync(setupZig, contents);
}

function ensureZigBuildWrapper(buildDir) {
  const wrapper = path.join(buildDir, "eliza-zig-wrapper.mjs");
  const hostTarget =
    process.env.ELIZA_BUN_IOS_ZIG_BUILD_RUNNER_TARGET ||
    (os.arch() === "arm64" ? "aarch64-macos.15.0" : "x86_64-macos.13.0");
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    cwd: options.cwd || process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function consumeValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value) {
    console.error(\`missing value after \${name}\`);
    process.exit(1);
  }
  return value;
}

if (args[0] !== "build") {
  const realZig = process.env.ELIZA_BUN_IOS_REAL_ZIG || "zig";
  run(realZig, args);
  process.exit(0);
}

let cacheDir = null;
let globalCacheDir = null;
let zigLibDir = null;
const forwarded = [];
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--cache-dir") {
    cacheDir = consumeValue(args, i, arg);
    i++;
    continue;
  }
  if (arg === "--global-cache-dir") {
    globalCacheDir = consumeValue(args, i, arg);
    i++;
    continue;
  }
  if (arg === "--zig-lib-dir") {
    zigLibDir = consumeValue(args, i, arg);
    i++;
    continue;
  }
  forwarded.push(arg);
}

if (!zigLibDir) {
  console.error("missing --zig-lib-dir for Eliza iOS Zig build wrapper");
  process.exit(1);
}
cacheDir ||= path.join(process.cwd(), ".zig-cache");
globalCacheDir ||= cacheDir;

const realZig = process.env.ELIZA_BUN_IOS_REAL_ZIG || path.join(path.dirname(zigLibDir), "zig");
const buildRoot = process.cwd();
const runnerSource = path.join(zigLibDir, "compiler", "build_runner.zig");
const buildFile = path.join(buildRoot, "build.zig");
const runnerDir = path.join(cacheDir, "eliza-build-runner");
const depsFile = path.join(runnerDir, "dependencies.zig");
const runner = path.join(runnerDir, "build-runner");

fs.mkdirSync(runnerDir, { recursive: true });
fs.writeFileSync(depsFile, "pub const packages = struct {};\\npub const root_deps: []const struct { []const u8, []const u8 } = &.{};\\n");

const runnerMissing = !fs.existsSync(runner);
const runnerMtime = runnerMissing ? 0 : fs.statSync(runner).mtimeMs;
const sourceMtime = Math.max(fs.statSync(runnerSource).mtimeMs, fs.statSync(buildFile).mtimeMs);
if (runnerMissing || runnerMtime < sourceMtime) {
  run(realZig, [
    "build-exe",
    "-target",
    ${JSON.stringify(hostTarget)},
    "-lc",
    "--cache-dir",
    path.join(runnerDir, "cache"),
    "--global-cache-dir",
    globalCacheDir,
    "--zig-lib-dir",
    zigLibDir,
    "--dep",
    "@build",
    "--dep",
    "@dependencies",
    \`-Mroot=\${runnerSource}\`,
    \`-M@build=\${buildFile}\`,
    \`-M@dependencies=\${depsFile}\`,
    \`-femit-bin=\${runner}\`,
  ]);
}

run(runner, [realZig, zigLibDir, buildRoot, cacheDir, globalCacheDir, ...forwarded], {
  cwd: buildRoot,
});
`,
  );
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function prepareBunSourceForCmake() {
  if (fs.existsSync(path.join(sourceDir, "bun.lock"))) {
    console.log("[bun-ios-runtime] Installing Bun source dependencies");
    run("bun", ["install", "--frozen-lockfile"], { cwd: sourceDir, env });
  }

  const requiredSourceLists = [
    path.join(sourceDir, "cmake", "sources", "BunErrorSources.txt"),
    path.join(sourceDir, "cmake", "sources", "NodeFallbacksSources.txt"),
  ];
  if (requiredSourceLists.some((file) => !fs.existsSync(file))) {
    console.log("[bun-ios-runtime] Generating Bun CMake source lists");
    run("bun", ["run", "glob-sources"], { cwd: sourceDir, env });
  }

  ensureRustTarget(info.rustTarget);
}

function ensureRustTarget(rustTarget) {
  const rustup = spawnSync("rustup", ["target", "list", "--installed"], {
    cwd: sourceDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (rustup.status !== 0) {
    return;
  }
  const installed = rustup.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (installed.includes(rustTarget)) {
    return;
  }
  console.log(`[bun-ios-runtime] Installing Rust target ${rustTarget}`);
  run("rustup", ["target", "add", rustTarget], { cwd: sourceDir, env });
}

function buildWithZig() {
  if (!fs.existsSync(path.join(sourceDir, "build.zig"))) {
    fail(
      `${sourceDir} does not support the Zig build backend (missing build.zig)`,
    );
  }
  console.log(`[bun-ios-runtime] Updating Bun submodules`);
  run("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: sourceDir,
    env,
  });
  console.log(`[bun-ios-runtime] Building JavaScriptCore/WebKit prerequisites`);
  run("make", ["jsc"], { cwd: sourceDir, env });
  console.log(
    `[bun-ios-runtime] Building Bun iOS engine target ${info.zigTarget}`,
  );
  run(
    "zig",
    [
      "build",
      `-Dtarget=${info.zigTarget}`,
      "-Doptimize=ReleaseFast",
      "-Deliza-ios-engine=true",
      `-Deliza-ios-xcframework=${artifact}`,
    ],
    { cwd: sourceDir, env },
  );
}

const selectedBackend = selectBackend();

if (explicitCommand) {
  console.log(
    `[bun-ios-runtime] Running ELIZA_BUN_IOS_BUILD_COMMAND for ${info.platform}`,
  );
  run("bash", ["-lc", explicitCommand], { cwd: sourceDir, env });
} else if (selectedBackend === "cmake") {
  buildWithCmake();
} else {
  buildWithZig();
}

if (!fs.existsSync(artifact)) {
  fail(
    `build completed but did not produce ${artifact}; the Bun fork must emit ElizaBunEngine.xcframework`,
  );
}

validateXcframework(artifact);
console.log(`[bun-ios-runtime] Built ${artifact}`);
