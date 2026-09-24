/** Validates the pinned Vulkan source contract before Android builds consume the fork without legacy shader overlays. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { patchVulkanKernels } from "../kernel-patches/vulkan-kernels.mjs";

const shaderRoot = "ggml/src/ggml-vulkan/vulkan-shaders";
const requiredSources = [
  "ggml/src/ggml-quants.c",
  "ggml/src/ggml-cpu/attn-score-tbq-polar.c",
  "ggml/src/ggml-vulkan/ggml-vulkan.cpp",
  `${shaderRoot}/vulkan-shaders-gen.cpp`,
  ...["turbo3", "turbo3_multi", "turbo4", "turbo4_multi"].map(
    (name) => `${shaderRoot}/${name}.comp`,
  ),
];
const otherShaders = [
  "turbo3_tcq",
  "turbo3_tcq_multi",
  "qjl",
  "qjl_get_rows",
  "qjl_mul_mv",
  "qjl_multi",
  "polar",
  "polar_preht",
  "polar_get_rows",
  "fused_attn_qjl_tbq",
  "fused_attn_qjl_polar",
];

function git(source, ...args) {
  return execFileSync("git", ["-C", source, ...args], {
    encoding: "utf8",
  }).trim();
}

export function validateMaintainedVulkanSource({ source, expectedRevision }) {
  const root = fs.realpathSync(source);
  if (!/^[a-f0-9]{40}$/.test(expectedRevision)) {
    throw new Error(
      "A pinned native revision is required for the Vulkan build",
    );
  }
  if (
    fs.realpathSync(git(root, "rev-parse", "--show-toplevel")) !== root ||
    git(root, "rev-parse", "HEAD") !== expectedRevision
  ) {
    throw new Error(
      "Vulkan source must match the parent repository's native gitlink",
    );
  }
  if (git(root, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error(
      "Vulkan source is modified; use the clean pinned native checkout",
    );
  }
  const declarationPath = path.join(
    root,
    "ggml/src/ggml-vulkan/eliza-capabilities.json",
  );
  if (!fs.existsSync(declarationPath)) {
    throw new Error(
      "Pinned native source lacks the Vulkan capability declaration; update to the qualified native revision before building",
    );
  }
  const declaration = JSON.parse(fs.readFileSync(declarationPath, "utf8"));
  const contract = declaration.contracts?.["tbq-attention-raw-query-v1"];
  const three = contract?.keyTypes?.tbq3_0;
  const four = contract?.keyTypes?.tbq4_0;
  if (
    declaration.schemaVersion !== 1 ||
    contract?.operation !== "ATTN_SCORE_TBQ" ||
    contract.headDim !== 128 ||
    contract.queryBasis !== "unconditioned" ||
    contract.conditioning !==
      "per-32 signed normalized Hadamard matching ggml-quants.c" ||
    contract.multiBlockThreshold !== 8192 ||
    three?.blockElements !== 32 ||
    three.blockBytes !== 14 ||
    three.packing !==
      "12 bytes of consecutive little-endian 3-bit codes after fp16 scale" ||
    four?.blockElements !== 32 ||
    four.blockBytes !== 18 ||
    four.packing !== "16 low nibbles then 16 high nibbles after fp16 scale"
  ) {
    throw new Error(
      "Pinned Vulkan fork does not declare the supported raw-query TBQ contract",
    );
  }
  const inventory = contract.requiredSources;
  if (
    !Array.isArray(inventory) ||
    new Set(inventory).size !== inventory.length ||
    !requiredSources.every((name) => inventory.includes(name))
  ) {
    throw new Error(
      "Vulkan capability declaration is missing required source inventory",
    );
  }
  for (const name of [
    ...inventory,
    ...otherShaders.map((name) => `${shaderRoot}/${name}.comp`),
  ]) {
    if (
      typeof name !== "string" ||
      path.isAbsolute(name) ||
      name.includes("\\") ||
      name
        .split("/")
        .some((part) => part === ".." || part === "." || part === "")
    ) {
      throw new Error("Vulkan source inventory contains an unsafe path");
    }
    const file = path.join(root, name);
    if (
      !fs.statSync(file).isFile() ||
      !fs.realpathSync(file).startsWith(`${root}${path.sep}`)
    ) {
      throw new Error(`Vulkan source inventory is unavailable: ${name}`);
    }
  }
  return { revision: expectedRevision, contract: "tbq-attention-raw-query-v1" };
}

export function readPinnedNativeRevision(repoRoot) {
  const entry = git(
    repoRoot,
    "ls-tree",
    "HEAD",
    "plugins/plugin-local-inference/native/llama.cpp",
  );
  const match = /^160000 commit ([a-f0-9]{40})\t/.exec(entry);
  if (!match) throw new Error("Parent repository has no pinned native gitlink");
  return match[1];
}

/** Selects the actual pre-build staging path; maintained forks are never overlaid. */
export function prepareAndroidVulkanSource({
  source,
  maintainedSource,
  expectedRevision,
  legacy = false,
  dryRun = false,
}) {
  if (legacy) {
    if (
      fs.existsSync(source) &&
      fs.existsSync(maintainedSource) &&
      fs.realpathSync(source) === fs.realpathSync(maintainedSource)
    ) {
      throw new Error(
        "Legacy Vulkan graft cannot overwrite the maintained native submodule",
      );
    }
    if (!dryRun)
      patchVulkanKernels(source, { target: "android-legacy-vulkan" });
    return { mode: "legacy" };
  }
  if (!dryRun) validateMaintainedVulkanSource({ source, expectedRevision });
  return { mode: "maintained" };
}
