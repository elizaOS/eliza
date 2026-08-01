import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectHetznerRunnerLabels,
  validateHetznerFleetRouting,
} from "../hetzner-fleet-routing-contract.mjs";

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HOSTED = ["ubuntu-24.04"];
const FLEET = ["self-hosted", "hetzner-robot"];
const SAFE_WORKFLOW = `name: Test
jobs:
  test:
    runs-on: \${{ fromJSON(vars.HETZNER_FLEET_ONLINE != 'true' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]') }}
`;
const PR_HOSTED_WORKFLOW = `name: Test
jobs:
  test:
    runs-on: \${{ fromJSON(github.event_name == 'pull_request' && '["ubuntu-24.04"]' || vars.HETZNER_FLEET_ONLINE != 'true' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]') }}
`;

function buildRepo(workflow = SAFE_WORKFLOW): string {
  const root = mkdtempSync(join(tmpdir(), "hetzner-fleet-routing-"));
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "test.yml"), workflow);
  return root;
}

describe("Hetzner fleet routing contract", () => {
  test("missing, empty, false, and noncanonical values fail safely to hosted", () => {
    for (const value of [undefined, "", "false", "TRUE", "1"]) {
      expect(selectHetznerRunnerLabels(value)).toEqual(HOSTED);
    }
  });

  test("only an explicit lowercase true opts into the fleet", () => {
    expect(selectHetznerRunnerLabels("true")).toEqual(FLEET);
  });

  test("rejects the fail-open explicit-false selector", () => {
    const root = buildRepo(
      SAFE_WORKFLOW.replace(
        "HETZNER_FLEET_ONLINE != 'true'",
        "HETZNER_FLEET_ONLINE == 'false'",
      ),
    );
    try {
      expect(() => validateHetznerFleetRouting(root)).toThrow(
        /must require HETZNER_FLEET_ONLINE == true/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts the explicit-true opt-in selector", () => {
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

  test("accepts the workflow that always hosts pull requests", () => {
    const root = buildRepo(PR_HOSTED_WORKFLOW);
    try {
      expect(validateHetznerFleetRouting(root)).toEqual({
        files: 1,
        selectors: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the checked-in workflow set is uniformly fail-safe", () => {
    const result = validateHetznerFleetRouting(REAL_REPO_ROOT);
    expect(result.files).toBeGreaterThan(100);
    expect(result.selectors).toBeGreaterThan(200);
  });
});
