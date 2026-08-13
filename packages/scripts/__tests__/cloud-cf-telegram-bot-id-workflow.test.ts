/**
 * Pages producer must bind the selected GitHub environment and pass
 * vars.VITE_TELEGRAM_BOT_ID into both Vite builds (#19121).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const workflowSource = readFileSync(
  new URL(".github/workflows/cloud-cf-deploy.yml", repoRoot),
  "utf8",
);

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
}

interface WorkflowJob {
  environment?: string;
  steps?: WorkflowStep[];
}

const workflow = Bun.YAML.parse(workflowSource) as {
  jobs?: Record<string, WorkflowJob>;
};

const ENV_EXPR =
  "${{ ((github.event_name == 'workflow_dispatch' && inputs.environment == 'production') || github.ref == 'refs/heads/main') && 'production' || 'staging' }}";
const BOT_ID_EXPR = "${{ vars.VITE_TELEGRAM_BOT_ID }}";

function namedStep(jobId: string, name: string): WorkflowStep {
  const step = workflow.jobs?.[jobId]?.steps?.find(
    (candidate) => candidate.name === name,
  );
  if (!step) {
    throw new Error(`Missing ${name} step for ${jobId}`);
  }
  return step;
}

describe("cloud-cf-deploy Pages Telegram bot ID (#19121)", () => {
  test("binds build-pages to the selected GitHub environment", () => {
    expect(workflow.jobs?.["build-pages"]?.environment).toBe(ENV_EXPR);
  });

  test("canonical Pages Vite build receives vars.VITE_TELEGRAM_BOT_ID", () => {
    const step = namedStep("build-pages", "Build consolidated frontend artifact");
    expect(step.env?.VITE_TELEGRAM_BOT_ID).toBe(BOT_ID_EXPR);
  });

  test("legacy inline Vite build receives vars.VITE_TELEGRAM_BOT_ID", () => {
    const matches = Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
      (job.steps ?? [])
        .filter((step) => step.name === "Legacy inline fallback - build app")
        .map((step) => ({ jobId, step })),
    );
    expect(matches.length).toBeGreaterThan(0);
    for (const { step } of matches) {
      expect(step.env?.VITE_TELEGRAM_BOT_ID).toBe(BOT_ID_EXPR);
    }
  });

  test("does not leak a hardcoded Telegram bot ID into the workflow", () => {
    expect(workflowSource).not.toMatch(/VITE_TELEGRAM_BOT_ID:\s*["']?\d+/);
  });
});
