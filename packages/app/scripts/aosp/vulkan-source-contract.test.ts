/** Exercises source admission with real temporary Git checkouts; it proves unchanged staging and rejection, not shader numerics. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  prepareAndroidVulkanSource,
  validateMaintainedVulkanSource,
} from "./vulkan-source-contract.ts";

const declaration = {
  schemaVersion: 1,
  contracts: {
    "tbq-attention-raw-query-v1": {
      operation: "ATTN_SCORE_TBQ",
      headDim: 128,
      queryBasis: "unconditioned",
      keyTypes: {
        tbq3_0: {
          blockElements: 32,
          blockBytes: 14,
          packing:
            "12 bytes of consecutive little-endian 3-bit codes after fp16 scale",
        },
        tbq4_0: {
          blockElements: 32,
          blockBytes: 18,
          packing: "16 low nibbles then 16 high nibbles after fp16 scale",
        },
      },
      conditioning: "per-32 signed normalized Hadamard matching ggml-quants.c",
      multiBlockThreshold: 8192,
      requiredSources: [
        "ggml/src/ggml-quants.c",
        "ggml/src/ggml-cpu/attn-score-tbq-polar.c",
        "ggml/src/ggml-vulkan/ggml-vulkan.cpp",
        "ggml/src/ggml-vulkan/vulkan-shaders/vulkan-shaders-gen.cpp",
        "ggml/src/ggml-vulkan/vulkan-shaders/turbo3.comp",
        "ggml/src/ggml-vulkan/vulkan-shaders/turbo3_multi.comp",
        "ggml/src/ggml-vulkan/vulkan-shaders/turbo4.comp",
        "ggml/src/ggml-vulkan/vulkan-shaders/turbo4_multi.comp",
      ],
      behavioralTest: "tests/test-backend-ops.cpp: ATTN_SCORE_TBQ",
    },
  },
};
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}
function fixture(change = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-vulkan-contract-"));
  roots.push(root);
  git(root, "init", "-q");
  const data = structuredClone(declaration);
  const contract = data.contracts["tbq-attention-raw-query-v1"];
  for (const name of [
    ...contract.requiredSources,
    ...[
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
    ].map((name) => `ggml/src/ggml-vulkan/vulkan-shaders/${name}.comp`),
  ]) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `// source identity: ${name}\n`);
  }
  change(data, root);
  fs.writeFileSync(
    path.join(root, "ggml/src/ggml-vulkan/eliza-capabilities.json"),
    JSON.stringify(data),
  );
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "source fixture",
  );
  return { source: root, expectedRevision: git(root, "rev-parse", "HEAD") };
}

test("admits the declared pinned source without changing any shader or dispatch bytes", () => {
  const input = fixture();
  const before = git(input.source, "ls-files", "-s");
  expect(
    prepareAndroidVulkanSource({ ...input, maintainedSource: input.source })
      .mode,
  ).toBe("maintained");
  expect(git(input.source, "status", "--porcelain")).toBe("");
  expect(git(input.source, "ls-files", "-s")).toBe(before);
});
test.each(["schema", "query", "packing", "missing", "unsafe", "duplicate"])(
  "rejects incompatible %s before source staging",
  (kind) => {
    const input = fixture((data, root) => {
      const contract = data.contracts["tbq-attention-raw-query-v1"];
      if (kind === "schema") data.schemaVersion = 2;
      if (kind === "query") contract.queryBasis = "preconditioned";
      if (kind === "packing")
        contract.keyTypes.tbq3_0.packing = "legacy split sign bits";
      if (kind === "missing")
        fs.unlinkSync(path.join(root, contract.requiredSources[0]));
      if (kind === "unsafe") contract.requiredSources.push("../outside.comp");
      if (kind === "duplicate")
        contract.requiredSources.push(contract.requiredSources[0]);
    });
    expect(() => validateMaintainedVulkanSource(input)).toThrow();
    expect(git(input.source, "status", "--porcelain")).toBe("");
  },
);
test("rejects a different revision and dirty shader before admission", () => {
  const input = fixture();
  expect(() =>
    validateMaintainedVulkanSource({
      ...input,
      expectedRevision: "0".repeat(40),
    }),
  ).toThrow(/gitlink/);
  fs.appendFileSync(
    path.join(input.source, "ggml/src/ggml-vulkan/vulkan-shaders/turbo3.comp"),
    "// stale overlay\n",
  );
  expect(() => validateMaintainedVulkanSource(input)).toThrow(/modified/);
});

test("refuses explicit legacy staging into the maintained source", () => {
  const input = fixture();
  expect(() =>
    prepareAndroidVulkanSource({
      ...input,
      maintainedSource: input.source,
      legacy: true,
    }),
  ).toThrow(/cannot overwrite/);
  expect(git(input.source, "status", "--porcelain")).toBe("");
});

test("rejects a clean pinned tree without its capability declaration", () => {
  const input = fixture();
  fs.unlinkSync(
    path.join(input.source, "ggml/src/ggml-vulkan/eliza-capabilities.json"),
  );
  git(input.source, "add", "-u");
  git(
    input.source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "missing declaration",
  );
  input.expectedRevision = git(input.source, "rev-parse", "HEAD");
  expect(() =>
    prepareAndroidVulkanSource({ ...input, maintainedSource: input.source }),
  ).toThrow(/lacks the Vulkan capability declaration/);
});
