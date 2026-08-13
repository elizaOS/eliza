/** Exercises the repository-wide fail-closed contract for direct and indirect Hetzner runner routes. */

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const MANUAL_FLEET_WORKFLOW = `name: Test
jobs:
  test:
    runs-on: \${{ fromJSON(inputs.runner != 'robot' && '["ubuntu-24.04"]' || vars.HETZNER_FLEET_ONLINE != 'true' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]') }}
`;
const SAFE_MATRIX_WORKFLOW = `name: Test
jobs:
  test:
    strategy:
      matrix:
        include:
          - lane: robot-fleet
            runner: \${{ vars.HETZNER_FLEET_ONLINE != 'true' && '["ubuntu-latest"]' || vars.ACTIONS_JANITOR_ROBOT_LANE_DISABLED == 'true' && '["ubuntu-latest"]' || vars.ACTIONS_JANITOR_ROBOT_RUNNER_JSON || '["self-hosted","Linux","X64","hetzner-robot"]' }}
    runs-on: \${{ fromJSON(matrix.runner) }}
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
        /must require explicit HETZNER_FLEET_ONLINE opt-in/,
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

  test("accepts a manual fleet choice only behind the repository opt-in", () => {
    const root = buildRepo(MANUAL_FLEET_WORKFLOW);
    try {
      expect(validateHetznerFleetRouting(root)).toEqual({
        files: 1,
        selectors: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a manual fleet choice without the repository opt-in", () => {
    const root = buildRepo(
      MANUAL_FLEET_WORKFLOW.replace(
        "vars.HETZNER_FLEET_ONLINE != 'true' && '[\"ubuntu-24.04\"]' || ",
        "",
      ),
    );
    try {
      expect(() => validateHetznerFleetRouting(root)).toThrow(
        /must require explicit HETZNER_FLEET_ONLINE opt-in/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts an indirect matrix route with the explicit fleet opt-in", () => {
    const root = buildRepo(SAFE_MATRIX_WORKFLOW);
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
      "an indirect unguarded matrix fallback",
      SAFE_MATRIX_WORKFLOW.replace(
        "vars.HETZNER_FLEET_ONLINE != 'true' && '[\"ubuntu-latest\"]' || ",
        "",
      ),
    ],
    [
      "a differently named opt-in variable",
      SAFE_MATRIX_WORKFLOW.replace(
        "vars.HETZNER_FLEET_ONLINE",
        "vars.ACTIONS_JANITOR_FLEET_ONLINE",
      ),
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
        /must require explicit HETZNER_FLEET_ONLINE opt-in/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects removal of the required janitor fleet guard", () => {
    const root = buildRepo();
    writeFileSync(
      join(root, ".github", "workflows", "actions-zombie-janitor.yml"),
      `name: Actions Zombie Janitor
jobs:
  reap:
    strategy:
      matrix:
        include:
          - lane: robot-fleet
            runner: \${{ vars.ACTIONS_JANITOR_ROBOT_RUNNER_JSON || '["ubuntu-latest"]' }}
    runs-on: \${{ fromJSON(matrix.runner) }}
`,
    );
    try {
      expect(() => validateHetznerFleetRouting(root)).toThrow(
        /robot-fleet matrix route must retain its explicit fleet opt-in/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the checked-in workflow set is uniformly fail-safe", () => {
    const result = validateHetznerFleetRouting(REAL_REPO_ROOT);
    expect(result.files).toBeGreaterThan(10);
    expect(result.selectors).toBeGreaterThan(30);
  });

  test("keeps bounded dev readiness on an isolated hosted runner", () => {
    const source = readFileSync(
      join(REAL_REPO_ROOT, ".github", "workflows", "dev-smoke.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      jobs?: Record<string, { "runs-on"?: string }>;
    };

    expect(workflow.jobs?.["dev-smoke"]?.["runs-on"]).toBe("ubuntu-24.04");
  });
});
