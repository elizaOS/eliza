/**
 * #18092: admission-before-mutation, with GitHub's real concurrency rules.
 *
 * YAML is checked against the policy module. Overlap cases simulate two and
 * three runs; they do not just grep for group: strings.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  admissionGroup,
  completeConcurrency,
  createConcurrencyGroup,
  overlappingMutations,
  releaseGroup,
  requestConcurrency,
} from "./production-deploy-admission-lock.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");

function readWorkflow(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
}

function workflowConcurrencyBlock(source) {
  const match = source.match(/^concurrency:\n(?: {2}.+\n)+/m);
  if (!match) throw new Error("missing top-level concurrency block");
  return match[0];
}

function jobBlock(source, jobId) {
  const start = source.search(new RegExp(`^  ${jobId}:\\n`, "m"));
  if (start < 0) throw new Error(`missing job ${jobId}`);
  const fromJob = source.slice(start);
  const header = `  ${jobId}:\n`;
  const next = fromJob.slice(header.length).search(/^ {2}[A-Za-z0-9_-]+:/m);
  return next < 0 ? fromJob : fromJob.slice(0, header.length + next);
}

const cloudCf = readWorkflow(".github/workflows/cloud-cf-deploy.yml");
const cloudCfRelease = readWorkflow(".github/workflows/cloud-cf-release.yml");
const provisioning = readWorkflow(
  ".github/workflows/deploy-eliza-provisioning-worker.yml",
);
const aasa = readWorkflow(".github/workflows/deploy-aasa.yml");

describe("admission group policy", () => {
  test("holds SHA constant and still issues distinct non-PR groups", () => {
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const first = admissionGroup({
      eventName: "workflow_dispatch",
      runId: "100",
      sha,
    });
    const second = admissionGroup({
      eventName: "push",
      runId: "101",
      sha,
    });
    expect(first.group).toBe("run-100");
    expect(second.group).toBe("run-101");
    expect(first.group).not.toBe(second.group);
    expect(first.cancelInProgress).toBe(false);
  });

  test("keeps pull-request supersession on the PR number", () => {
    const first = admissionGroup({
      eventName: "pull_request",
      prNumber: 19109,
      runId: "1",
    });
    const second = admissionGroup({
      eventName: "pull_request",
      prNumber: 19109,
      runId: "2",
    });
    expect(first.group).toBe(second.group);
    expect(first.cancelInProgress).toBe(true);
    const group = createConcurrencyGroup(first);
    requestConcurrency(group, "run-1");
    expect(requestConcurrency(group, "run-2")).toBe("active");
    expect(group.cancelled.has("run-1")).toBe(true);
  });
});

describe("GitHub concurrency state model", () => {
  test("two approved releases cannot interleave mutate legs", () => {
    const lock = createConcurrencyGroup(releaseGroup("production"));
    expect(requestConcurrency(lock, "A-release")).toBe("active");
    expect(requestConcurrency(lock, "B-release")).toBe("pending");
    expect(overlappingMutations([{ id: lock.active, phase: "release" }])).toBe(
      false,
    );
    expect(lock.active).toBe("A-release");
    completeConcurrency(lock, "A-release");
    expect(lock.active).toBe("B-release");
    expect(lock.pending).toEqual([]);
  });

  test("default queue:single evicts the pending member, not the active one", () => {
    const lock = createConcurrencyGroup({ cancelInProgress: false });
    requestConcurrency(lock, "A");
    requestConcurrency(lock, "B");
    requestConcurrency(lock, "C");
    expect(lock.active).toBe("A");
    expect(lock.pending).toEqual(["C"]);
    expect(lock.cancelled.has("B")).toBe(true);
    expect(lock.cancelled.has("A")).toBe(false);
  });

  test("queue:max keeps every approved waiter and promotes FIFO by wait-start", () => {
    const lock = createConcurrencyGroup(releaseGroup("production"));
    expect(lock.queue).toBe("max");
    requestConcurrency(lock, "A");
    requestConcurrency(lock, "B");
    requestConcurrency(lock, "C");
    expect(lock.active).toBe("A");
    expect(lock.pending).toEqual(["B", "C"]);
    expect(lock.cancelled.size).toBe(0);
    completeConcurrency(lock, "A");
    expect(lock.active).toBe("B");
    expect(lock.pending).toEqual(["C"]);
    completeConcurrency(lock, "B");
    expect(lock.active).toBe("C");
    expect(lock.pending).toEqual([]);
  });

  test("queue:max cannot combine with cancel-in-progress", () => {
    expect(() =>
      createConcurrencyGroup({ cancelInProgress: true, queue: "max" }),
    ).toThrow(/queue: max/);
  });

  test("queue:max cancels arrivals after 100 pending members", () => {
    const lock = createConcurrencyGroup({
      cancelInProgress: false,
      queue: "max",
    });
    requestConcurrency(lock, "active");
    for (let i = 0; i < 100; i += 1) {
      expect(requestConcurrency(lock, `p${i}`)).toBe("pending");
    }
    expect(requestConcurrency(lock, "overflow")).toBe("cancelled");
    expect(lock.active).toBe("active");
    expect(lock.pending).toHaveLength(100);
    expect(lock.cancelled.has("overflow")).toBe(true);
    expect(lock.cancelled.has("p0")).toBe(false);
  });

  test("the former three-group design allows B to migrate while A deploys API", () => {
    const migrate = createConcurrencyGroup({ cancelInProgress: false });
    const api = createConcurrencyGroup({ cancelInProgress: false });
    requestConcurrency(migrate, "A-migrate");
    completeConcurrency(migrate, "A-migrate");
    requestConcurrency(api, "A-api");
    requestConcurrency(migrate, "B-migrate");
    expect(api.active).toBe("A-api");
    expect(migrate.active).toBe("B-migrate");
    expect(
      overlappingMutations([
        { id: "A-api", phase: "api" },
        { id: "B-migrate", phase: "migrate" },
      ]),
    ).toBe(true);
  });

  test("same-SHA reruns both reach admission when groups are per run", () => {
    const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const a = admissionGroup({
      eventName: "workflow_dispatch",
      runId: "8",
      sha,
    });
    const b = admissionGroup({
      eventName: "workflow_dispatch",
      runId: "9",
      sha,
    });
    const groupA = createConcurrencyGroup(a);
    const groupB = createConcurrencyGroup(b);
    expect(requestConcurrency(groupA, "run-8")).toBe("active");
    expect(requestConcurrency(groupB, "run-9")).toBe("active");
  });

  test("a shared SHA admission group still zero-jobs the second dispatch", () => {
    const shared = createConcurrencyGroup({ cancelInProgress: false });
    expect(requestConcurrency(shared, "first-same-sha")).toBe("active");
    expect(requestConcurrency(shared, "second-same-sha")).toBe("pending");
    expect(shared.active).toBe("first-same-sha");
  });
});

describe("committed Cloud CF workflow matches the policy", () => {
  test("non-PR admission is per run_id, not per SHA", () => {
    const block = workflowConcurrencyBlock(cloudCf);
    expect(block).toContain("cloud-cf-deploy-v6-");
    expect(block).toContain("format('run-{0}', github.run_id)");
    expect(block).toContain(
      "format('pr-{0}', github.event.pull_request.number)",
    );
    expect(block).not.toContain("github.sha");
    expect(block).not.toContain("queue: max");
    expect(cloudCf).not.toContain("cloud-cf-deploy-v5-");
  });

  test("production authorization is outside the release lock", () => {
    const authorize = jobBlock(cloudCf, "authorize-production");
    const release = jobBlock(cloudCf, "release");
    expect(authorize).toContain("environment: production-approval");
    expect(authorize).not.toContain("concurrency:");
    expect(release).toContain("uses: ./.github/workflows/cloud-cf-release.yml");
    expect(release).toContain("group: cloud-cf-release-v6-");
    expect(release).toContain("cancel-in-progress: false");
    expect(release).toContain("queue: max");
    expect(release).not.toMatch(/^ {4}environment:/m);
  });

  test("the release workflow has no second concurrency critical section", () => {
    expect(cloudCfRelease).toContain("workflow_call:");
    expect(cloudCfRelease).not.toMatch(/^concurrency:/m);
    expect(cloudCfRelease).not.toMatch(/^ {4}concurrency:/m);
    expect(cloudCfRelease).not.toContain("cloud-db-migrate-v2-");
    expect(cloudCfRelease).not.toContain("cloud-cf-deploy-api-");
    expect(cloudCfRelease).not.toContain("cloud-cf-deploy-app-");
  });

  test("PR Pages previews remain pinned to staging inputs", () => {
    const buildPages = jobBlock(cloudCf, "build-pages");
    expect(buildPages).not.toContain("inputs.target_environment");
    expect(buildPages).toContain("VITE_API_URL: https://api-staging.eliza.app");
    expect(buildPages).toContain(
      "NEXT_PUBLIC_APP_URL: https://cloud-staging.eliza.app",
    );
    expect(buildPages).toContain("VITE_ENVIRONMENT: staging");
  });
});

describe("committed AASA and provisioning workflows match the policy", () => {
  test("provisioning admission is per run and SSH is one locked job", () => {
    const top = workflowConcurrencyBlock(provisioning);
    expect(top).toContain("format('run-{0}', github.run_id)");
    expect(top).not.toContain("github.sha");
    const determine = jobBlock(provisioning, "determine-env");
    const deploy = jobBlock(provisioning, "deploy");
    expect(determine).not.toMatch(/^ {4}environment:/m);
    expect(determine).not.toContain("concurrency:");
    expect(deploy).toContain("group: deploy-eliza-provisioning-worker-mutate-");
    expect(deploy).toContain("cancel-in-progress: false");
    expect(deploy).toContain("queue: max");
  });

  test("AASA admission is per run and CDN proof stays inside the mutate job", () => {
    const top = workflowConcurrencyBlock(aasa);
    expect(top).toContain("format('run-{0}', github.run_id)");
    expect(top).not.toContain("github.sha");
    expect(aasa).not.toContain("verify-apple-cdn:");
    const publish = jobBlock(aasa, "deploy-and-verify-origin");
    expect(publish).toContain("environment: production");
    expect(publish).toContain("group: deploy-aasa-edge-mutate");
    expect(publish).toContain("apple-cdn-live");
    expect(publish).toContain("cancel-in-progress: false");
    expect(publish).toContain("queue: max");
  });
});
