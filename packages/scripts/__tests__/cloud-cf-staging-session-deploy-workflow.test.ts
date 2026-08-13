/** Fail-closed ordering and input contracts for the staging QA auth cutover. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateStagingSessionCutoverConfig } from "../../cloud/scripts/validate-staging-session-cutover.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const workflowSource = readFileSync(
  new URL(".github/workflows/cloud-cf-deploy.yml", repoRoot),
  "utf8",
);

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const steps = workflow.jobs?.["deploy-api"]?.steps ?? [];

function step(name: string): WorkflowStep {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}

function index(name: string): number {
  return steps.findIndex((candidate) => candidate.name === name);
}

const VALID = {
  DEPLOY_ENVIRONMENT: "staging",
  STAGING_SESSION_EXCHANGE_DESIRED_ENABLED: "true",
  STAGING_SESSION_EXCHANGE_VERSION: "v1",
  STAGING_SESSION_EXCHANGE_SIGNING_SECRET:
    "dedicated-staging-session-signing-secret-0123456789",
  STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "staging-qa-v1-2026-08",
  STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS:
    "33333333-3333-4333-8333-333333333333",
  STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS:
    "11111111-1111-4111-8111-111111111111",
  STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS:
    "22222222-2222-4222-8222-222222222222",
};

describe("Cloud CF staging session cutover", () => {
  test("orders freshness, off-first config, deploy proof, activation, and final proof", () => {
    const ordered = [
      "Deploy freshness guard",
      "Disable staging session exchange before cutover",
      "Publish Worker AI secrets",
      "Deploy to Cloudflare Workers",
      "Verify deployed API commit",
      "Activate and verify staging session exchange after deploy proof",
    ].map(index);
    expect(ordered.every((value) => value >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));

    const disable = step("Disable staging session exchange before cutover");
    expect(disable.if).toContain("steps.freshness.outputs.should_deploy");
    expect(disable.run).toContain(
      "wrangler secret delete STAGING_SESSION_EXCHANGE_ENABLED --env staging",
    );

    const publish = step("Publish Worker AI secrets");
    expect(publish.if).toContain("steps.freshness.outputs.should_deploy");
    expect(publish.run).toContain('STAGING_SESSION_EXCHANGE_ENABLED=""');
    expect(publish.run).toContain(
      "publish_toggle_secret STAGING_SESSION_EXCHANGE_ENABLED",
    );
    expect(
      publish.run?.indexOf(
        "publish_toggle_secret STAGING_SESSION_EXCHANGE_ENABLED",
      ),
    ).toBeLessThan(
      publish.run?.indexOf("staging_session_config_names=(") ?? -1,
    );

    const activation = step(
      "Activate and verify staging session exchange after deploy proof",
    );
    expect(activation.if).toContain("steps.freshness.outputs.should_deploy");
    expect(activation.run).toContain(
      "wrangler secret put STAGING_SESSION_EXCHANGE_ENABLED --env staging",
    );
    expect(activation.run).toContain("trap rollback_on_unproven_exit EXIT");
    expect(activation.run).toContain("status?.ready !== true");
    expect(activation.run).toContain(
      "wrangler secret delete STAGING_SESSION_EXCHANGE_ENABLED --env staging",
    );
    expect(
      activation.run?.indexOf(
        "wrangler secret put STAGING_SESSION_EXCHANGE_ENABLED --env staging",
      ),
    ).toBeLessThan(
      activation.run?.indexOf("body.stagingSessionExchange") ?? -1,
    );
  });

  test("rejects malformed UUID allowlists without echoing their values", () => {
    for (const key of [
      "STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS",
      "STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS",
      "STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS",
    ] as const) {
      const malformed = `${VALID[key]},not-a-uuid-secret-value`;
      const errors = validateStagingSessionCutoverConfig({
        ...VALID,
        [key]: malformed,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(key);
      expect(JSON.stringify(errors)).not.toContain(malformed);
      expect(JSON.stringify(errors)).not.toContain("not-a-uuid-secret-value");
    }
    expect(
      index("Disable staging session exchange before cutover"),
    ).toBeLessThan(index("Publish Worker AI secrets"));
  });

  test("requires the dedicated v1 signer and accepts exact UUID lists", () => {
    expect(validateStagingSessionCutoverConfig(VALID)).toEqual([]);
    expect(workflowSource).toContain("ELIZA_SERVICE_JWT_SECRET:");
    expect(workflowSource).toContain("secrets.ELIZA_SERVICE_JWT_SECRET");
    expect(workflowSource).toContain(
      `STAGING_SESSION_EXCHANGE_SIGNING_SECRET: \${{ steps.env.outputs.deploy_environment == 'staging' && secrets.STAGING_SESSION_EXCHANGE_SIGNING_SECRET || '' }}`,
    );
    expect(workflowSource).toContain(
      `STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: \${{ steps.env.outputs.deploy_environment == 'staging' && vars.STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID || '' }}`,
    );
    for (const name of [
      "STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS",
      "STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS",
      "STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS",
    ]) {
      expect(workflowSource).toContain(
        `${name}: \${{ steps.env.outputs.deploy_environment == 'staging' && vars.${name} || '' }}`,
      );
      expect(workflowSource).not.toContain(`secrets.${name}`);
    }
    expect(
      validateStagingSessionCutoverConfig({
        ...VALID,
        ELIZA_SERVICE_JWT_SECRET: VALID.STAGING_SESSION_EXCHANGE_SIGNING_SECRET,
      }),
    ).toContain(
      "STAGING_SESSION_EXCHANGE_SIGNING_SECRET must be dedicated to staging QA sessions",
    );
    expect(
      validateStagingSessionCutoverConfig({
        ...VALID,
        STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "primary",
      }),
    ).toContain("STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID is invalid");
    expect(
      validateStagingSessionCutoverConfig({
        ...VALID,
        STAGING_SESSION_EXCHANGE_VERSION: "v2",
      }),
    ).toContain("STAGING_SESSION_EXCHANGE_VERSION must be v1");
  });

  test("a failed code deploy cannot run the later activation step", () => {
    // GitHub steps have implicit success() unless `always()`/`failure()` is
    // present. Activation follows both deploy and exact-commit proof and has no
    // override, so either failure leaves the off-first state served.
    const activation = step(
      "Activate and verify staging session exchange after deploy proof",
    );
    expect(index("Deploy to Cloudflare Workers")).toBeLessThan(
      index("Verify deployed API commit"),
    );
    expect(index("Verify deployed API commit")).toBeLessThan(
      index("Activate and verify staging session exchange after deploy proof"),
    );
    expect(activation.if).not.toContain("always()");
    expect(activation.if).not.toContain("failure()");
  });
});
