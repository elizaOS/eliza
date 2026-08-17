/**
 * Validates that canonical Snap publication is exact-release-bound, protected,
 * and exposes Store credentials only to the steps that authenticate or upload.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowPath = path.join(repoRoot, ".github/workflows/snap-publish.yml");
const workflowSource = fs.readFileSync(workflowPath, "utf8");

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
}

interface WorkflowJob {
  environment?: { name?: string } | string;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const publishJob = workflow.jobs?.["build-and-publish"];

function requireStep(name: string): WorkflowStep {
  const step = publishJob?.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

describe("canonical Snap publication gate", () => {
  test("is callable-only and protected by the production release environment", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_call"]);
    expect(publishJob).toBeDefined();
    expect(
      typeof publishJob?.environment === "string"
        ? publishJob.environment
        : publishJob?.environment?.name,
    ).toBe("production-release");
  });

  test("checks out the finalized source without persisted Git credentials", () => {
    const checkout = publishJob?.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.ref).toBe(`\${{ inputs.source_sha }}`);
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  test("binds the version, tag, checked-out commit, and peeled tag commit", () => {
    const bind = requireStep("Bind Snap build to the finalized tag");
    expect(bind.env?.EXPECTED_SHA).toBe(`\${{ inputs.source_sha }}`);
    expect(bind.env?.EXPECTED_TAG).toBe(`\${{ inputs.tag }}`);
    expect(bind.env?.EXPECTED_VERSION).toBe(`\${{ inputs.version }}`);
    expect(bind.run).toContain(
      'test "$EXPECTED_SHA" = "$(git rev-parse HEAD)"',
    );
    expect(bind.run).toContain('test "$EXPECTED_TAG" = "v$EXPECTED_VERSION"');
    expect(bind.run).toContain("refs/tags/$EXPECTED_TAG^{commit}");

    const updateVersion = requireStep("Update snap version");
    expect(updateVersion.run).toContain("store-release-plan.mjs");
  });

  test("keeps the Store credential out of checkout, setup, and build steps", () => {
    expect(publishJob?.env?.SNAPCRAFT_STORE_CREDENTIALS).toBeUndefined();

    const allowed = new Set([
      "Check Snap Store credentials",
      "Verify Snap Store credentials",
      "Publish to Snap Store",
    ]);
    for (const step of publishJob?.steps ?? []) {
      if (allowed.has(step.name ?? "")) {
        expect(step.env?.SNAPCRAFT_STORE_CREDENTIALS).toBe(
          `\${{ secrets.SNAPCRAFT_STORE_CREDENTIALS }}`,
        );
      } else {
        expect(step.env?.SNAPCRAFT_STORE_CREDENTIALS).toBeUndefined();
      }
    }
  });
});
