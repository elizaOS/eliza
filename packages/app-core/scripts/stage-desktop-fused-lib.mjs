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
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
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
function removePathRecursive(targetPath) {
  const res = spawnSync(
    "node",
    [cleanupHelperScript, path.relative(repoRoot, targetPath)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    die(
      [`failed to remove ${targetPath}`, res.stdout.trim(), res.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    );
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

// ---- Staleness guard -------------------------------------------------------
// The #1 way the staged fused lib goes stale in dev→device: a rebuild lands in
// the build dir (e.g. building a CLI target rebuilds `elizainference` too) but
// the STAGE step is not re-run, so `<stateDir>/local-inference/lib` keeps an
// older copy; or a `git submodule update` restores fork sources with rewound
// mtimes so an incremental cmake keeps stale objects. Both produce a lib that
// silently mismatches the current source. We fingerprint the fork (commit +
// uncommitted-tree hash) and the staged lib (sha256) into a build stamp so:
//   - a normal run auto-CLEAN-rebuilds when the fork changed since the stamp;
//   - `--check` fast-detects a stale staged lib (non-zero exit) without building.
const STAMP_FILE = ".eliza-fused-build-stamp.json";
const FUSED_LIB_NAME =
  process.platform === "win32"
    ? "elizainference.dll"
    : process.platform === "darwin"
      ? "libelizainference.dylib"
      : "libelizainference.so";
function forkCommit() {
  try {
    return execFileSync("git", ["-C", forkSrc, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}
function forkDirtyHash() {
  try {
    const s = execFileSync(
      "git",
      [
        "-C",
        forkSrc,
        "status",
        "--porcelain",
        "--untracked-files=no",
        "--",
        "tools",
        "src",
        "ggml",
        "common",
        "CMakeLists.txt",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ).trim();
    return s ? createHash("sha256").update(s).digest("hex").slice(0, 16) : "";
  } catch {
    return "";
  }
}
function sha256File(p) {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}
function readStamp(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, STAMP_FILE), "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {
    variant: "auto",
    outDir: null,
    jobs: null,
    force: false,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--variant") out.variant = argv[++i];
    else if (argv[i] === "--out") out.outDir = argv[++i];
    else if (argv[i] === "--jobs") out.jobs = parseInt(argv[++i], 10);
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--check") out.check = true;
    else if (argv[i] === "--ensure") out.ensure = true;
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
  check,
  ensure,
} = parseArgs(process.argv.slice(2));

const stagedOutDir =
  outOverride || path.join(resolveStateDir(), "local-inference", "lib");
const currentFork = forkCommit();
const currentDirty = forkDirtyHash();

// Shared staleness verdict for --check / --ensure. Returns the reasons the
// staged fused lib is stale ([] = fresh).
function stagedStalenessReasons() {
  const stamp = readStamp(stagedOutDir);
  const stagedSha = sha256File(path.join(stagedOutDir, FUSED_LIB_NAME));
  const reasons = [];
  if (!stagedSha) reasons.push(`staged ${FUSED_LIB_NAME} is missing`);
  if (!stamp) reasons.push("no build stamp (built by an older/raw cmake path)");
  if (stamp && stamp.forkCommit !== currentFork)
    reasons.push(
      `fork commit changed (${String(stamp.forkCommit).slice(0, 10)} → ${currentFork.slice(0, 10)})`,
    );
  if (stamp && (stamp.forkDirty || "") !== currentDirty)
    reasons.push("fork working tree changed (uncommitted source edits)");
  if (stamp && stagedSha && stamp.fusedSha256 !== stagedSha)
    reasons.push("staged lib hash != stamp (partial copy / tampered)");
  return reasons;
}

// `--check`: fast staleness probe — no build. Exit 0 = the staged fused lib
// matches the current fork; exit 2 = stale. Build/deploy flows call this to
// fail-fast (or trigger a rebuild) before shipping to a device.
if (check) {
  const reasons = stagedStalenessReasons();
  if (reasons.length) {
    console.error(
      `[stage-desktop-fused-lib] STALE: ${reasons.join("; ")}.\n` +
        "  Rebuild: bun run --cwd packages/app-core build:fused-desktop",
    );
    process.exit(2);
  }
  log(
    `FRESH: staged libelizainference matches fork ${currentFork.slice(0, 10)}${currentDirty ? " (+local edits)" : ""}.`,
  );
  process.exit(0);
}

// `--ensure`: the build/deploy entry point — fast when the staged lib already
// matches the current fork (skip the build), rebuild + re-stage when stale.
// This is what guarantees "no stale native lib reaches a device": every build
// that runs this either confirms freshness or produces a matching lib.
if (ensure) {
  const reasons = stagedStalenessReasons();
  if (!reasons.length) {
    log(
      `up to date — staged libelizainference matches fork ${currentFork.slice(0, 10)}; skipping rebuild.`,
    );
    process.exit(0);
  }
  log(`rebuilding — staged lib is stale: ${reasons.join("; ")}`);
  // fall through to the full build below.
}

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
const outDir = stagedOutDir;

// Self-healing clean rebuild: if the existing build dir was produced from a
// DIFFERENT fork commit / working tree than we have now, an incremental cmake
// can silently keep stale objects (git can restore fork sources with rewound
// mtimes on a submodule update). Wipe it so the produced lib always matches the
// current source — the guarantee "no stale native lib reaches a device".
const priorBuildStamp = readStamp(buildDir);
const forkChanged =
  priorBuildStamp &&
  (priorBuildStamp.forkCommit !== currentFork ||
    (priorBuildStamp.forkDirty || "") !== currentDirty);
if ((force || forkChanged) && existsSync(buildDir)) {
  if (forkChanged && !force) {
    log(
      `fork changed since last build (${String(priorBuildStamp.forkCommit).slice(0, 10)} → ${currentFork.slice(0, 10)}) — clean rebuild to avoid stale objects`,
    );
  }
  removePathRecursive(buildDir);
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
// `elizainference` SHARED target (TTS + local ASR + Kokoro). GGML_NATIVE=ON tunes
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

// Honesty check: warn loudly when the staged Kokoro lib has no espeak G2P (the
// TS layer supplies IPA — #11776 — so this is informational, not fatal).
warnIfEspeakless();

// Stamp the staged set with the fork fingerprint + the staged fused-lib sha256.
// `--check` reads this to fast-detect a stale staged lib, and the next build
// reads the buildDir copy to self-heal an incremental build from another commit.
const buildStamp = JSON.stringify(
  {
    forkCommit: currentFork,
    forkDirty: currentDirty,
    backend,
    fusedLib: fusedName,
    fusedSha256: sha256File(path.join(outDir, fusedName)),
    builtAt: new Date().toISOString(),
  },
  null,
  2,
);
writeFileSync(path.join(outDir, STAMP_FILE), buildStamp);
writeFileSync(path.join(buildDir, STAMP_FILE), buildStamp);
log(
  `stamped build → fork ${currentFork.slice(0, 10)}${currentDirty ? " (+local edits)" : ""}`,
);

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

// True when the host has libespeak-ng dev files where CMake looks for them.
// Mirrors tools/kokoro/CMakeLists.txt find_path/find_library (same prefixes +
// KOKORO_ESPEAK_ROOT). When false, the fused kokoro build silently linked NO
// espeak — its raw-text G2P is the lossy ASCII grapheme fallback.
function hostHasEspeakNg() {
  const roots = [
    process.env.KOKORO_ESPEAK_ROOT,
    "/opt/homebrew",
    "/usr/local",
    "/usr",
  ].filter(Boolean);
  const libNames =
    process.platform === "win32"
      ? ["espeak-ng.lib", "libespeak-ng.lib"]
      : process.platform === "darwin"
        ? ["libespeak-ng.dylib", "libespeak-ng.a"]
        : ["libespeak-ng.so", "libespeak-ng.a"];
  return roots.some((root) => {
    const hasHeader = existsSync(
      path.join(root, "include", "espeak-ng", "speak_lib.h"),
    );
    const hasLib = ["lib", "lib64"].some((d) =>
      libNames.some((n) => existsSync(path.join(root, d, n))),
    );
    return hasHeader && hasLib;
  });
}

// Loud, non-fatal notice when the staged Kokoro lib has no espeak G2P. Since
// ABI v14 (#11776) the TS runtime feeds espeak-ng-WASM IPA through
// eliza_inference_kokoro_synthesize_ipa, so an espeak-less lib stays
// intelligible — but the operator should know the host is missing the dev files
// (the old failure mode was silent garbled desktop TTS).
function warnIfEspeakless() {
  if (hostHasEspeakNg()) {
    log(
      "Kokoro G2P: libespeak-ng found on host — fused lib links real espeak.",
    );
    return;
  }
  log("");
  log(
    "WARNING: no libespeak-ng dev files on this host — the staged Kokoro lib was",
  );
  log(
    "  built WITHOUT espeak (g2p_kind = ASCII). Its internal raw-text path is the",
  );
  log(
    "  lossy grapheme fallback (unintelligible on its own). This is OK: the TS",
  );
  log(
    "  Kokoro runtime detects g2p=ascii and feeds espeak-ng-WASM IPA through",
  );
  log("  eliza_inference_kokoro_synthesize_ipa (#11776), so desktop TTS stays");
  log(
    "  intelligible. Install libespeak-ng-dev (macOS: `brew install espeak-ng`;",
  );
  log(
    "  Debian/Ubuntu: `apt-get install libespeak-ng-dev`) to link real G2P in.",
  );
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
