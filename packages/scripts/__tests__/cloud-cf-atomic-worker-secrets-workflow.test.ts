/**
 * Pins the Cloud release workflow to an atomic Worker code-and-secrets deploy,
 * including private-file ownership, cleanup, and post-deploy name verification.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const source = readFileSync(
  new URL(".github/workflows/cloud-cf-release.yml", repoRoot),
  "utf8",
);

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const workflow = Bun.YAML.parse(source) as Workflow;
const steps = workflow.jobs?.["deploy-api"]?.steps ?? [];

function step(name: string): WorkflowStep {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found?.run) throw new Error(`Missing executable workflow step: ${name}`);
  return found;
}

function index(name: string): number {
  return steps.findIndex((candidate) => candidate.name === name);
}

describe("Cloud CF atomic Worker secrets deploy", () => {
  test("prepares configured values without mutating a pre-deploy Worker version", () => {
    const prepare = step("Prepare Worker secrets for atomic deploy");
    expect(prepare.id).toBe("worker-secrets");
    expect(prepare.run).toContain("declare -a worker_secret_names=()");
    expect(prepare.run).toContain("queue_secret() {");
    expect(prepare.run).toContain("queue_toggle_secret() {");
    expect(prepare.run).toContain("worker-secrets-file.mjs");
    expect(prepare.run).toContain('create "$RUNNER_TEMP"');
    expect(prepare.run).toContain('>> "$GITHUB_OUTPUT"');
    expect(prepare.run).not.toContain("bunx wrangler secret put");
    expect(prepare.run).not.toContain('echo "$value"');
    expect(prepare.run).not.toContain("printf '%s' \"$value\"");
  });

  test("commits the private payload with exact code and cleans it on every outcome", () => {
    const prepareIndex = index("Prepare Worker secrets for atomic deploy");
    const deployIndex = index("Deploy to Cloudflare Workers");
    const cleanupIndex = index("Remove atomic Worker secrets file");
    const verifyIndex = index("Verify required Worker secret binding names");
    expect(prepareIndex).toBeGreaterThan(0);
    expect(deployIndex).toBeGreaterThan(prepareIndex);
    expect(cleanupIndex).toBe(deployIndex + 1);
    expect(verifyIndex).toBeGreaterThan(cleanupIndex);

    const deploy = step("Deploy to Cloudflare Workers");
    expect(deploy.env?.WORKER_SECRETS_FILE).toBe(
      "$" + "{{ steps.worker-secrets.outputs.secrets_file }}",
    );
    expect(deploy.run).toContain('[ ! -f "$WORKER_SECRETS_FILE" ]');
    expect(deploy.run).toContain('[ -L "$WORKER_SECRETS_FILE" ]');
    expect(deploy.run).toContain("stat -c '%a'");
    expect(deploy.run).toContain('--secrets-file "$WORKER_SECRETS_FILE"');
    expect(deploy.run).toContain("bunx wrangler deploy");
    expect(deploy.run).toContain('"$' + '{args[@]}"');

    const cleanup = step("Remove atomic Worker secrets file");
    expect(cleanup.if).toContain("always()");
    expect(cleanup.if).toContain("steps.cf.outputs.configured == 'true'");
    expect(cleanup.if).toContain(
      "steps.freshness.outputs.should_deploy == 'true'",
    );
    expect(cleanup.env).toBeUndefined();
    expect(cleanup.run).toContain("worker-secrets-file.mjs");
    expect(cleanup.run).toContain('remove-all "$RUNNER_TEMP"');
  });

  test("preserves omitted bindings and verifies authoritative names after deploy", () => {
    const prepare = step("Prepare Worker secrets for atomic deploy");
    expect(prepare.run).toContain(
      "omitted preserve-only bindings remain untouched",
    );
    expect(prepare.run).toContain(
      'echo "::notice::$name is not configured; skipping"',
    );

    const verify = step("Verify required Worker secret binding names");
    expect(verify.run).toContain("wrangler@4.116.0 secret list");
    expect(verify.run).toContain("values were not read");
    expect(verify.run).toContain('"DATABASE_URL"');
    expect(verify.run).toContain('"OIDC_SIGNING_JWKS"');
    expect(verify.run).toContain('"STEWARD_TENANT_API_KEY"');
    expect(verify.run).toContain('"VOICE_REALTIME_ELIZA_AUTHORIZATION"');
  });

  test("keeps post-deploy session activation separate from the atomic payload", () => {
    const prepare = step("Prepare Worker secrets for atomic deploy");
    const activation = step(
      "Activate and verify staging session exchange after deploy proof",
    );
    expect(prepare.run).not.toContain(
      "wrangler secret put STAGING_SESSION_EXCHANGE_ENABLED",
    );
    expect(activation.run).toContain(
      "wrangler secret put STAGING_SESSION_EXCHANGE_ENABLED --env staging",
    );
    expect(index("Verify deployed API commit")).toBeLessThan(
      index("Activate and verify staging session exchange after deploy proof"),
    );
  });
});
