/**
 * Validates the Snap Store publication gate wiring in snap-publish.yml: the
 * tagged commit must resolve and pass a protected-branch ancestry check before
 * the production-release approval, and the build must check out the resolved
 * commit rather than the movable tag. Static workflow contract only — no
 * runner, Store, or snapcraft execution.
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
  if?: string;
  name?: string;
  needs?: string | string[];
  environment?: string;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<
    string,
    { inputs?: Record<string, { default?: string; options?: string[] }> }
  >;
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;

function requireJob(id: string): WorkflowJob {
  const job = workflow.jobs?.[id];
  if (!job) throw new Error(`Missing workflow job: ${id}`);
  return job;
}

function requireStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

function needsList(job: WorkflowJob): string[] {
  return typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
}

describe("snap-publish release gate", () => {
  test("the Store upload is gated on the production-release approval", () => {
    const authorize = requireJob("authorize-release");
    expect(authorize.environment).toBe("production-release");
    expect(needsList(authorize)).toEqual(["prepare"]);
    // Approval marker only: no checkout, so the gate itself can never run
    // pipeline code or touch the Store credentials.
    expect(authorize.steps ?? []).toHaveLength(1);
    for (const step of authorize.steps ?? []) {
      expect(step.uses ?? "").not.toContain("checkout");
    }

    const build = requireJob("build-and-publish");
    expect(needsList(build)).toEqual(
      expect.arrayContaining(["prepare", "authorize-release"]),
    );
    expect(build.if).toContain("needs.authorize-release.result == 'success'");
  });

  test("prepare refuses a tagged commit that never landed on a protected branch", () => {
    const prepare = requireJob("prepare");
    const checkout = requireStep(prepare, "Checkout");
    expect(checkout.with?.["fetch-depth"]).toBe(0);

    const resolve = requireStep(prepare, "Resolve tag to peeled commit");
    const ancestry = requireStep(
      prepare,
      "Require tagged commit on a protected branch",
    );
    // The checked commit is exactly the resolved source_sha, and the ancestry
    // step runs after resolution.
    expect(ancestry.env?.SOURCE_SHA).toBe(
      `\${{ steps.version.outputs.source_sha }}`,
    );
    const steps = prepare.steps ?? [];
    expect(steps.indexOf(ancestry)).toBeGreaterThan(steps.indexOf(resolve));

    expect(ancestry.run).toContain(
      'git merge-base --is-ancestor "$SOURCE_SHA" origin/main',
    );
    expect(ancestry.run).toContain(
      'git merge-base --is-ancestor "$SOURCE_SHA" origin/develop',
    );
    expect(ancestry.run).toContain("exit 1");

    // The tag input reaches a refspec, so resolution must reject names with
    // shell or refspec metacharacters before fetching.
    expect(resolve.run).toContain("INPUT_TAG");
    expect(resolve.run).toMatch(/\^v\[0-9\]/);
  });

  test("the build checks out the resolved commit, never the movable tag", () => {
    const build = requireJob("build-and-publish");
    const checkout = build.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout).toBeDefined();
    expect(checkout?.with?.ref).toBe(
      `\${{ needs.prepare.outputs.source_sha }}`,
    );
    // No step anywhere in the workflow may check out the raw tag input.
    for (const line of workflowSource.split("\n")) {
      expect(line).not.toContain(`ref: \${{ inputs.tag }}`);
    }
  });

  test("channels are pinned to edge|beta while the snap is grade: devel", () => {
    const dispatchChannel = workflow.on?.workflow_dispatch?.inputs?.channel;
    expect(dispatchChannel?.options ?? []).toEqual(["edge", "beta"]);
    expect(dispatchChannel?.default).toBe("edge");
    expect(workflow.on?.workflow_call?.inputs?.channel?.default).toBe("edge");

    const build = requireJob("build-and-publish");
    const publish = requireStep(build, "Publish to Snap Store");
    expect(publish.run).toContain("edge|beta");
    expect(publish.run).not.toContain("stable|candidate");
    expect(publish.run).toContain("snapcraft upload");
  });
});
