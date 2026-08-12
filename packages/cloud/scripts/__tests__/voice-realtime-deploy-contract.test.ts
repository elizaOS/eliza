/**
 * Locks the authenticated staging realtime canary and its fail-closed rollback
 * to the authoritative Cloudflare deployment workflow.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowStep {
  env?: Record<string, string>;
  if?: string;
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
    resolve(repoRoot, ".github/workflows/cloud-cf-deploy.yml"),
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

describe("realtime staging deploy contract", () => {
  const canary = namedStep(
    "Canary authenticated staging realtime and rollback on failure",
  );
  const run = canary.run ?? "";

  test("runs only after the exact staging API deployment", () => {
    const steps = workflow.jobs["deploy-api"].steps;
    expect(steps.indexOf(canary)).toBeGreaterThan(
      steps.indexOf(namedStep("Verify deployed API commit")),
    );
    expect(canary.if).toContain("deploy_environment == 'staging'");
    expect(canary.env?.STAGING_ELIZACLOUD_API_KEY).toContain(
      "secrets.ELIZACLOUD_API_KEY",
    );
  });

  test("proves an authenticated, stateful realtime edge", () => {
    expect(run).toContain('if [ "$VOICE_REALTIME_WS_ENABLED" != "true" ]');
    expect(run).toContain('-H "X-API-Key: $STAGING_ELIZACLOUD_API_KEY"');
    expect(run).toContain("/api/v1/voice/session/consent");
    expect(run).toContain("body.consentNonce");
    expect(run).toContain("body.expiresAt");
  });

  test("keeps rollback armed until proof and verifies the served gate is off", () => {
    const rollbackDeploy = [
      'bunx wrangler deploy "$',
      '{rollback_args[@]}"',
    ].join("");
    expect(run).toContain("trap rollback_on_unproven_exit EXIT");
    expect(run).toContain("canary_proven=false");
    expect(run).toContain('--var VOICE_REALTIME_WS_ENABLED:"false"');
    expect(run).toContain('[ "$code" = "404" ] && return 0');
    expect(run).toContain(rollbackDeploy);
    expect(run.indexOf(rollbackDeploy)).toBeLessThan(
      run.indexOf('[ "$code" = "404" ] && return 0'),
    );
    expect(run.indexOf("trap rollback_on_unproven_exit EXIT")).toBeLessThan(
      run.indexOf("requires an authenticated canary credential"),
    );
  });
});
