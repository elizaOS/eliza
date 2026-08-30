/** Verifies the read-only workflow used to obtain staging identity receipts. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface Step {
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
}

interface Workflow {
  on: {
    workflow_dispatch: {
      inputs: Record<string, { required: boolean; type: string }>;
    };
  };
  permissions: Record<string, string>;
  jobs: {
    admission: {
      "continue-on-error"?: boolean | string;
      env?: Record<string, string>;
      environment?: string;
      "runs-on": string;
      steps: Step[];
      "timeout-minutes": number;
    };
    report: {
      "continue-on-error"?: boolean | string;
      concurrency: { group: string; "cancel-in-progress": boolean };
      env: Record<string, string>;
      environment: string;
      if: string;
      needs: string;
      "runs-on": string;
      steps: Step[];
      "timeout-minutes": number;
    };
  };
}

const repoRoot = resolve(import.meta.dirname, "../../../..");
const workflow = parse(
  readFileSync(
    resolve(repoRoot, ".github/workflows/database-identity-staging-report.yml"),
    "utf8",
  ),
) as Workflow;
const admission = workflow.jobs.admission;
const job = workflow.jobs.report;

function expression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

const DATABASE_URL_SECRET_REFERENCE =
  /\bsecrets\s*(?:\.\s*DATABASE_URL\b|\[\s*["']DATABASE_URL["']\s*\])/i;

function sensitiveDatabaseUrlPaths(root: unknown): {
  databaseUrlKeys: string[];
  secretReferences: string[];
} {
  const databaseUrlKeys: string[] = [];
  const secretReferences: string[] = [];

  function visit(
    value: unknown,
    path: string,
    ancestors: ReadonlySet<object>,
  ): void {
    if (
      typeof value === "string" &&
      DATABASE_URL_SECRET_REFERENCE.test(value)
    ) {
      secretReferences.push(path);
    }
    if (value === null || typeof value !== "object") return;
    if (ancestors.has(value)) throw new Error(`Cyclic YAML alias at ${path}`);

    const branchAncestors = new Set(ancestors);
    branchAncestors.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        visit(child, `${path}[${index}]`, branchAncestors);
      });
      return;
    }

    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const childPath = `${path}.${key}`;
      if (key === "DATABASE_URL") databaseUrlKeys.push(childPath);
      visit(child, childPath, branchAncestors);
    }
  }

  visit(root, "$", new Set());
  return { databaseUrlKeys, secretReferences };
}

function reportStep(name: string): Step {
  const value = job.steps.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing workflow step: ${name}`);
  return value;
}

function admissionStep(name: string): Step {
  const value = admission.steps.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing admission step: ${name}`);
  return value;
}

describe("database identity staging report workflow", () => {
  test("admits only manual develop runs before attaching staging", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs).sort()).toEqual(["admission", "report"]);
    expect(admission["continue-on-error"]).toBeUndefined();
    expect(admission.environment).toBeUndefined();
    expect(admission.env).toBeUndefined();
    expect(admission["runs-on"]).toBe("ubuntu-24.04");
    expect(admission["timeout-minutes"]).toBe(2);
    expect(job.needs).toBe("admission");
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job.if).toBe(
      "needs.admission.result == 'success' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/develop'",
    );
    expect(job.environment).toBe("staging");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(10);
    expect(job.concurrency).toEqual({
      group: "database-identity-staging-report",
      "cancel-in-progress": false,
    });
    for (const [jobName, steps] of [
      ["admission", admission.steps],
      ["report", job.steps],
    ] as const) {
      for (const step of steps) {
        expect(
          step["continue-on-error"],
          `${jobName} step ${step.name ?? "<unnamed>"}`,
        ).toBeUndefined();
      }
    }
  });

  test("binds the protected URL only to the redacted reporter step", () => {
    expect(job.env).not.toHaveProperty("DATABASE_URL");
    expect(job.env.DATABASE_IDENTITY_GATE_MODE).toBe("report");
    expect(job.env.DATABASE_IDENTITY_ENVIRONMENT).toBe("staging");
    expect(job.env).not.toHaveProperty(
      "DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256",
    );
    expect(job.env).not.toHaveProperty(
      "DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256",
    );

    const reporterIndexes = job.steps.flatMap((candidate, index) =>
      candidate.name === "Emit redacted staging identity receipts"
        ? [index]
        : [],
    );
    expect(reporterIndexes).toEqual([job.steps.length - 1]);
    const reporterIndex = reporterIndexes[0];
    if (reporterIndex === undefined) throw new Error("Missing reporter step");
    const reporter = job.steps[reporterIndex];
    if (!reporter) throw new Error("Missing reporter step");
    expect(reporter.env?.DATABASE_URL).toBe(expression("secrets.DATABASE_URL"));
    expect(reporter["continue-on-error"]).toBeUndefined();

    const expectedPath = `$.jobs.report.steps[${reporterIndex}].env.DATABASE_URL`;
    expect(sensitiveDatabaseUrlPaths(workflow)).toEqual({
      databaseUrlKeys: [expectedPath],
      secretReferences: [expectedPath],
    });
  });

  test("does not collapse aliased sensitive scopes during validation", () => {
    const aliased = parse(
      [
        "steps:",
        "  - &reporter",
        "    name: Emit redacted staging identity receipts",
        "    env:",
        `      DATABASE_URL: ${expression("secrets.DATABASE_URL")}`,
        "  - *reporter",
      ].join("\n"),
    ) as { steps: Step[] };

    expect(aliased.steps[0]).toBe(aliased.steps[1]);
    expect(sensitiveDatabaseUrlPaths(aliased)).toEqual({
      databaseUrlKeys: [
        "$.steps[0].env.DATABASE_URL",
        "$.steps[1].env.DATABASE_URL",
      ],
      secretReferences: [
        "$.steps[0].env.DATABASE_URL",
        "$.steps[1].env.DATABASE_URL",
      ],
    });
  });

  test("detects sensitive keys and references across every workflow scope", () => {
    const misplaced = {
      env: {
        DATABASE_URL: expression("env.INDIRECT_DATABASE_URL"),
        INDIRECT_DATABASE_URL: expression("secrets.DATABASE_URL"),
      },
      jobs: {
        report: {
          container: {
            env: {
              DATABASE_URL: expression("secrets.DATABASE_URL"),
            },
            volumes: [expression("secrets.DATABASE_URL")],
          },
          env: {
            DATABASE_URL: expression("env.INDIRECT_DATABASE_URL"),
          },
          services: {
            postgres: {
              env: {
                DATABASE_URL: expression(`secrets["DATABASE_URL"]`),
              },
            },
          },
          steps: [
            {
              with: {
                connection: expression("secrets.DATABASE_URL"),
              },
            },
          ],
        },
      },
    };

    expect(sensitiveDatabaseUrlPaths(misplaced)).toEqual({
      databaseUrlKeys: [
        "$.env.DATABASE_URL",
        "$.jobs.report.container.env.DATABASE_URL",
        "$.jobs.report.env.DATABASE_URL",
        "$.jobs.report.services.postgres.env.DATABASE_URL",
      ],
      secretReferences: [
        "$.env.INDIRECT_DATABASE_URL",
        "$.jobs.report.container.env.DATABASE_URL",
        "$.jobs.report.container.volumes[0]",
        "$.jobs.report.services.postgres.env.DATABASE_URL",
        "$.jobs.report.steps[0].with.connection",
      ],
    });
  });

  test("rejects an untrusted ref or commit without attaching staging", () => {
    const guard = admissionStep("Reject untrusted source");
    expect(guard["continue-on-error"]).toBeUndefined();
    expect(guard.shell).toBe("bash");
    expect(guard.env?.EXPECTED_COMMIT).toBe(
      expression("inputs.expected_cloud_commit"),
    );
    expect(guard.env?.CHECKED_OUT_COMMIT).toBe(expression("github.sha"));
    expect(guard.env?.SOURCE_REF).toBe(expression("github.ref"));
    expect(guard.run).toContain('"refs/heads/develop"');
    expect(guard.run).toContain('"$EXPECTED_COMMIT" != "$CHECKED_OUT_COMMIT"');
    expect(guard.run).toContain("^[0-9a-f]{40}$");
    expect(guard.run).not.toContain("secrets.");

    const trustedCommit = "a".repeat(40);
    const cases = [
      {
        name: "trusted exact develop commit",
        expectedExit: 0,
        expectedCommit: trustedCommit,
        checkedOutCommit: trustedCommit,
        sourceRef: "refs/heads/develop",
      },
      {
        name: "wrong source ref",
        expectedExit: 1,
        expectedCommit: trustedCommit,
        checkedOutCommit: trustedCommit,
        sourceRef: "refs/heads/feature",
      },
      {
        name: "malformed expected commit",
        expectedExit: 1,
        expectedCommit: "deadbeef",
        checkedOutCommit: trustedCommit,
        sourceRef: "refs/heads/develop",
      },
      {
        name: "mismatched checked-out commit",
        expectedExit: 1,
        expectedCommit: trustedCommit,
        checkedOutCommit: "b".repeat(40),
        sourceRef: "refs/heads/develop",
      },
    ] as const;

    for (const scenario of cases) {
      const result = Bun.spawnSync(["/bin/bash", "-c", guard.run ?? ""], {
        env: {
          CHECKED_OUT_COMMIT: scenario.checkedOutCommit,
          EXPECTED_COMMIT: scenario.expectedCommit,
          SOURCE_REF: scenario.sourceRef,
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, scenario.name).toBe(scenario.expectedExit);
      expect(result.stderr.toString(), scenario.name).toBe("");
      expect(result.stdout.toString(), scenario.name).not.toMatch(
        /[0-9a-f]{40}/,
      );
    }
  });

  test("runs only contract checks and the read-only reporter", () => {
    const setup = reportStep("Setup Bun workspace");
    expect(setup.uses).toBe("./.github/actions/setup-bun-workspace");
    expect(setup.with).toMatchObject({
      "bun-version": "1.3.14",
      "setup-python": "false",
      "install-protoc": "false",
      "install-native-deps": "false",
      "run-postinstall": "false",
    });
    const linkedBuild = reportStep("Build required linked runtime").run;
    expect(linkedBuild).toContain(
      "bun run --cwd packages/prompts build:package",
    );
    expect(linkedBuild).toContain("bun run --cwd packages/shared build");
    expect(linkedBuild).toContain("bun run --cwd packages/core build");
    expect(reportStep("Probe fixed runtime dependencies").run).toBe(
      "bun run packages/cloud/scripts/admin/preflight-database-identity.ts --probe-dependencies",
    );
    const buildIndex = job.steps.findIndex(
      (candidate) => candidate.name === "Build required linked runtime",
    );
    const probeIndex = job.steps.findIndex(
      (candidate) => candidate.name === "Probe fixed runtime dependencies",
    );
    const reporterIndex = job.steps.findIndex(
      (candidate) =>
        candidate.name === "Emit redacted staging identity receipts",
    );
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(probeIndex).toBeGreaterThan(buildIndex);
    expect(reporterIndex).toBeGreaterThan(probeIndex);
    expect(reportStep("Validate identity reporter contracts").run).toContain(
      "preflight-database-identity.test.ts",
    );
    expect(reportStep("Emit redacted staging identity receipts").run).toBe(
      "bun run packages/cloud/scripts/admin/preflight-database-identity.ts",
    );
  });
});
