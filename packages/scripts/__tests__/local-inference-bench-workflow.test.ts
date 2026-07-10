/** Locks the nightly local-inference profile to the real fused runtime required by Eliza-1 bundles. */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const workflow = readFileSync(
  path.resolve(
    import.meta.dir,
    "../../../.github/workflows/local-inference-bench.yml",
  ),
  "utf8",
);
const releaseAcceptanceConfig = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dir,
      "../benchmark/configs/host-cpu-release-acceptance.json",
    ),
    "utf8",
  ),
) as { models: string[] };

describe("local inference bench workflow", () => {
  it("preflights and profiles every published release tier", () => {
    expect(releaseAcceptanceConfig.models).toEqual([
      "eliza-1-2b",
      "eliza-1-4b",
    ]);
    for (const modelId of releaseAcceptanceConfig.models) {
      expect(workflow).toContain(`preflight-eliza1-manifest.mjs ${modelId}`);
    }
    expect(workflow).toContain(
      "--config packages/scripts/benchmark/configs/host-cpu-release-acceptance.json",
    );
    expect(workflow).toContain("timeout-minutes: 120");
  });

  it("schedules the real model profile on model-capable self-hosted runners", () => {
    const nightlyJob = workflow.slice(
      workflow.indexOf("  nightly-real-agent:"),
      workflow.indexOf("  cuttlefish-bench:"),
    );

    expect(nightlyJob).toContain(
      "vars.LOCAL_INFERENCE_BENCH_RUNNER_LABELS || " +
        '\'["self-hosted","Linux","X64","eliza"]\'',
    );
    expect(nightlyJob).not.toContain("vars.HETZNER_FLEET_ONLINE");
  });

  it("builds and exposes libelizainference before booting the real agent", () => {
    const pythonStep = workflow.indexOf(
      "- name: Setup Python for fused-runtime build tools",
    );
    const dependencyStep = workflow.indexOf(
      "- name: Provision fused-runtime build tools",
    );
    const buildStep = workflow.indexOf(
      "node packages/app-core/scripts/stage-desktop-fused-lib.mjs",
    );
    const submoduleStep = workflow.indexOf(
      "git submodule update --init --recursive",
    );
    const bootStep = workflow.indexOf("- name: Boot dev agent");

    expect(pythonStep).toBeGreaterThan(-1);
    expect(dependencyStep).toBeGreaterThan(-1);
    expect(buildStep).toBeGreaterThan(-1);
    expect(submoduleStep).toBeGreaterThan(-1);
    expect(dependencyStep).toBeGreaterThan(pythonStep);
    expect(buildStep).toBeGreaterThan(dependencyStep);
    expect(buildStep).toBeGreaterThan(submoduleStep);
    expect(bootStep).toBeGreaterThan(buildStep);
    expect(workflow).toContain("--variant cpu");
    expect(workflow).not.toContain("sudo apt-get");
    expect(workflow).toContain('"cmake>=3.28,<5" "ninja>=1.11,<2"');
    expect(workflow).toContain(
      "ELIZA_INFERENCE_LIB_DIR: $" + "{{ github.workspace }}/.ci-fused-lib",
    );
  });
});
