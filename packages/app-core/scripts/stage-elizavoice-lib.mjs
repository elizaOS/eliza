#!/usr/bin/env node
// stage-elizavoice-lib.mjs
//
// Phase 3a: cross-build the fused fork voice library
// (`libelizainference.so` — the omnivoice `elizainference` target with VAD,
// wake-word, speaker, and diarizer fused at ABI v7) for Android arm64-v8a
// with the NDK (BIONIC, not musl/zig), and stage the stripped .so into the
// app's jniLibs so the externalNativeBuild JNI shim (libelizavoicejni.so) can
// link it and the APK packages it.
//
// The build statically links ggml/llama/mtmd into libelizainference.so so the
// resulting .so has NO external NEEDED deps beyond bionic libc/libm/libdl —
// zero SONAME collision with the existing musl jniLibs (libeliza_bun.so etc).
//
// Two variants:
//   --variant cpu     (default) static-fused libelizainference.so, CPU only.
//   --variant vulkan  dynamic build: libelizainference.so + its ggml/llama/mtmd
//                     shared backends incl. libggml-vulkan.so. The GPU backend
//                     dlopens the device's libvulkan at runtime — the path the
//                     bionic app process can take but the musl agent cannot.
//                     Device-proven on Pixel 9a (Mali-G715), ~15 tok/s warm.
//
// Usage:
//   node packages/app-core/scripts/stage-elizavoice-lib.mjs [--abi arm64-v8a] [--variant cpu|vulkan]
//
// Env:
//   ANDROID_HOME / ANDROID_SDK_ROOT  Android SDK root (NDK under ndk/<version>)
//   ELIZA_NDK_VERSION                NDK version dir (default: highest installed)
//   (vulkan variant only — host shader tooling, auto-discovered, env overrides win)
//   ELIZA_GLSLC                      glslc (default: NDK shader-tools)
//   ELIZA_SPIRV_HEADERS_DIR          SPIRV-Headers lib/cmake/SPIRV-Headers dir
//   ELIZA_VULKAN_INCLUDE_DIR         Vulkan-Headers include dir (vulkan/, vk_video/, spirv/)
//
// Output:
//   packages/app-core/platforms/android/app/src/main/jniLibs/<abi>/libelizainference.so
//   (+ the ggml/llama/mtmd sibling .so for --variant vulkan)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { androidArm64SimdCmakeFlags } from "./build-helpers/arm64-simd.mjs";
import { assertVulkanMaliMitigation } from "./build-helpers/verify-fused-symbols.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> app-core -> packages -> eliza repo root
const repoRoot = path.resolve(__dirname, "../../..");

function log(msg) {
  process.stdout.write(`[stage-elizavoice-lib] ${msg}\n`);
}

function die(msg) {
  process.stderr.write(`[stage-elizavoice-lib] ERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { abi: "arm64-v8a", variant: "cpu" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--abi") out.abi = argv[++i];
    else if (argv[i] === "--variant") out.variant = argv[++i];
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
function resolveVulkanHostTooling(ndk) {
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
    firstExisting([
      "/tmp/spirv-headers-install/lib/cmake/SPIRV-Headers",
      "/home/shaw/aosp/external/shaderc/spirv-headers",
    ]);
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
      "toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/31/libvulkan.so",
    ),
  ]);

  return { glslc, spirvHeadersDir, vulkanIncludeDir, vulkanLib };
}

const ABI_TO_PLATFORM = {
  "arm64-v8a": "android-23",
};

function resolveSdk() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !existsSync(sdk)) {
    die("ANDROID_HOME / ANDROID_SDK_ROOT not set or missing");
  }
  return sdk;
}

function resolveNdk(sdk) {
  if (process.env.ELIZA_NDK_VERSION) {
    const p = path.join(sdk, "ndk", process.env.ELIZA_NDK_VERSION);
    if (!existsSync(p))
      die(
        `ELIZA_NDK_VERSION ${process.env.ELIZA_NDK_VERSION} not found under ${path.join(sdk, "ndk")}`,
      );
    return p;
  }
  const ndkRoot = path.join(sdk, "ndk");
  if (!existsSync(ndkRoot)) die(`No NDK under ${ndkRoot}`);
  const versions = readdirSync(ndkRoot)
    .filter((d) => statSync(path.join(ndkRoot, d)).isDirectory())
    .sort();
  if (versions.length === 0) die(`No NDK versions under ${ndkRoot}`);
  return path.join(ndkRoot, versions[versions.length - 1]);
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

const { abi, variant } = parseArgs(process.argv.slice(2));
const platform = ABI_TO_PLATFORM[abi];
if (!platform) die(`unsupported abi ${abi} (Phase 3a: arm64-v8a only)`);
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
// LLM+ASR+voice stack but run it scalar. Pin armv8.2-a+dotprod+fp16 (no i8mm — SIGILLs pre-v8.6 cores, see arm64-simd.mjs) and
// flip the QJL dispatch define (build-helpers/arm64-simd.mjs). The voice
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
// LLAMA_BUILD_KOKORO=ON folds kokoro_lib (Kokoro-82M TTS, ABI v10) into the
// fused libelizainference.so. With LLAMA_BUILD_TOOLS=OFF the fork's root
// CMakeLists embed-as-library hook (`LLAMA_BUILD_KOKORO AND NOT (COMMON AND
// TOOLS)`) adds tools/kokoro BEFORE tools/omnivoice, so the `if(TARGET
// kokoro_lib)` fold in tools/omnivoice/CMakeLists.txt resolves and
// elizainference exports the eliza_inference_kokoro_* surface. This is the
// device-proven path: on a real Pixel (arm64/bionic) the staged .so reports
// eliza_inference_abi_version()=="10", kokoro_supported()==1, and synthesizes
// PCM on-device with only libc/libm/libdl NEEDED.
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
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
  ...arm64SimdFlags,
  "-DLLAMA_BUILD_OMNIVOICE=ON",
  "-DLLAMA_BUILD_KOKORO=ON",
  "-DLLAMA_BUILD_COMMON=ON",
  "-DLLAMA_BUILD_EXAMPLES=OFF",
  "-DLLAMA_BUILD_TESTS=OFF",
  "-DLLAMA_BUILD_SERVER=OFF",
  "-DLLAMA_CURL=OFF",
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
  const vk = resolveVulkanHostTooling(ndk);
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

let jobs = 4;
try {
  jobs = parseInt(execFileSync("nproc", { encoding: "utf8" }).trim(), 10) || 4;
} catch {
  jobs = 4;
}
run("cmake", [
  "--build",
  buildDir,
  "--target",
  "elizainference",
  "-j",
  String(jobs),
]);

const binDir = path.join(buildDir, "bin");
const builtSo = path.join(binDir, "libelizainference.so");
if (!existsSync(builtSo)) die(`build did not produce ${builtSo}`);

const strip = ndkTool(ndk, "llvm-strip");
const jniDir = path.join(
  repoRoot,
  "packages/app-core/platforms/android/app/src/main/jniLibs",
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

// Verify the engine .so is bionic arm64, exports the FFI symbols, and has no
// musl deps. For the Vulkan variant its backends are NEEDED siblings (resolved
// in-process), not musl — but libvulkan resolves from the device at runtime.
const readelf = ndkTool(ndk, "llvm-readelf");
const engineSo = path.join(jniDir, "libelizainference.so");
const dyn = execFileSync(readelf, ["--dyn-syms", engineSo], {
  encoding: "utf8",
});
const symCount = (dyn.match(/eliza_inference_/g) || []).length;
const needed = execFileSync(readelf, ["-d", engineSo], { encoding: "utf8" })
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
  // path (compile-libllama.mjs) already gates via verify-fused-symbols; this
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
