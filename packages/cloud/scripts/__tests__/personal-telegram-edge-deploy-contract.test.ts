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

  test("sources both Telegram credentials from the protected environment", () => {
    const token = prepare.env?.ELIZA_APP_TELEGRAM_BOT_TOKEN ?? "";
    const webhookSecret = prepare.env?.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET ?? "";
    expect(token).toBe("$" + "{{ secrets.ELIZA_APP_TELEGRAM_BOT_TOKEN }}");
    expect(webhookSecret).toBe(
      "$" + "{{ secrets.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET }}",
    );
  });

  test("includes both credentials in the atomic Worker version", () => {
    const run = prepare.run ?? "";
    expect(run).toContain("ELIZA_APP_TELEGRAM_BOT_TOKEN");
    expect(run).toContain("ELIZA_APP_TELEGRAM_WEBHOOK_SECRET");
    expect(run).toContain('queue_secret "$name"');
  });
});
