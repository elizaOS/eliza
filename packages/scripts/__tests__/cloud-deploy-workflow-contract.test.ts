/** Locks canonical Cloud deployment triggers and environment-scoped release gates. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);

interface WorkflowTrigger {
  branches?: string[];
  paths?: string[];
  inputs?: Record<string, unknown>;
}

interface WorkflowJob {
  environment?: string;
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
}

interface WorkflowStep {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
}

interface Workflow {
  on?: Record<string, WorkflowTrigger>;
  jobs?: Record<string, WorkflowJob>;
}

function readWorkflowSource(name: string): string {
  return readFileSync(new URL(`.github/workflows/${name}`, repoRoot), "utf8");
}

function readWorkflow(name: string): Workflow {
  return Bun.YAML.parse(readWorkflowSource(name)) as Workflow;
}

function githubExpression(value: string): string {
  return `\${{ ${value} }}`;
}

const canonicalSource = readWorkflowSource("cloud-cf-deploy.yml");
const canonical = readWorkflow("cloud-cf-deploy.yml");
const legacy = readWorkflow("cloud-deploy-backend.yml");

describe("Cloud deployment workflow trigger contract", () => {
  test("canonical push and pull-request deploys cover app-core changes", () => {
    const push = canonical.on?.push;
    const pullRequest = canonical.on?.pull_request;

    expect(push?.branches).toEqual(["main", "develop"]);
    expect(pullRequest?.branches).toEqual(["main", "develop"]);
    expect(push?.paths).toContain("packages/app/**");
    expect(push?.paths).toContain("packages/app-core/**");
    expect(pullRequest?.paths).toContain("packages/app/**");
    expect(pullRequest?.paths).toContain("packages/app-core/**");
  });

  test("publishes Deepgram credentials and the environment-scoped batch STT toggle", () => {
    expect(canonicalSource).toContain(
      "DEEPGRAM_API_KEY: $" + "{{ secrets.DEEPGRAM_API_KEY }}",
    );
    expect(canonicalSource).toContain(
      "VOICE_BATCH_STT_PROVIDER: $" + "{{ vars.VOICE_BATCH_STT_PROVIDER }}",
    );
    expect(canonicalSource).toContain("            DEEPGRAM_API_KEY \\");
    expect(canonicalSource).toContain("            VOICE_BATCH_STT_PROVIDER");
  });

  test("gates mobile App Auth release mode before and after deploy", () => {
    const migrate = canonical.jobs?.["migrate-db"];
    const deployApi = canonical.jobs?.["deploy-api"];
    expect(migrate).toBeDefined();
    expect(deployApi).toBeDefined();

    const mobileAppIdVariable = githubExpression(
      "vars.ELIZA_MOBILE_APP_AUTH_APP_ID",
    );
    const mobileEnabledVariable = githubExpression(
      "vars.ELIZA_MOBILE_APP_AUTH_ENABLED",
    );
    expect(migrate?.environment).toContain(
      "inputs.environment == 'production'",
    );
    expect(migrate?.environment).toContain("github.ref == 'refs/heads/main'");
    expect(deployApi?.environment).toBe(migrate?.environment);
    expect(migrate?.env?.ELIZA_MOBILE_APP_AUTH_APP_ID).toBe(
      mobileAppIdVariable,
    );
    expect(deployApi?.env?.ELIZA_MOBILE_APP_AUTH_APP_ID).toBe(
      mobileAppIdVariable,
    );
    expect(migrate?.env?.ELIZA_MOBILE_APP_AUTH_ENABLED).toBe(
      mobileEnabledVariable,
    );
    expect(deployApi?.env?.ELIZA_MOBILE_APP_AUTH_ENABLED).toBe(
      mobileEnabledVariable,
    );
    expect(deployApi?.needs).toBe("migrate-db");
    expect(deployApi?.if).toContain("needs.migrate-db.result == 'success'");

    const migrationSteps = migrate?.steps ?? [];
    const releaseModeIndex = migrationSteps.findIndex(
      (step) => step.name === "Validate mobile App Auth release mode",
    );
    const migrationIndex = migrationSteps.findIndex(
      (step) => step.name === "Run migrations",
    );
    const databaseProofIndex = migrationSteps.findIndex(
      (step) => step.name === "Verify mobile App Auth database registration",
    );
    expect(releaseModeIndex).toBeGreaterThanOrEqual(0);
    expect(migrationIndex).toBeGreaterThan(releaseModeIndex);
    expect(databaseProofIndex).toBeGreaterThan(migrationIndex);
    expect(migrationSteps[releaseModeIndex]?.run).toContain(
      '"$ELIZA_MOBILE_APP_AUTH_ENABLED" != "true"',
    );
    expect(migrationSteps[releaseModeIndex]?.run).toContain(
      '"$ELIZA_MOBILE_APP_AUTH_ENABLED" == "true" && -z "$ELIZA_MOBILE_APP_AUTH_APP_ID"',
    );
    expect(migrationSteps[databaseProofIndex]?.env?.DATABASE_URL).toBe(
      githubExpression("env.MIGRATION_DATABASE_URL"),
    );
    expect(migrationSteps[databaseProofIndex]?.run).toBe(
      "bun packages/scripts/cloud/admin/verify-mobile-app-auth-registration.ts",
    );

    const deploySteps = deployApi?.steps ?? [];
    const deployIndex = deploySteps.findIndex(
      (step) => step.name === "Deploy to Cloudflare Workers",
    );
    const commitProofIndex = deploySteps.findIndex(
      (step) => step.name === "Verify deployed API commit",
    );
    const liveProofIndex = deploySteps.findIndex(
      (step) => step.name === "Verify live mobile App Auth registration",
    );
    expect(deployIndex).toBeGreaterThanOrEqual(0);
    expect(commitProofIndex).toBeGreaterThan(deployIndex);
    expect(liveProofIndex).toBeGreaterThan(commitProofIndex);
    expect(deploySteps[deployIndex]?.run).toContain(
      '--var ELIZA_MOBILE_APP_AUTH_APP_ID:"$ELIZA_MOBILE_APP_AUTH_APP_ID"',
    );
    expect(deploySteps[deployIndex]?.run).toContain(
      '--var ELIZA_MOBILE_APP_AUTH_ENABLED:"$ELIZA_MOBILE_APP_AUTH_ENABLED"',
    );
    expect(
      deploySteps[liveProofIndex]?.env?.ELIZA_MOBILE_APP_AUTH_ENVIRONMENT,
    ).toBe(githubExpression("steps.env.outputs.deploy_environment"));
    expect(deploySteps[liveProofIndex]?.run).toBe(
      "bun packages/scripts/cloud/admin/verify-mobile-app-auth-registration.ts --skip-database --verify-live",
    );
    expect(deploySteps[liveProofIndex]?.if).toBe(
      deploySteps[commitProofIndex]?.if,
    );
  });

  test("legacy backend deploys are manual-only and retain migration/VPS controls", () => {
    expect(Object.keys(legacy.on ?? {}).sort()).toEqual(["workflow_dispatch"]);

    const dispatch = legacy.on?.workflow_dispatch;
    expect(dispatch?.inputs).toHaveProperty("environment");
    expect(dispatch?.inputs).toHaveProperty("deploy_legacy_vps");
    expect(legacy.jobs).toHaveProperty("migrate-db");
    expect(legacy.jobs).toHaveProperty("deploy");
    expect(legacy.jobs?.deploy?.if).toContain("inputs.deploy_legacy_vps");
  });
});
