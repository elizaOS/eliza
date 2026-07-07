#!/usr/bin/env node
/**
 * patch-llama-cpp-capacitor.mjs
 *
 * Bun v1.3.x has been observed to mis-apply patches that touch deeply-nested
 * directories inside cached packages (related bugs:
 *  - https://github.com/oven-sh/bun/issues/13330
 *  - https://github.com/oven-sh/bun/issues/13770).
 *
 * This script applies patches/llama-cpp-capacitor@0.1.5.patch using the
 * system `patch` utility instead, targeting all installed
 * llama-cpp-capacitor copies in node_modules.
 *
 * The patch rewrites android/build.gradle (per-ABI MTP lib dirs, riscv64
 * added to abiFilters), android/src/main/CMakeLists.txt (drop vendored
 * llama.cpp sources, link against MTP .so via the Eliza JNI bridge) and
 * android/src/main/java/.../LlamaCpp.java (riscv64 library mapping and
 * MTP dependency preload). It also repairs partially-applied installs so a
 * half-patched package cannot silently reach Android CI.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeModulesDir = join(repoRoot, "node_modules");
const bunCacheDir = join(nodeModulesDir, ".bun");
const patchFile = join(repoRoot, "patches", "llama-cpp-capacitor@0.1.5.patch");

if (!existsSync(nodeModulesDir)) {
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

// Discover every installed llama-cpp-capacitor copy: the top-level
// node_modules entry (used at build time by the Android app) and every
// per-hash bun cache copy. Bun's installer does not always hardlink the
// top-level copy back to the cache, so we must patch both.
const candidates = [];
const topLevel = join(nodeModulesDir, "llama-cpp-capacitor");
if (existsSync(topLevel)) {
  candidates.push({ label: "node_modules/llama-cpp-capacitor", dir: topLevel });
}
if (existsSync(bunCacheDir)) {
  for (const entry of readdirSync(bunCacheDir)) {
    if (!entry.startsWith("llama-cpp-capacitor@0.1.5")) continue;
    const pkgDir = join(
      bunCacheDir,
      entry,
      "node_modules",
      "llama-cpp-capacitor",
    );
    if (existsSync(pkgDir)) {
      candidates.push({ label: `node_modules/.bun/${entry}`, dir: pkgDir });
    }
  }
}

let patched = 0;
let skipped = 0;
let repaired = 0;
let failed = 0;

function writeIfChanged(filePath, current, next) {
  if (next === current) return false;
  writeFileSync(filePath, next);
  return true;
}

function ensureGradleMtpContract(pkgDir) {
  const gradlePath = join(pkgDir, "android", "build.gradle");
  if (!existsSync(gradlePath)) return false;
  const current = readFileSync(gradlePath, "utf8");
  let next = current;

  const mtpHelpers =
    `def resolveElizaRepoRoot = { ->\n` +
    `    return rootProject.projectDir.toPath().resolve('../../../..').normalize().toFile().absolutePath\n` +
    `}\n` +
    `\n` +
    `// Per-ABI resolver for the MTP cross-compile output produced by\n` +
    `// \`packages/app-core/scripts/build-llama-cpp-mtp.mjs\` and\n` +
    `// \`packages/app-core/scripts/aosp/compile-libllama.mjs\`. Each ABI has\n` +
    `// its own gradle property (\`eliza.mtp.android.libdir.<abi>\`) and env\n` +
    `// var (\`ELIZA_MTP_ANDROID_LIBDIR_<ABI>\`). For arm64-v8a the legacy\n` +
    `// unsuffixed names are still honored for backwards compatibility.\n` +
    `// riscv64 has no Vulkan path yet (Wave 2 ships CPU-only), so only the\n` +
    `// \`cpu\` backend is searched on that ABI.\n` +
    `def resolveElizaMtpAndroidLibDir = { String abi ->\n` +
    `    def propSuffix = abi == 'arm64-v8a' ? '' : ".\${abi}"\n` +
    `    def envSuffix = abi == 'arm64-v8a' ? '' : "_\${abi.replace('-', '_').toUpperCase()}"\n` +
    `    def fromProp = project.findProperty("eliza.mtp.android.libdir\${propSuffix}")\n` +
    `    if (fromProp) return fromProp.toString()\n` +
    `    def fromEnv = System.getenv("ELIZA_MTP_ANDROID_LIBDIR\${envSuffix}")\n` +
    `    if (fromEnv) return fromEnv\n` +
    `    def stateDir = System.getenv('ELIZA_STATE_DIR') ?: "\${System.getProperty('user.home')}/.eliza"\n` +
    `    def abiToken = [\n` +
    `        'arm64-v8a': 'android-arm64',\n` +
    `        'x86_64'   : 'android-x86_64',\n` +
    `        'riscv64'  : 'android-riscv64',\n` +
    `    ][abi]\n` +
    `    if (abiToken == null) return ''\n` +
    `    def backends = abi == 'riscv64' ? ['cpu'] : ['vulkan', 'cpu']\n` +
    `    def candidates = backends.collect { backend ->\n` +
    `        "\${stateDir}/local-inference/bin/mtp/\${abiToken}-\${backend}"\n` +
    `    }\n` +
    `    return candidates.find { new File(it).isDirectory() } ?: ''\n` +
    `}\n` +
    `\n` +
    `def resolveElizaSkipMtpAndroidLib = { ->\n` +
    `    // The retired llama-cpp-capacitor Android module is dropped from the\n` +
    `    // gradle build by default (run-mobile-build dropRetiredLlamaCppFromAndroidGradle),\n` +
    `    // so its CMake never runs and there is no stub. If it is explicitly\n` +
    `    // re-included (ELIZA_ANDROID_INCLUDE_LLAMA_CPP_CAPACITOR=1) build the real\n` +
    `    // MTP lib — never a no-op stub.\n` +
    `    return false\n` +
    `}\n`;

  // Self-heal duplicate helper blocks. An older non-idempotent version of
  // this patch appended a fresh helper copy on every install/build cycle, so
  // the file accumulated many duplicate top-level `def`s — duplicate
  // script-level closures crash Gradle's Groovy resolver with a
  // GradleResolveVisitor NPE ("source is null") and break every Android
  // build. If we see more than one copy, collapse the entire region between
  // the ext{} block and `buildscript {` back to a single canonical block.
  const repoRootCount = (next.match(/def resolveElizaRepoRoot\b/g) || [])
    .length;
  if (repoRootCount > 1) {
    next = next.replace(
      /(ext\s*\{[\s\S]*?\n\}\n)[\s\S]*?(\nbuildscript \{)/,
      `$1\n${mtpHelpers}$2`,
    );
  } else if (!next.includes("def resolveElizaRepoRoot")) {
    next = next.replace(/(ext\s*\{[\s\S]*?\n\}\n)/, `$1\n${mtpHelpers}\n`);
  } else if (
    !next.includes("def resolveElizaMtpAndroidLibDir = { String abi ->") ||
    !next.includes("def resolveElizaSkipMtpAndroidLib")
  ) {
    next = next.replace(
      /def resolveElizaRepoRoot = \{ ->[\s\S]*?\n\}\n\nbuildscript \{/,
      `${mtpHelpers}\nbuildscript {`,
    );
  }

  next = next
    .replace(
      /rootProject\.projectDir\.toPath\(\)\.resolve\('\.\.\/\.\.\/\.\.'\)/g,
      "rootProject.projectDir.toPath().resolve('../../../..')",
    )
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
    .replace(/\babortOnError false/g, "abortOnError = false")
    .replace(
      /abiFilters 'arm64-v8a'(?!,)/g,
      "abiFilters 'arm64-v8a', 'riscv64'",
    );

  const cmakeArgsBlock =
    `\n\n        externalNativeBuild {\n` +
    `            cmake {\n` +
    `                arguments "-DELIZA_REPO_ROOT=\${resolveElizaRepoRoot()}",\n` +
    `                    "-DELIZA_MTP_ANDROID_LIBDIR_ARM64_V8A=\${resolveElizaMtpAndroidLibDir('arm64-v8a')}",\n` +
    `                    "-DELIZA_MTP_ANDROID_LIBDIR_RISCV64=\${resolveElizaMtpAndroidLibDir('riscv64')}",\n` +
    `                    "-DELIZA_SKIP_MTP_ANDROID_LIB=\${resolveElizaSkipMtpAndroidLib() ? 'ON' : 'OFF'}"\n` +
    `            }\n` +
    `        }`;

  if (!next.includes("-DELIZA_REPO_ROOT=")) {
    next = next.replace(
      /(\n\s*ndk\s*\{\s*\n\s*abiFilters 'arm64-v8a'(?:,\s*'riscv64')?\s*\n\s*\})/,
      `$1${cmakeArgsBlock}`,
    );
  } else if (!next.includes("-DELIZA_MTP_ANDROID_LIBDIR_ARM64_V8A=")) {
    next = next.replace(
      /"-DELIZA_MTP_ANDROID_LIBDIR=\$\{resolveElizaMtpAndroidLibDir\(\)\}",?\n\s*(?:"-DELIZA_SKIP_MTP_ANDROID_LIB=\$\{resolveElizaSkipMtpAndroidLib\(\) \? 'ON' : 'OFF'\}")?/,
      `"-DELIZA_MTP_ANDROID_LIBDIR_ARM64_V8A=\${resolveElizaMtpAndroidLibDir('arm64-v8a')}",\n                    "-DELIZA_MTP_ANDROID_LIBDIR_RISCV64=\${resolveElizaMtpAndroidLibDir('riscv64')}",\n                    "-DELIZA_SKIP_MTP_ANDROID_LIB=\${resolveElizaSkipMtpAndroidLib() ? 'ON' : 'OFF'}"`,
    );
  } else if (!next.includes("-DELIZA_SKIP_MTP_ANDROID_LIB=")) {
    next = next.replace(
      /("-DELIZA_MTP_ANDROID_LIBDIR_RISCV64=\$\{resolveElizaMtpAndroidLibDir\('riscv64'\)\}")/,
      `$1,\n                    "-DELIZA_SKIP_MTP_ANDROID_LIB=\${resolveElizaSkipMtpAndroidLib() ? 'ON' : 'OFF'}"`,
    );
  }

  return writeIfChanged(gradlePath, current, next);
}

function ensureCmakeMtpContract(pkgDir) {
  const cmakePath = join(pkgDir, "android", "src", "main", "CMakeLists.txt");
  if (!existsSync(cmakePath)) return false;
  const current = readFileSync(cmakePath, "utf8");
  let next = current.replace(
    /\$\{ELIZA_REPO_ROOT\}\/packages\/native-plugins\/llama\/android\/eliza-mtp-jni\.cpp/g,
    "$" +
      "{ELIZA_REPO_ROOT}/packages/native/plugins/llama/android/eliza-mtp-jni.cpp",
  );

  if (
    next.includes("ELIZA_REPO_ROOT is required") &&
    !next.includes("ELIZA_SKIP_MTP_ANDROID_LIB")
  ) {
    const smokeLibraryBlock =
      `\noption(ELIZA_SKIP_MTP_ANDROID_LIB "Build a minimal JNI library for Android smoke builds without MTP libs" OFF)\n` +
      `\n` +
      `find_library(LOG_LIB log)\n` +
      `find_library(ANDROID_LIB android)\n` +
      `\n` +
      `if(ELIZA_SKIP_MTP_ANDROID_LIB)\n` +
      `    if(ANDROID_ABI STREQUAL "riscv64")\n` +
      `        set(ELIZA_SMOKE_OUTPUT_NAME "llama-cpp-riscv64")\n` +
      `    else()\n` +
      `        set(ELIZA_SMOKE_OUTPUT_NAME "llama-cpp-arm64")\n` +
      `    endif()\n` +
      `    file(WRITE "\${CMAKE_CURRENT_BINARY_DIR}/eliza-mtp-smoke.cpp" "extern \\"C\\" int eliza_mtp_smoke() { return 0; }\\n")\n` +
      `    add_library(\${ELIZA_SMOKE_OUTPUT_NAME} SHARED "\${CMAKE_CURRENT_BINARY_DIR}/eliza-mtp-smoke.cpp")\n` +
      `    target_link_libraries(\${ELIZA_SMOKE_OUTPUT_NAME} PRIVATE \${LOG_LIB} \${ANDROID_LIB})\n` +
      `    set_target_properties(\n` +
      `        \${ELIZA_SMOKE_OUTPUT_NAME}\n` +
      `        PROPERTIES\n` +
      `        OUTPUT_NAME "\${ELIZA_SMOKE_OUTPUT_NAME}"\n` +
      `        LIBRARY_OUTPUT_DIRECTORY "\${CMAKE_CURRENT_SOURCE_DIR}/jniLibs/\${ANDROID_ABI}"\n` +
      `    )\n` +
      `    message(STATUS "Building Eliza MTP JNI smoke library for Android \${ANDROID_ABI}")\n` +
      `    return()\n` +
      `endif()\n`;
    next = next.replace(
      /(set\(CMAKE_CXX_STANDARD_REQUIRED ON\)\n)/,
      `$1${smokeLibraryBlock}`,
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
  changed = ensureGradleMtpContract(pkgDir) || changed;
  changed = ensureCmakeMtpContract(pkgDir) || changed;
  return changed;
}

function isPatchAlreadyApplied(pkgDir) {
  const cmakePath = join(pkgDir, "android", "src", "main", "CMakeLists.txt");
  const gradlePath = join(pkgDir, "android", "build.gradle");
  if (
    existsSync(cmakePath) &&
    readFileSync(cmakePath, "utf8").includes("llama-cpp-capacitor-eliza-mtp")
  ) {
    return true;
  }
  return (
    existsSync(gradlePath) &&
    readFileSync(gradlePath, "utf8").includes("'arm64-v8a', 'riscv64'")
  );
}

for (const { label, dir: pkgDir } of candidates) {
  if (isPatchAlreadyApplied(pkgDir)) {
    skipped++;
  } else {
    // Apply with --forward to skip already-applied hunks, --batch to never
    // prompt interactively. Exit 0 = all hunks applied, exit 1 = some hunks
    // already applied (acceptable), exit 2+ = real error.
    const result = spawnSync(
      "patch",
      ["-p1", "--batch", "--forward", "-i", patchFile],
      { cwd: pkgDir, encoding: "utf8" },
    );

    if (result.status === 0 || result.status === 1) {
      patched++;
    } else if (process.platform === "win32") {
      // Windows CI ships GNU patch 2.5.9 from Strawberry Perl
      // (C:\Strawberry\c\bin\patch.exe), which aborts with an internal
      // assertion ("patch.c, Line 354, Expression: hunk") on these hunks
      // instead of applying them. This patch only rewrites Android build
      // files (build.gradle / CMakeLists / LlamaCpp.java) that are never
      // built on Windows, so a failed apply here is not fatal — the
      // string-based repair below still runs and Windows never consumes the
      // Android artifacts. Treat it as a skip so `bun install` stays green.
      skipped++;
      console.warn(
        `[patch-llama-cpp-capacitor] \`patch\` failed on Windows for ${label}; Android build files are not consumed here, continuing.`,
      );
    } else {
      failed++;
      console.error(
        `[patch-llama-cpp-capacitor] Failed to patch ${label}:\n${result.stderr}`,
      );
    }
  }

  try {
    if (repairPatchedPackage(pkgDir)) repaired++;
  } catch (error) {
    failed++;
    console.error(error instanceof Error ? error.message : String(error));
  }
}

// Never fail the install on Windows: the only artifacts this script touches
// are Android build files, which are not built on Windows, and the Strawberry
// Perl `patch.exe` there is prone to aborting on otherwise-valid hunks.
if (failed > 0 && process.platform !== "win32") {
  process.exitCode = 1;
}

if (patched > 0 || skipped > 0 || repaired > 0 || failed > 0) {
  console.log(
    `[patch-llama-cpp-capacitor] patched=${patched} already-applied=${skipped} repaired=${repaired} failed=${failed}`,
  );
}
