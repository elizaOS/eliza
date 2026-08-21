/** Verifies the read-only workflow used to obtain staging identity receipts. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface Step {
  env?: Record<string, string>;
  name?: string;
  run?: string;
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
    report: {
      concurrency: { group: string; "cancel-in-progress": boolean };
      env: Record<string, string>;
      environment: string;
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
const job = workflow.jobs.report;

function expression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

function step(name: string): Step {
  const value = job.steps.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing workflow step: ${name}`);
  return value;
}

describe("database identity staging report workflow", () => {
  test("is manual, staging-bound, serialized, and read-only to GitHub", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("staging");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(10);
    expect(job.concurrency).toEqual({
      group: "database-identity-staging-report",
      "cancel-in-progress": false,
    });
  });

  test("binds the protected URL only to report mode for staging", () => {
    expect(job.env.DATABASE_URL).toBe(expression("secrets.DATABASE_URL"));
    expect(job.env.DATABASE_IDENTITY_GATE_MODE).toBe("report");
    expect(job.env.DATABASE_IDENTITY_ENVIRONMENT).toBe("staging");
    expect(job.env).not.toHaveProperty(
      "DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256",
    );
    expect(job.env).not.toHaveProperty(
      "DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256",
    );
  });

  test("requires the exact develop commit", () => {
    const guard = step("Require exact develop commit");
    expect(guard.env?.EXPECTED_COMMIT).toBe(
      expression("inputs.expected_cloud_commit"),
    );
    expect(guard.env?.CHECKED_OUT_COMMIT).toBe(expression("github.sha"));
    expect(guard.run).toContain('"refs/heads/develop"');
    expect(guard.run).toContain("expected !== checkedOut");
    expect(guard.run).toContain("/^[0-9a-f]{40}$/");
  });

  test("runs only contract checks and the read-only reporter", () => {
    expect(step("Setup Bun").with?.["bun-version"]).toBe("1.3.14");
    expect(step("Install deterministic dependencies").run).toBe(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    expect(step("Validate identity reporter contracts").run).toContain(
      "preflight-database-identity.test.ts",
    );
    expect(step("Emit redacted staging identity receipts").run).toBe(
      "bun run packages/cloud/scripts/admin/preflight-database-identity.ts",
    );
  });
});
