/**
 * Pins the develop-health.yml canonical trunk-signal contract (#19181).
 * During merge waves hosted capacity can delay the bounded canonical push queue
 * and arrivals beyond its 100-pending limit can be rejected, so this lane exists
 * to produce an independent signal that always terminates. It must stay
 * schedule/dispatch-only, never cancel in progress, never share a ref-scoped
 * concurrency group with push runs, measure the live develop tip, stay one job
 * wide, and publish a `develop-health` commit status on the exact SHA it measured.
 * Deterministic, reads the real workflow file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowPath = join(
  repoRoot,
  ".github",
  "workflows",
  "develop-health.yml",
);
const source = readFileSync(workflowPath, "utf8");

interface Step {
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

const workflow = Bun.YAML.parse(source) as {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      "runs-on"?: string;
      "timeout-minutes"?: number;
      permissions?: Record<string, string>;
      steps?: Step[];
    }
  >;
};

describe("develop-health.yml canonical trunk-signal contract", () => {
  test("triggers only on schedule and manual dispatch, never on push", () => {
    const triggers = Object.keys(workflow.on ?? {}).sort();
    expect(triggers).toEqual(["schedule", "workflow_dispatch"]);
  });

  test("uses one fixed concurrency group that never cancels in progress", () => {
    // A ref- or run-scoped group would either park the lane behind the
    // develop push queue or allow unbounded pile-up; a fixed group bounds it
    // to one running plus one pending run.
    expect(workflow.concurrency?.group).toBe("develop-health");
    expect(workflow.concurrency?.group).not.toContain("${{");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("stays one job wide so the observer does not add fleet fan-out", () => {
    const jobs = Object.keys(workflow.jobs ?? {});
    expect(jobs).toEqual(["verify"]);
    const steps = workflow.jobs?.verify?.steps ?? [];
    expect(steps.some((step) => step.uses?.startsWith("./"))).toBe(false);
  });

  test("checks out the live develop tip on a hosted runner", () => {
    const job = workflow.jobs?.verify;
    expect(job?.["runs-on"]).toBe("ubuntu-24.04");
    expect(job?.["timeout-minutes"]).toBeGreaterThanOrEqual(60);
    const checkout = job?.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.ref).toBe("develop");
  });

  test("runs the repository verify gate", () => {
    const steps = workflow.jobs?.verify?.steps ?? [];
    expect(steps.some((step) => step.run === "bun run verify")).toBe(true);
  });

  test("publishes a develop-health commit status on success and failure", () => {
    const status = workflow.jobs?.verify?.steps?.find((step) =>
      step.run?.includes("statuses/"),
    );
    expect(status?.if).toBe("success() || failure()");
    expect(status?.run).toContain('context="develop-health"');
    // The status must land on the measured SHA, not github.sha, so a manual
    // dispatch resolved from an older workflow revision still stamps the tip
    // it actually verified.
    expect(status?.env?.SHA).toBe("${{ steps.tip.outputs.sha }}");
  });

  test("grants status writes only at the job scope", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs?.verify?.permissions?.statuses).toBe("write");
  });

  test("pins toolchain versions to the repository contract", () => {
    expect(source).toContain('bun-version: "1.3.14"');
    expect(source).toContain('node-version: "24.15.0"');
  });
});
