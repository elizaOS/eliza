/** Verifies the manual workflow that owns the protected staging re-review boundary. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

type Step = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
const repoRoot = resolve(import.meta.dirname, "../../../..");
const workflow = parse(
  readFileSync(
    resolve(
      repoRoot,
      ".github/workflows/personal-dedicated-rereview-staging.yml",
    ),
    "utf8",
  ),
) as {
  on: { workflow_dispatch: { inputs: Record<string, { required: boolean }> } };
  permissions: Record<string, string>;
  jobs: {
    rereview: {
      environment: string;
      concurrency: Record<string, unknown>;
      env: Record<string, string>;
      steps: Step[];
    };
  };
};
const job = workflow.jobs.rereview;
const step = (name: string) => {
  const found = job.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
};

describe("personal Dedicated staging re-review workflow", () => {
  test("is manual, staging protected, serialized, and GitHub read-only", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("staging");
    expect(job.concurrency).toEqual({
      group: "personal-dedicated-rereview-staging",
      "cancel-in-progress": false,
    });
  });

  test("requires exact develop SHA, prior digest, reviewed reason, and confirmation", () => {
    const guard = step("Require exact develop deployment authority");
    expect(guard.run).toContain(
      'process.env.REF_NAME !== "refs/heads/develop"',
    );
    expect(guard.run).toContain("expected !== process.env.CHECKED_OUT_COMMIT");
    expect(guard.run).toContain("APPROVAL_DIGEST");
    expect(guard.run).toContain(
      "retain_current_receipt_target_after_duplicate_inventory_review",
    );
    expect(guard.run).toContain(
      "REREVIEW_STALE_SELECTION_WITHOUT_COMPUTE_MUTATION",
    );
  });

  test("binds protected identity and smoke account authorities without artifacts", () => {
    expect(job.env.DATABASE_IDENTITY_GATE_MODE).toBe("enforce");
    expect(job.env.DATABASE_IDENTITY_ENVIRONMENT).toBe("staging");
    expect(job.env.DATABASE_URL).toContain("secrets.DATABASE_URL");
    expect(job.env.ELIZAOS_CLOUD_API_KEY).toContain(
      "secrets.ELIZAOS_CLOUD_API_KEY",
    );
    expect(step("Verify protected staging database identity").run).toContain(
      "preflight-database-identity.ts",
    );
    expect(
      job.steps.some((candidate) => candidate.run?.includes("upload-artifact")),
    ).toBe(false);
  });
});
