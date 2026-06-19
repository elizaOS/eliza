#!/usr/bin/env node
/**
 * build-llama-cpp-desktop-dylib.mjs — Build the desktop Bun.dlopen pair:
 *
 *   libllama.<ext>             — shared-lib variant of llama.cpp (NOT static)
 *   libeliza-llama-shim.<ext>  — our pointer-style wrappers, NEEDED-links libllama
 *
 * Output layout (matches resolveDesktopBinDir in desktop-llama-adapter.ts):
 *
 *   $ELIZA_STATE_DIR/local-inference/bin/llama-cpp/<platform>-<arch>-<backend>/
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

// The native same-GGUF MTP engine (eliza_mtp_driver.cpp) requires the
// MTP-capable llama.cpp fork. That fork is vendored in-repo under
// packages/native/ios-deps/llama.cpp/src and is the source of truth until the
// MTP branch is published to elizaOS/llama.cpp. ensureSourceCheckout() prefers
// it over a network clone of `main` (which is pre-MTP). Override explicitly
// with ELIZA_DESKTOP_LLAMA_CPP_SRC=<abs path to a llama.cpp src tree>.
const LLAMA_CPP_LOCAL_SRC =
  process.env.ELIZA_DESKTOP_LLAMA_CPP_SRC ||
  path.resolve(
    here,
    "..",
    "..",
    "native",
    "ios-deps",
    "llama.cpp",
    "src",
  );

// Mirror @elizaos/core resolveStateDir() precedence EXACTLY so the build stages
// dylibs where the runtime's resolveDesktopBinDir() will look for them:
//   ELIZA_STATE_DIR > $XDG_STATE_HOME/<namespace> > ~/.local/state/<namespace>
// (namespace = ELIZA_NAMESPACE ?? "eliza"). Drift here silently breaks the FFI
// path — the runtime never finds the shim and falls through to the subprocess.
const STATE_DIR = (() => {
  const explicit = process.env.ELIZA_STATE_DIR?.trim();
  if (explicit) return explicit;
  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  const xdg = process.env.XDG_STATE_HOME?.trim();
  if (xdg) {
    return path.isAbsolute(xdg)
      ? path.join(xdg, namespace)
      : path.join(os.homedir(), xdg, namespace);
  }
  return path.join(os.homedir(), ".local", "state", namespace);
})();

const CACHE_DIR = path.join(
  STATE_DIR,
  "local-inference",
  "desktop-llama-build",
);

// ─── target table ────────────────────────────────────────────────────────────

/**
 * Per-target build recipe. cmakeFlags are the platform-specific CMake
 * args layered on top of the common base. backend is the mtp-style
 * suffix the output dir gets (matches existing `<platform>-<arch>-<backend>`
 * pattern from the mtp builder).
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
    hostNote:
      "On a Windows host this build requires MSVC's `cl.exe` first on PATH. " +
      "If `C:\\Strawberry\\c\\bin` (Strawberry Perl) is on PATH ahead of MSVC, " +
      "CMake auto-detects Strawberry's MinGW `gcc.exe` + `windres.exe` as the " +
      "host compiler/resource compiler, then `nvcc` (for `ELIZA_DESKTOP_BACKEND=cuda`) " +
      "rejects the MinGW host with `Detecting CUDA compiler ABI info - failed` / " +
      "`broken CUDA compiler`. Fix: launch a clean shell, `call vcvars64.bat` " +
      "first, then append CUDA / node / git / VS-bundled cmake+ninja to PATH — " +
      "DO NOT prepend Strawberry. CUDA toolkit must be a complete install (v12.4 " +
      "or newer); empty `v12.6` stubs without `nvcc.exe` break detection too. " +
      "For Vulkan backend (default), install the Vulkan SDK first.",
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

function readExportTable(platform, libraryPath) {
  const commands =
    platform === "windows"
      ? [
          ["dumpbin", ["/exports", libraryPath]],
          ["llvm-nm", ["-g", libraryPath]],
          ["nm", ["-g", libraryPath]],
        ]
      : platform === "darwin"
        ? [["nm", ["-gU", libraryPath]]]
        : [
            ["nm", ["-D", "-g", libraryPath]],
            ["llvm-nm", ["-D", "-g", libraryPath]],
          ];

  const failures = [];
  for (const [cmd, args] of commands) {
    const result = spawnSync(cmd, args, { encoding: "utf8" });
    if (result.status === 0) {
      return {
        command: [cmd, ...args].join(" "),
        output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      };
    }
    failures.push(`${cmd}: ${result.error?.message ?? `exit ${result.status}`}`);
  }

  die(`unable to inspect shim exports with ${commands.map(([cmd]) => cmd).join(", ")} (${failures.join("; ")})`);
}

function ensureSourceCheckout(srcDir) {
  if (fs.existsSync(path.join(srcDir, "CMakeLists.txt"))) {
    log(`source checkout present: ${srcDir}`);
    return;
  }
  // Prefer the in-repo MTP fork over a network clone of `main` (pre-MTP).
  // We symlink the cache src dir at the fork so the separate out-of-source
  // buildDir keeps generated artifacts out of the vendored tree.
  if (fs.existsSync(path.join(LLAMA_CPP_LOCAL_SRC, "CMakeLists.txt"))) {
    log(`linking MTP fork → ${srcDir} (${LLAMA_CPP_LOCAL_SRC})`);
    fs.mkdirSync(path.dirname(srcDir), { recursive: true });
    fs.symlinkSync(LLAMA_CPP_LOCAL_SRC, srcDir);
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
  if (t.hostNote) {
    log(`[${targetKey}] host-build prerequisites:\n  ${t.hostNote}`);
  }

  // Output dir MUST match the runtime's `resolveDesktopBinDir()` in
  // plugins/plugin-local-inference/src/services/desktop-llama-adapter.ts:
  //   $ELIZA_STATE_DIR/local-inference/bin/llama-cpp/<platform>-<arch>-<backend>
  // (no `-dlopen` suffix; the `bin/mtp/` tree is the separate native-runtime
  // region store). If these drift, loadDesktopLlama() never finds the shim and
  // silently falls through to the subprocess path.
  const [platform, arch] = targetKey.split("-");
  const outDirName = `${platform}-${arch}-${t.backend}`;
  const outDir = path.join(
    STATE_DIR,
    "local-inference",
    "bin",
    "llama-cpp",
    outDirName,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const srcDir = path.join(CACHE_DIR, "src");
  ensureSourceCheckout(srcDir);

  const buildDir = path.join(CACHE_DIR, "build", targetKey);
  fs.mkdirSync(buildDir, { recursive: true });

  // ── Step 1: build libllama as a shared library ────────────────────────────
  // Vision (mmproj/mtmd) is opt-in: setting `ELIZA_ENABLE_VISION=1` in the
  // build env flips `LLAMA_BUILD_MTMD=ON` so the mtmd shared library
  // gets built alongside libllama. The shim then compiles with
  // `-DELIZA_ENABLE_VISION=1` and links against `libmtmd`. Default builds
  // skip vision entirely (no mtmd target, no shim vision wrappers).
  //
  // Upstream renamed the multimodal surface from `examples/llava/` to
  // `tools/mtmd/` and consolidated llava + clip into a single mtmd target
  // built as a shared library when `BUILD_SHARED_LIBS=ON`.
  const ENABLE_VISION = process.env.ELIZA_ENABLE_VISION === "1";
  const cmakeArgs = [
    srcDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=ON",
    "-DGGML_NATIVE=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_SERVER=OFF",
    "-DLLAMA_CURL=OFF",
    ...(ENABLE_VISION ? ["-DLLAMA_BUILD_MTMD=ON"] : []),
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

  // ── Step 1a: build libllama-common as a shared library ───────────────────
  // The native MTP driver (eliza_mtp_driver.cpp) calls into the
  // `common_speculative_*` / `common_sampler_*` helpers, which live in the
  // `llama-common` CMake target (NOT `common`). With BUILD_SHARED_LIBS=ON
  // this produces `libllama-common.<ext>` next to libllama. The shim links
  // it via `-lllama-common`; it's staged + rpath-resolved like libllama.
  log(`cmake build ${targetKey} (llama-common for MTP driver)`);
  run(
    "cmake",
    [
      "--build",
      ".",
      "--config",
      "Release",
      "--target",
      "llama-common",
      "--parallel",
      String(os.cpus().length),
    ],
    buildDir,
  );

  // ── Step 1b: build mtmd when vision is enabled ───────────────────────────
  // llama.cpp HEAD exposes multimodal under `tools/mtmd/`. The `mtmd`
  // cmake target builds `libmtmd.<ext>` as a shared library (because
  // BUILD_SHARED_LIBS=ON). LLAMA_BUILD_MTMD=ON enables the target. The
  // shim links against this shared lib via `-lmtmd`.
  if (ENABLE_VISION) {
    log(`cmake build ${targetKey} (mtmd for vision)`);
    run(
      "cmake",
      [
        "--build",
        ".",
        "--config",
        "Release",
        "--target",
        "mtmd",
        "--parallel",
        String(os.cpus().length),
      ],
      buildDir,
    );
  }

  // ── Step 2: locate the build's shared-lib output dir ─────────────────────
  // Naming convention: linux/macOS produce `libllama.{so,dylib}` (CMake adds
  // the `lib` prefix on shared libs). Windows MSVC produces `llama.dll` —
  // the `lib` prefix is dropped because PE doesn't carry it. The runtime
  // (`desktop-llama-adapter.ts`) always opens `libllama.{so,dylib,dll}`.
  const libllamaName = `libllama.${t.libExt}`;
  const buildOutputNames =
    process.platform === "win32"
      ? [libllamaName, `llama.${t.libExt}`]
      : [libllamaName];
  const candidates = [];
  for (const name of buildOutputNames) {
    candidates.push(
      path.join(buildDir, name),
      path.join(buildDir, "bin", name),
      path.join(buildDir, "bin", "Release", name),
      path.join(buildDir, "src", name),
      path.join(buildDir, "src", "Release", name),
    );
  }
  // cmake puts the shared lib in different places depending on generator
  // (Ninja vs Make/VS). Fall through to a find scan.
  let libllamaSrcPath = candidates.find((p) => fs.existsSync(p));
  if (!libllamaSrcPath) {
    for (const name of buildOutputNames) {
      const found = spawnSync("find", [buildDir, "-name", name, "-print"], {
        encoding: "utf8",
      });
      libllamaSrcPath = found.stdout.split("\n").find((s) => s.trim());
      if (libllamaSrcPath) break;
    }
  }
  if (!libllamaSrcPath) {
    die(
      `could not locate ${buildOutputNames.join(" or ")} after cmake build ` +
        `in ${buildDir}; check that -DBUILD_SHARED_LIBS=ON took effect`,
    );
  }
  const srcBinDir = path.dirname(libllamaSrcPath);

  // ── Step 2a: stage the FULL shim dependency closure ──────────────────────
  // The shim links libllama + libllama-common, and those in turn pull in the
  // entire libggml* backend family (base/cpu/metal/cuda/…). Every cross-ref
  // uses a VERSIONED install name (`@rpath/libNAME.0.dylib`), while the
  // runtime opens the UNVERSIONED `libllama.<ext>`. So we must stage every
  // matching lib AND preserve the build's symlink farm
  // (libNAME.<ext> → libNAME.0.<ext> → libNAME.<major>.<minor>.<patch>.<ext>)
  // so both naming forms resolve. CMake bakes an absolute build-tree LC_RPATH
  // into each lib; we add `@loader_path` so the closure resolves from whatever
  // dir it's staged into (the runtime's resolveDesktopBinDir target).
  if (process.platform === "win32") {
    // PE has no rpath/symlinks: DLLs resolve from the same dir. Copy them flat,
    // normalizing the dropped `lib` prefix to the runtime's expected name.
    for (const entry of fs.readdirSync(srcBinDir)) {
      if (!/\.(dll)$/i.test(entry)) continue;
      if (!/^(lib)?(ggml|llama|mtmd)/i.test(entry)) continue;
      const staged = entry.startsWith("lib") ? entry : `lib${entry}`;
      fs.copyFileSync(
        path.join(srcBinDir, entry),
        path.join(outDir, staged),
      );
    }
  } else {
    const ext = t.libExt; // dylib | so
    const libRe = new RegExp(`^lib(ggml|llama|mtmd)[^/]*\\.${ext}`);
    const visionRe = /mtmd/;
    for (const entry of fs.readdirSync(srcBinDir)) {
      if (!libRe.test(entry)) continue;
      if (!ENABLE_VISION && visionRe.test(entry)) continue;
      const src = path.join(srcBinDir, entry);
      const dst = path.join(outDir, entry);
      const lst = fs.lstatSync(src);
      if (lst.isSymbolicLink()) {
        // Recreate the (relative) symlink so the name chain stays intact.
        const target = fs.readlinkSync(src);
        try {
          fs.rmSync(dst, { force: true });
        } catch {}
        fs.symlinkSync(target, dst);
        continue;
      }
      // Real versioned dylib: copy then add @loader_path so its own
      // `@rpath/lib*.0.<ext>` deps resolve from the staged dir.
      fs.copyFileSync(src, dst);
      const tool = process.platform === "darwin" ? "install_name_tool" : null;
      if (tool) {
        const res = spawnSync(tool, ["-add_rpath", "@loader_path", dst], {
          encoding: "utf8",
        });
        // Non-fatal: a duplicate @loader_path entry just means it's already set.
        if (
          res.status !== 0 &&
          !/would duplicate path|already/i.test(res.stderr || "")
        ) {
          die(`install_name_tool -add_rpath failed for ${dst}: ${res.stderr}`);
        }
      } else {
        // ELF: patchelf if available, else rely on the linker's $ORIGIN rpath.
        const pe = spawnSync(
          "patchelf",
          ["--add-rpath", "$ORIGIN", dst],
          { encoding: "utf8" },
        );
        if (pe.error) {
          log(
            `patchelf unavailable; ${entry} relies on its build-tree rpath ` +
              `(set $ORIGIN via the linker when building the shim)`,
          );
        }
      }
    }
  }
  log(`staged shim dependency closure (libllama/libllama-common/libggml*) → ${outDir}`);

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
  // mtmd.h is staged into include/ for debug/reference; the shim compile
  // also has `-I${srcDir}/tools/mtmd` so this copy is optional but matches
  // how llama.h is staged.
  if (ENABLE_VISION) {
    const mtmdH = path.join(srcDir, "tools", "mtmd", "mtmd.h");
    if (fs.existsSync(mtmdH)) {
      fs.copyFileSync(mtmdH, path.join(incDir, "mtmd.h"));
    }
  }

  // ── Step 4: compile the shim + MTP driver and NEEDED-link the libs ───────
  // The shim is two translation units:
  //   - eliza_llama_shim.c    (C11)   — pointer-style wrappers over libllama
  //   - eliza_mtp_driver.cpp  (C++17) — native same-GGUF MTP engine that
  //                                     drives common_speculative_* /
  //                                     common_sampler_* from libllama-common
  // We compile each to an object then link both into one dylib with clang++
  // (so the C++ runtime is pulled in) against libllama + libllama-common.
  const shimOut = path.join(outDir, `libeliza-llama-shim.${t.libExt}`);
  const cc = process.env.CC || (platform === "darwin" ? "clang" : "cc");
  const cxx = process.env.CXX || (platform === "darwin" ? "clang++" : "c++");

  // Compile against the fork's source headers ONLY. The staged `incDir` copies
  // (Step 3b) are debug-only and intentionally NOT on the include path: it holds
  // llama.h + ggml.h but not ggml-cpu.h, so llama.h's `#include "ggml-cpu.h"`
  // would fall through to srcDir and pull in a SECOND ggml.h → enum redefinition.
  const commonInc = [
    `-I${path.join(srcDir, "include")}`,
    `-I${path.join(srcDir, "ggml", "include")}`,
  ];
  const visionDefs = ENABLE_VISION
    ? ["-DELIZA_ENABLE_VISION=1", `-I${path.join(srcDir, "tools", "mtmd")}`]
    : [];

  const shimObj = path.join(buildDir, "eliza_llama_shim.o");
  const driverObj = path.join(buildDir, "eliza_mtp_driver.o");

  log(`compile shim TU → ${shimObj}`);
  run(cc, [
    "-O2",
    "-fPIC",
    "-std=c11",
    "-c",
    ...commonInc,
    ...visionDefs,
    path.join(SHIM_DIR, "eliza_llama_shim.c"),
    "-o",
    shimObj,
  ]);

  log(`compile MTP driver TU → ${driverObj}`);
  run(cxx, [
    "-O2",
    "-fPIC",
    "-std=c++17",
    "-c",
    ...commonInc,
    // The driver reaches into the common helper headers (speculative.h,
    // sampling.h, common.h) which live under src/common.
    `-I${path.join(srcDir, "common")}`,
    ...visionDefs,
    path.join(SHIM_DIR, "eliza_mtp_driver.cpp"),
    "-o",
    driverObj,
  ]);

  log(`link shim dylib → ${shimOut}`);
  const linkArgs = [
    "-shared",
    "-fPIC",
    shimObj,
    driverObj,
    "-o",
    shimOut,
    `-L${outDir}`,
    "-lllama",
    "-lllama-common",
  ];

  // Vision opt-in: NEEDED-link against the staged libmtmd next to libllama.
  if (ENABLE_VISION) {
    linkArgs.push("-lmtmd");
  }

  // Set rpath so libeliza-llama-shim resolves libllama + libllama-common from
  // its own dir at load time. Otherwise the user has to set
  // DYLD_LIBRARY_PATH/LD_LIBRARY_PATH.
  if (platform === "darwin") {
    linkArgs.push("-Wl,-install_name,@rpath/libeliza-llama-shim.dylib");
    linkArgs.push("-Wl,-rpath,@loader_path");
  } else if (platform === "linux") {
    linkArgs.push("-Wl,-rpath,$ORIGIN");
    linkArgs.push("-Wl,--enable-new-dtags");
  }
  // Windows DLLs resolve from the same dir by default — no rpath flag needed.

  // Link with the C++ driver so use clang++/c++ to pull in libc++/libstdc++.
  run(cxx, linkArgs);

  // ── Step 5: smoke-check that exports are present ─────────────────────────
  const exportTable = readExportTable(platform, shimOut);
  const exportCount = (
    exportTable.output.match(/(?:^|[\s|])_?eliza_llama_[A-Za-z0-9_]+/gm) ?? []
  ).length;
  log(
    `exports in libeliza-llama-shim.${t.libExt}: ${exportCount} eliza_llama_* symbols (${exportTable.command})`,
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
