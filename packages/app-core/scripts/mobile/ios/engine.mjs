/** Owns ios engine using the shared build context and existing platform contracts. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  findForbiddenRuntimeImportGroups,
  findForbiddenRuntimeStrings,
  formatForbiddenRuntimeFindings,
} from "../../../../native/bun-runtime/scripts/ios-app-store-runtime-policy.mjs";
import {
  MTP_FORK_SRC_CANDIDATES,
  mtpForceRebuildRequested,
  mtpSliceReuse,
} from "../../lib/mobile-build-decisions.mjs";
import {
  resolvePackageAbsolutePath,
  rmRecursive,
  run,
  runCaptureSync,
} from "../build-tools.mjs";
import { __dirname } from "../context.mjs";
import {
  isIosSimulatorBuildTarget,
  shouldEnforceIosBunEngineAppStoreRuntime,
  shouldIncludeIosFullBunEngine,
  shouldIncludeIosLlama,
  shouldUseIosFusedLocalInference,
} from "./policy.mjs";
import {
  defaultIosBunEngineXcframework,
  IOS_BUN_ENGINE_ABI_VERSION,
  IOS_BUN_ENGINE_EXECUTION_PROFILE,
  IOS_BUN_ENGINE_FRAMEWORK_NAME,
  IOS_BUN_ENGINE_REQUIRED_SYMBOLS,
  iosBunRuntimePackageRoot,
} from "./runtime-assets.mjs";

// ── Phase 6: Native builds ──────────────────────────────────────────────

export function patchLlamaCppCapacitorPodspecForXcframework(
  packageDir,
  {
    xcframeworkRelPath = "ios/Frameworks-xcframework/LlamaCpp.xcframework",
  } = {},
) {
  const podspecPath = path.join(packageDir, "LlamaCppCapacitor.podspec");
  if (fs.existsSync(podspecPath)) {
    const current = fs.readFileSync(podspecPath, "utf8");
    let patched = current.replace(
      "s.vendored_frameworks = 'ios/Frameworks/llama-cpp.framework'",
      `s.vendored_frameworks = '${xcframeworkRelPath}'`,
    );
    patched = patched.replace(
      "s.vendored_frameworks = 'ios/Frameworks/LlamaCpp.framework'",
      `s.vendored_frameworks = '${xcframeworkRelPath}'`,
    );
    patched = patched.replace(
      "s.vendored_frameworks = 'ios/Frameworks/llama-cpp.xcframework'",
      `s.vendored_frameworks = '${xcframeworkRelPath}'`,
    );
    patched = patched.replace(
      "s.vendored_frameworks = 'ios/Frameworks/LlamaCpp.xcframework'",
      `s.vendored_frameworks = '${xcframeworkRelPath}'`,
    );
    patched = patched.replace(
      /\n\s*s\.pod_target_xcconfig\s*=\s*\{\s*\n\s*['"]FRAMEWORK_SEARCH_PATHS['"]\s*=>\s*['"]\$\(inherited\) "\$\(PODS_TARGET_SRCROOT\)\/ios\/Frameworks"['"]\s*\n\s*\}\s*/m,
      "\n",
    );
    // The published podspec also injects `ios/Frameworks` into
    // FRAMEWORK_SEARCH_PATHS, which contains the device-only
    // `llama-cpp.framework` next to the xcframework. The linker scans
    // -F paths in order and resolves `-framework llama-cpp` against the
    // device-only slice first, producing
    //   ld: building for 'iOS-simulator', but linking in dylib (...
    //   /llama-cpp.framework/llama-cpp) built for 'iOS'
    // on iphonesimulator builds. Drop the explicit search path so the
    // xcframework's per-platform slice is picked up via the standard
    // XCFrameworkIntermediates path the Xcode build system maintains.
    patched = patched.replace(
      /\s*s\.pod_target_xcconfig\s*=\s*\{[^}]*'FRAMEWORK_SEARCH_PATHS'\s*=>\s*'[^']*'[^}]*\}\s*/,
      "\n",
    );
    if (patched !== current) {
      fs.writeFileSync(podspecPath, patched, "utf8");
      console.log(
        "[mobile-build] Patched llama-cpp-capacitor podspec for xcframework + dropped FRAMEWORK_SEARCH_PATHS device-only override.",
      );
    }
  }

  const llamaPodspecPath = path.join(packageDir, "LlamaCpp.podspec");
  if (fs.existsSync(llamaPodspecPath)) {
    const current = fs.readFileSync(llamaPodspecPath, "utf8");
    let patched = current.replace(
      /^\s*s\.source_files\s*=.*$/m,
      "  s.source_files = []",
    );
    patched = patched.replace(
      "s.vendored_frameworks = 'ios/Frameworks/llama-cpp.framework'",
      `s.vendored_frameworks = '${xcframeworkRelPath}'`,
    );
    patched = patched.replace(
      "s.vendored_frameworks = 'ios/Frameworks/LlamaCpp.framework'",
      `s.vendored_frameworks = '${xcframeworkRelPath}'`,
    );
    patched = patched.replace(
      "s.vendored_frameworks = 'ios/Frameworks/llama-cpp.xcframework'",
      `s.vendored_frameworks = '${xcframeworkRelPath}'`,
    );
    patched = patched.replace(
      "s.vendored_frameworks = 'ios/Frameworks/LlamaCpp.xcframework'",
      `s.vendored_frameworks = '${xcframeworkRelPath}'`,
    );
    if (patched !== current) {
      fs.writeFileSync(llamaPodspecPath, patched, "utf8");
      console.log(
        "[mobile-build] Patched LlamaCpp podspec for eliza-built xcframework.",
      );
    }
  }
}

// Wave-4-F (iOS pipeline rewire): the iOS LlamaCpp.xcframework is now
// produced by `build-llama-cpp-mtp.mjs --target ios-arm64-metal` +
// `--target ios-arm64-simulator-metal` and assembled by
// `ios-xcframework/build-xcframework.mjs --verify`. The previous in-process
// cmake invocation that built `llama-cpp-capacitor`'s bundled `ios/`
// source produced a STOCK llama.cpp framework with none of the eliza
// kernels (TurboQuant / QJL / PolarQuant / MTP) and silently violated
// AGENTS.md §3 on every iOS build. Delegating to the mtp builder
// ensures the same kernel-set lands on iOS as on darwin/linux/android.
//
// AGENTS.md §3 enforcement: build-llama-cpp-mtp.mjs hard-throws on
// missing kernels via writeCapabilities()/requiredKernelsMissing(); the
// xcframework packaging --verify step additionally greps the static
// archives for AGENTS.md §3 kernel symbols. Either failure aborts the
// iOS build before the npm-bundled stock framework can be linked.
export const MTP_BUILD_SCRIPT = path.resolve(
  __dirname,
  "build-llama-cpp-mtp.mjs",
);

export const IOS_XCFRAMEWORK_BUILD_SCRIPT = path.resolve(
  __dirname,
  "ios-xcframework",
  "build-xcframework.mjs",
);

export function elizaStateDirForBuild() {
  const env = process.env.ELIZA_STATE_DIR?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".eliza");
}

export function mtpTargetOutDir(target) {
  return path.join(
    elizaStateDirForBuild(),
    "local-inference",
    "bin",
    "mtp",
    target,
  );
}

export function resolveMtpForkSrc() {
  for (const candidate of MTP_FORK_SRC_CANDIDATES) {
    if (fs.existsSync(path.join(candidate, "CMakeLists.txt"))) return candidate;
  }
  return null;
}

/** `git describe --always --dirty` of the fork, or null when git/desc fails. */
export function currentMtpForkRevision(forkSrc) {
  if (!forkSrc) return null;
  const result = spawnSync(
    "git",
    ["-C", forkSrc, "describe", "--always", "--dirty"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return result.stdout?.trim() || null;
}

export async function ensureMtpIosTarget(target) {
  const outDir = mtpTargetOutDir(target);
  const capabilities = path.join(outDir, "CAPABILITIES.json");
  const forkSrc = resolveMtpForkSrc();
  const reuse = mtpSliceReuse(
    capabilities,
    forkSrc,
    currentMtpForkRevision(forkSrc),
  );
  const forceRebuild = mtpForceRebuildRequested(reuse, process.env);
  if (!forceRebuild) {
    console.log(
      `[mobile-build] Reusing fresh mtp artifact for ${target} at ${outDir}`,
    );
    return outDir;
  }
  if (fs.existsSync(capabilities)) {
    console.log(
      `[mobile-build] Rebuilding mtp artifact for ${target} — ${process.env.ELIZA_IOS_REBUILD_MTP === "1" ? "ELIZA_IOS_REBUILD_MTP=1" : reuse.reason}`,
    );
  } else {
    console.log(`[mobile-build] Building mtp artifact for ${target}`);
  }
  // The child builder (build-llama-cpp-mtp.mjs) has its OWN presence-only reuse
  // gate keyed on ELIZA_MTP_FORCE_REBUILD. Without propagating it, the child
  // would see the stale CAPABILITIES.json and reuse it — turning this staleness
  // gate into a no-op. Force the child to actually rebuild (#9309).
  await run("node", [MTP_BUILD_SCRIPT, "--target", target], {
    env: { ...process.env, ELIZA_MTP_FORCE_REBUILD: "1" },
  });
  if (!fs.existsSync(capabilities)) {
    throw new Error(
      `[mobile-build] mtp build for ${target} did not produce CAPABILITIES.json at ${capabilities}. ` +
        `AGENTS.md §3 forbids shipping an iOS framework without the full kernel set; aborting.`,
    );
  }
  return outDir;
}

export async function ensureIosLlamaCppVendoredFramework({
  buildTarget: _buildTarget,
}) {
  // When llama is excluded from the build (cloud-only / App Store thin
  // client), the pod is not generated and the vendored framework is not
  // referenced. Skipping here avoids spinning up xcodebuild for an
  // xcframework that nothing consumes.
  const includeLlama = shouldIncludeIosLlama();
  if (!includeLlama) return;

  if (process.platform !== "darwin") {
    throw new Error(
      "[mobile-build] iOS llama.cpp xcframework build requires a macOS host with Xcode. " +
        "Either run on macOS or unset ELIZA_IOS_INCLUDE_LLAMA.",
    );
  }

  const packageDir = resolvePackageAbsolutePath("llama-cpp-capacitor");
  if (!packageDir) {
    throw new Error(
      "[mobile-build] llama-cpp-capacitor package not found in node_modules; " +
        "either install it or unset ELIZA_IOS_INCLUDE_LLAMA.",
    );
  }

  const frameworksDir = path.join(packageDir, "ios", "Frameworks");
  const xcframeworksDir = path.join(
    packageDir,
    "ios",
    "Frameworks-xcframework",
  );
  const xcframeworkDir = path.join(xcframeworksDir, "LlamaCpp.xcframework");
  patchLlamaCppCapacitorPodspecForXcframework(packageDir);

  // Build (or reuse) both per-platform slices via the mtp builder so
  // the iOS xcframework carries the same eliza kernel set as every
  // other supported backend. Per AGENTS.md §3, missing kernels here are
  // a hard error: build-llama-cpp-mtp.mjs already enforces that and
  // throws via writeCapabilities() before producing CAPABILITIES.json.
  const useFusedLocalInference = shouldUseIosFusedLocalInference();
  const deviceTarget = useFusedLocalInference
    ? "ios-arm64-metal-fused"
    : "ios-arm64-metal";
  const simulatorTarget = useFusedLocalInference
    ? "ios-arm64-simulator-metal-fused"
    : "ios-arm64-simulator-metal";
  if (useFusedLocalInference) {
    console.log(
      "[mobile-build] Using fused iOS local-inference slices for bundled local models",
    );
  }
  await ensureMtpIosTarget(deviceTarget);
  await ensureMtpIosTarget(simulatorTarget);

  fs.mkdirSync(xcframeworksDir, { recursive: true });
  rmRecursive(xcframeworkDir);
  await run("node", [
    IOS_XCFRAMEWORK_BUILD_SCRIPT,
    "--output",
    xcframeworkDir,
    "--device-archive-dir",
    mtpTargetOutDir(deviceTarget),
    "--sim-archive-dir",
    mtpTargetOutDir(simulatorTarget),
    "--verify",
  ]);

  // CocoaPods adds the parent directory of every `vendored_frameworks`
  // entry to FRAMEWORK_SEARCH_PATHS. The npm package ships a stock
  // device-only `LlamaCpp.framework` / `llama-cpp.framework` next to
  // the (now-replaced) xcframework slot. With both present the linker
  // resolves `-framework LlamaCpp` to the stock .framework first and
  // fails simulator builds with:
  //   ld: building for 'iOS-simulator', but linking in dylib (...) built for 'iOS'
  // Move the npm-bundled stock frameworks out of the search path so the
  // xcframework's per-platform slice is the only resolvable target.
  for (const stale of [
    path.join(frameworksDir, "LlamaCpp.framework"),
    path.join(frameworksDir, "llama-cpp.framework"),
  ]) {
    if (!fs.existsSync(stale)) continue;
    const archived = path.join(
      packageDir,
      "ios",
      `.${path.basename(stale, ".framework")}-stock-archive`,
    );
    rmRecursive(archived);
    fs.renameSync(stale, archived);
    console.log(
      `[mobile-build] Archived stock npm framework: ${stale} -> ${archived} ` +
        `(stock build has no Eliza-1 kernels — see AGENTS.md §3).`,
    );
  }
  console.log(
    "[mobile-build] iOS LlamaCpp.xcframework wired to eliza-built kernels (device + simulator slices).",
  );
}

export function resolveIosFullBunEngineXcframework({
  buildTarget = null,
} = {}) {
  const candidates = [
    process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK,
    defaultIosBunEngineXcframework,
    path.join(
      iosBunRuntimePackageRoot,
      "build",
      isIosSimulatorBuildTarget(buildTarget) ? "simulator" : "device",
      `${IOS_BUN_ENGINE_FRAMEWORK_NAME}.xcframework`,
    ),
  ].filter(Boolean);
  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  if (process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK) {
    return existing[0] ?? null;
  }
  return (
    existing.find((candidate) =>
      xcframeworkContainsIosBunEngineLibrary(candidate, { buildTarget }),
    ) ??
    existing[0] ??
    null
  );
}

export function xcframeworkContainsIosBunEngineLibrary(
  xcframework,
  { buildTarget = null } = {},
) {
  try {
    resolveIosBunEngineLibrary(xcframework, { buildTarget });
    return true;
  } catch {
    return false;
  }
}

export function parsePlistJson(plistPath) {
  const result = runCaptureSync("plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    plistPath,
  ]);
  if (result.status !== 0) {
    const reason =
      result.stderr?.trim() ||
      result.error?.message ||
      `exit status ${String(result.status)}`;
    throw new Error(
      `[mobile-build] failed to parse ${plistPath} with plutil: ${reason}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `[mobile-build] malformed JSON from plutil for ${plistPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function resolveIosBunEngineLibrary(
  xcframework,
  { buildTarget = null } = {},
) {
  const infoPlist = path.join(xcframework, "Info.plist");
  if (!fs.existsSync(infoPlist)) {
    throw new Error(
      `[mobile-build] ${IOS_BUN_ENGINE_FRAMEWORK_NAME}.xcframework is missing Info.plist: ${xcframework}`,
    );
  }
  const info = parsePlistJson(infoPlist);
  const libraries = Array.isArray(info.AvailableLibraries)
    ? info.AvailableLibraries
    : [];
  const wantSimulator = isIosSimulatorBuildTarget(buildTarget);
  const library = libraries.find((entry) => {
    if (entry?.SupportedPlatform !== "ios") return false;
    const variant = entry.SupportedPlatformVariant;
    return wantSimulator ? variant === "simulator" : !variant;
  });
  if (!library?.LibraryIdentifier) {
    const requested = wantSimulator ? "iOS Simulator" : "iOS device";
    const available = libraries
      .map(
        (entry) =>
          `${entry?.SupportedPlatform ?? "unknown"}${
            entry?.SupportedPlatformVariant
              ? `-${entry.SupportedPlatformVariant}`
              : ""
          }/${entry?.LibraryIdentifier ?? "missing-id"}`,
      )
      .join(", ");
    throw new Error(
      `[mobile-build] ${xcframework} does not contain a ${requested} ${IOS_BUN_ENGINE_FRAMEWORK_NAME} library. Available: ${available || "none"}`,
    );
  }
  const libraryRoot = path.join(xcframework, library.LibraryIdentifier);
  const frameworkRelPath =
    typeof library.LibraryPath === "string"
      ? library.LibraryPath
      : `${IOS_BUN_ENGINE_FRAMEWORK_NAME}.framework`;
  const frameworkDir = path.join(libraryRoot, frameworkRelPath);
  const binary = path.join(frameworkDir, IOS_BUN_ENGINE_FRAMEWORK_NAME);
  if (!fs.existsSync(binary)) {
    throw new Error(
      `[mobile-build] ${xcframework} selected ${library.LibraryIdentifier}, but ${binary} was not found`,
    );
  }
  return { binary, frameworkDir, libraryIdentifier: library.LibraryIdentifier };
}

export function validateIosBunEngineSymbols(binary) {
  const result = runCaptureSync("nm", ["-gU", binary], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const reason =
      result.stderr?.trim() ||
      result.error?.message ||
      `exit status ${String(result.status)}`;
    throw new Error(
      `[mobile-build] failed to inspect ${binary} with nm: ${reason}`,
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const missing = IOS_BUN_ENGINE_REQUIRED_SYMBOLS.filter(
    (symbol) => !output.includes(symbol),
  );
  if (missing.length > 0) {
    throw new Error(
      `[mobile-build] ${binary} is missing required full-Bun ABI symbols: ${missing.join(", ")}`,
    );
  }
}

export function validateIosBunEngineNoJitDynamicCode(
  binary,
  { buildTarget = null } = {},
) {
  const imports = runCaptureSync("nm", ["-u", binary], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (imports.status !== 0) {
    const reason =
      imports.stderr?.trim() ||
      imports.error?.message ||
      `exit status ${String(imports.status)}`;
    throw new Error(
      `[mobile-build] failed to inspect ${binary} imports with nm: ${reason}`,
    );
  }
  const importedSymbols = `${imports.stdout}\n${imports.stderr}`;
  const importGroups = findForbiddenRuntimeImportGroups(importedSymbols);
  if (importGroups.length > 0) {
    const message = formatForbiddenRuntimeFindings({
      binary,
      importGroups,
    });
    if (shouldEnforceIosBunEngineAppStoreRuntime(buildTarget)) {
      throw new Error(message);
    }
    console.warn(
      `${message}. Continuing for iOS Simulator; device/App Store full-Bun builds remain strict.`,
    );
  }

  const strings = runCaptureSync("strings", ["-a", binary], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (strings.status !== 0) {
    const reason =
      strings.stderr?.trim() ||
      strings.error?.message ||
      `exit status ${String(strings.status)}`;
    throw new Error(
      `[mobile-build] failed to inspect ${binary} strings: ${reason}`,
    );
  }
  const binaryStrings = `${strings.stdout}\n${strings.stderr}`;
  const stringPatterns = findForbiddenRuntimeStrings(binaryStrings);
  if (stringPatterns.length > 0) {
    const message = formatForbiddenRuntimeFindings({
      binary,
      stringPatterns,
    });
    if (shouldEnforceIosBunEngineAppStoreRuntime(buildTarget)) {
      throw new Error(message);
    }
    console.warn(
      `${message}. Continuing for iOS Simulator; device/App Store full-Bun builds remain strict.`,
    );
  }
}

export function validateIosFullBunEngineXcframework(
  xcframework,
  { buildTarget = null } = {},
) {
  const { binary, frameworkDir, libraryIdentifier } =
    resolveIosBunEngineLibrary(xcframework, { buildTarget });
  const frameworkInfoPlist = path.join(frameworkDir, "Info.plist");
  if (!fs.existsSync(frameworkInfoPlist)) {
    throw new Error(
      `[mobile-build] ${frameworkDir} is missing Info.plist; cannot verify full-Bun ABI metadata`,
    );
  }
  const frameworkInfo = parsePlistJson(frameworkInfoPlist);
  if (
    String(frameworkInfo.ElizaBunEngineABIVersion ?? "") !==
    IOS_BUN_ENGINE_ABI_VERSION
  ) {
    throw new Error(
      `[mobile-build] ${frameworkInfoPlist} has ElizaBunEngineABIVersion=${String(
        frameworkInfo.ElizaBunEngineABIVersion,
      )}; expected ${IOS_BUN_ENGINE_ABI_VERSION}`,
    );
  }
  if (frameworkInfo.ElizaBunEngineNoJIT !== true) {
    throw new Error(
      `[mobile-build] ${frameworkInfoPlist} must declare ElizaBunEngineNoJIT=true`,
    );
  }
  if (
    frameworkInfo.ElizaBunEngineExecutionProfile !==
    IOS_BUN_ENGINE_EXECUTION_PROFILE
  ) {
    throw new Error(
      `[mobile-build] ${frameworkInfoPlist} must declare ElizaBunEngineExecutionProfile=${IOS_BUN_ENGINE_EXECUTION_PROFILE}`,
    );
  }
  validateIosBunEngineSymbols(binary);
  validateIosBunEngineNoJitDynamicCode(binary, { buildTarget });
  console.log(
    `[mobile-build] iOS full Bun engine validated ${libraryIdentifier}: ${binary}`,
  );
}

export function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function stageIosFullBunEngineForPodspec(framework) {
  const resolved = path.resolve(framework);
  if (isPathInside(iosBunRuntimePackageRoot, resolved)) {
    return resolved;
  }
  if (resolved === path.resolve(defaultIosBunEngineXcframework)) {
    return resolved;
  }

  console.log(
    `[mobile-build] staging external iOS full Bun engine for CocoaPods: ${resolved} -> ${defaultIosBunEngineXcframework}`,
  );
  rmRecursive(defaultIosBunEngineXcframework);
  fs.mkdirSync(path.dirname(defaultIosBunEngineXcframework), {
    recursive: true,
  });
  fs.cpSync(resolved, defaultIosBunEngineXcframework, { recursive: true });
  return defaultIosBunEngineXcframework;
}

export function ensureIosFullBunEngineArtifact({ buildTarget = null } = {}) {
  if (!shouldIncludeIosFullBunEngine()) return null;
  const framework = resolveIosFullBunEngineXcframework({ buildTarget });
  if (!framework) {
    const target = isIosSimulatorBuildTarget(buildTarget)
      ? "simulator"
      : "device";
    throw new Error(
      [
        "ELIZA_IOS_FULL_BUN_ENGINE is set, but ElizaBunEngine.xcframework was not found.",
        "Build the Bun fork first:",
        `  ELIZA_BUN_IOS_SOURCE_DIR=/path/to/elizaos-bun bun run --cwd packages/native/bun-runtime build:${target === "simulator" ? "sim" : "device"}`,
        "Or set ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK=/absolute/path/ElizaBunEngine.xcframework.",
        "Refusing to fall back to the JSContext compatibility host for a full-engine build.",
      ].join("\n"),
    );
  }
  validateIosFullBunEngineXcframework(framework, { buildTarget });
  const stagedFramework = stageIosFullBunEngineForPodspec(framework);
  if (stagedFramework !== framework) {
    validateIosFullBunEngineXcframework(stagedFramework, { buildTarget });
  }
  process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK = stagedFramework;
  console.log(`[mobile-build] iOS full Bun engine: ${stagedFramework}`);
  return stagedFramework;
}
