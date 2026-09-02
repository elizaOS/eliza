/** Locks protected Telegram identity attestation ahead of every release mutation. */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowStep {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
}

interface WorkflowJob {
  needs?: string | string[];
  steps: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

const repoRoot = resolve(import.meta.dirname, "../../../..");

function workflow(name: string): Workflow {
  return parse(
    readFileSync(resolve(repoRoot, ".github/workflows", name), "utf8"),
  ) as Workflow;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

function expectBashSyntax(step: WorkflowStep): void {
  const checked = spawnSync("bash", ["-n"], {
    encoding: "utf8",
    input: step.run ?? "",
  });
  expect(checked.stderr).toBe("");
  expect(checked.status).toBe(0);
}

describe("protected Telegram identity workflow contract", () => {
  test("Cloudflare preflight admits the selected identity before migration or deploy", () => {
    const release = workflow("cloud-cf-release.yml");
    const resolver = release.jobs["resolve-pages-environment-config"];
    const migrate = release.jobs["migrate-db"];
    const deploy = release.jobs["deploy-api"];
    if (!resolver || !migrate || !deploy)
      throw new Error("Missing release job");

    const select = namedStep(
      resolver,
      "Validate caller-admitted Telegram public identity",
    );
    expect(migrate.needs).toBe("resolve-pages-environment-config");
    expect(select.env).toMatchObject({
      RELEASE_RUN_ATTEMPT: expect.stringContaining("github.run_attempt"),
      TARGET_ENVIRONMENT: expect.stringContaining("inputs.target_environment"),
      TELEGRAM_AUTHORITY_RUN_ATTEMPT: expect.stringContaining(
        "inputs.telegram_authority_run_attempt",
      ),
      ADMITTED_TELEGRAM_BOT_ID: expect.stringContaining(
        "inputs.admitted_telegram_bot_id",
      ),
      ADMITTED_TELEGRAM_BOT_USERNAME: expect.stringContaining(
        "inputs.admitted_telegram_bot_username",
      ),
      TELEGRAM_RUNTIME_AUTHORITY: expect.stringContaining(
        "inputs.telegram_runtime_authority",
      ),
    });
    expect(select.run).toContain("packages/homepage/src/lib/contact.ts");
    expect(select.run).toContain("TELEGRAM_AUTHORITY_RUN_ATTEMPT");
    expect(select.run).toContain("TELEGRAM_RUNTIME_AUTHORITY");
    expect(select.run).toContain("ADMITTED_TELEGRAM_BOT_ID");
    expect(select.run).toContain("ADMITTED_TELEGRAM_BOT_USERNAME");

    const prepare = namedStep(
      deploy,
      "Prepare Worker secrets for atomic deploy",
    );
    const publish = namedStep(deploy, "Deploy to Cloudflare Workers");
    const readiness = namedStep(
      deploy,
      "Verify deployed Telegram identity readiness",
    );
    expect(prepare.run).toContain(
      "Required protected production Telegram secret is absent or blank",
    );
    expect(prepare.run).toContain(
      "Staging can preserve the existing Telegram credentials",
    );
    expect(prepare.run).toContain('queue_secret "$name"');
    expect(publish.run).toContain("ELIZA_APP_TELEGRAM_BOT_ID");
    expect(publish.run).toContain("ELIZA_APP_TELEGRAM_BOT_USERNAME");
    expect(deploy.steps.indexOf(readiness)).toBeGreaterThan(
      deploy.steps.indexOf(publish),
    );
    expect(readiness.run).toContain(
      "/api/eliza-app/webhook/telegram/readiness",
    );
    for (const step of [select, prepare, readiness]) {
      expectBashSyntax(step);
    }
  });

  test("Railway attests its exact token and paired secret before deployment", () => {
    const deployWorkflow = workflow("deploy-gateway-webhook.yml");
    const deploy = deployWorkflow.jobs.deploy;
    if (!deploy) throw new Error("Missing gateway deploy job");

    const select = namedStep(
      deploy,
      "Resolve protected Telegram public identity",
    );
    const verify = namedStep(
      deploy,
      "Verify canonical Railway variables and sensitive names",
    );
    const mutate = namedStep(deploy, "Deploy exact gateway-webhook source");
    const postdeploy = namedStep(
      deploy,
      "Verify deployed health and canonical fallback configuration",
    );
    const receipt = namedStep(deploy, "Write exact deployment receipt");

    expect(select.run).toContain("packages/homepage/src/lib/contact.ts");
    expect(select.run).toContain("STAGING_TELEGRAM_BOT_ID");
    expect(verify.env).toMatchObject({
      WORKER_ELIZA_APP_TELEGRAM_BOT_TOKEN: expect.stringContaining(
        "secrets.ELIZA_APP_TELEGRAM_BOT_TOKEN",
      ),
      WORKER_ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: expect.stringContaining(
        "secrets.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
      ),
    });
    expect(verify.run).toContain("verify-telegram-bot-identity.mjs");
    expect(verify.run).toContain(
      "require_exact_variable ELIZA_APP_TELEGRAM_BOT_ID",
    );
    expect(verify.run).toContain(
      "require_exact_variable ELIZA_APP_TELEGRAM_BOT_USERNAME",
    );
    expect(verify.run).toContain("railway_telegram_digests");
    expect(deploy.steps.indexOf(verify)).toBeLessThan(
      deploy.steps.indexOf(mutate),
    );
    expect(postdeploy.run).toContain("/ready/telegram-identity/eliza-app");
    expect(receipt.run).toContain('telegramIdentity: "attested"');
    for (const step of [select, verify, postdeploy, receipt]) {
      expectBashSyntax(step);
    }
  });

  test("edge enable requires both live identity proofs before cutover mutation", () => {
    const cutoverWorkflow = workflow(
      "activate-personal-shared-telegram-edge.yml",
    );
    const cutover = cutoverWorkflow.jobs.cutover;
    if (!cutover) throw new Error("Missing Telegram cutover job");

    const protectedAttestation = namedStep(
      cutover,
      "Attest protected Telegram credential before enable",
    );
    const workerProof = namedStep(
      cutover,
      "Verify served Worker Telegram identity before enable",
    );
    const gatewayProof = namedStep(
      cutover,
      "Verify exact active gateway before enable",
    );
    const mutation = namedStep(cutover, "Apply and verify served edge state");

    expect(protectedAttestation.if).toContain("inputs.enabled == true");
    expect(protectedAttestation.run).toContain(
      "verify-telegram-bot-identity.mjs",
    );
    expect(workerProof.run).toContain(
      "/api/eliza-app/webhook/telegram/readiness",
    );
    expect(gatewayProof.run).toContain("/ready/telegram-identity/eliza-app");
    expect(gatewayProof.run).toContain('.telegramIdentity == "attested"');
    for (const proof of [protectedAttestation, workerProof, gatewayProof]) {
      expect(cutover.steps.indexOf(proof)).toBeLessThan(
        cutover.steps.indexOf(mutation),
      );
      expectBashSyntax(proof);
    }
  });
});
