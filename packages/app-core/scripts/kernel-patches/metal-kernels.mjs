// Real Metal kernel-shipment helpers — replace the v0.4.0-milady decorative
// log no-ops in build-llama-cpp-dflash.mjs.
//
// What this module does:
//
//   1. Copies the five verified standalone Metal shaders from
//      packages/inference/metal/ into the fork's tree at
//      ggml/src/ggml-metal/milady-shipped/<kernel>.metal. The standalones are
//      self-contained TUs (only #include <metal_stdlib>; their own structs,
//      constants, kernel symbols), so they compile as independent .air files.
//
//   2. Patches ggml/src/ggml-metal/CMakeLists.txt so the non-EMBED_LIBRARY
//      branch (the one used by darwin host metal builds) builds each standalone
//      shader into its own .air via `xcrun metal -c` and merges all
//      .air files (the original ggml-metal.air plus the five milady .air files)
//      into default.metallib via a single `xcrun metallib` invocation.
//
//   The original CMake snippet pipes `xcrun metal | xcrun metallib`. We
//   replace that with explicit per-source compilation + a final merge step,
//   keyed by a `# MILADY-KERNEL-PATCH-V1` sentinel so the patch is idempotent.
//
//   3. Hard-throws on any error — missing files, missing anchor in
//      CMakeLists.txt, fs failures. Per AGENTS.md §3, the build must exit
//      non-zero rather than silently produce a kernel-missing artifact.
//
// What this module deliberately does NOT do (out of scope for v0.4.0-milady):
//
//   * Wire dispatch sites in ggml-metal-ops.cpp / ggml-metal-device.m. The
//     fork has zero existing dispatch entries for the milady quant types in
//     the Metal backend (CUDA has them; Metal does not). Adding dispatch
//     requires substantial fork-internals changes spanning case-statements
//     per `GGML_TYPE_*`. Once kernels are in the metallib, follow-up work
//     can add the dispatch wiring and the kernels become reachable. Until
//     then the kernels ship as live symbols inside default.metallib but are
//     not yet selected by the runtime — the symbol-presence audit (`nm`,
//     `strings default.metallib`) passes, the dispatch audit does not.
//
//   * EMBED_LIBRARY path used by iOS targets. iOS builds compile a single
//     concatenated .metal via `.incbin`, which would require stripping the
//     duplicate decls (`block_qjl1_256`, `block_q4_polar`, `QK_QJL`,
//     `QK_POLAR`, `QJL_RESIDUAL_BYTES` already in ggml-common.h). That is a
//     separate patch and is documented as a deferred gap.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// packages/app-core/scripts/kernel-patches/  →  packages/inference/metal/
const STANDALONE_METAL_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "inference",
  "metal",
);

// Map: standalone-shader-filename → in-fork relative path (under cacheDir).
// Each standalone is copied verbatim — its content is not edited. Per agent
// contract: the 13 standalone shaders are verified and must not be touched.
export const METAL_KERNEL_FILES = [
  "turbo3.metal",
  "turbo4.metal",
  "turbo3_tcq.metal",
  "qjl.metal",
  "polar.metal",
];

const SENTINEL = "# MILADY-KERNEL-PATCH-V1";

function inForkRelpath(name) {
  return path.posix.join("ggml", "src", "ggml-metal", "milady-shipped", name);
}

// Verify all standalones exist and are non-empty before any fs writes — we
// want a fail-fast that does not partially mutate the fork tree.
function assertStandalonesPresent() {
  const missing = [];
  for (const name of METAL_KERNEL_FILES) {
    const src = path.join(STANDALONE_METAL_DIR, name);
    if (!fs.existsSync(src)) {
      missing.push(src);
      continue;
    }
    const stat = fs.statSync(src);
    if (!stat.isFile() || stat.size === 0) {
      missing.push(`${src} (not a file or empty)`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[metal-kernels] missing/invalid standalone shader sources:\n  ${missing.join("\n  ")}`,
    );
  }
}

// Copy each standalone .metal into the fork at
// ggml/src/ggml-metal/milady-shipped/<name>.metal, overwriting any prior copy
// so the canonical source-of-truth is always the verified standalone.
//
// We deliberately overwrite the fork's stale ggml/src/ggml-metal/milady-kernels/
// content if it exists, but we write into a sibling milady-shipped/ directory
// so the patch is self-contained and the original (un-wired) milady-kernels/
// drafts remain visible for diff-archaeology if a future agent wants them.
function copyStandalonesIntoFork(cacheDir, { dryRun }) {
  const targetDir = path.join(cacheDir, "ggml", "src", "ggml-metal", "milady-shipped");
  if (dryRun) {
    console.log(
      `[metal-kernels] (dry-run) mkdir -p ${targetDir}`,
    );
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const copied = [];
  for (const name of METAL_KERNEL_FILES) {
    const src = path.join(STANDALONE_METAL_DIR, name);
    const dst = path.join(targetDir, name);
    if (dryRun) {
      console.log(`[metal-kernels] (dry-run) cp ${src} -> ${dst}`);
    } else {
      const text = fs.readFileSync(src, "utf8");
      // Prepend a sentinel comment so a future audit can tell this file came
      // from the build script's verified standalone, not a hand-edited
      // in-fork draft.
      const stamped =
        `// ${SENTINEL} — copied verbatim from packages/inference/metal/${name}\n` +
        `// at build time by build-llama-cpp-dflash.mjs. Do not edit in place;\n` +
        `// edit the standalone source and rerun the build.\n` +
        text;
      fs.writeFileSync(dst, stamped, "utf8");
    }
    copied.push(inForkRelpath(name));
  }
  return copied;
}

// Patch ggml/src/ggml-metal/CMakeLists.txt: replace the single
//   `xcrun metal -c X | xcrun metallib - -o Y`
// pipe with a multi-source compile + merge that includes our shipped kernels.
//
// We anchor on the `add_custom_command(OUTPUT ${...}/default.metallib` line
// in the non-EMBED_LIBRARY branch; that is the only metallib build the
// darwin host metal target uses. Idempotent via SENTINEL.
function patchMetalCMakeLists(cacheDir, { dryRun }) {
  const cmakePath = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-metal",
    "CMakeLists.txt",
  );
  if (!fs.existsSync(cmakePath)) {
    throw new Error(
      `[metal-kernels] expected ${cmakePath} to exist on the fork; cannot wire shipped kernels`,
    );
  }
  const original = fs.readFileSync(cmakePath, "utf8");
  if (original.includes(SENTINEL)) {
    return { changed: false, path: cmakePath };
  }

  // The exact block we replace. This pipe pattern has been stable in the
  // milady-ai/llama.cpp fork for the entire v0.4.x line; if the upstream
  // ever rewrites it we want to fail loudly rather than silently no-op.
  const anchor = `    add_custom_command(
        OUTPUT \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND xcrun -sdk macosx metal \${XC_FLAGS} -c \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal -o - |
                xcrun -sdk macosx metallib        - -o \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-common.h
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal
        DEPENDS ggml-metal.metal \${METALLIB_COMMON}
        COMMENT "Compiling Metal kernels"
        )`;
  if (!original.includes(anchor)) {
    throw new Error(
      `[metal-kernels] CMakeLists.txt anchor not found at ${cmakePath}; ` +
        `the fork's metallib build snippet has changed shape and the patch ` +
        `must be revisited. Inspect the file's add_custom_command for default.metallib.`,
    );
  }

  // Replacement: compile ggml-metal.metal AND each shipped standalone into
  // its own .air file, then merge them all into default.metallib.
  const milady_air_lines = METAL_KERNEL_FILES.map((name) => {
    const stem = name.replace(/\.metal$/, "");
    return `        COMMAND xcrun -sdk macosx metal \${XC_FLAGS} -c \${CMAKE_CURRENT_SOURCE_DIR}/milady-shipped/${name} -o \${CMAKE_CURRENT_BINARY_DIR}/${stem}.air`;
  }).join("\n");
  const milady_air_inputs = METAL_KERNEL_FILES.map((name) => {
    const stem = name.replace(/\.metal$/, "");
    return `\${CMAKE_CURRENT_BINARY_DIR}/${stem}.air`;
  }).join(" ");
  const milady_depends = METAL_KERNEL_FILES.map(
    (name) => `\${CMAKE_CURRENT_SOURCE_DIR}/milady-shipped/${name}`,
  ).join(" ");

  const replacement = `    # ${SENTINEL}
    # Build ggml-metal.metal AND each milady standalone shader into its own
    # .air file, then merge all .air files into a single default.metallib.
    # The standalones are self-contained TUs (only #include <metal_stdlib>;
    # define their own block_*, constants, kernel functions) so they do not
    # collide with anything ggml-metal.metal pulls in via ggml-common.h.
    add_custom_command(
        OUTPUT \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND xcrun -sdk macosx metal \${XC_FLAGS} -c \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal -o \${CMAKE_CURRENT_BINARY_DIR}/ggml-metal.air
${milady_air_lines}
        COMMAND xcrun -sdk macosx metallib \${CMAKE_CURRENT_BINARY_DIR}/ggml-metal.air ${milady_air_inputs} -o \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/default.metallib
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-common.h
        COMMAND rm -f \${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ggml-metal.metal
        DEPENDS ggml-metal.metal \${METALLIB_COMMON} ${milady_depends}
        COMMENT "Compiling Metal kernels (ggml-metal + milady-shipped: ${METAL_KERNEL_FILES.join(", ")})"
        )`;

  const patched = original.replace(anchor, replacement);
  if (patched === original) {
    throw new Error(
      `[metal-kernels] anchor matched but replacement did not change ${cmakePath}; this is a bug`,
    );
  }
  if (dryRun) {
    console.log(
      `[metal-kernels] (dry-run) would patch ${cmakePath} (anchor matched, replacement size ${replacement.length} chars, includes ${METAL_KERNEL_FILES.length} shipped kernels)`,
    );
    return { changed: false, path: cmakePath };
  }
  fs.writeFileSync(cmakePath, patched, "utf8");
  return { changed: true, path: cmakePath };
}

// Public entry point used by build-llama-cpp-dflash.mjs.
// Throws on any failure. Idempotent across runs.
export function patchMetalKernels(cacheDir, { dryRun = false } = {}) {
  if (!cacheDir || !fs.existsSync(cacheDir)) {
    throw new Error(`[metal-kernels] cacheDir does not exist: ${cacheDir}`);
  }
  assertStandalonesPresent();
  const copied = copyStandalonesIntoFork(cacheDir, { dryRun });
  const cmake = patchMetalCMakeLists(cacheDir, { dryRun });
  console.log(
    `[metal-kernels] ${dryRun ? "(dry-run) " : ""}wired ${copied.length} shipped Metal kernels: ${METAL_KERNEL_FILES.join(", ")}`,
  );
  console.log(
    `[metal-kernels] ${dryRun ? "(dry-run) " : ""}CMakeLists.txt: ${cmake.changed ? "patched" : "already-patched"} (${cmake.path})`,
  );
  return { copied, cmake };
}
