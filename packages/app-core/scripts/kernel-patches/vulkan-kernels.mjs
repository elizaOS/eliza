// Vulkan kernel-shipment + dispatch wiring for the v0.4.0-milady fork.
//
// What this module does:
//
//   1. Copies the eight verified standalone .comp shaders from
//      packages/inference/vulkan/ into the fork at
//      ggml/src/ggml-vulkan/vulkan-shaders/<name>.comp. The fork's CMakeLists
//      uses `file(GLOB CONFIGURE_DEPENDS ${input_dir}/*.comp)` to discover
//      shader sources, so dropping files into vulkan-shaders/ is sufficient
//      for glslc to compile them. Registration with vulkan-shaders-gen (so
//      the resulting SPV bytes appear as `<name>_data[]`/`<name>_len` in
//      ggml-vulkan-shaders.hpp) is handled by the patch in
//      vulkan-dispatch-patches/01-vulkan-shaders-gen.patch.
//
//   2. Applies the two unified-anchor patches under
//      vulkan-dispatch-patches/:
//        - 01-vulkan-shaders-gen.patch — adds 8 string_to_spv() registrations
//          at the bottom of process_shaders().
//        - 02-ggml-vulkan-pipelines.patch — extends vk_device_struct with 8
//          pipeline slots and adds 8 ggml_vk_create_pipeline() calls at the
//          bottom of ggml_vk_load_shaders(). End result: each milady SPV blob
//          is referenced at link time and `nm libggml-vulkan.so | grep
//          milady_` shows the new symbols.
//
//      Patches are idempotent: each carries a `MILADY-VK-DISPATCH-PATCH-V1`
//      sentinel; if the sentinel is already present in the target file, the
//      hunk is skipped (re-running the build is safe).
//
// Out of scope (deliberate, mirrors metal-kernels.mjs's same staged approach):
//
//   * Op-level dispatch wiring. The 8 standalones use bespoke push-constant
//     layouts and bind sets that do NOT plug into the existing
//     vk_op_binary_push_constants / vk_mat_vec_push_constants paths. The
//     follow-up patch needs to introduce a milady-native dispatch entrypoint
//     for GGML_OP_ATTN_SCORE_QJL (already declared in ggml.h:563 as a
//     CPU-only op) and add per-op routing for QJL/Polar K-cache score and
//     mul_mv. Until that lands, the kernels live as live, named pipelines
//     inside libggml-vulkan.so but are NOT yet selected at runtime — symbol
//     audit passes, end-to-end attention dispatch does not.
//
//   * Type-aware case branches in ggml_vk_get_dequantize_mul_mat_vec() etc.
//     Same reason as above: the existing dequant/mul_mat_vec paths assume a
//     uniform bind-set that the milady kernels intentionally do not match.

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

const PATCHES_DIR = path.resolve(__dirname, "vulkan-dispatch-patches");

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

const SHADER_SENTINEL = "// MILADY-VK-DISPATCH-PATCH-V1";
const PATCH_SENTINEL = "MILADY-VK-DISPATCH-PATCH-V1";

const PATCH_TARGETS = [
  {
    file: "01-vulkan-shaders-gen.patch",
    target: path.posix.join(
      "ggml",
      "src",
      "ggml-vulkan",
      "vulkan-shaders",
      "vulkan-shaders-gen.cpp",
    ),
  },
  {
    file: "02-ggml-vulkan-pipelines.patch",
    target: path.posix.join(
      "ggml",
      "src",
      "ggml-vulkan",
      "ggml-vulkan.cpp",
    ),
  },
];

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
  // vulkan-shaders/ is the directory the upstream CMakeLists uses for
  // file(GLOB CONFIGURE_DEPENDS *.comp) — dropping our 8 files there causes
  // glslc to compile them automatically as part of the existing per-shader
  // add_custom_command pipeline. The string_to_spv() registration patch
  // (01-vulkan-shaders-gen.patch) wires the resulting .spv bytes into
  // ggml-vulkan-shaders.hpp.
  const targetDir = path.join(
    cacheDir,
    "ggml",
    "src",
    "ggml-vulkan",
    "vulkan-shaders",
  );
  if (dryRun) {
    console.log(`[vulkan-kernels] (dry-run) ensure dir ${targetDir}`);
  } else if (!fs.existsSync(targetDir)) {
    throw new Error(
      `[vulkan-kernels] expected vulkan-shaders/ to exist in fork: ${targetDir}`,
    );
  }
  const copied = [];
  for (const name of VULKAN_KERNEL_FILES) {
    const src = path.join(STANDALONE_VULKAN_DIR, name);
    const dst = path.join(targetDir, name);
    if (dryRun) {
      console.log(`[vulkan-kernels] (dry-run) cp ${src} -> ${dst}`);
    } else {
      const text = fs.readFileSync(src, "utf8");
      // Mark the staged copy with the same sentinel as the patches so a
      // human inspecting the fork tree can see the file came from us.
      const stamped =
        `${SHADER_SENTINEL} — staged from packages/inference/vulkan/${name} by\n` +
        `// build-llama-cpp-dflash.mjs. Frozen — do not edit in fork.\n` +
        text;
      fs.writeFileSync(dst, stamped, "utf8");
    }
    copied.push(name);
  }
  return copied;
}

// Parse one anchor-driven patch file. Returns an array of hunks; each hunk
// has { anchor, sentinel, inject } strings.
function parsePatchFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const hunks = [];
  let cur = null;
  let inInject = false;
  let injectLines = [];
  for (const line of lines) {
    if (line.startsWith("ANCHOR")) {
      cur = { anchor: line.replace(/^ANCHOR\s+/, ""), sentinel: null, inject: null };
    } else if (line.startsWith("SENTINEL")) {
      if (!cur) throw new Error(`[vulkan-kernels] SENTINEL before ANCHOR in ${filePath}`);
      cur.sentinel = line.replace(/^SENTINEL\s+/, "").trim();
    } else if (line === "---INJECT-BEGIN---") {
      inInject = true;
      injectLines = [];
    } else if (line === "---INJECT-END---") {
      if (!cur) throw new Error(`[vulkan-kernels] INJECT-END without ANCHOR in ${filePath}`);
      cur.inject = injectLines.join("\n");
      hunks.push(cur);
      cur = null;
      inInject = false;
    } else if (inInject) {
      injectLines.push(line);
    }
  }
  if (hunks.length === 0) {
    throw new Error(`[vulkan-kernels] no hunks parsed from ${filePath}`);
  }
  return hunks;
}

// Apply one parsed hunk to file contents. Returns { text, applied } where
// applied=false means the sentinel was already present (idempotent skip).
function applyHunk(text, hunk, ctx) {
  if (hunk.sentinel && text.includes(hunk.sentinel)) {
    return { text, applied: false };
  }
  const idx = text.indexOf(hunk.anchor);
  if (idx === -1) {
    throw new Error(
      `[vulkan-kernels] anchor not found in ${ctx}: ${JSON.stringify(hunk.anchor)}`,
    );
  }
  // Find the start of the line containing the anchor so we insert before it.
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const before = text.slice(0, lineStart);
  const after = text.slice(lineStart);
  return { text: before + hunk.inject + after, applied: true };
}

function applyPatches(cacheDir, { dryRun }) {
  const results = [];
  for (const { file, target } of PATCH_TARGETS) {
    const patchPath = path.join(PATCHES_DIR, file);
    const targetPath = path.join(cacheDir, target);
    if (!fs.existsSync(patchPath)) {
      throw new Error(`[vulkan-kernels] missing patch file: ${patchPath}`);
    }
    if (!fs.existsSync(targetPath)) {
      throw new Error(`[vulkan-kernels] missing target file: ${targetPath}`);
    }
    const hunks = parsePatchFile(patchPath);
    if (dryRun) {
      console.log(
        `[vulkan-kernels] (dry-run) would apply ${hunks.length} hunk(s) from ${file} to ${target}`,
      );
      results.push({ file, target, hunks: hunks.length, applied: 0, skipped: hunks.length });
      continue;
    }
    let text = fs.readFileSync(targetPath, "utf8");
    let applied = 0;
    let skipped = 0;
    for (const hunk of hunks) {
      const r = applyHunk(text, hunk, target);
      text = r.text;
      if (r.applied) applied++; else skipped++;
    }
    fs.writeFileSync(targetPath, text, "utf8");
    results.push({ file, target, hunks: hunks.length, applied, skipped });
  }
  return results;
}

// Public entry point used by build-llama-cpp-dflash.mjs.
export function patchVulkanKernels(cacheDir, { dryRun = false, target = null } = {}) {
  if (!cacheDir || !fs.existsSync(cacheDir)) {
    throw new Error(`[vulkan-kernels] cacheDir does not exist: ${cacheDir}`);
  }
  assertStandalonesPresent();
  const copied = copyStandalonesIntoFork(cacheDir, { dryRun });
  const patchResults = applyPatches(cacheDir, { dryRun });
  console.log(
    `[vulkan-kernels] ${dryRun ? "(dry-run) " : ""}staged ${copied.length} standalone Vulkan shaders into vulkan-shaders/ ` +
      `and applied ${patchResults.length} dispatch patches:`,
  );
  for (const r of patchResults) {
    console.log(
      `[vulkan-kernels]   ${r.file} → ${r.target}: ${r.applied} hunk(s) applied, ${r.skipped} idempotent-skipped`,
    );
  }
  // Note: target arg is currently unused. AGENTS.md §3 enforcement (no
  // milady-missing vulkan binary) is now done at build-llama-cpp-dflash.mjs
  // post-build via the requiredKernels audit on the SPV blob list.
  return { copied, patchResults };
}
