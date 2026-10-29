#!/usr/bin/env node
/**
 * Cross-builds the fused inference library for Android arm64-v8a and x86_64
 * with NDK 28.2 and stages it into the app's jniLibs (or --out). Speech is
 * Paradee-8M TTS with native misaki G2P (eSpeak NG 1.52.0 as the
 * out-of-lexicon fallback), Parakeet-TDT ASR (Phonon-2, batch and streaming)
 * and VAD; no Kokoro voice ships. The
 * CPU variant statically links ggml/llama/mtmd; the Vulkan variant stages
 * their shared backends and requires host shader tooling supplied by the
 * documented ELIZA_* overrides. Every library is 16 KiB page aligned.
 *
 *   node packages/app/scripts/stage-elizavoice-lib.ts --abi arm64-v8a|x86_64 \
 *     [--variant cpu|vulkan] [--out <dir>] [--espeak-dir <dir>]
 *
 * --espeak-dir holds the eSpeak NG build (reused when it matches the pin in
 * the fork's tools/misaki-g2p/pins.json): <abi>/include, <abi>/lib and the
 * compiled English data in data/espeak-ng-data.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { androidArm64SimdCmakeFlags } from "./build-helpers/arm64-simd.ts";
import {
  assertAndroidVoiceLibrary,
  assertVulkanMaliMitigation,
} from "./build-helpers/verify-fused-symbols.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> app -> packages -> eliza repo root
const repoRoot = path.resolve(__dirname, "../../..");

function log(msg) {
  process.stdout.write(`[stage-elizavoice-lib] ${msg}\n`);
}

function die(msg) {
  process.stderr.write(`[stage-elizavoice-lib] ERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { abi: "arm64-v8a", variant: "cpu", out: "", espeakDir: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--abi") out.abi = argv[++i];
    else if (argv[i] === "--variant") out.variant = argv[++i];
    else if (argv[i] === "--out") out.out = path.resolve(argv[++i]);
    else if (argv[i] === "--espeak-dir")
      out.espeakDir = path.resolve(argv[++i]);
    else die(`unknown argument ${argv[i]}`);
  }
  if (out.variant !== "cpu" && out.variant !== "vulkan") {
    die(`unsupported --variant ${out.variant} (cpu | vulkan)`);
  }
  return out;
}

// The vulkan variant cross-compiles ggml's GLSL compute shaders to SPIR-V with
// a HOST-built vulkan-shaders-gen, which needs glslc + the Vulkan/SPIRV headers
// on the build machine. These are not vendored in the fork; discover the proven
// locations (env overrides win) and fail loudly with what to provide.
function resolveVulkanHostTooling(ndk, abi) {
  const firstExisting = (cands) => cands.find((p) => p && existsSync(p));

  const glslc =
    process.env.ELIZA_GLSLC ||
    firstExisting([
      path.join(ndk, "shader-tools", "linux-x86_64", "glslc"),
      path.join(ndk, "shader-tools", "darwin-x86_64", "glslc"),
    ]);
  if (!glslc) {
    die(
      "glslc not found (set ELIZA_GLSLC) — install the NDK shader-tools " +
        `(expected under ${path.join(ndk, "shader-tools")})`,
    );
  }

  const spirvHeadersDir =
    process.env.ELIZA_SPIRV_HEADERS_DIR ||
    firstExisting(["/tmp/spirv-headers-install/lib/cmake/SPIRV-Headers"]);
  if (!spirvHeadersDir) {
    die(
      "SPIRV-Headers cmake dir not found (set ELIZA_SPIRV_HEADERS_DIR) — clone " +
        "KhronosGroup/SPIRV-Headers and `cmake --install` it (need the " +
        "lib/cmake/SPIRV-Headers config dir).",
    );
  }

  const vulkanIncludeDir =
    process.env.ELIZA_VULKAN_INCLUDE_DIR ||
    firstExisting([
      path.join(
        process.env.HOME || "",
        ".cache/eliza-android-agent/llama-cpp-v1.2.0-eliza/vulkan-headers",
      ),
    ]);
  if (!vulkanIncludeDir) {
    die(
      "Vulkan headers dir not found (set ELIZA_VULKAN_INCLUDE_DIR) — provide a " +
        "KhronosGroup/Vulkan-Headers include dir (with vulkan/, vk_video/, spirv/).",
    );
  }

  const vulkanLib = firstExisting([
    path.join(
      ndk,
      `toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/${abi === "x86_64" ? "x86_64" : "aarch64"}-linux-android/31/libvulkan.so`,
    ),
  ]);

  return { glslc, spirvHeadersDir, vulkanIncludeDir, vulkanLib };
}

const ABI_TO_PLATFORM = {
  "arm64-v8a": "android-23",
  x86_64: "android-23",
};

function resolveSdk() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !existsSync(sdk)) {
    die("ANDROID_HOME / ANDROID_SDK_ROOT not set or missing");
  }
  return sdk;
}

// The app and the paradee-voice library build their JNI bridge with this NDK
// (build.gradle ndkVersion); the staged libc++_shared.so must come from it too.
const DEFAULT_NDK_VERSION = "28.2.13676358";

function resolveNdk(sdk) {
  const version = process.env.ELIZA_NDK_VERSION || DEFAULT_NDK_VERSION;
  const p = path.join(sdk, "ndk", version);
  if (!existsSync(p)) {
    die(
      `NDK ${version} not found under ${path.join(sdk, "ndk")} (set ELIZA_NDK_VERSION to override)`,
    );
  }
  return p;
}

function ndkTool(ndk, name) {
  const prebuilt = path.join(ndk, "toolchains", "llvm", "prebuilt");
  const hosts = readdirSync(prebuilt);
  for (const host of hosts) {
    const bin = path.join(prebuilt, host, "bin", name);
    if (existsSync(bin)) return bin;
  }
  die(`NDK tool ${name} not found under ${prebuilt}`);
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Size of libespeak-ng's data-path buffer (`path_home`, N_PATH_HOME). The
 * upstream POSIX default is 160 bytes, which limits the eSpeak NG data
 * directory to about 135 bytes once libespeak-ng appends `/espeak-ng-data`;
 * on-device bundle paths can be longer. Every eSpeak buffer that holds a data
 * path is sized from it, so raising it is safe. The fused library rejects a
 * path that does not fit instead of truncating it (elizaOS/llama.cpp
 * tools/espeak-shared).
 */
const ESPEAK_PATH_HOME = 1024;

function espeakCmakeFlags() {
  // Only the phonemizer is used: no audio output, sonic, MBROLA or synthesizers.
  return [
    // -DCMAKE_C_FLAGS keeps the NDK toolchain's own flags; a CFLAGS
    // environment variable is ignored under the NDK toolchain.
    `-DCMAKE_C_FLAGS=-DN_PATH_HOME=${ESPEAK_PATH_HOME}`,
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DBUILD_TESTING=OFF",
    "-DUSE_ASYNC=OFF",
    "-DUSE_MBROLA=OFF",
    "-DUSE_LIBPCAUDIO=OFF",
    "-DPCAUDIO_LIB=PCAUDIO_LIB-NOTFOUND",
    // Setting the sonic paths stops deps.cmake from cloning sonic at configure time.
    "-DUSE_LIBSONIC=OFF",
    "-DSONIC_LIB=UNUSED",
    "-DSONIC_INC=UNUSED",
  ];
}

/**
 * Builds eSpeak NG at the fork's pinned version (tools/misaki-g2p/pins.json)
 * into `dir`: the static phonemizer for `abi` under <abi>/{include,lib}
 * (libespeak-ng.a with libucd folded in), the
 * compiled data the pin lists (English, and Spanish for the Delibes voice)
 * under data/espeak-ng-data and the GPL notice as COPYING. misaki G2P uses the
 * English data only for words outside its lexicon; the Spanish voice's G2P is
 * eSpeak NG itself. A build that matches the pin is reused.
 */
async function ensureEspeakNg({ dir, abi, ndk, forkSrc }) {
  const pins = JSON.parse(
    readFileSync(path.join(forkSrc, "tools/misaki-g2p/pins.json"), "utf8"),
  );
  const pin = pins.espeak_ng;
  if (!pin?.sha256 || !pin.url || !Array.isArray(pin.data)) {
    die("fork tools/misaki-g2p/pins.json has no espeak_ng pin");
  }
  const stamp = path.join(dir, abi, "pin.sha256");
  // The stamp names the build options too, so an older build (160-byte
  // N_PATH_HOME) is rebuilt.
  const stampValue = `${pin.sha256} N_PATH_HOME=${ESPEAK_PATH_HOME}`;
  // Reuse needs the compiled data too: a pin that adds a language (es_dict)
  // keeps the same archive and library stamp.
  const dataReady = pin.data.every((relative) =>
    existsSync(path.join(dir, "data", "espeak-ng-data", relative)),
  );
  if (
    dataReady &&
    existsSync(stamp) &&
    readFileSync(stamp, "utf8").trim() === stampValue
  ) {
    log(`eSpeak NG ${pin.version} for ${abi}: reusing ${path.join(dir, abi)}`);
    return path.join(dir, abi);
  }
  const archive = path.join(
    dir,
    "downloads",
    `espeak-ng-${pin.version}.tar.gz`,
  );
  if (!existsSync(archive) || sha256File(archive) !== pin.sha256) {
    mkdirSync(path.dirname(archive), { recursive: true });
    log(`fetch ${pin.url}`);
    const response = await fetch(pin.url, { redirect: "follow" });
    if (!response.ok) die(`${pin.url} returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== pin.bytes || digest !== pin.sha256) {
      die(
        `${pin.url} is ${bytes.length} bytes sha256 ${digest}; expected ${pin.bytes} ${pin.sha256}`,
      );
    }
    writeFileSync(`${archive}.partial`, bytes);
    renameSync(`${archive}.partial`, archive);
  }
  const source = path.join(dir, `espeak-ng-${pin.version}`);
  if (!existsSync(path.join(source, "CMakeLists.txt"))) {
    run("tar", ["-xzf", archive, "-C", dir]);
  }

  // The data compiler runs on the build host; the compiled data is ABI independent.
  const dataOut = path.join(dir, "data", "espeak-ng-data");
  if (!pin.data.every((relative) => existsSync(path.join(dataOut, relative)))) {
    // The phoneme compiler truncates paths at 180 bytes, so build in a short
    // temporary directory.
    const hostBuild = mkdtempSync(path.join(os.tmpdir(), "espeak-host-"));
    run("cmake", ["-S", source, "-B", hostBuild, ...espeakCmakeFlags()]);
    run("ninja", [
      "-C",
      hostBuild,
      "espeak-ng-data/intonations",
      "espeak-ng-data/phondata",
      // every compiled dictionary the pin lists (en_dict, es_dict)
      ...pin.data
        .filter((relative) => relative.endsWith("_dict"))
        .map((relative) => `espeak-ng-data/${relative}`),
    ]);
    for (const relative of pin.data) {
      mkdirSync(path.dirname(path.join(dataOut, relative)), {
        recursive: true,
      });
      copyFileSync(
        path.join(hostBuild, "espeak-ng-data", relative),
        path.join(dataOut, relative),
      );
    }
    rmSync(hostBuild, { recursive: true, force: true });
  }
  copyFileSync(path.join(source, "COPYING"), path.join(dir, "COPYING"));

  const build = path.join(dir, `build-${abi}`);
  run("cmake", [
    "-S",
    source,
    "-B",
    build,
    ...espeakCmakeFlags(),
    `-DCMAKE_TOOLCHAIN_FILE=${path.join(ndk, "build/cmake/android.toolchain.cmake")}`,
    `-DANDROID_ABI=${abi}`,
    "-DANDROID_PLATFORM=android-26",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
    "-DUSE_KLATT=OFF",
    "-DUSE_SPEECHPLAYER=OFF",
  ]);
  run("ninja", ["-C", build, "espeak-ng"]);
  const prefix = path.join(dir, abi);
  mkdirSync(path.join(prefix, "include/espeak-ng"), { recursive: true });
  mkdirSync(path.join(prefix, "lib"), { recursive: true });
  for (const header of ["speak_lib.h", "espeak_ng.h", "encoding.h"]) {
    copyFileSync(
      path.join(source, "src/include/espeak-ng", header),
      path.join(prefix, "include/espeak-ng", header),
    );
  }
  // The static libespeak-ng.a needs libucd.a. Fold ucd into one archive so a
  // consumer that links `espeak-ng` alone (find_library) resolves it.
  const archiveOut = path.join(prefix, "lib/libespeak-ng.a");
  rmSync(archiveOut, { force: true });
  const ar = ndkTool(ndk, "llvm-ar");
  run(ar, [
    "qcL",
    archiveOut,
    path.join(build, "src/libespeak-ng/libespeak-ng.a"),
  ]);
  run(ar, ["qL", archiveOut, path.join(build, "src/ucd-tools/libucd.a")]);
  run(ar, ["s", archiveOut]);
  // path_home is a BSS array of N_PATH_HOME bytes: check the define reached
  // the library build.
  const pathHome = /^[0-9a-f]+ ([0-9a-f]+) [BbCc] path_home$/m.exec(
    execFileSync(ndkTool(ndk, "llvm-nm"), ["--print-size", archiveOut], {
      encoding: "utf8",
    }),
  );
  if (!pathHome || Number.parseInt(pathHome[1], 16) !== ESPEAK_PATH_HOME) {
    die(
      `${archiveOut}: libespeak-ng path_home is ${pathHome ? Number.parseInt(pathHome[1], 16) : "missing"} bytes; expected N_PATH_HOME=${ESPEAK_PATH_HOME}`,
    );
  }
  writeFileSync(stamp, `${stampValue}\n`);
  return prefix;
}

const {
  abi,
  variant,
  out: outDir,
  espeakDir: espeakArg,
} = parseArgs(process.argv.slice(2));
const platform = ABI_TO_PLATFORM[abi];
if (!platform) die(`unsupported abi ${abi} (arm64-v8a | x86_64)`);
log(`variant: ${variant}`);

const sdk = resolveSdk();
const ndk = resolveNdk(sdk);
const toolchain = path.join(ndk, "build", "cmake", "android.toolchain.cmake");
if (!existsSync(toolchain)) die(`NDK cmake toolchain missing: ${toolchain}`);
log(`NDK: ${ndk}`);

const forkSrc = path.join(
  repoRoot,
  "plugins/plugin-local-inference/native/llama.cpp",
);
if (!existsSync(path.join(forkSrc, "tools/omnivoice/CMakeLists.txt"))) {
  die(
    `fork omnivoice CMakeLists missing under ${forkSrc} — run git submodule update --init --recursive`,
  );
}

const buildDir = path.join(
  repoRoot,
  ".cache",
  "elizavoice-android",
  variant === "vulkan" ? `${abi}-vulkan` : abi,
);
mkdirSync(buildDir, { recursive: true });

// arm64 SIMD floor: GGML_NATIVE=OFF cross-builds to bare armv8-a, which leaves
// the LLM + ASR matmul/dot kernels (ggml dotprod/i8mm/fp16) AND the eliza QJL
// NEON-dotprod K-cache kernel dead — this fused .so would carry the full
// LLM+ASR+voice stack but run it scalar. Pin armv8.2-a+dotprod+fp16 (no i8mm — SIGILLs pre-v8.6 cores, see arm64-simd.ts) and
// flip the QJL dispatch define (build-helpers/arm64-simd.ts). The voice
// classifier forward graphs are tiny scalar C and unaffected; this lights up
// the heavy LLM/ASR paths the same lib carries.
const arm64SimdFlags = androidArm64SimdCmakeFlags(abi);
if (arm64SimdFlags.length > 0) {
  log(`arm64 SIMD floor: ${arm64SimdFlags.join(" ")}`);
}

// Configure: static-link ggml/llama/mtmd into the SHARED elizainference .so.
// LLAMA_BUILD_TOOLS=OFF + LLAMA_BUILD_MTMD=ON ensures the mtmd target exists
// before tools/omnivoice configures (the fork's top-level CMakeLists orders
// the mtmd embed hook before omnivoice so `if(TARGET mtmd)` is satisfied).
//
// Android speech is Paradee-8M (ABI v17): LLAMA_BUILD_PARADEE=ON and
// LLAMA_BUILD_MISAKI_G2P=ON add paradee_lib and misaki_g2p before
// tools/omnivoice, which folds both into elizainference (ELIZA_ENABLE_PARADEE).
// Paradee runs on the tools/kokoro layers, so kokoro_lib is still compiled;
// Android ships no Kokoro model, its JNI exposes no Kokoro natives, and
// Kokoro's own eSpeak link is off. misaki links the pinned eSpeak NG
// phonemizer (GPL-3.0-or-later) as its out-of-lexicon fallback; the
// MISAKI_ESPEAK_* cache entries name it directly because the NDK toolchain
// confines find_library to the sysroot. assertAndroidVoiceLibrary below reads
// paradee_supported() and asr_supported() from the built code and requires
// both to return 1.
//
// ASR: LLAMA_BUILD_PARAKEET=ON adds parakeet_lib, which omnivoice folds into
// elizainference (ELIZA_ENABLE_PARAKEET). mmap_acquire("asr") then serves the
// eliza_inference_asr_* surface, including asr_stream_*, from a parakeet-tdt
// GGUF under <bundle>/asr/ (Phonon-2, the only mobile ASR).
// ELIZA_ASR_THREADS sets decode threads.
// The parakeet kernels pick dotprod/i8mm (arm64) or AVX2 (x86_64) at runtime
// and compile those files with their own target flags, so the SIMD floor
// above is unchanged.
const espeakPrefix = await ensureEspeakNg({
  dir:
    espeakArg ||
    path.join(repoRoot, ".cache", "elizavoice-android", "espeak-ng"),
  abi,
  ndk,
  forkSrc,
});
const baseConfigure = [
  "-S",
  forkSrc,
  "-B",
  buildDir,
  "-G",
  "Ninja",
  `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
  `-DANDROID_ABI=${abi}`,
  `-DANDROID_PLATFORM=${platform}`,
  "-DANDROID_STL=c++_shared",
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
  ...arm64SimdFlags,
  // 16 KiB page alignment for Android 15+ devices.
  "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384",
  "-DLLAMA_BUILD_OMNIVOICE=ON",
  "-DLLAMA_BUILD_KOKORO=ON",
  "-DKOKORO_ENABLE_ESPEAK=OFF",
  "-DLLAMA_BUILD_PARADEE=ON",
  "-DLLAMA_BUILD_MISAKI_G2P=ON",
  "-DLLAMA_BUILD_PARAKEET=ON",
  "-DMISAKI_G2P_ESPEAK=ON",
  `-DMISAKI_ESPEAK_INCLUDE_DIR=${path.join(espeakPrefix, "include")}`,
  `-DMISAKI_ESPEAK_LIBRARY=${path.join(espeakPrefix, "lib", "libespeak-ng.a")}`,
  // Android exposes still-image decoding, not the ffmpeg subprocess video helper.
  // The latter requires posix_spawn (API 28); retain the existing API floor.
  "-DMTMD_VIDEO=OFF",
  "-DLLAMA_BUILD_COMMON=ON",
  "-DLLAMA_BUILD_EXAMPLES=OFF",
  "-DLLAMA_BUILD_TESTS=OFF",
  "-DLLAMA_BUILD_SERVER=OFF",
  "-DLLAMA_CURL=OFF",
  // Video shells out to FFmpeg through posix_spawn (Android API 28+).
  // This mobile library supports older APIs and only embeds audio/image mtmd.
  "-DMTMD_VIDEO=OFF",
];

if (variant === "cpu") {
  // CPU-static-fused: ggml/llama/mtmd folded into the single shared
  // libelizainference.so (no external NEEDED beyond bionic libc/libm/libdl).
  run("cmake", [
    ...baseConfigure,
    "-DBUILD_SHARED_LIBS=OFF",
    "-DLLAMA_BUILD_MTMD=ON",
    "-DLLAMA_BUILD_TOOLS=OFF",
  ]);
} else {
  // Dynamic-Vulkan: BUILD_SHARED_LIBS=ON keeps the GPU backend in its own
  // libggml-vulkan.so so it can dlopen the device's libvulkan at runtime — the
  // path only the bionic app process can take (never the musl agent). The CPU
  // static-fuse can't carry ggml-vulkan (zig-musl static link gap on the shader
  // glue), so this variant ships the sibling .so set instead. Shaders are
  // cross-compiled to SPIR-V by a host vulkan-shaders-gen (needs glslc + the
  // Vulkan/SPIRV headers — see resolveVulkanHostTooling).
  const vk = resolveVulkanHostTooling(ndk, abi);
  log(`vulkan glslc: ${vk.glslc}`);
  log(`vulkan SPIRV-Headers: ${vk.spirvHeadersDir}`);
  log(`vulkan headers: ${vk.vulkanIncludeDir}`);
  run("cmake", [
    ...baseConfigure,
    "-DBUILD_SHARED_LIBS=ON",
    "-DGGML_VULKAN=ON",
    `-DVulkan_GLSLC_EXECUTABLE=${vk.glslc}`,
    `-DVulkan_INCLUDE_DIR=${vk.vulkanIncludeDir}`,
    ...(vk.vulkanLib ? [`-DVulkan_LIBRARY=${vk.vulkanLib}`] : []),
    `-DSPIRV-Headers_DIR=${vk.spirvHeadersDir}`,
    // The NDK toolchain restricts find_package to the sysroot; BOTH lets cmake
    // see the host-installed SPIRV-Headers config.
    "-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH",
  ]);
}

const jobs = os.availableParallelism();
run("cmake", [
  "--build",
  buildDir,
  "--target",
  "elizainference",
  "-j",
  String(process.env.CMAKE_BUILD_PARALLEL_LEVEL || jobs),
]);

const binDir = path.join(buildDir, "bin");
const builtSo = path.join(binDir, "libelizainference.so");
if (!existsSync(builtSo)) die(`build did not produce ${builtSo}`);

const strip = ndkTool(ndk, "llvm-strip");
// Gate the built library before staging: ABI >= 17, Paradee and ASR probes
// return 1, 16 KiB LOAD alignment. It cannot run on this host, so the probe
// values are read from its machine code.
const voiceReport = assertAndroidVoiceLibrary({
  lib: builtSo,
  objdump: ndkTool(ndk, "llvm-objdump"),
  nm: ndkTool(ndk, "llvm-nm"),
});
// The eSpeak fallback is static and hidden; the unstripped symbol table shows
// whether misaki linked it.
const builtSymbols = execFileSync(ndkTool(ndk, "llvm-nm"), [builtSo], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
if (!/\bespeak_TextToPhonemes\b/.test(builtSymbols)) {
  die(
    `${builtSo} does not link eSpeak NG; misaki would spell out words outside its lexicon`,
  );
}
// parakeet_lib is static and hidden too; without it asr_stream_supported()
// stays 0 and the bundle's Phonon-2 GGUF could not load.
for (const symbol of ["pk_model_load", "pk_stream_open"]) {
  if (!new RegExp(`\\b${symbol}\\b`).test(builtSymbols)) {
    die(
      `${builtSo} does not link parakeet_lib (${symbol}); configure with -DLLAMA_BUILD_PARAKEET=ON`,
    );
  }
}
log(
  `voice ABI ${voiceReport.abiVersion}: ${Object.entries(voiceReport.probes)
    .map(([probe, value]) => `${probe}()=${value}`)
    .join(", ")}, LOAD align ${voiceReport.loadAlignment}`,
);
// --out stages into another consumer, such as the paradee-voice library.
const jniDir =
  outDir ||
  path.join(
    repoRoot,
    "packages/app/platforms/android/app/src/main/jniLibs",
    abi,
  );
mkdirSync(jniDir, { recursive: true });

// The dynamic-Vulkan variant emits libelizainference.so plus its shared
// backends; the CPU variant folds them all in, so it stages only the one .so.
// Keep the lists mutually exclusive: when staging CPU, sweep any stale Vulkan
// siblings so the loader never sees a half-swapped set, and vice-versa.
const VULKAN_SIBLINGS = [
  "libelizainference.so",
  "libggml.so",
  "libggml-base.so",
  "libggml-cpu.so",
  "libggml-vulkan.so",
  "libllama.so",
  "libllama-common.so",
  "libmtmd.so",
];
const SIBLINGS_TO_CLEAN = VULKAN_SIBLINGS.filter(
  (n) => n !== "libelizainference.so",
);

const toStage =
  variant === "vulkan" ? VULKAN_SIBLINGS : ["libelizainference.so"];
if (variant === "cpu") {
  for (const sib of SIBLINGS_TO_CLEAN) {
    const stale = path.join(jniDir, sib);
    if (existsSync(stale)) {
      rmSync(stale);
      log(
        `removed stale Vulkan sibling ${sib} (CPU variant is self-contained)`,
      );
    }
  }
}

// Gate the BUILT artifacts before anything touches the shipping jniLibs dir:
// running the Mali check only after staging (as before) left the rejected
// libggml-vulkan.so already copied over a previously-good set on a red run,
// where a later gradle build that skips this script would package it.
if (variant === "vulkan") {
  assertVulkanMaliMitigation({
    lib: path.join(binDir, "libelizainference.so"),
    target: `android-${abi}-vulkan`,
  });
}

const staged = [];
for (const name of toStage) {
  const src = path.join(binDir, name);
  if (!existsSync(src)) {
    die(`${variant} build did not produce ${name} (expected in ${binDir})`);
  }
  const dst = path.join(jniDir, name);
  run(strip, ["--strip-unneeded", src, "-o", dst]);
  staged.push(dst);
}

// Every shared native component uses the same C++ runtime. Multiple static
// libc++ copies can disagree on locale/type state during backend initialization.
const cxxRuntime = path.join(
  ndk,
  "toolchains/llvm/prebuilt",
  process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64",
  "sysroot/usr/lib",
  abi === "x86_64" ? "x86_64-linux-android" : "aarch64-linux-android",
  "libc++_shared.so",
);
const stagedCxxRuntime = path.join(jniDir, "libc++_shared.so");
run(strip, ["--strip-unneeded", cxxRuntime, "-o", stagedCxxRuntime]);
staged.push(stagedCxxRuntime);

// Verify the engine .so is bionic arm64, exports the FFI symbols, and has no
// musl deps. For the Vulkan variant its backends are NEEDED siblings (resolved
// in-process), not musl — but libvulkan resolves from the device at runtime.
const readelf = ndkTool(ndk, "llvm-readelf");
const nm = ndkTool(ndk, "llvm-nm");
const engineSo = path.join(jniDir, "libelizainference.so");
const symCountFile = path.join(buildDir, "eliza-inference-symbol-count.txt");
const dynamicFile = path.join(buildDir, "eliza-inference-dynamic.txt");
function captureToolOutput(command, args, outputFile) {
  log(`$ ${command} ${args.join(" ")} > ${outputFile}`);
  const outputFd = openSync(outputFile, "w");
  try {
    execFileSync(command, args, {
      stdio: ["ignore", outputFd, "inherit"],
    });
  } finally {
    closeSync(outputFd);
  }
}
captureToolOutput(nm, ["-D", "--defined-only", engineSo], symCountFile);
captureToolOutput(readelf, ["-d", engineSo], dynamicFile);
const symCount = (
  readFileSync(symCountFile, "utf8").match(/eliza_inference_/g) || []
).length;
const needed = readFileSync(dynamicFile, "utf8")
  .split("\n")
  .filter((l) => l.includes("NEEDED"))
  .map((l) => (l.match(/\[([^\]]+)\]/) || [])[1])
  .filter(Boolean);
const muslNeeded = needed.filter((n) => /musl/i.test(n));
if (symCount === 0) die("staged .so exports no eliza_inference_* symbols");
if (muslNeeded.length > 0)
  die(`staged .so has musl NEEDED deps: ${muslNeeded.join(", ")}`);

if (variant === "vulkan") {
  const vulkanSo = path.join(jniDir, "libggml-vulkan.so");
  if (!existsSync(vulkanSo)) die("vulkan variant missing libggml-vulkan.so");
  // Fail-closed Mali flash-attn gate (#9508) on what actually ships: a
  // libggml-vulkan.so staged into jniLibs without the VK_VENDOR_ID_ARM
  // disable_subgroups mitigation SIGABRTs mid-decode on Mali. The CI build
  // path (compile-libllama.ts) already gates via verify-fused-symbols; this
  // closes the bypass where stage-elizavoice-lib populated the APK from a
  // stale submodule working tree (observed 2026-06-24: mitigated gitlink,
  // zero-marker staged lib).
  assertVulkanMaliMitigation({
    lib: engineSo,
    target: `android-${abi}-vulkan`,
  });
  log(`staged ${staged.length} libs (dynamic-Vulkan):`);
  for (const s of staged) log(`  ${path.basename(s)}`);
} else {
  log(`staged ${engineSo}`);
}
log(`  eliza_inference_* exported symbols: ${symCount}`);
log(`  NEEDED (bionic): ${needed.join(", ")}`);
log("done");
