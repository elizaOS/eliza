/**
 * Pins Android's fused native producer, its Actions-API app-build consumer, and
 * the canonical mobile/Apple authorities while retired native scaffolds stay absent.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowsDir = path.join(repoRoot, ".github", "workflows");

function readWorkflow(name: string): string {
  return readFileSync(path.join(workflowsDir, name), "utf8");
}

function extractStep(workflow: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = workflow.match(
    new RegExp(
      `^      - name: ${escaped}\\n(?<body>[\\s\\S]*?)(?=^      - (?:name|uses): |$(?![\\s\\S]))`,
      "m",
    ),
  );
  if (!match?.groups?.body) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return match.groups.body;
}

const producerName = "build-llama-ffi-android.yml";
const producer = readWorkflow(producerName);
const consumer = readWorkflow("build-android.yml");
const fusedVerifier = readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/scripts/build-helpers/verify-fused-symbols.mjs",
  ),
  "utf8",
);

describe("Android native build authority", () => {
  test("supports exactly the two fused ABIs and rejects invalid filters", () => {
    expect(producer.match(/default: "arm64-v8a,x86_64"/g)).toHaveLength(2);
    expect(producer).toContain(
      'description: "Comma-separated subset of supported ABIs: arm64-v8a,x86_64"',
    );
    expect(producer).toContain(
      `ABI_FILTER: \${{ github.event_name == 'push' && 'arm64-v8a,x86_64' || inputs.abi_filter }}`,
    );
    expect(producer).not.toContain("inputs.abi_filter ||");
    expect(producer).toContain(
      "const filterRaw = process.env.ABI_FILTER.trim();",
    );
    expect(producer).not.toContain("context.payload.inputs");
    expect(producer).toContain(
      '{ abi: "arm64-v8a", target: "android-arm64-vulkan-fused" }',
    );
    expect(producer).toContain(
      '{ abi: "x86_64",    target: "android-x86_64-cpu-fused" }',
    );
    expect(producer).not.toContain('{ abi: "armeabi-v7a"');
    expect(producer).toContain(
      "abi_filter must select at least one supported ABI",
    );
    expect(producer).toContain("abi_filter contains unsupported ABI(s)");
    expect(producer).toContain("core.setFailed(");
  });

  test("fails closed on the complete fused ABI and Mali marker contracts", () => {
    const verifyStep = extractStep(
      producer,
      "Verify fused artifact (FFI symbols + Mali FA mitigation on arm64)",
    );
    const uploadIndex = producer.indexOf(
      "- name: Upload libelizainference artifact",
    );
    const verifyIndex = producer.indexOf(
      "- name: Verify fused artifact (FFI symbols + Mali FA mitigation on arm64)",
    );

    expect(verifyStep).toContain("set -euo pipefail");
    expect(verifyStep).toContain(
      "packages/app-core/scripts/build-helpers/verify-fused-symbols.mjs",
    );
    expect(verifyStep).toMatch(/--target "\$\{\{ matrix\.target \}\}"/);
    expect(verifyStep).toContain("--json");
    expect(fusedVerifier).toContain(
      'const MALI_FA_MITIGATION_MARKER = "GGML_VK_FA_ALLOW_SUBGROUPS"',
    );
    expect(fusedVerifier).toContain(
      "if (binaryContainsAnyMarker(lib, [MALI_FA_MITIGATION_MARKER])) return",
    );
    expect(fusedVerifier).toContain(
      "assertVulkanMaliMitigation({ lib, target });",
    );
    expect(fusedVerifier).toContain(
      "const missingAbiSymbols = REQUIRED_ELIZA_INFERENCE_SYMBOLS.filter",
    );
    expect(fusedVerifier).toContain("if (missingAbiSymbols.length > 0)");
    expect(verifyStep).not.toContain("WARNING:");
    expect(verifyStep).not.toContain("|| true");
    expect(verifyStep).not.toContain("continue-on-error");
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(verifyIndex);
  });

  test("keeps the app build on the input-compatible Actions API consumer", () => {
    expect(consumer).toContain("actions: read");
    expect(consumer).toContain(`".github/workflows/${producerName}"`);
    expect(consumer).toContain(
      `actions/workflows/${producerName}/runs?status=success&per_page=20`,
    );
    expect(consumer).toContain('local_sha=$(git rev-parse "HEAD:$path")');
    expect(consumer).toContain("libelizainference-android-arm64-vulkan-fused");
    expect(consumer).toContain("libelizainference-android-x86_64-cpu-fused");
    expect(consumer).toContain(
      "no successful build-llama-ffi-android run matches this checkout's native producer inputs",
    );
  });

  test("removes uncalled scaffolds without replacing mobile or Apple authorities", () => {
    const retired = [
      ...["ios", "linux", "macos"].map(
        (platform) => `build-llama-ffi-${platform}.yml`,
      ),
      ["build", "ios.yml"].join("-"),
    ];
    for (const name of retired) {
      expect(existsSync(path.join(workflowsDir, name))).toBe(false);
    }

    expect(existsSync(path.join(workflowsDir, producerName))).toBe(true);
    expect(existsSync(path.join(workflowsDir, "mobile-build-smoke.yml"))).toBe(
      true,
    );
    expect(existsSync(path.join(workflowsDir, "apple-store-release.yml"))).toBe(
      true,
    );
  });
});
