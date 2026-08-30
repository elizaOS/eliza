/** Verifies the read-only workflow used to obtain staging identity receipts. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface Step {
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
      env?: Record<string, string>;
      environment?: string;
      "runs-on": string;
      steps: Step[];
      "timeout-minutes": number;
    };
    report: {
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
    expect(admission.environment).toBeUndefined();
    expect(admission.env).toBeUndefined();
    expect(admission["runs-on"]).toBe("ubuntu-24.04");
    expect(admission["timeout-minutes"]).toBe(2);
    expect(job.needs).toBe("admission");
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

  test("rejects an untrusted ref or commit without attaching staging", () => {
    const guard = admissionStep("Reject untrusted source");
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
