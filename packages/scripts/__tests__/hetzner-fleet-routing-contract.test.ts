/** Exercises the repository-wide ban on routing CI onto production placement nodes. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHetznerFleetRouting } from "../hetzner-fleet-routing-contract.mjs";

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SAFE_WORKFLOW = `name: Test
jobs:
  test:
    runs-on: ubuntu-24.04
`;

function buildRepo(workflow = SAFE_WORKFLOW): string {
  const root = mkdtempSync(join(tmpdir(), "hetzner-fleet-routing-"));
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "test.yml"), workflow);
  return root;
}

describe("Hetzner fleet routing contract", () => {
  test("accepts a hosted runner selector", () => {
    const root = buildRepo();
    try {
      expect(validateHetznerFleetRouting(root)).toEqual({
        files: 1,
        selectors: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    [
      "hard-coded fleet labels",
      `name: Test
jobs:
  test:
    runs-on: [self-hosted, hetzner-robot]
`,
    ],
    [
      "a conditional fleet opt-in",
      `name: Test
jobs:
  test:
    runs-on: \${{ fromJSON(vars.HETZNER_FLEET_ONLINE == 'true' && '["self-hosted","hetzner-robot"]' || '["ubuntu-24.04"]') }}
`,
    ],
    [
      "a runner override variable",
      `name: Test
jobs:
  test:
    runs-on: \${{ fromJSON(vars.CLOUD_CF_DEPLOY_RUNNER_JSON || '["ubuntu-latest"]') }}
`,
    ],
    [
      "an arbitrarily named runner override",
      `name: Test
jobs:
  test:
    runs-on: \${{ vars.CUSTOM_RUNNER }}
`,
    ],
    [
      "a fleet label hidden behind a matrix reference",
      `name: Test
jobs:
  test:
    strategy:
      matrix:
        runner:
          - '["self-hosted","hetzner-robot"]'
    runs-on: \${{ fromJSON(matrix.runner) }}
`,
    ],
  ])("rejects %s", (_name, workflow) => {
    const root = buildRepo(workflow);
    try {
      expect(() => validateHetznerFleetRouting(root)).toThrow(
        /must remain separated from production placement nodes/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the checked-in workflow set contains only separated runner routes", () => {
    const result = validateHetznerFleetRouting(REAL_REPO_ROOT);
    expect(result.files).toBeGreaterThan(0);
    expect(result.selectors).toBeGreaterThan(0);
  });
});
