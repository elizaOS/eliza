/**
 * Exercises the exhaustive-lane proof with synthetic workflow collisions and
 * the real committed manifest, including reusable-call isolation, consecutive
 * exhaustive queuing, and the canonical quiescent develop result.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../ci-full-matrix-proof.mjs", import.meta.url),
);
const {
  parseArgs: parseProofArgs,
  runProof: executeProof,
  writeSummary: writeProofSummary,
} = await import("../ci-full-matrix-proof.mjs");

function githubExpression(body: string): string {
  return `\${{ ${body} }}`;
}

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

const HEALTHY_POST_MERGE_WORKFLOW = HEALTHY_WORKFLOW.replace(
  "  pull_request:\n",
  "  push:\n    branches: [develop]\n  pull_request:\n",
)
  .replace(
    "jobs:\n",
    `concurrency:\n  group: test-${githubExpression(
      "github.event_name == 'push' && github.ref || format('{0}-{1}', github.event_name, github.run_id)",
    )}\n  cancel-in-progress: ${githubExpression(
      "github.event_name == 'push'",
    )}\njobs:\n`,
  )
  .replace(
    "  ci-ok:\n    name: ci-ok\n",
    `  ci-ok:\n    name: ci-ok\n    if: ${githubExpression(
      "!cancelled() && always()",
    )}\n`,
  );

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

const POST_MERGE_MANIFEST = {
  ...HEALTHY_MANIFEST,
  postMergeSignal: { branch: "develop", aggregateJob: "ci-ok" },
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
      resolved.exhaustiveConcurrencyScope ??= "develop-exhaustive";
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

    const proof = executeProof({
      manifest: manifestPath,
      planFile: planPath,
      summary: null,
    });
    return {
      status: proof.violations.length === 0 ? 0 : 1,
      stdout: [
        ...proof.laneReport.map(
          (row) => `[ci-full-matrix-proof] lane ${row.lane} — ${row.status}`,
        ),
        ...(proof.violations.length === 0
          ? ["PASS every expected lane accounted for"]
          : []),
      ].join("\n"),
      stderr: proof.violations.join("\n"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ci-full-matrix-proof", () => {
  test("parses every CLI path and rejects missing or unknown arguments", () => {
    expect(
      parseProofArgs([
        "--plan-file",
        "plan.json",
        "--manifest",
        "manifest.json",
        "--summary",
        "summary.md",
      ]),
    ).toMatchObject({
      planFile: "plan.json",
      manifest: "manifest.json",
      summary: "summary.md",
    });
    expect(() => parseProofArgs(["--manifest"])).toThrow(
      "--manifest requires a value",
    );
    expect(() => parseProofArgs(["--wat"])).toThrow("unknown argument: --wat");
  });

  test("writes human-reviewable pass and fail summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-matrix-summary-"));
    try {
      const passPath = join(dir, "pass.md");
      writeProofSummary(
        passPath,
        [{ lane: "scenario", name: "Scenario", status: "OK" }],
        [{ metric: "taskCount", value: 4, floor: 3 }],
        [],
      );
      const pass = readFileSync(passPath, "utf8");
      expect(pass).toContain("| `scenario` | Scenario | OK |");
      expect(pass).toContain("**Result: PASS**");

      const failPath = join(dir, "fail.md");
      writeProofSummary(failPath, [], [], ["collision"]);
      const fail = readFileSync(failPath, "utf8");
      expect(fail).toContain("**Result: FAIL** — 1 violation(s)");
      expect(fail).toContain("- collision");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the real CLI exits nonzero and prints a failing fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-matrix-cli-fail-"));
    try {
      const workflowPath = join(dir, "test.yml");
      const manifestPath = join(dir, "manifest.json");
      const planPath = join(dir, "plan.json");
      writeFileSync(workflowPath, HEALTHY_WORKFLOW);
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...HEALTHY_MANIFEST,
          workflow: workflowPath,
          workflowLanes: [
            ...HEALTHY_MANIFEST.workflowLanes,
            { job: "ghost-lane", name: "Ghost Lane" },
          ],
        }),
      );
      writeFileSync(planPath, JSON.stringify(HEALTHY_PLAN));

      const result = spawnSync(
        process.execPath,
        [
          script,
          "--manifest",
          manifestPath,
          "--plan-file",
          planPath,
          "--summary",
          join(dir, "summary.md"),
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ghost-lane");
      expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain(
        "**Result: FAIL**",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  test("models obsolete develop pushes as superseded while preserving a quiescent aggregate", () => {
    const result = runProof({
      workflow: HEALTHY_POST_MERGE_WORKFLOW,
      manifest: POST_MERGE_MANIFEST,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("post-merge:ci-ok — OK");
  });

  test("fails when develop pushes use per-run groups and cannot supersede", () => {
    const workflow = HEALTHY_POST_MERGE_WORKFLOW.replace(
      "github.event_name == 'push' && github.ref || format('{0}-{1}', github.event_name, github.run_id)",
      "github.event_name == 'push' && github.run_id || format('{0}-{1}', github.event_name, github.run_id)",
    );
    const result = runProof({
      workflow,
      manifest: POST_MERGE_MANIFEST,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("post-merge concurrency drift");
  });

  test("fails when pushes can cancel scheduled or manual runs", () => {
    const workflow = HEALTHY_POST_MERGE_WORKFLOW.replace(
      "github.event_name == 'push' && github.ref || format('{0}-{1}', github.event_name, github.run_id)",
      "github.ref",
    );
    const result = runProof({
      workflow,
      manifest: POST_MERGE_MANIFEST,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("isolate schedule/dispatch by run id");
  });

  test("fails when an appended run id defeats push supersession", () => {
    const canonical = githubExpression(
      "github.event_name == 'push' && github.ref || format('{0}-{1}', github.event_name, github.run_id)",
    );
    const workflow = HEALTHY_POST_MERGE_WORKFLOW.replace(
      canonical,
      `${canonical}-${githubExpression("github.run_id")}`,
    );
    const result = runProof({
      workflow,
      manifest: POST_MERGE_MANIFEST,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("post-merge concurrency drift");
  });

  test("fails when the canonical develop aggregate can report after cancellation", () => {
    const workflow = HEALTHY_POST_MERGE_WORKFLOW.replace(
      githubExpression("!cancelled() && always()"),
      githubExpression("always()"),
    );
    const result = runProof({
      workflow,
      manifest: POST_MERGE_MANIFEST,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("canonical post-merge result missing");
  });

  test("fails when an OR-shaped aggregate bypasses cancellation", () => {
    const workflow = HEALTHY_POST_MERGE_WORKFLOW.replace(
      githubExpression("!cancelled() && always()"),
      githubExpression("always() || !cancelled()"),
    );
    const result = runProof({
      workflow,
      manifest: POST_MERGE_MANIFEST,
      plan: HEALTHY_PLAN,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("canonical post-merge result missing");
  });

  const CALLABLE_WORKFLOW = `name: Reusable
on:
  workflow_call:
    inputs:
      concurrency_scope:
        required: false
        type: string
        default: standalone
  pull_request:
concurrency:
  group: reusable-\${{ inputs.concurrency_scope || 'standalone' }}-\${{ github.ref }}
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
    inputs:
      concurrency_scope:
        required: false
        type: string
        default: standalone
  pull_request:
concurrency:
  group: reusable-\${{ inputs.concurrency_scope || 'standalone' }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  x:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;

  const COLLIDING_CALLABLE_WORKFLOW = CALLABLE_WORKFLOW.replace(
    `reusable-${githubExpression("inputs.concurrency_scope || 'standalone'")}-`,
    "reusable-",
  );

  const TRUTHY_COLLIDING_CALLABLE_WORKFLOW = CALLABLE_WORKFLOW.replace(
    "inputs.concurrency_scope || 'standalone'",
    "inputs.concurrency_scope && 'standalone'",
  );

  const SCHEDULE_CANCELLING_WORKFLOW = CALLABLE_WORKFLOW.replace(
    githubExpression("github.event_name == 'pull_request'"),
    githubExpression("github.event_name != 'pull_request'"),
  );

  function orchestrator(
    basenames,
    { passScope = true, cancelInProgress = false, queue = "max" } = {},
  ) {
    const lanes = basenames
      .map(
        (b, i) =>
          `  lane${i}:\n    uses: ./.github/workflows/${b}${
            passScope
              ? "\n    with:\n      concurrency_scope: develop-exhaustive"
              : ""
          }\n    secrets: inherit`,
      )
      .join("\n");
    const queueLine = queue === null ? "" : `  queue: ${queue}\n`;
    return `name: Develop Exhaustive\non:\n  schedule:\n    - cron: "0 6 * * *"\nconcurrency:\n  group: develop-exhaustive-\${{ github.ref }}\n${queueLine}  cancel-in-progress: ${cancelInProgress}\njobs:\n${lanes}\n`;
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
      "reusable workflow can cancel exhaustive coverage",
    );
    expect(result.stderr).toContain("scenario-pr.yml");
  });

  test("fails when an exhaustive caller enters the standalone concurrency group", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      orchestrator: orchestrator(["scenario-pr.yml"], {
        passScope: false,
      }),
      reusables: { "scenario-pr.yml": CALLABLE_WORKFLOW },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "reusable caller shares standalone concurrency",
    );
  });

  test("fails when a reusable group ignores the exhaustive caller scope", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      orchestrator: orchestrator(["scenario-pr.yml"]),
      reusables: { "scenario-pr.yml": COLLIDING_CALLABLE_WORKFLOW },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reusable concurrency collision");
  });

  test("fails when a truthy lookalike collapses both reusable scopes", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      orchestrator: orchestrator(["scenario-pr.yml"]),
      reusables: {
        "scenario-pr.yml": TRUTHY_COLLIDING_CALLABLE_WORKFLOW,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exact inputs.concurrency_scope");
  });

  test("fails when a reusable lane cancels a scheduled caller", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      orchestrator: orchestrator(["scenario-pr.yml"]),
      reusables: { "scenario-pr.yml": SCHEDULE_CANCELLING_WORKFLOW },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cancels schedule");
  });

  test("fails when the next exhaustive invocation can cancel the active one", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      orchestrator: orchestrator(["scenario-pr.yml"], {
        cancelInProgress: true,
      }),
      reusables: { "scenario-pr.yml": CALLABLE_WORKFLOW },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("consecutive exhaustive runs can cancel");
  });

  test("fails when the third exhaustive invocation can replace a pending run", () => {
    const result = runProof({
      workflow: HEALTHY_WORKFLOW,
      manifest: HEALTHY_MANIFEST,
      plan: HEALTHY_PLAN,
      orchestrator: orchestrator(["scenario-pr.yml"], { queue: null }),
      reusables: { "scenario-pr.yml": CALLABLE_WORKFLOW },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("replace pending coverage");
  });

  test("proves the real committed manifest against the real workflow + plan", () => {
    // No fixtures: run the shipped script with its default manifest and let it
    // spawn `run-all-tests.mjs --plan=json` (which does whole-repo workspace
    // discovery). This is the guard that the manifest stays honest as the repo
    // evolves.
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const direct = executeProof({
      manifest: join(repoRoot, "packages/scripts/ci-lane-manifest.json"),
      planFile: null,
      summary: null,
    });
    expect(direct.violations).toEqual([]);

    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS every expected lane accounted for");
  }, 60_000);
});
