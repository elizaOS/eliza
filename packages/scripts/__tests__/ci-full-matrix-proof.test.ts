// Exercises the exhaustive-lane matrix proof (#12342) with synthetic manifests,
// workflow fixtures, and plan JSON — a deterministic, dependency-free harness
// (no real workflow run) that pins the proof's failure modes: missing lane,
// PR-only-pinned lane, and every plan-floor breach.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../ci-full-matrix-proof.mjs", import.meta.url),
);

const HEALTHY_WORKFLOW = `name: Tests
on:
  pull_request:
    branches: [develop]
  schedule:
    - cron: "17 9 * * *"
jobs:
  server-tests:
    name: Server Tests
    if: github.event_name != 'pull_request' || needs.changes.outputs.server == 'true'
    runs-on: ubuntu-24.04
    steps:
      - run: echo server
  client-tests:
    name: Client Tests
    runs-on: ubuntu-24.04
    steps:
      - run: echo client
  ci-ok:
    name: ci-ok
    needs:
      - server-tests
      - client-tests
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;

const HEALTHY_MANIFEST = {
  workflow: "test.yml",
  aggregateStatusJob: "ci-ok",
  workflowLanes: [
    { job: "server-tests", name: "Server Tests" },
    { job: "client-tests", name: "Client Tests" },
  ],
  planFloors: {
    minTaskCount: 3,
    minPackageCount: 2,
    requiredPackages: ["@elizaos/core"],
    nonEmptyScriptLanes: ["test", "test:e2e"],
  },
};

const HEALTHY_PLAN = {
  summary: {
    taskCount: 4,
    packageCount: 3,
    byScript: { test: 3, "test:e2e": 1 },
  },
  tasks: [
    {
      packageName: "@elizaos/core",
      relativeDir: "packages/core",
      scriptName: "test",
    },
    {
      packageName: "@elizaos/agent",
      relativeDir: "packages/agent",
      scriptName: "test",
    },
    {
      packageName: "plugin-x",
      relativeDir: "plugins/plugin-x",
      scriptName: "test",
    },
    {
      packageName: "plugin-x",
      relativeDir: "plugins/plugin-x",
      scriptName: "test:e2e",
    },
  ],
};

function runProof({ workflow, manifest, plan, orchestrator, reusables }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-matrix-proof-"));
  try {
    const workflowPath = join(dir, "test.yml");
    const manifestPath = join(dir, "manifest.json");
    const planPath = join(dir, "plan.json");
    writeFileSync(workflowPath, workflow);
    // The manifest's path fields are resolved relative to the repo root, so
    // point them at the fixtures via absolute paths for the test.
    const resolved = { ...manifest, workflow: workflowPath };
    if (orchestrator) {
      const orchestratorPath = join(dir, "develop-exhaustive.yml");
      writeFileSync(orchestratorPath, orchestrator);
      resolved.exhaustiveOrchestrator = orchestratorPath;
    }
    if (reusables) {
      resolved.reusableWorkflows = Object.entries(reusables).map(
        ([basename, content]) => {
          const p = join(dir, basename);
          writeFileSync(p, content);
          return { workflow: p, name: basename };
        },
      );
    }
    writeFileSync(manifestPath, JSON.stringify(resolved));
    writeFileSync(planPath, JSON.stringify(plan));

    const result = spawnSync(
      process.execPath,
      [script, "--manifest", manifestPath, "--plan-file", planPath],
      { encoding: "utf8" },
    );
    return {
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ci-full-matrix-proof", () => {
  test("passes when every lane is present and the plan clears its floors", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS every expected lane accounted for");
  });

  test("fails when a manifest lane is missing from the workflow", () => {
    const manifest = {
      ...HEALTHY_MANIFEST,
      workflowLanes: [
        ...HEALTHY_MANIFEST.workflowLanes,
        { job: "ghost-lane", name: "Ghost Lane" },
      ],
    };
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing lane");
    expect(result.stderr).toContain("ghost-lane");
  });

  test("fails when a lane is pinned to pull_request only", () => {
    const workflow = HEALTHY_WORKFLOW.replace(
      "    name: Client Tests\n    runs-on: ubuntu-24.04",
      "    name: Client Tests\n    if: github.event_name == 'pull_request'\n    runs-on: ubuntu-24.04",
    );
    const result = runProof({
      workflow,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpectedly skipped lane");
    expect(result.stderr).toContain("client-tests");
  });

  test("fails when the aggregate status job drops a lane dependency", () => {
    const workflow = HEALTHY_WORKFLOW.replace("      - client-tests\n", "");
    const result = runProof({
      workflow,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("aggregate drift");
    expect(result.stderr).toContain("client-tests");
  });

  test("fails when the plan collected fewer tasks than the floor", () => {
    const plan = {
      ...HEALTHY_PLAN,
      summary: { ...HEALTHY_PLAN.summary, taskCount: 1 },
    };
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("taskCount 1 < minTaskCount");
  });

  test("fails when a required package has no discovered test task", () => {
    const plan = {
      ...HEALTHY_PLAN,
      tasks: HEALTHY_PLAN.tasks.filter(
        (t) => t.packageName !== "@elizaos/core",
      ),
      summary: { ...HEALTHY_PLAN.summary, taskCount: 3 },
    };
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required package "@elizaos/core"');
  });

  test("fails when a whole script lane collected zero tasks", () => {
    const plan = {
      ...HEALTHY_PLAN,
      summary: {
        ...HEALTHY_PLAN.summary,
        byScript: { test: 4 }, // test:e2e lane vanished
      },
    };
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'script lane "test:e2e" collected zero tasks',
    );
  });

  const CALLABLE_WORKFLOW = `name: Reusable
on:
  workflow_call:
  pull_request:
concurrency:
  group: reusable-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
jobs:
  x:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;

  const NON_CALLABLE_WORKFLOW = `name: Reusable
on:
  pull_request:
jobs:
  x:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;

  const CANCELLING_CALLABLE_WORKFLOW = `name: Reusable
on:
  workflow_call:
  pull_request:
concurrency:
  group: reusable-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  x:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;

  function orchestrator(basenames) {
    const lanes = basenames
      .map(
        (b, i) =>
          `  lane${i}:\n    uses: ./.github/workflows/${b}\n    secrets: inherit`,
      )
      .join("\n");
    return `name: Develop Exhaustive\non:\n  schedule:\n    - cron: "0 6 * * *"\njobs:\n${lanes}\n`;
  }

  test("passes when the orchestrator wires every reusable lane and each is callable", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      orchestrator: orchestrator(["windows-ci.yml", "scenario-pr.yml"]),
      reusables: {
        "windows-ci.yml": CALLABLE_WORKFLOW,
        "scenario-pr.yml": CALLABLE_WORKFLOW,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS every expected lane accounted for");
  });

  test("fails when the orchestrator drops a reusable lane's uses:", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      // Only wires windows-ci; scenario-pr is listed but not invoked.
      orchestrator: orchestrator(["windows-ci.yml"]),
      reusables: {
        "windows-ci.yml": CALLABLE_WORKFLOW,
        "scenario-pr.yml": CALLABLE_WORKFLOW,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing reusable lane");
    expect(result.stderr).toContain("scenario-pr.yml");
  });

  test("fails when a listed reusable workflow no longer declares workflow_call", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      orchestrator: orchestrator(["windows-ci.yml", "scenario-pr.yml"]),
      reusables: {
        "windows-ci.yml": CALLABLE_WORKFLOW,
        "scenario-pr.yml": NON_CALLABLE_WORKFLOW,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reusable workflow not callable");
    expect(result.stderr).toContain("scenario-pr.yml");
  });

  test("fails when a reusable workflow can cancel scheduled exhaustive coverage", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      orchestrator: orchestrator(["windows-ci.yml", "scenario-pr.yml"]),
      reusables: {
        "windows-ci.yml": CALLABLE_WORKFLOW,
        "scenario-pr.yml": CANCELLING_CALLABLE_WORKFLOW,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "reusable workflow can cancel scheduled coverage",
    );
    expect(result.stderr).toContain("scenario-pr.yml");
  });

  test("proves the real committed manifest against the real workflow + plan", () => {
    // No fixtures: run the shipped script with its default manifest and let it
    // spawn `run-all-tests.mjs --plan=json` (which does whole-repo workspace
    // discovery). This is the guard that the manifest stays honest as the repo
    // evolves.
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS every expected lane accounted for");
  }, 60_000);
});
