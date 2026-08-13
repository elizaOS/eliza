/**
 * #18092: a protected-environment wait must not own the shared mutation lock.
 *
 * Workflow-level groups are per SHA so a newer canonical release always
 * creates jobs and can reach an explicit approval state. Mutation jobs
 * serialize with cancel-in-progress: false. Assertions read the committed
 * YAML so GitHub expressions stay literal — a parser that interpolates
 * `${{ }}` would hide the defect this file exists to catch.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

function readWorkflow(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
}

function githubExpression(body) {
  return ["$", "{{ ", body, " }}"].join("");
}

/**
 * Two SHAs must not share a workflow group, or the older environment wait
 * head-of-line blocks the newer run before any job exists.
 */
function admitsConcurrentShas(groupLine) {
  return groupLine.includes("github.sha");
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
const provisioning = readWorkflow(
  ".github/workflows/deploy-eliza-provisioning-worker.yml",
);
const aasa = readWorkflow(".github/workflows/deploy-aasa.yml");

describe("production deploy admission lock (#18092)", () => {
  test("Cloud CF workflow groups are per SHA after v4 retirement", () => {
    const block = workflowConcurrencyBlock(cloudCf);
    expect(block).toContain("cloud-cf-deploy-v5-");
    expect(admitsConcurrentShas(block)).toBe(true);
    expect(block).toContain("format('{0}-{1}'");
    expect(block).not.toMatch(/&& 'production' \|\| format\('staging-/);
    expect(cloudCf).not.toContain("cloud-cf-deploy-v4-");
  });

  test("Cloud CF mutation jobs serialize without cancelling production", () => {
    const migrate = jobBlock(cloudCf, "migrate-db");
    const api = jobBlock(cloudCf, "deploy-api");
    const app = jobBlock(cloudCf, "deploy-app");
    expect(migrate).toContain("group: cloud-db-migrate-v2-");
    expect(migrate).toContain("cancel-in-progress: false");
    expect(api).toContain("group: cloud-cf-deploy-api-");
    expect(api).toContain("cancel-in-progress: false");
    expect(app).toContain("group: cloud-cf-deploy-app-");
    expect(app).toContain(
      `cancel-in-progress: ${githubExpression("github.event_name == 'pull_request'")}`,
    );
  });

  test("Cloud CF requests production only on mutation jobs", () => {
    expect(jobBlock(cloudCf, "validate-deploy-source")).not.toContain(
      "environment:",
    );
    expect(jobBlock(cloudCf, "admit-staging")).toContain(
      "environment: staging-approval",
    );
    expect(jobBlock(cloudCf, "build-pages")).not.toContain("environment:");
    expect(jobBlock(cloudCf, "verify-routing")).not.toContain("environment:");
    expect(jobBlock(cloudCf, "migrate-db")).toMatch(
      /environment: \$\{\{ .*'production'.+\}\}/,
    );
    expect(jobBlock(cloudCf, "deploy-api")).toMatch(
      /environment: \$\{\{ .*'production'.+\}\}/,
    );
  });

  test("provisioning workflow groups are per SHA and the SSH job owns the mutate lock", () => {
    const top = workflowConcurrencyBlock(provisioning);
    expect(top).toContain("deploy-eliza-provisioning-worker-");
    expect(admitsConcurrentShas(top)).toBe(true);
    expect(top).toContain("cancel-in-progress: false");

    const determine = jobBlock(provisioning, "determine-env");
    const deploy = jobBlock(provisioning, "deploy");
    // Job-level GitHub Environment is four-space `environment:`.
    // The `outputs.environment` field is six spaces and is not a gate.
    expect(determine).not.toMatch(/^ {4}environment:/m);
    expect(determine).not.toContain("concurrency:");
    expect(deploy).toContain(
      `group: deploy-eliza-provisioning-worker-mutate-${githubExpression("needs.determine-env.outputs.environment")}`,
    );
    expect(deploy).toContain("cancel-in-progress: false");
    expect(deploy).toContain(
      `environment: ${githubExpression("needs.determine-env.outputs.environment")}`,
    );
  });

  test("AASA validate-ref is free of the mutate lock that publish holds", () => {
    const top = workflowConcurrencyBlock(aasa);
    expect(top).toContain(
      `group: deploy-aasa-edge-${githubExpression("github.sha")}`,
    );
    expect(top).toContain("cancel-in-progress: false");
    expect(top).not.toMatch(/group: deploy-aasa-edge\n/);

    const validate = jobBlock(aasa, "validate-ref");
    const publish = jobBlock(aasa, "deploy-and-verify-origin");
    const observe = jobBlock(aasa, "verify-apple-cdn");
    expect(validate).not.toContain("environment:");
    expect(validate).not.toContain("concurrency:");
    expect(publish).toContain("environment: production");
    expect(publish).toContain("group: deploy-aasa-edge-mutate");
    expect(publish).toContain("cancel-in-progress: false");
    expect(observe).not.toContain("environment:");
    expect(observe).not.toContain("concurrency:");
  });
});
