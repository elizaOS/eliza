#!/usr/bin/env node
/**
 * patch-llama-cpp-capacitor.mjs
 *
 * Bun v1.3.x has been unreliable for this nested package patch in CI.
 * In particular, partially-applied patches can leave CMake updated without
 * the matching Gradle arguments that pass ELIZA_REPO_ROOT and DFlash paths.
 *
 * This script applies the patch using the system `patch` utility instead,
 * targeting all installed llama-cpp-capacitor copies in node_modules/.bun.
 * It is idempotent and repairs the Gradle/CMake contract after patching so a
 * half-patched install cannot silently reach Android CI.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bunCacheDir = join(repoRoot, "node_modules", ".bun");
const patchFile = join(repoRoot, "patches", "llama-cpp-capacitor@0.1.5.patch");

if (!existsSync(bunCacheDir)) {
  process.exit(0);
}

if (!existsSync(patchFile)) {
  console.warn("[patch-llama-cpp-capacitor] Patch file not found — skipping.");
  process.exit(0);
}

// Check that `patch` is available on PATH.
const patchCheck = spawnSync("patch", ["--version"], { encoding: "utf8" });
if (patchCheck.status !== 0 && patchCheck.error) {
  console.warn(
    "[patch-llama-cpp-capacitor] `patch` utility not found — skipping.",
  );
  process.exit(0);
}

let patched = 0;
let skipped = 0;
let repaired = 0;

function writeIfChanged(filePath, current, next) {
  if (next === current) return false;
  writeFileSync(filePath, next);
  return true;
}

function ensureGradleDflashContract(pkgDir) {
  const gradlePath = join(pkgDir, "android", "build.gradle");
  if (!existsSync(gradlePath)) return false;
  const current = readFileSync(gradlePath, "utf8");
  let next = current;

  const dflashHelpers =
    `def resolveElizaRepoRoot = { ->\n` +
    `    return rootProject.projectDir.toPath().resolve('../../..').normalize().toFile().absolutePath\n` +
    `}\n` +
    `\n` +
    `def resolveElizaDflashAndroidLibDir = { ->\n` +
    `    def fromProp = project.findProperty('eliza.dflash.android.libdir')\n` +
    `    if (fromProp) return fromProp.toString()\n` +
    `    def fromEnv = System.getenv('ELIZA_DFLASH_ANDROID_LIBDIR')\n` +
    `    if (fromEnv) return fromEnv\n` +
    `    def stateDir = System.getenv('ELIZA_STATE_DIR') ?: "\${System.getProperty('user.home')}/.eliza"\n` +
    `    def candidates = ['vulkan', 'cpu'].collect { backend ->\n` +
    `        "\${stateDir}/local-inference/bin/dflash/android-arm64-\${backend}"\n` +
    `    }\n` +
    `    return candidates.find { new File(it).isDirectory() } ?: ''\n` +
    `}\n` +
    `\n` +
    `def resolveElizaSkipDflashAndroidLib = { ->\n` +
    `    return project.findProperty('elizaSkipForkLlamaLib') == 'true' ||\n` +
    `        System.getenv('ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB') == '1'\n` +
    `}\n`;

  if (!next.includes("def resolveElizaRepoRoot")) {
    next = next.replace(/(ext\s*\{[\s\S]*?\n\}\n)/, `$1\n${dflashHelpers}\n`);
  } else if (!next.includes("def resolveElizaSkipDflashAndroidLib")) {
    next = next.replace(
      /(def resolveElizaDflashAndroidLibDir = \{ ->[\s\S]*?\n\}\n)/,
      `$1\n` +
        `def resolveElizaSkipDflashAndroidLib = { ->\n` +
        `    return project.findProperty('elizaSkipForkLlamaLib') == 'true' ||\n` +
        `        System.getenv('ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB') == '1'\n` +
        `}\n`,
    );
  }

  next = next
    .replace(
      /namespace\s+"ai\.annadata\.plugin\.capacitor"/g,
      'namespace = "ai.annadata.plugin.capacitor"',
    )
    .replace(
      /getDefaultProguardFile\('proguard-android\.txt'\)/g,
      "getDefaultProguardFile('proguard-android-optimize.txt')",
    )
    .replace(/\bversion "3\.22\.1"/g, 'version = "3.22.1"')
    .replace(/\bndkVersion "29\.0\.13113456"/g, 'ndkVersion = "29.0.13113456"')
    .replace(/\babortOnError false/g, "abortOnError = false");

  const cmakeArgsBlock =
    `\n\n        externalNativeBuild {\n` +
    `            cmake {\n` +
    `                arguments "-DELIZA_REPO_ROOT=\${resolveElizaRepoRoot()}",\n` +
    `                    "-DELIZA_DFLASH_ANDROID_LIBDIR=\${resolveElizaDflashAndroidLibDir()}",\n` +
    `                    "-DELIZA_SKIP_DFLASH_ANDROID_LIB=\${resolveElizaSkipDflashAndroidLib() ? 'ON' : 'OFF'}"\n` +
    `            }\n` +
    `        }`;

  if (!next.includes("-DELIZA_REPO_ROOT=")) {
    next = next.replace(
      /(\n\s*ndk\s*\{\s*\n\s*abiFilters 'arm64-v8a'\s*\n\s*\})/,
      `$1${cmakeArgsBlock}`,
    );
  } else if (!next.includes("-DELIZA_SKIP_DFLASH_ANDROID_LIB=")) {
    next = next.replace(
      /("-DELIZA_DFLASH_ANDROID_LIBDIR=\$\{resolveElizaDflashAndroidLibDir\(\)\}")/,
      `$1,\n                    "-DELIZA_SKIP_DFLASH_ANDROID_LIB=\${resolveElizaSkipDflashAndroidLib() ? 'ON' : 'OFF'}"`,
    );
  }

  return writeIfChanged(gradlePath, current, next);
}

function ensureCmakeDflashContract(pkgDir) {
  const cmakePath = join(pkgDir, "android", "src", "main", "CMakeLists.txt");
  if (!existsSync(cmakePath)) return false;
  const current = readFileSync(cmakePath, "utf8");
  let next = current.replace(
    /\$\{ELIZA_REPO_ROOT\}\/packages\/native-plugins\/llama\/android\/eliza-dflash-jni\.cpp/g,
    "$" +
      "{ELIZA_REPO_ROOT}/packages/native/plugins/llama/android/eliza-dflash-jni.cpp",
  );

  if (
    next.includes("ELIZA_REPO_ROOT is required") &&
    !next.includes("ELIZA_SKIP_DFLASH_ANDROID_LIB")
  ) {
    const smokeStubBlock =
      `\noption(ELIZA_SKIP_DFLASH_ANDROID_LIB "Build a no-op JNI library for Android smoke builds without DFlash libs" OFF)\n` +
      `\n` +
      `find_library(LOG_LIB log)\n` +
      `find_library(ANDROID_LIB android)\n` +
      `\n` +
      `if(ELIZA_SKIP_DFLASH_ANDROID_LIB)\n` +
      `    file(WRITE "\${CMAKE_CURRENT_BINARY_DIR}/eliza-dflash-stub.cpp" "extern \\"C\\" int eliza_dflash_stub() { return 0; }\\n")\n` +
      `    add_library(llama-cpp-arm64 SHARED "\${CMAKE_CURRENT_BINARY_DIR}/eliza-dflash-stub.cpp")\n` +
      `    target_link_libraries(llama-cpp-arm64 PRIVATE \${LOG_LIB} \${ANDROID_LIB})\n` +
      `    set_target_properties(\n` +
      `        llama-cpp-arm64\n` +
      `        PROPERTIES\n` +
      `        OUTPUT_NAME "llama-cpp-arm64"\n` +
      `        LIBRARY_OUTPUT_DIRECTORY "\${CMAKE_CURRENT_SOURCE_DIR}/jniLibs/arm64-v8a"\n` +
      `    )\n` +
      `    message(STATUS "Building Eliza DFlash JNI smoke stub for Android ARM64")\n` +
      `    return()\n` +
      `endif()\n`;
    next = next.replace(
      /(set\(CMAKE_CXX_STANDARD_REQUIRED ON\)\n)/,
      `$1${smokeStubBlock}`,
    );
  }

  if (
    next.includes("ELIZA_REPO_ROOT is required") &&
    !next.includes("packages/native/plugins/llama")
  ) {
    throw new Error(
      "[patch-llama-cpp-capacitor] patched CMake still points at the old native plugin path",
    );
  }

  return writeIfChanged(cmakePath, current, next);
}

function repairPatchedPackage(pkgDir) {
  let changed = false;
  changed = ensureGradleDflashContract(pkgDir) || changed;
  changed = ensureCmakeDflashContract(pkgDir) || changed;
  return changed;
}

function isPatchAlreadyApplied(pkgDir) {
  const cmakePath = join(pkgDir, "android", "src", "main", "CMakeLists.txt");
  if (!existsSync(cmakePath)) return false;
  return readFileSync(cmakePath, "utf8").includes(
    "llama-cpp-capacitor-eliza-dflash",
  );
}

for (const entry of readdirSync(bunCacheDir)) {
  if (!entry.startsWith("llama-cpp-capacitor@0.1.5")) continue;

  const pkgDir = join(
    bunCacheDir,
    entry,
    "node_modules",
    "llama-cpp-capacitor",
  );

  if (!existsSync(pkgDir)) continue;

  if (isPatchAlreadyApplied(pkgDir)) {
    skipped++;
  } else {
    // Apply with --forward to skip already-applied hunks, --batch to never
    // prompt interactively. Exit 0 = all hunks applied, exit 1 = some hunks
    // already applied (acceptable), exit 2+ = real error.
    const result = spawnSync(
      "patch",
      ["-p1", "--batch", "--forward", `-i`, patchFile],
      { cwd: pkgDir, encoding: "utf8" },
    );

    if (result.status === 0 || result.status === 1) {
      patched++;
    } else {
      console.error(
        `[patch-llama-cpp-capacitor] Failed to patch ${entry}:\n${result.stderr}`,
      );
    }
  }

  try {
    if (repairPatchedPackage(pkgDir)) repaired++;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (patched > 0 || skipped > 0 || repaired > 0) {
  console.log(
    `[patch-llama-cpp-capacitor] patched=${patched} already-applied=${skipped} repaired=${repaired}`,
  );
}
