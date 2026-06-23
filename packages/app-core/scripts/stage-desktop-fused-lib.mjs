#!/usr/bin/env node
/**
 * stage-desktop-fused-lib.mjs — build + stage the fused `libelizainference` for
 * the DESKTOP host (Linux / macOS / Windows) with host-GPU autodetection and a
 * CPU fallback baked into the same library.
 *
 * This is the desktop counterpart to the two maintained build scripts that
 * already existed for the mobile slices — `stage-elizavoice-lib.mjs` (Android
 * NDK → jniLibs) and `build-llama-cpp-mtp.mjs` (iOS xcframework). Before this,
 * the desktop fused lib had NO maintained, one-command build: developers ran
 * raw `cmake` into ad-hoc `build-cuda` / `build-cpu` dirs. That made Linux /
 * macOS / Windows a second-class path vs. mobile. This script gives desktop the
 * same single command.
 *
 * The `DesktopFusedFfiBackendRuntime` loads the staged lib via
 * `resolveFusedLibraryPath`, which searches `ELIZA_INFERENCE_LIBRARY`,
 * `<bundleRoot>/lib`, `ELIZA_INFERENCE_LIB_DIR`, and `<stateDir>/local-inference/lib`
 * (this script's default output). So after staging, the desktop fused path
 * works with no env wiring.
 *
 * Usage:
 *   node packages/app-core/scripts/stage-desktop-fused-lib.mjs \
 *     [--variant auto|cpu|cuda|vulkan|metal|hip] [--out <dir>] [--jobs N] [--force]
 *
 * Backend autodetect (--variant auto, the default):
 *   macOS          → Metal (Apple GPU; always present)
 *   Linux/Windows  → CUDA (nvcc) else Vulkan (glslc + headers) else HIP (hipcc) else CPU
 *
 * GGML_CPU is ALWAYS ON, so the same `.so/.dylib/.dll` transparently falls back
 * to CPU at runtime when no GPU device is present or GPU init fails. The build
 * is BUILD_SHARED_LIBS=ON: the GPU backend lives in its own `libggml-<be>` so it
 * can load the system driver at runtime; all produced shared libs are staged
 * together as a self-consistent set.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const forkSrc = path.join(
  repoRoot,
  "plugins/plugin-local-inference/native/llama.cpp",
);

function log(msg) {
  console.log(`[stage-desktop-fused-lib] ${msg}`);
}
function die(msg) {
  console.error(`[stage-desktop-fused-lib] ERROR: ${msg}`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) {
    die(`${cmd} exited ${res.status ?? res.signal}`);
  }
}
function have(cmd, args = ["--version"]) {
  try {
    const res = spawnSync(cmd, args, { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const out = { variant: "auto", outDir: null, jobs: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--variant") out.variant = argv[++i];
    else if (argv[i] === "--out") out.outDir = argv[++i];
    else if (argv[i] === "--jobs") out.jobs = parseInt(argv[++i], 10);
    else if (argv[i] === "--force") out.force = true;
    else die(`unknown arg: ${argv[i]}`);
  }
  const ok = ["auto", "cpu", "cuda", "vulkan", "metal", "hip"];
  if (!ok.includes(out.variant)) {
    die(`unsupported --variant ${out.variant} (one of: ${ok.join(", ")})`);
  }
  return out;
}

/** Resolve the state dir the same way @elizaos/core resolveStateDir does, so
 *  the default output dir matches where the runtime searches. */
function resolveStateDir() {
  const explicit = process.env.ELIZA_STATE_DIR?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.join(os.homedir(), explicit);
  }
  const ns = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  const xdg = process.env.XDG_STATE_HOME?.trim();
  if (xdg) {
    return path.isAbsolute(xdg)
      ? path.join(xdg, ns)
      : path.join(os.homedir(), xdg, ns);
  }
  return path.join(os.homedir(), ".local", "state", ns);
}

/** Autodetect the best available GPU backend for the host. */
function detectBackend() {
  if (process.platform === "darwin") return "metal";
  // CUDA: the nvcc compiler must be on PATH or under a CUDA toolkit dir.
  if (
    have("nvcc") ||
    process.env.CUDACXX ||
    (existsSync("/usr/local/cuda") && existsSync("/usr/local/cuda/bin/nvcc"))
  ) {
    return "cuda";
  }
  // Vulkan: needs the GLSL→SPIR-V compiler (glslc) the ggml-vulkan build runs.
  if (have("glslc")) return "vulkan";
  // ROCm/HIP (AMD).
  if (have("hipcc")) return "hip";
  return "cpu";
}

/**
 * Bake a RELATIVE rpath into the libs at link time so the staged fused lib
 * resolves its NEEDED siblings (libggml.so.0, libllama.so.0, …) from its own
 * directory — no patchelf, no LD_LIBRARY_PATH, no fragile absolute build-dir
 * RUNPATH. `CMAKE_BUILD_WITH_INSTALL_RPATH=ON` puts the install rpath into the
 * build-tree binaries directly.
 */
function rpathCmakeFlags() {
  if (process.platform === "win32") return []; // DLLs search their own dir
  const origin = process.platform === "darwin" ? "@loader_path" : "$ORIGIN";
  return [
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
    `-DCMAKE_INSTALL_RPATH=${origin}`,
  ];
}

/**
 * CUDA target architectures. `-arch=native` (ggml's default) requires nvcc to
 * query the live GPU at BUILD time — which fails in headless/background builds
 * ("Cannot find valid GPU for '-arch=native'") and silently bakes a fallback
 * arch that omits the host GPU, so at runtime CUDA reports "no CUDA-capable
 * device" and the lib drops to CPU. Detect the real compute capability from
 * nvidia-smi instead (e.g. 12.0 → "120"), with a broad modern fallback list.
 */
/**
 * Path to the CUDA compiler. A box can have BOTH an old `/usr/bin/nvcc` (from a
 * distro package) and a newer `/usr/local/cuda-X.Y/bin/nvcc`; CMake picks the
 * PATH one, which on a Blackwell host is too old for sm_120 ("nvcc broken" at
 * configure, or a silent CPU-only lib). Honor CUDACXX, else pick the highest
 * versioned nvcc under /usr/local/cuda-X.Y/bin, else fall back to PATH.
 */
function cudaCompiler() {
  const explicit = process.env.CUDACXX?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  let best = null;
  let bestVer = -1;
  try {
    for (const d of readdirSync("/usr/local")) {
      const m = d.match(/^cuda-(\d+)\.(\d+)$/);
      const nvcc = path.join("/usr/local", d, "bin", "nvcc");
      if (m && existsSync(nvcc)) {
        const ver = Number(m[1]) * 100 + Number(m[2]);
        if (ver > bestVer) {
          bestVer = ver;
          best = nvcc;
        }
      }
    }
  } catch {
    /* /usr/local unreadable — fall through to PATH nvcc */
  }
  const generic = "/usr/local/cuda/bin/nvcc";
  if (!best && existsSync(generic)) best = generic;
  return best; // null → let CMake find nvcc on PATH
}

function cudaArchitectures() {
  const explicit = process.env.ELIZA_CUDA_ARCHITECTURES?.trim();
  if (explicit) return explicit;
  const res = spawnSync(
    "nvidia-smi",
    ["--query-gpu=compute_cap", "--format=csv,noheader"],
    { encoding: "utf8" },
  );
  if (res.status === 0 && typeof res.stdout === "string") {
    const caps = [
      ...new Set(
        res.stdout
          .split(/\r?\n/)
          .map((l) => l.trim().replace(".", ""))
          .filter((c) => /^\d+$/.test(c)),
      ),
    ];
    if (caps.length) return caps.join(";");
  }
  // Fallback: Turing → Blackwell real archs + PTX for forward compat.
  return "75-real;80-real;86-real;89-real;90-real;120-real;120-virtual";
}

function backendCmakeFlags(backend) {
  switch (backend) {
    case "metal":
      return [
        "-DGGML_METAL=ON",
        "-DGGML_METAL_EMBED_LIBRARY=ON",
        "-DGGML_METAL_USE_BF16=ON",
        "-DGGML_ACCELERATE=ON",
      ];
    case "cuda": {
      const nvcc = cudaCompiler();
      return [
        "-DGGML_CUDA=ON",
        `-DCMAKE_CUDA_ARCHITECTURES=${cudaArchitectures()}`,
        ...(nvcc ? [`-DCMAKE_CUDA_COMPILER=${nvcc}`] : []),
      ];
    }
    case "vulkan":
      return ["-DGGML_VULKAN=ON"];
    case "hip":
      return ["-DGGML_HIP=ON"];
    case "cpu":
      return [];
    default:
      die(`unknown backend ${backend}`);
  }
}

const {
  variant,
  outDir: outOverride,
  jobs: jobsArg,
  force,
} = parseArgs(process.argv.slice(2));

if (!existsSync(path.join(forkSrc, "CMakeLists.txt"))) {
  die(
    `fork source not found at ${forkSrc}. Run \`git submodule update --init --recursive\` (bun install does this).`,
  );
}
if (!have("cmake")) die("cmake not found on PATH");

const backend = variant === "auto" ? detectBackend() : variant;
log(`host: ${process.platform}/${process.arch}`);
log(
  `backend: ${backend}${variant === "auto" ? " (autodetected)" : ""} (GGML_CPU always on for fallback)`,
);

const buildDir = path.join(forkSrc, `build-desktop-${backend}`);
const outDir =
  outOverride || path.join(resolveStateDir(), "local-inference", "lib");

if (force && existsSync(buildDir)) {
  rmSync(buildDir, { recursive: true, force: true });
}
mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const jobs =
  jobsArg ||
  (() => {
    try {
      return os.cpus().length || 4;
    } catch {
      return 4;
    }
  })();

// Configure. BUILD_SHARED_LIBS=ON keeps each ggml backend in its own shared lib
// (so the GPU backend can load the system driver at runtime) and matches the
// dlopen()-able sibling set the runtime resolves. LLAMA_BUILD_OMNIVOICE +
// LLAMA_BUILD_MTMD + LLAMA_BUILD_KOKORO are required for the fused
// `elizainference` SHARED target (TTS + Qwen3-ASR + Kokoro). GGML_NATIVE=ON tunes
// the CPU backend to the build host — correct for a local/dev build; a
// redistributable build should pin explicit CPU features instead.
run("cmake", [
  "-S",
  forkSrc,
  "-B",
  buildDir,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=ON",
  // kokoro_lib (and other static intermediates) fold into the SHARED
  // libelizainference; on desktop Linux/Windows static libs are not PIC by
  // default, so the shared-object link fails ("recompile with -fPIC"). Android's
  // NDK toolchain forces PIC globally so never hit this; make it explicit here.
  "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
  "-DGGML_CPU=ON",
  "-DGGML_NATIVE=ON",
  "-DLLAMA_BUILD_OMNIVOICE=ON",
  "-DLLAMA_BUILD_MTMD=ON",
  "-DLLAMA_BUILD_KOKORO=ON",
  "-DLLAMA_BUILD_TOOLS=OFF",
  "-DLLAMA_BUILD_TESTS=OFF",
  "-DLLAMA_BUILD_EXAMPLES=OFF",
  "-DLLAMA_BUILD_SERVER=OFF",
  "-DLLAMA_CURL=OFF",
  ...rpathCmakeFlags(),
  ...backendCmakeFlags(backend),
]);

run("cmake", [
  "--build",
  buildDir,
  "--target",
  "elizainference",
  // Multi-config generators (MSVC, Xcode) ignore -DCMAKE_BUILD_TYPE and pick
  // Debug unless the build step names the config; single-config generators
  // (Make, Ninja) silently ignore --config, so this is safe everywhere.
  "--config",
  "Release",
  "-j",
  String(jobs),
]);

// Collect the produced shared libs (the fused lib + its ggml/llama/mtmd
// backends) and stage them as one consistent set. Sweep the out dir first so a
// backend switch never leaves a stale sibling the loader could pick up.
// Multi-config generators (MSVC, Xcode) nest the artifacts under bin/<Config>;
// single-config generators (Make, Ninja) emit straight into bin/.
let binDir = path.join(buildDir, "bin");
const releaseBinDir = path.join(binDir, "Release");
if (existsSync(releaseBinDir)) binDir = releaseBinDir;
const libExt =
  process.platform === "darwin"
    ? ".dylib"
    : process.platform === "win32"
      ? ".dll"
      : ".so";
// CMake prepends the `lib` prefix to shared libs on Unix only; MSVC/Windows
// emits the bare target name (elizainference.dll).
const fusedName =
  process.platform === "win32"
    ? `elizainference${libExt}`
    : `libelizainference${libExt}`;
if (!existsSync(path.join(binDir, fusedName))) {
  die(`build did not produce ${fusedName} in ${binDir}`);
}

// Sweep stale libs from a prior backend so the loader never sees a half-swapped
// set, then stage the produced set. cmake emits versioned SONAME symlink chains
// (libggml.so -> libggml.so.0 -> libggml.so.0.12.0); the fused lib's NEEDED
// entries reference the SONAME (libggml.so.0), so we dereference and copy the
// REAL file content under each .so / .so.<major> name. cpSync({dereference})
// turns the symlinks into self-contained files (no dangling links into the
// build dir). We skip the full .so.<major>.<minor>… node — the SONAME copy
// covers the dynamic loader.
const isStageable = (n) => {
  if (process.platform === "win32") return n.endsWith(".dll");
  if (process.platform === "darwin") return n.endsWith(".dylib");
  // Linux: libfoo.so or libfoo.so.<major>, NOT libfoo.so.<major>.<minor>…
  return /\.so(\.\d+)?$/.test(n);
};
const libFamily = (n) =>
  /^(lib)?(elizainference|ggml|llama|mtmd|omnivoice)/.test(n);

for (const stale of readdirSync(outDir)) {
  if (isStageable(stale)) rmSync(path.join(outDir, stale), { force: true });
}

const produced = readdirSync(binDir).filter(
  (n) => isStageable(n) && libFamily(n),
);
const staged = [];
for (const name of produced) {
  // realpathSync resolves the .so -> .so.0 -> .so.0.12.0 chain to the real
  // file; copyFileSync writes its CONTENT under the (SONAME) name the loader's
  // NEEDED entry references — a self-contained copy, no link into the build dir.
  const real = realpathSync(path.join(binDir, name));
  copyFileSync(real, path.join(outDir, name));
  staged.push(name);
}
log(`staged ${staged.length} libs → ${outDir}`);
for (const s of staged) log(`  ${s}`);

// Verify the fused FFI + voice fusion landed. The fused lib MUST define the
// eliza_inference_* FFI ABI (what the runtime dlsyms) and the ov_* OmniVoice
// symbols (proving omnivoice-core folded in). In a BUILD_SHARED_LIBS=ON build
// llama_* legitimately lives in the sibling libllama.so.0 (transitively loaded),
// NOT re-exported by the fused lib — so llama_* is checked across the whole
// staged set, not the fused lib alone. A half-fused link drops eliza/ov.
verifyFusedSymbols(outDir);

function definedSymbols(libPath) {
  const tool =
    process.platform === "darwin"
      ? { cmd: "nm", args: ["-gU", libPath] }
      : process.platform === "win32"
        ? // PE exports live in the export-address table shown by `objdump -p`
          // ("[Ordinal/Name Pointer] Table"); `-T` is the ELF dynamic-symbol
          // flag and lists nothing for a .dll, so it would false-fail the verify.
          { cmd: "objdump", args: ["-p", libPath] }
        : { cmd: "nm", args: ["-D", "--defined-only", libPath] };
  try {
    return execFileSync(tool.cmd, tool.args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function verifyFusedSymbols(stagedDir) {
  const fusedSyms = definedSymbols(path.join(stagedDir, fusedName));
  if (fusedSyms === null) {
    log("symbol verify skipped (nm/objdump unavailable)");
    return;
  }
  // eliza_inference_* and ov_* must be in the fused lib itself. Anchor to the
  // symbol start after nm's type column and allow the Mach-O leading underscore
  // (`_eliza_inference_*` on macOS, `eliza_inference_*` on Linux) — a bare `\b`
  // does NOT match between `_` and a letter, so it false-fails on macOS.
  const inFused = {
    "eliza_inference_*": /(?:^|\s)_?eliza_inference_/m,
    "ov_*": /(?:^|\s)_?ov_/m,
  };
  const missingFused = Object.entries(inFused)
    .filter(([, re]) => !re.test(fusedSyms))
    .map(([n]) => n);
  if (missingFused.length) {
    die(
      `fused lib ${fusedName} is missing symbol families: ${missingFused.join(", ")} ` +
        `— a half-fused link. Check LLAMA_BUILD_OMNIVOICE / LLAMA_BUILD_MTMD.`,
    );
  }
  // llama_* across the staged set (the sibling libllama in a shared build).
  const llamaHere = staged.some((n) => {
    const s = definedSymbols(path.join(stagedDir, n));
    return s !== null && /(?:^|\s)_?llama_/m.test(s);
  });
  if (!llamaHere) {
    die(`llama_* symbols not found in the staged lib set — incomplete build.`);
  }
  log(
    "symbol verify OK: eliza_inference_* + ov_* in fused lib, llama_* in set",
  );
}

log("");
log(`done. The desktop runtime resolves this automatically via`);
log(`  <stateDir>/local-inference/lib  (resolveFusedLibraryPath default)`);
log(`or set ELIZA_INFERENCE_LIB_DIR=${outDir} to point at it explicitly.`);
