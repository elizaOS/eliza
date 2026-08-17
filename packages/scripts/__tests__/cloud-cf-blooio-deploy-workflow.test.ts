/**
 * Guards staging-only Blooio secret sourcing, atomic Worker publication, and
 * names-only post-deploy verification in the protected Cloud release.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const source = readFileSync(
  new URL(".github/workflows/cloud-cf-release.yml", repoRoot),
  "utf8",
);

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const workflow = Bun.YAML.parse(source) as Workflow;
const steps = workflow.jobs?.["deploy-api"]?.steps ?? [];
const blooioNames = [
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
  "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
] as const;
const stagingValues: Record<(typeof blooioNames)[number], string> = {
  ELIZA_APP_BLOOIO_API_KEY: "api-key-private-canary",
  ELIZA_APP_BLOOIO_PHONE_NUMBER: "+15555550199",
  ELIZA_APP_BLOOIO_WEBHOOK_SECRET: "webhook-secret-private-canary",
};

function step(name: string): WorkflowStep {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found?.run) throw new Error(`Missing executable workflow step: ${name}`);
  return found;
}

function index(name: string): number {
  return steps.findIndex((candidate) => candidate.name === name);
}

function githubExpression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

function runValidation(
  overrides: Partial<typeof stagingValues> = {},
): ReturnType<typeof Bun.spawnSync> {
  const validation = step("Validate protected staging Blooio configuration");
  return Bun.spawnSync(["bash", "-c", validation.run ?? ""], {
    env: {
      ...process.env,
      DEPLOY_ENVIRONMENT: "staging",
      ...stagingValues,
      ...overrides,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
}

describe("protected Cloud staging Blooio configuration", () => {
  test("fails closed before Worker mutation without exposing protected values", () => {
    const validation = step("Validate protected staging Blooio configuration");
    expect(validation.if).toContain(
      "steps.env.outputs.deploy_environment == 'staging'",
    );
    expect(index("Validate canonical routing contract")).toBeLessThan(
      index("Validate protected staging Blooio configuration"),
    );
    expect(
      index("Validate protected staging Blooio configuration"),
    ).toBeLessThan(index("Disable staging session exchange before cutover"));

    const complete = runValidation();
    expect(complete.exitCode).toBe(0);
    expect(complete.stdout.toString()).toContain(
      "Verified 3 protected staging Blooio secret names",
    );
    const completeOutput = `${complete.stdout.toString()}${complete.stderr.toString()}`;
    for (const value of Object.values(stagingValues)) {
      expect(completeOutput).not.toContain(value);
    }

    for (const name of blooioNames) {
      for (const missingValue of ["", " \t "]) {
        const missing = runValidation({ [name]: missingValue });
        expect(missing.exitCode).toBe(1);
        const output = `${missing.stdout.toString()}${missing.stderr.toString()}`;
        expect(output).toContain(name);
        for (const value of Object.values(stagingValues)) {
          expect(output).not.toContain(value);
        }
      }
    }
  });

  test("sources only protected staging values and commits them atomically", () => {
    const validation = step("Validate protected staging Blooio configuration");
    const prepare = step("Prepare Worker secrets for atomic deploy");
    const deploy = step("Deploy to Cloudflare Workers");
    const cleanup = step("Remove atomic Worker secrets file");

    for (const name of blooioNames) {
      const expected = githubExpression(
        `steps.env.outputs.deploy_environment == 'staging' && secrets.${name} || ''`,
      );
      expect(validation.env?.[name]).toBe(expected);
      expect(prepare.env?.[name]).toBe(expected);
      expect(prepare.run).toContain(`\n    ${name}`);
    }
    expect(prepare.run).toContain('if [ "$DEPLOY_ENVIRONMENT" = "staging" ]');
    expect(prepare.run).toContain('queue_secret "$name" || exit 1');
    expect(prepare.run).toContain("worker-secrets-file.mjs");
    expect(prepare.run).toContain('create "$RUNNER_TEMP"');
    expect(prepare.run).not.toMatch(/^\s*bunx wrangler secret put/m);
    expect(deploy.run).toContain('--secrets-file "$WORKER_SECRETS_FILE"');
    expect(cleanup.if).toContain("always()");
    expect(cleanup.run).toContain('remove-all "$RUNNER_TEMP"');
  });

  test("verifies staging names after deploy while leaving production isolated", () => {
    const verify = step("Verify required Worker secret binding names");
    expect(verify.run).toContain(
      'process.env.DEPLOY_ENVIRONMENT === "staging"',
    );
    for (const name of blooioNames) {
      expect(verify.run).toContain(`"${name}"`);
    }
    expect(verify.run).toContain("values were not read");

    const validation = step("Validate protected staging Blooio configuration");
    expect(validation.if).not.toContain("production");
    for (const name of blooioNames) {
      expect(validation.env?.[name]).not.toContain(
        `deploy_environment == 'production' && secrets.${name}`,
      );
      expect(
        step("Prepare Worker secrets for atomic deploy").env?.[name],
      ).not.toContain(`deploy_environment == 'production' && secrets.${name}`);
    }
  });
});
