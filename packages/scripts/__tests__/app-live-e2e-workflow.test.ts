/**
 * Fail-closed contract for the real Eliza Cloud job in app-live-e2e.yml.
 *
 * The Playwright spec intentionally remains self-skipping in keyless contexts
 * so PR lanes cannot spend Cloud credits. The secret-gated workflow job must
 * therefore reject a missing credential before setup/build/test work; otherwise
 * Playwright reports the only test as skipped and the declared live job is green.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
}

interface WorkflowJob {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(
  read(".github/workflows/app-live-e2e.yml"),
) as Workflow;
const cloudJob = workflow.jobs?.["cloud-live"];

function namedStep(name: string): WorkflowStep {
  const step = cloudJob?.steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing cloud-live workflow step: ${name}`);
  }
  return step;
}

describe("App Live E2E real Cloud job (#14357, #16194)", () => {
  test("maps the runtime key to the established repository-secret fallback", () => {
    expect(cloudJob?.env?.ELIZAOS_CLOUD_API_KEY).toBe(
      "$" + "{{ secrets.ELIZAOS_CLOUD_API_KEY || secrets.ELIZACLOUD_API_KEY }}",
    );
  });

  test("fails on a missing key before setup, build, or Playwright can skip", () => {
    const steps = cloudJob?.steps ?? [];
    const preflightIndex = steps.findIndex(
      (step) => step.name === "Require real Cloud credential",
    );
    const firstExpensiveStepIndex = steps.findIndex(
      (step) => step.name === "Free disk space for browser smoke",
    );
    const testIndex = steps.findIndex(
      (step) => step.name === "Run real cloud login + provision + chat",
    );

    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(firstExpensiveStepIndex).toBeGreaterThan(preflightIndex);
    expect(testIndex).toBeGreaterThan(preflightIndex);

    const run = namedStep("Require real Cloud credential").run;
    expect(run).toBeDefined();

    const missing = spawnSync("bash", ["-c", run ?? ""], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: "" },
    });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("refusing a green-by-skip Cloud job");

    const whitespaceOnly = spawnSync("bash", ["-c", run ?? ""], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: " \t\n" },
    });
    expect(whitespaceOnly.status).toBe(1);

    const configured = spawnSync("bash", ["-c", run ?? ""], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: "contract-test-key" },
    });
    expect(configured.status).toBe(0);
  });

  test("keeps the live spec keyless-safe and out of pull-request workflows", () => {
    const spec = read("packages/app/test/ui-smoke/cloud-live.spec.ts");

    expect(workflow.on?.pull_request).toBeUndefined();
    expect(spec).toContain(
      "const HAS_CLOUD_KEY = Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim())",
    );
    expect(spec).toContain("test.skip(\n    !HAS_CLOUD_KEY,");
  });

  test("hands the job credential to the browser without retaining secret-bearing traces", () => {
    const spec = read("packages/app/test/ui-smoke/cloud-live.spec.ts");

    expect(spec).toContain("await seedCloudLiveBrowserAuth(page)");
    expect(spec).toContain('test.use({ trace: "off" });');
  });
});
