/**
 * Guards the production-deploy admission topology fixed for #18092: a job
 * waiting on a protected `environment` approval must never own a shared
 * workflow-level concurrency group, or the wait head-of-line blocks every
 * newer canonical run at `pending` with zero jobs. Admission is therefore
 * per-run (or per-PR) at the workflow level. For workflows that rely on
 * GitHub job-level locking (cloud-cf-deploy, deploy-aasa) that lock must be a
 * shared serial queue (`cancel-in-progress: false`, `queue: max`) and must
 * never carry per-run ids. The provisioning-worker deploy is the deliberate
 * exception (#29337): its job concurrency key is run-unique queue-lease
 * isolation so a canceled run cannot hold a stale pending slot, because the
 * deploy's real cross-run mutation serializer is the remote-host `flock` in
 * `/tmp`, which protects `/opt/eliza` mutations. Deterministic static checks
 * against the checked-in workflow YAML.
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
  steps?: Array<{
    name?: string;
    with?: { command_timeout?: string; envs?: string; script?: string };
  }>;
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

  it("uses a run-unique deploy lease while the host flock serializes mutation (#29337)", () => {
    const deploy = provisioning.jobs?.deploy;
    const lock = deploy?.concurrency;
    // #29337 deliberately makes the job queue key run-unique so a canceled
    // zero-step run cannot hold a stale GitHub pending slot; serialization is
    // owned by the remote host flock, not this group. Keep the non-eviction
    // guarantees the queue is supposed to provide when it does contend.
    expect(lock?.group).toBeDefined();
    expect(lock?.group).toContain("format('run-{0}', github.run_id)");
    expect(lock?.["cancel-in-progress"]).toBe(false);
    expect(lock?.queue).toBe("max");
    expect(deploy?.environment).toContain(
      "needs.determine-env.outputs.environment",
    );

    // The real cross-run mutation serializer: the deploy SSH step must
    // acquire the host lock on the shared checkout before mutating it.
    const hostStep = deploy?.steps?.find(
      (step) => step.name === "Deploy and restart worker",
    );
    expect(hostStep?.with?.script).toContain(
      "/tmp/eliza-provisioning-worker-deploy.lock",
    );
    expect(hostStep?.with?.script).toContain("flock -w 1200 9");
  });

  it("serializes deployment identity through health or fails as superseded", () => {
    const steps = provisioning.jobs?.deploy?.steps ?? [];
    const deployStep = steps.find(
      (step) => step.name === "Deploy and restart worker",
    );
    const healthStep = steps.find((step) => step.name === "Health check");
    const deployScript = deployStep?.with?.script ?? "";
    const healthScript = healthStep?.with?.script ?? "";
    const lockPath = "/tmp/eliza-provisioning-worker-deploy.lock";

    expect(deployScript).toContain(`exec 9>${lockPath}`);
    expect(healthScript).toContain(`exec 9>${lockPath}`);
    expect(healthStep?.with?.command_timeout).toBe("25m");
    expect(healthStep?.with?.envs?.split(",")).toContain("DEPLOY_SHA");

    const healthLockIndex = healthScript.indexOf("flock -w 1200 9");
    const checkoutReadIndex = healthScript.indexOf(
      "ACTUAL_DEPLOY_SHA=$(git rev-parse HEAD)",
    );
    const identityCheckIndex = healthScript.indexOf(
      'if [ "$ACTUAL_DEPLOY_SHA" != "$DEPLOY_SHA" ]',
    );
    const healthLoopIndex = healthScript.indexOf("for attempt in $(seq 1 18)");
    expect(healthLockIndex).toBeGreaterThanOrEqual(0);
    expect(checkoutReadIndex).toBeGreaterThan(healthLockIndex);
    expect(identityCheckIndex).toBeGreaterThan(checkoutReadIndex);
    expect(healthLoopIndex).toBeGreaterThan(identityCheckIndex);
    expect(healthScript).toContain(
      "Provisioning deployment was superseded before health verification",
    );
  });
});
