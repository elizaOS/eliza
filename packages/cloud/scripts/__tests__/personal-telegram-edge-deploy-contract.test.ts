/**
 * Locks the fail-closed Telegram edge rollout and protected Worker secret
 * preparation to the authoritative Cloudflare release inputs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
}

interface Workflow {
  jobs: {
    "deploy-api": { steps: WorkflowStep[] };
  };
}

const repoRoot = resolve(import.meta.dirname, "../../../..");
const workflow = parse(
  readFileSync(
    resolve(repoRoot, ".github/workflows/cloud-cf-release.yml"),
    "utf8",
  ),
) as Workflow;

function namedStep(name: string): WorkflowStep {
  const step = workflow.jobs["deploy-api"].steps.find(
    (candidate) => candidate.name === name,
  );
  if (!step) throw new Error(`Missing Cloud deploy step: ${name}`);
  return step;
}

describe("Personal Shared Telegram edge deploy contract", () => {
  const prepare = namedStep("Prepare Worker secrets for atomic deploy");

  // #30397 replaced the computed `secrets[format(...)]` key with a direct
  // reference and declared both names in `on.workflow_call.secrets`, because a
  // computed key evaluates without the job's Environment values inside a
  // reusable workflow and silently publishes a blank Worker secret. The
  // caller-side prohibition is unchanged and still enforced where it belongs,
  // in homepage-deploy-workflow.test.ts: `cloud-cf-deploy.yml` must never
  // forward either name. What this file owns is the consuming end.
  test("sources both Telegram credentials from the protected environment", () => {
    for (const name of [
      "ELIZA_APP_TELEGRAM_BOT_TOKEN",
      "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
    ] as const) {
      expect(prepare.env?.[name], name).toBe(`\${{ secrets.${name} }}`);
    }
  });

  test("includes both credentials in the atomic Worker version", () => {
    const run = prepare.run ?? "";
    expect(run).toContain("ELIZA_APP_TELEGRAM_BOT_TOKEN");
    expect(run).toContain("ELIZA_APP_TELEGRAM_WEBHOOK_SECRET");
    expect(run).toContain('queue_secret "$name"');
  });
});
