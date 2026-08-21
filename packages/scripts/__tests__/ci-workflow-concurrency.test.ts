/**
 * Pins the two-level canonical CI concurrency contract. The push-only wrapper
 * uses GitHub's bounded max queue while the reusable graph preserves stale PR
 * and merge-candidate cancellation.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

type Permissions = Record<string, string>;

interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: string | boolean;
    queue?: string;
  };
  permissions?: Permissions;
  jobs?: Record<
    string,
    { uses?: string; permissions?: Permissions; name?: string }
  >;
}

function readWorkflow(name: string): Workflow {
  const source = readFileSync(
    join(repoRoot, ".github", "workflows", name),
    "utf8",
  );
  return Bun.YAML.parse(source) as Workflow;
}

const workflow = readWorkflow("ci.yml");
const pushWrapper = readWorkflow("ci-develop-push.yml");
const autoheal = readWorkflow("claude-ci-autoheal.yml");

describe("ci.yml internal concurrency contract", () => {
  const concurrency = workflow.concurrency;
  const group = concurrency?.group ?? "";

  test("has no direct push trigger and remains reusable", () => {
    expect(workflow.on?.push).toBeUndefined();
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on).toHaveProperty("merge_group");
    expect(workflow.on).toHaveProperty("workflow_call");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  test("gives caller-backed push, schedule, and dispatch runs independent groups", () => {
    expect(group).toContain("format('run-{0}', github.run_id)");
  });

  test("supersedes pull-request runs by pull-request number", () => {
    expect(group).toContain(
      "github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number)",
    );
  });

  test("supersedes merge-group runs by their stable candidate ref", () => {
    expect(group).toContain(
      "github.event_name == 'merge_group' && format('merge-{0}', github.ref)",
    );
  });

  test("does not let a Nightly caller collide with a queued develop push", () => {
    expect(group).not.toContain("|| github.ref || github.run_id");
    expect(group).not.toContain("github.event_name == 'push'");
  });

  test("keeps its group distinct from the develop-push wrapper", () => {
    expect(group).toStartWith("ci-internal-");
    expect(group).not.toBe(pushWrapper.concurrency?.group);
    expect(concurrency?.queue).toBeUndefined();
  });

  test("cancels only stale pull-request and merge-group work", () => {
    expect(concurrency?.["cancel-in-progress"]).toBe(
      `\${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}`,
    );
  });
});

describe("ci-develop-push.yml queue contract", () => {
  const concurrency = pushWrapper.concurrency;
  const group = concurrency?.group ?? "";
  const job = pushWrapper.jobs?.ci;

  test("owns only the direct develop push trigger", () => {
    expect(pushWrapper.name).toBe("CI Develop Push");
    expect(Object.keys(pushWrapper.on ?? {})).toEqual(["push"]);
    expect(pushWrapper.on?.push).toEqual({ branches: ["develop"] });
  });

  test("uses one stable bounded max queue without run-scoped identity", () => {
    expect(group).toBe(`ci-develop-push-\${{ github.ref }}`);
    expect(group).not.toContain("github.run_id");
    expect(group).not.toContain("github.sha");
    expect(concurrency?.["cancel-in-progress"]).toBe(false);
    expect(concurrency?.queue).toBe("max");
  });

  test("calls canonical CI with the transitive permission ceiling", () => {
    expect(job?.uses).toBe("./.github/workflows/ci.yml");
    expect(pushWrapper.permissions).toEqual({ contents: "read" });
    expect(job?.permissions).toEqual({
      actions: "read",
      contents: "read",
      issues: "write",
    });
  });

  test("keeps develop-push failures visible to CI autoheal", () => {
    const workflowRun = autoheal.on?.workflow_run as
      | { workflows?: string[] }
      | undefined;
    expect(workflowRun?.workflows).toContain(pushWrapper.name);
  });
});
