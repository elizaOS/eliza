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
const wrangler = Bun.TOML.parse(
  readFileSync(resolve(repoRoot, "packages/cloud/api/wrangler.toml"), "utf8"),
) as {
  env?: { staging?: { vars?: Record<string, string> } };
  migrations?: Array<{ tag?: string; new_sqlite_classes?: string[] }>;
};

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
    expect(prepare.env?.ELIZA_APP_TELEGRAM_BOT_TOKEN).toContain(
      "secrets.ELIZA_APP_TELEGRAM_BOT_TOKEN",
    );
    expect(prepare.env?.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET).toContain(
      "secrets.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
    );
  });

  test("includes both credentials in the atomic Worker version", () => {
    const run = prepare.run ?? "";
    expect(run).toContain("ELIZA_APP_TELEGRAM_BOT_TOKEN");
    expect(run).toContain("ELIZA_APP_TELEGRAM_WEBHOOK_SECRET");
    expect(run).toContain('queue_secret "$name"');
  });

  test("creates a fail-closed post-migration version before activation", () => {
    const steps = workflow.jobs["deploy-api"].steps;
    expect(steps.indexOf(prepare)).toBeLessThan(
      steps.indexOf(namedStep("Deploy to Cloudflare Workers")),
    );
    expect(
      wrangler.env?.staging?.vars?.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED,
    ).toBe("false");
    expect(wrangler.migrations).toContainEqual({
      tag: "personal-telegram-delivery-v1",
      new_sqlite_classes: ["PersonalTelegramDelivery"],
    });
  });
});
