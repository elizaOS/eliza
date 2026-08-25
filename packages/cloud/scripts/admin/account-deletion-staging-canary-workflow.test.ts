/** Verifies the manual workflow that owns the destructive staging canary boundary. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface Step {
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  id?: string;
  if?: string;
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
    canary: {
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
const workflowPath = resolve(
  repoRoot,
  ".github/workflows/account-deletion-staging-canary.yml",
);
const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
const job = workflow.jobs.canary;

function expression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

function step(name: string): Step {
  const value = job.steps.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`Missing workflow step: ${name}`);
  return value;
}

describe("account deletion staging canary workflow", () => {
  test("is manual, staging-bound, serialized, and read-only to GitHub", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("staging");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(95);
    expect(job.concurrency).toEqual({
      group: "account-deletion-staging-canary",
      "cancel-in-progress": false,
    });
    expect(
      workflow.on.workflow_dispatch.inputs.expected_cloud_commit,
    ).toMatchObject({
      required: true,
      type: "string",
    });
    expect(workflow.on.workflow_dispatch.inputs.confirmation).toMatchObject({
      required: true,
      type: "string",
    });
    expect(
      workflow.on.workflow_dispatch.inputs.expected_cluster_sha256,
    ).toMatchObject({ required: true, type: "string" });
    expect(
      workflow.on.workflow_dispatch.inputs.expected_authority_sha256,
    ).toMatchObject({ required: true, type: "string" });
  });

  test("binds exact staging targets and protected authorities", () => {
    expect(job.env.ELIZA_ACCOUNT_DELETION_STAGING_CANARY).toBe("1");
    expect(job.env.ELIZA_ACCOUNT_DELETION_STAGING_CLOUD_BASE_URL).toBe(
      "https://api-staging.eliza.app",
    );
    expect(job.env.ELIZA_ACCOUNT_DELETION_STAGING_STEWARD_BASE_URL).toBe(
      "https://steward-api-staging.up.railway.app",
    );
    expect(job.env.DATABASE_URL).toBe(expression("secrets.DATABASE_URL"));
    expect(job.env.STEWARD_PLATFORM_KEYS).toBe(
      expression("secrets.STEWARD_PLATFORM_KEYS"),
    );
    expect(job.env.ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_CLOUD_COMMIT).toBe(
      expression("inputs.expected_cloud_commit"),
    );
    expect(job.env.ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_CLUSTER_SHA256).toBe(
      expression("inputs.expected_cluster_sha256"),
    );
    expect(
      job.env.ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_AUTHORITY_SHA256,
    ).toBe(expression("inputs.expected_authority_sha256"));
  });

  test("requires the checked-out commit and deliberate destructive phrase", () => {
    const guard = step("Require deliberate exact-commit staging authority");
    expect(guard.env?.EXPECTED_COMMIT).toBe(
      expression("inputs.expected_cloud_commit"),
    );
    expect(guard.env?.CHECKED_OUT_COMMIT).toBe(expression("github.sha"));
    expect(guard.run).toContain("DELETE_DISPOSABLE_STAGING_ACCOUNTS");
    expect(guard.run).toContain("expected !== checkedOut");
    expect(guard.run).toContain("/^[0-9a-f]{40}$/");
  });

  test("runs deterministic contracts before the single destructive invocation", () => {
    expect(step("Setup Bun").with?.["bun-version"]).toBe("1.3.14");
    expect(step("Install deterministic dependencies").run).toBe(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    expect(step("Validate canary contracts").run).toContain(
      "account-deletion-staging-canary.test.ts",
    );
    const live = step("Run bounded disposable staging canary");
    expect(live.id).toBe("live");
    expect(live["continue-on-error"]).toBe(true);
    expect(live.run).toBe(
      "bun run packages/cloud/scripts/admin/account-deletion-staging-canary.ts",
    );
    expect(job.steps.filter((candidate) => candidate.run === live.run)).toEqual(
      [live],
    );
  });

  test("uploads only validated identifier-free evidence and fails on cleanup errors", () => {
    const privacy = step("Validate privacy-safe evidence");
    expect(privacy.if).toBe(expression("always()"));
    expect(privacy.run).toContain(
      "validateAccountDeletionStagingCanaryEvidence",
    );
    expect(privacy.run).toContain("chmod(path, 0o600)");
    expect(privacy.run).toContain('echo "validated=true"');

    const upload = step("Upload identifier-free canary evidence");
    expect(upload.if).toBe(
      expression("always() && steps.privacy.outputs.validated == 'true'"),
    );
    expect(upload.with?.path).toBe(
      "reports/account-deletion-staging-canary.json",
    );
    expect(upload.with?.["retention-days"]).toBe(14);

    const gate = step("Require successful lifecycle and cleanup");
    expect(gate.if).toBe(expression("always()"));
    expect(gate.env?.LIVE_OUTCOME).toBe(expression("steps.live.outcome"));
    expect(gate.run).toContain('test "$LIVE_OUTCOME" = "success"');
    expect(gate.run).toContain('test "$PRIVACY_VALIDATED" = "true"');
  });
});
