/**
 * Guards the production-deploy admission topology fixed for #18092: a job
 * waiting on a protected `environment` approval must never own a shared
 * workflow-level concurrency group, or the wait head-of-line blocks every
 * newer canonical run at `pending` with zero jobs. Admission is therefore
 * per-run (or per-PR) at the workflow level, and mutation is serialized by
 * job-level groups with `cancel-in-progress: false` and `queue: max`.
 * Deterministic static checks against the checked-in workflow YAML.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

interface ConcurrencyBlock {
  group?: string;
  "cancel-in-progress"?: boolean | string;
  queue?: string;
}

interface WorkflowJob {
  concurrency?: ConcurrencyBlock;
  environment?: string;
}

interface Workflow {
  concurrency?: ConcurrencyBlock;
  jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(name: string): Workflow {
  return Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows", name), "utf8"),
  ) as Workflow;
}

const cfDeploy = loadWorkflow("cloud-cf-deploy.yml");
const cfRelease = loadWorkflow("cloud-cf-release.yml");
const aasa = loadWorkflow("deploy-aasa.yml");
const provisioning = loadWorkflow("deploy-eliza-provisioning-worker.yml");

/** Asserts a workflow-level group admits every non-PR run independently. */
function expectPerRunAdmission(workflow: Workflow): void {
  const group = workflow.concurrency?.group ?? "";
  expect(group).toContain("format('run-{0}', github.run_id)");
}

/** Asserts a mutation lock is a shared serial queue, never an eviction race. */
function expectSerialMutationLock(job: WorkflowJob | undefined): void {
  const lock = job?.concurrency;
  expect(lock?.group).toBeDefined();
  expect(lock?.group).not.toContain("github.run_id");
  expect(lock?.group).not.toContain("github.sha");
  expect(lock?.["cancel-in-progress"]).toBe(false);
  expect(lock?.queue).toBe("max");
}

describe("cloud-cf-deploy approval/concurrency topology (#18092)", () => {
  it("admits every non-PR run into a unique workflow group", () => {
    const group = cfDeploy.concurrency?.group ?? "";
    expect(group).toContain(
      "github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id)",
    );
    expect(String(cfDeploy.concurrency?.["cancel-in-progress"])).toContain(
      "github.event_name == 'pull_request'",
    );
  });

  it("keeps production approval outside every mutation lock", () => {
    const approval = cfDeploy.jobs?.["authorize-production"];
    expect(approval).toBeDefined();
    expect(approval?.environment).toBe("production");
    expect(approval?.concurrency).toBeUndefined();
  });

  it("serializes release mutation on a per-environment job lock", () => {
    expectSerialMutationLock(cfDeploy.jobs?.release);
    const group = cfDeploy.jobs?.release?.concurrency?.group ?? "";
    expect(group).toContain("'production' || 'staging'");
  });

  it("leaves release serialization to the caller job lock", () => {
    expect(cfRelease.concurrency).toBeUndefined();
    for (const [name, job] of Object.entries(cfRelease.jobs ?? {})) {
      expect(job.concurrency, `cloud-cf-release job ${name}`).toBeUndefined();
    }
  });
});

describe("deploy-aasa approval/concurrency topology (#18092)", () => {
  it("admits every run into a unique workflow group without eviction", () => {
    expectPerRunAdmission(aasa);
    expect(aasa.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("keeps the production publish lock at job level as a serial queue", () => {
    const publish = Object.values(aasa.jobs ?? {}).find(
      (job) => job.environment === "production",
    );
    expect(publish).toBeDefined();
    expectSerialMutationLock(publish);
  });
});

describe("provisioning-worker approval/concurrency topology (#18092)", () => {
  it("admits every run into a unique workflow group without eviction", () => {
    expectPerRunAdmission(provisioning);
    expect(provisioning.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("keeps the deploy mutation lock at job level as a serial queue", () => {
    expectSerialMutationLock(provisioning.jobs?.deploy);
    expect(provisioning.jobs?.deploy?.environment).toContain(
      "needs.determine-env.outputs.environment",
    );
  });
});
