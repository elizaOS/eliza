#!/usr/bin/env node
/**
 * build-llama-cpp-desktop-dylib.mjs — Build the desktop Bun.dlopen pair:
 *
 *   libllama.<ext>             — shared-lib variant of llama.cpp (NOT static)
 *   libeliza-llama-shim.<ext>  — our pointer-style wrappers, NEEDED-links libllama
 *
 * Output layout (mirrors the existing dflash bin dirs):
 *
 *   $ELIZA_STATE_DIR/local-inference/bin/dflash/<platform>-<arch>-<backend>/
 *     libllama.<ext>
 *     libeliza-llama-shim.<ext>
 *     include/llama.h           (for downstream debug + future header-driven binders)
 *     include/eliza_llama_shim.h
 *
 * Where <ext> is .dylib (darwin), .so (linux), .dll (windows).
 *
 * Cross-target story:
 *   - darwin-arm64 / darwin-x86_64  → native + lipo, or one-arch-at-a-time
 *   - linux-x86_64 / linux-arm64    → zig cc --target=<arch>-linux-gnu (or musl
 *                                     for our APK shim — desktop wants -gnu so
 *                                     it can link Vulkan/CUDA from system libs)
 *   - windows-x86_64                → mingw-w64 cross via clang or x86_64-w64-mingw32-gcc
 *
 * On a darwin/arm64 host (this Mac) only the native darwin-arm64 target
 * can be physically built. Linux + Windows recipes are documented and
 * gated behind explicit --target flags; the user is expected to run them
 * on a matching CI runner.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const SHIM_DIR = path.join(here, "desktop-llama-shim");

const LLAMA_CPP_REPO =
  process.env.ELIZA_DESKTOP_LLAMA_CPP_REPO ||
  "https://github.com/elizaOS/llama.cpp";
const LLAMA_CPP_REF = process.env.ELIZA_DESKTOP_LLAMA_CPP_REF || "main";

const STATE_DIR =
  process.env.ELIZA_STATE_DIR ||
  process.env.MILADY_STATE_DIR ||
  path.join(os.homedir(), ".eliza");

const CACHE_DIR = path.join(
  STATE_DIR,
  "local-inference",
  "desktop-llama-build",
);

// ─── target table ────────────────────────────────────────────────────────────

/**
 * Per-target build recipe. cmakeFlags are the platform-specific CMake
 * args layered on top of the common base. backend is the dflash-style
 * suffix the output dir gets (matches existing `<platform>-<arch>-<backend>`
 * pattern from the dflash builder).
 */
const TARGETS = {
  "darwin-arm64": {
    backend: "metal",
    canBuildHere: () =>
      process.platform === "darwin" && process.arch === "arm64",
    libExt: "dylib",
    cmakeFlags: [
      "-DCMAKE_OSX_ARCHITECTURES=arm64",
      "-DGGML_METAL=ON",
      "-DGGML_METAL_EMBED_LIBRARY=ON",
      "-DGGML_ACCELERATE=ON",
      "-DGGML_BLAS=OFF",
    ],
  },
  "darwin-x86_64": {
    backend: "metal",
    canBuildHere: () => process.platform === "darwin",
    libExt: "dylib",
    cmakeFlags: [
      "-DCMAKE_OSX_ARCHITECTURES=x86_64",
      "-DGGML_METAL=ON",
      "-DGGML_METAL_EMBED_LIBRARY=ON",
      "-DGGML_ACCELERATE=ON",
      "-DGGML_BLAS=OFF",
    ],
  },
  "linux-x86_64": {
    backend: "vulkan",
    canBuildHere: () => process.platform === "linux" && process.arch === "x64",
    libExt: "so",
    cmakeFlags: [
      // Vulkan + CUDA both opt-in via separate ENV; default is Vulkan since
      // it's available on every recent Linux desktop without proprietary
      // drivers. Toggle with ELIZA_DESKTOP_BACKEND=cuda|vulkan|cpu.
      ...(process.env.ELIZA_DESKTOP_BACKEND === "cuda"
        ? ["-DGGML_CUDA=ON"]
        : process.env.ELIZA_DESKTOP_BACKEND === "cpu"
          ? []
          : ["-DGGML_VULKAN=ON"]),
    ],
    crossNote:
      "Cross-build from darwin host: use `zig cc -target x86_64-linux-gnu` " +
      "via -DCMAKE_C_COMPILER + -DCMAKE_CXX_COMPILER; install Vulkan SDK on the " +
      "build host or compile with GGML_VULKAN=OFF and re-enable on the target.",
  },
  "linux-arm64": {
    backend: "vulkan",
    canBuildHere: () =>
      process.platform === "linux" && process.arch === "arm64",
    libExt: "so",
    cmakeFlags: [
      ...(process.env.ELIZA_DESKTOP_BACKEND === "cpu"
        ? []
        : ["-DGGML_VULKAN=ON"]),
    ],
    crossNote:
      "Cross-build from darwin host: use `zig cc -target aarch64-linux-gnu` " +
      "via -DCMAKE_C_COMPILER + -DCMAKE_CXX_COMPILER; CMake toolchain file " +
      "should set CMAKE_SYSTEM_NAME=Linux CMAKE_SYSTEM_PROCESSOR=aarch64.",
  },
  "windows-x86_64": {
    backend: "vulkan",
    canBuildHere: () => process.platform === "win32",
    libExt: "dll",
    cmakeFlags: [
      ...(process.env.ELIZA_DESKTOP_BACKEND === "cuda"
        ? ["-DGGML_CUDA=ON"]
        : ["-DGGML_VULKAN=ON"]),
    ],
    crossNote:
      "Cross-build from darwin host: install `mingw-w64` via brew, then pass " +
      "a toolchain file setting CMAKE_C_COMPILER=x86_64-w64-mingw32-gcc, " +
      "CMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++, CMAKE_RC_COMPILER=" +
      "x86_64-w64-mingw32-windres, CMAKE_SYSTEM_NAME=Windows. Note: Metal " +
      "is unavailable; Vulkan is the desktop Windows backend.",
  },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`\x1b[34m[desktop-llama]\x1b[0m ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`\x1b[31m[desktop-llama:err]\x1b[0m ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} → exit ${r.status}`);
}

function ensureSourceCheckout(srcDir) {
  if (fs.existsSync(path.join(srcDir, "CMakeLists.txt"))) {
    log(`source checkout present: ${srcDir}`);
    return;
  }
  log(`cloning ${LLAMA_CPP_REPO}@${LLAMA_CPP_REF} → ${srcDir}`);
  fs.mkdirSync(srcDir, { recursive: true });
  run("git", ["init", "-q"], srcDir);
  run("git", ["remote", "add", "origin", LLAMA_CPP_REPO], srcDir);
  run("git", ["fetch", "--depth", "1", "origin", LLAMA_CPP_REF], srcDir);
  run("git", ["checkout", "--quiet", "FETCH_HEAD"], srcDir);
}

// ─── per-target build ────────────────────────────────────────────────────────

function buildTarget(targetKey) {
  const t = TARGETS[targetKey];
  if (!t) die(`unknown target: ${targetKey}`);
  if (!t.canBuildHere()) {
    const note = t.crossNote ?? "no documented cross-build path from this host";
    die(
      `cannot build ${targetKey} on ${process.platform}/${process.arch}: ${note}`,
    );
  }

  const [platform, arch] = targetKey.split("-");
  const outDirName = `${platform}-${arch}-${t.backend}-dlopen`;
  const outDir = path.join(
    STATE_DIR,
    "local-inference",
    "bin",
    "dflash",
    outDirName,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const srcDir = path.join(CACHE_DIR, "src");
  ensureSourceCheckout(srcDir);

  const buildDir = path.join(CACHE_DIR, "build", targetKey);
  fs.mkdirSync(buildDir, { recursive: true });

  // ── Step 1: build libllama as a shared library ────────────────────────────
  const cmakeArgs = [
    srcDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=ON",
    "-DGGML_NATIVE=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_SERVER=OFF",
    "-DLLAMA_CURL=OFF",
    ...t.cmakeFlags,
  ];
  log(`cmake configure ${targetKey} (shared libllama)`);
  run("cmake", cmakeArgs, buildDir);
  log(`cmake build ${targetKey}`);
  run(
    "cmake",
    [
      "--build",
      ".",
      "--config",
      "Release",
      "--target",
      "llama",
      "--parallel",
      String(os.cpus().length),
    ],
    buildDir,
  );

  // ── Step 2: locate the built libllama.<ext> and stage it ─────────────────
  const libllamaName = `libllama.${t.libExt}`;
  const candidates = [
    path.join(buildDir, libllamaName),
    path.join(buildDir, "bin", libllamaName),
    path.join(buildDir, "src", libllamaName),
  ];
  // Also walk shallow: cmake puts the shared lib in different places
  // depending on generator (Ninja vs Make). Fall through to a find scan.
  let libllamaSrcPath = candidates.find((p) => fs.existsSync(p));
  if (!libllamaSrcPath) {
    const found = spawnSync(
      "find",
      [buildDir, "-name", libllamaName, "-print"],
      {
        encoding: "utf8",
      },
    );
    libllamaSrcPath = found.stdout.split("\n").find((s) => s.trim());
  }
  if (!libllamaSrcPath) {
    die(
      `could not locate ${libllamaName} after cmake build in ${buildDir}; ` +
        `check that -DBUILD_SHARED_LIBS=ON took effect`,
    );
  }
  log(`staging ${libllamaSrcPath} → ${outDir}`);
  fs.copyFileSync(libllamaSrcPath, path.join(outDir, libllamaName));

  // ── Step 3: stage headers ────────────────────────────────────────────────
  const incDir = path.join(outDir, "include");
  fs.mkdirSync(incDir, { recursive: true });
  fs.copyFileSync(
    path.join(srcDir, "include", "llama.h"),
    path.join(incDir, "llama.h"),
  );
  // ggml.h is required by the shim's #include chain (llama.h pulls ggml types)
  const ggmlH = path.join(srcDir, "ggml", "include", "ggml.h");
  if (fs.existsSync(ggmlH)) {
    fs.copyFileSync(ggmlH, path.join(incDir, "ggml.h"));
  }
  fs.copyFileSync(
    path.join(SHIM_DIR, "eliza_llama_shim.h"),
    path.join(incDir, "eliza_llama_shim.h"),
  );

  // ── Step 4: compile the shim and NEEDED-link libllama ────────────────────
  const shimOut = path.join(outDir, `libeliza-llama-shim.${t.libExt}`);
  log(`compile shim → ${shimOut}`);

  const compilerArgs = [
    "-O2",
    "-fPIC",
    "-shared",
    "-std=c11",
    `-I${incDir}`,
    `-I${path.join(srcDir, "include")}`,
    `-I${path.join(srcDir, "ggml", "include")}`,
    path.join(SHIM_DIR, "eliza_llama_shim.c"),
    "-o",
    shimOut,
    `-L${outDir}`,
    "-lllama",
  ];

  // Set rpath so libeliza-llama-shim resolves libllama from its own dir at
  // load time. Otherwise the user has to set DYLD_LIBRARY_PATH/LD_LIBRARY_PATH.
  if (platform === "darwin") {
    compilerArgs.push("-Wl,-install_name,@rpath/libeliza-llama-shim.dylib");
    compilerArgs.push("-Wl,-rpath,@loader_path");
  } else if (platform === "linux") {
    compilerArgs.push("-Wl,-rpath,$ORIGIN");
    compilerArgs.push("-Wl,--enable-new-dtags");
  }
  // Windows DLLs resolve from the same dir by default — no rpath flag needed.

  const cc = process.env.CC || (platform === "darwin" ? "clang" : "cc");
  run(cc, compilerArgs);

  // ── Step 5: smoke-check that exports are present ─────────────────────────
  const nm = spawnSync("nm", ["-gU", shimOut], { encoding: "utf8" });
  const exportCount = (nm.stdout.match(/_eliza_llama_/g) ?? []).length;
  log(
    `exports in libeliza-llama-shim.${t.libExt}: ${exportCount} eliza_llama_* symbols`,
  );
  if (exportCount === 0) die("shim has no eliza_llama_* exports — link failed");

  log(`✔ ${targetKey} → ${outDir}`);
  return outDir;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  let target = argv[0];
  if (!target || target === "--host") {
    if (process.platform === "darwin" && process.arch === "arm64") {
      target = "darwin-arm64";
    } else if (process.platform === "darwin") {
      target = "darwin-x86_64";
    } else if (process.platform === "linux" && process.arch === "x64") {
      target = "linux-x86_64";
    } else if (process.platform === "linux" && process.arch === "arm64") {
      target = "linux-arm64";
    } else if (process.platform === "win32") {
      target = "windows-x86_64";
    } else {
      die(`no default target for ${process.platform}/${process.arch}`);
    }
  }
  if (target === "--list") {
    for (const k of Object.keys(TARGETS)) {
      const t = TARGETS[k];
      const here = t.canBuildHere() ? " (buildable on this host)" : "";
      process.stdout.write(`  ${k} → ${t.backend}/${t.libExt}${here}\n`);
    }
    return;
  }
  const out = buildTarget(target);
  process.stdout.write(`OUTDIR=${out}\n`);
}

main();
