// Real Vulkan kernel-shipment helpers — replace the v0.4.0-milady decorative
// log no-ops in build-llama-cpp-dflash.mjs.
//
// Audited state at v0.4.0-milady (commit 08032d57):
//
//   * The fork has ZERO turbo/qjl/polar Vulkan compute shaders. A grep for
//     'turbo|tbq|qjl|polar' under ggml/src/ggml-vulkan/ returns empty.
//   * The fork's vulkan shader build is mediated by a host-only tool
//     `vulkan-shaders-gen` which consumes every .comp under
//     ggml/src/ggml-vulkan/vulkan-shaders/ via file(GLOB) and emits a
//     generated ggml-vulkan-shaders.hpp that ggml-vulkan.cpp links into
//     `__ggml_vulkan_*` symbols.
//   * vulkan-shaders-gen requires per-shader registration (entry-point
//     name, push-constant layout, dispatch shape) coded into vulkan-shaders/
//     CMakeLists.txt + the gen tool's source. Our standalones are
//     self-contained .comp files but they do NOT carry the registration
//     metadata vulkan-shaders-gen expects.
//
//   * Even if vulkan-shaders-gen accepted the files, ggml-vulkan.cpp has no
//     dispatch sites for the milady quant types (`GGML_TYPE_TBQ3_0`,
//     `GGML_TYPE_QJL1_256`, etc.), so the kernels would be dead code in the
//     SPV blob.
//
// What this module does today:
//
//   1. Copies the eight verified standalone .comp shaders from
//      packages/inference/vulkan/ into the fork at
//      ggml/src/ggml-vulkan/milady-shipped/<name>.comp. NOT into the
//      vulkan-shaders/ directory — dropping them there would break the
//      vulkan-shaders-gen host build with cryptic missing-registration
//      errors. Putting them under milady-shipped/ leaves them visible for
//      the next agent to wire up properly without breaking the existing
//      build.
//
//   2. Hard-throws when the build is invoked for a *-vulkan target unless
//      ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN=1 is set in the environment.
//      Per AGENTS.md §3, an Eliza-1 vulkan binary that lacks
//      turbo/qjl/polar must not be silently produced. The escape hatch is
//      explicit and audit-loggable.
//
// Out of scope (deferred):
//
//   * Wiring the standalones into vulkan-shaders-gen so they emit SPV blobs
//     that ggml-vulkan-shaders.hpp registers.
//   * Adding dispatch sites in ggml-vulkan.cpp for the milady quant types.
//
// When that follow-up lands, point this helper at vulkan-shaders/ and drop
// the hard-throw.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STANDALONE_VULKAN_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "inference",
  "vulkan",
);

export const VULKAN_KERNEL_FILES = [
  "turbo3.comp",
  "turbo4.comp",
  "turbo3_tcq.comp",
  "qjl.comp",
  "qjl_get_rows.comp",
  "qjl_mul_mv.comp",
  "polar.comp",
  "polar_get_rows.comp",
];

const SENTINEL = "# MILADY-KERNEL-PATCH-V1";

function assertStandalonesPresent() {
  const missing = [];
  for (const name of VULKAN_KERNEL_FILES) {
    const src = path.join(STANDALONE_VULKAN_DIR, name);
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
      `[vulkan-kernels] missing/invalid standalone shader sources:\n  ${missing.join("\n  ")}`,
    );
  }
}

function copyStandalonesIntoFork(cacheDir, { dryRun }) {
  const targetDir = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-vulkan",
    "milady-shipped",
  );
  if (dryRun) {
    console.log(`[vulkan-kernels] (dry-run) mkdir -p ${targetDir}`);
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const copied = [];
  for (const name of VULKAN_KERNEL_FILES) {
    const src = path.join(STANDALONE_VULKAN_DIR, name);
    const dst = path.join(targetDir, name);
    if (dryRun) {
      console.log(`[vulkan-kernels] (dry-run) cp ${src} -> ${dst}`);
    } else {
      const text = fs.readFileSync(src, "utf8");
      const stamped =
        `// ${SENTINEL} — copied verbatim from packages/inference/vulkan/${name}\n` +
        `// at build time by build-llama-cpp-dflash.mjs. Not yet wired into\n` +
        `// vulkan-shaders-gen (see kernel-patches/vulkan-kernels.mjs).\n` +
        text;
      fs.writeFileSync(dst, stamped, "utf8");
    }
    copied.push(name);
  }
  return copied;
}

// Public entry point used by build-llama-cpp-dflash.mjs.
//
// Signature mirrors patchMetalKernels but adds a `target` argument so we can
// hard-throw at exactly the right moment: when the build is producing a
// vulkan binary that would violate AGENTS.md §3.
export function patchVulkanKernels(
  cacheDir,
  { dryRun = false, target = null } = {},
) {
  if (!cacheDir || !fs.existsSync(cacheDir)) {
    throw new Error(`[vulkan-kernels] cacheDir does not exist: ${cacheDir}`);
  }
  assertStandalonesPresent();
  const copied = copyStandalonesIntoFork(cacheDir, { dryRun });
  console.log(
    `[vulkan-kernels] ${dryRun ? "(dry-run) " : ""}staged ${copied.length} standalone Vulkan shaders under ggml/src/ggml-vulkan/milady-shipped/ ` +
      `(NOT YET wired into vulkan-shaders-gen — see kernel-patches/vulkan-kernels.mjs comment)`,
  );

  // Hard-fail when actually building a vulkan target. Per AGENTS.md §3 the
  // build script must not silently produce a vulkan artifact that lacks
  // turbo/qjl/polar dispatch.
  const isVulkanTarget =
    target && (target.endsWith("-vulkan") || target.endsWith("-vulkan-fused"));
  if (isVulkanTarget && !dryRun) {
    if (process.env.ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN === "1") {
      console.warn(
        `[vulkan-kernels] WARNING: building target=${target} with ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN=1; ` +
          `the resulting binary will lack turbo/qjl/polar dispatch. AGENTS.md §3 violation acknowledged by env override.`,
      );
    } else {
      throw new Error(
        `[vulkan-kernels] target=${target} cannot be built: the standalone Vulkan shaders are staged but ` +
          `not yet registered with vulkan-shaders-gen, and ggml-vulkan.cpp has no dispatch sites for ` +
          `GGML_TYPE_TBQ3_0 / TBQ4_0 / QJL1_256 / Q4_POLAR. Producing this artifact would violate AGENTS.md §3 ` +
          `(no Eliza-1 vulkan binary missing turbo/qjl/polar). Set ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN=1 to ` +
          `acknowledge the gap, or implement vulkan-shaders-gen registration + ggml-vulkan.cpp dispatch first.`,
      );
    }
  }

  return { copied };
}
