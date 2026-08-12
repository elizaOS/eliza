/**
 * Pins the staging onboarding login URL to the staging homepage and verifies
 * the Worker deploy migrates legacy secret bindings without losing rollback.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workflow = readFileSync(".github/workflows/cloud-cf-deploy.yml", "utf8");
const wrangler = readFileSync("packages/cloud/api/wrangler.toml", "utf8");

describe("staging onboarding login URL deployment", () => {
  test("pins staging and production to their matching homepage origins", () => {
    expect(wrangler).toContain(
      'ELIZA_ONBOARDING_LOGIN_APP_URL = "https://staging.eliza.app"',
    );
    expect(wrangler).toContain(
      'ELIZA_ONBOARDING_LOGIN_APP_URL = "https://eliza.app"',
    );
    expect(wrangler).toContain("canonical deploy-homepage.yml workflow");
    expect(wrangler).not.toContain("deploy-homepage-staging.yml");
  });

  test("retires both legacy secret aliases immediately before staging deploy", () => {
    const firstDelete = workflow.indexOf(
      "delete_legacy_onboarding_secret ELIZA_ONBOARDING_LOGIN_APP_URL",
    );
    const secondDelete = workflow.indexOf(
      "delete_legacy_onboarding_secret ELIZA_APP_ONBOARDING_LOGIN_APP_URL",
    );
    const deploy = workflow.indexOf('bunx wrangler deploy "${args[@]}"');
    expect(firstDelete).toBeGreaterThan(0);
    expect(secondDelete).toBeGreaterThan(firstDelete);
    expect(deploy).toBeGreaterThan(secondDelete);
    expect(workflow).toContain(
      'if [ "$DEPLOY_ENVIRONMENT" = "staging" ]; then',
    );
  });

  test("restores the known staging value when deployment fails after deletion", () => {
    expect(workflow).toContain("trap restore_legacy_onboarding_secrets ERR");
    expect(workflow).toContain(
      'printf \'%s\' "$STAGING_ONBOARDING_LOGIN_APP_URL" | bunx wrangler secret put "$name" --env staging',
    );
    expect(workflow).toContain("trap - ERR");
  });
});
