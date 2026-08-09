/** Ensures consolidated deterministic smoke provisions its required browsers before E2E. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowStep {
  if?: string;
  name?: string;
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = Bun.YAML.parse(
  readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"),
) as Workflow;

describe("consolidated deterministic smoke browser setup", () => {
  test("installs Chromium and WebKit through the canonical helper before app E2E", () => {
    const steps = workflow.jobs?.smoke?.steps;
    if (!steps) throw new Error("CI smoke job must declare steps");

    const installIndex = steps.findIndex(
      ({ name }) => name === "Install Playwright Chromium + WebKit",
    );
    const smokeIndex = steps.findIndex(
      ({ name }) => name === "Deterministic end-to-end smoke",
    );
    expect(installIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBe(installIndex + 1);

    const install = steps[installIndex];
    const smoke = steps[smokeIndex];
    expect(install?.if).toBe("needs.changes.outputs.zero_key == 'true'");
    expect(install?.run).toBe(
      ".github/scripts/install-playwright-browsers.sh chromium webkit",
    );
    expect(smoke).toMatchObject({
      if: install?.if,
      run: "bun run test:e2e",
    });
  });
});
