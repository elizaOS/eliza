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

describe("local inference bench workflow", () => {
  it("builds and exposes libelizainference before booting the real agent", () => {
    const buildStep = workflow.indexOf(
      "node packages/app-core/scripts/stage-desktop-fused-lib.mjs",
    );
    const submoduleStep = workflow.indexOf(
      "git submodule update --init --recursive",
    );
    const bootStep = workflow.indexOf("- name: Boot dev agent");

    expect(buildStep).toBeGreaterThan(-1);
    expect(submoduleStep).toBeGreaterThan(-1);
    expect(buildStep).toBeGreaterThan(submoduleStep);
    expect(bootStep).toBeGreaterThan(buildStep);
    expect(workflow).toContain("--variant cpu");
    expect(workflow).toContain(
      "ELIZA_INFERENCE_LIB_DIR: $" + "{{ github.workspace }}/.ci-fused-lib",
    );
  });
});
