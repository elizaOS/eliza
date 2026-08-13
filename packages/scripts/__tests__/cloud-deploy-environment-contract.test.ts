/**
 * Guards canonical cloud deployment workflows against environment, routing,
 * host-inventory, and shared-secret drift without inspecting protected values.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  needs?: string | string[];
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function parse(path: string): Workflow {
  return Bun.YAML.parse(read(path)) as Workflow;
}

function step(workflow: Workflow, jobId: string, name: string): WorkflowStep {
  const found = workflow.jobs?.[jobId]?.steps?.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`Missing ${jobId} workflow step: ${name}`);
  return found;
}

const cloudSource = read(".github/workflows/cloud-cf-deploy.yml");
const cloud = parse(".github/workflows/cloud-cf-deploy.yml");
const infraSource = read(".github/workflows/infra.yml");
const infra = parse(".github/workflows/infra.yml");
const provisioning = parse(
  ".github/workflows/deploy-eliza-provisioning-worker.yml",
);
const appsWorker = parse(".github/workflows/deploy-apps-worker.yml");

const workerSecretNames = [
  "DATABASE_URL",
  "HEADSCALE_API_KEY",
  "CONTAINERS_SSH_KEY",
  "SECRETS_MASTER_KEY",
] as const;

const cloudWorkerSecretNames = [
  ...workerSecretNames,
  "TUNNEL_HOSTNAME_SIGNING_SECRET",
] as const;

const requiredAuthWorkerSecretNames = [
  "OIDC_CLIENTS",
  "OIDC_SIGNING_JWKS",
  "STEWARD_API_URL",
  "STEWARD_JWT_SECRET",
  "STEWARD_SESSION_SECRET",
  "STEWARD_REQUEST_SIGNING_SECRET",
  "STEWARD_PLATFORM_KEYS",
  "STEWARD_TENANT_API_KEY",
] as const;

describe("canonical cloud deployment environment contract", () => {
  test("gates protected Terraform operations on the canonical source ref", () => {
    expect(infra.jobs?.terraform?.needs).toBe("validate-source");
    const validate = step(
      infra,
      "validate-source",
      "Validate canonical source ref",
    );
    expect(validate.run).toContain('expected_ref="refs/heads/main"');
    expect(validate.run).toContain('expected_ref="refs/heads/develop"');
    expect(validate.run).toContain('if [ "$SOURCE_REF" != "$expected_ref" ]');
  });

  test("applies only an encrypted, service-bound artifact from a successful plan attempt", () => {
    const plan = step(infra, "terraform", "Plan");
    expect(plan.run).toContain("terraform plan");
    const packagePlan = step(infra, "terraform", "Package reviewed plan");
    expect(packagePlan.run).toContain("sha256sum selected.tfplan");
    expect(packagePlan.run).toContain("plan-metadata.json");
    expect(packagePlan.run).toContain("selected.tfplan.enc");
    expect(packagePlan.run).toContain("terraform-plan-envelope.mjs");
    expect(packagePlan.run).not.toContain(
      'cp selected.tfplan "$artifact_dir/selected.tfplan"',
    );
    const validateRun = step(infra, "terraform", "Validate reviewed plan run");
    expect(validateRun.run).toContain('run.name !== "Infrastructure"');
    expect(validateRun.run).toContain(
      'run.path !== ".github/workflows/infra.yml"',
    );
    expect(validateRun.run).toContain('run.conclusion !== "success"');
    expect(validateRun.run).toContain("run.run_attempt");
    const resolveArtifact = step(
      infra,
      "terraform",
      "Resolve reviewed plan artifact",
    );
    expect(resolveArtifact.run).toContain(
      "actions/artifacts/$EXPECTED_ARTIFACT_ID",
    );
    expect(resolveArtifact.run).toContain("artifact.digest");
    expect(resolveArtifact.run).toContain("artifact.workflow_run?.id");
    expect(resolveArtifact.run).toContain("EXPECTED_RUN_ATTEMPT");
    const downloadArtifact = step(
      infra,
      "terraform",
      "Download reviewed plan artifact",
    );
    expect(downloadArtifact.with?.["artifact-ids"]).toContain(
      "inputs.plan_artifact_id",
    );
    expect(downloadArtifact.with).not.toHaveProperty("name");
    const validateArtifact = step(
      infra,
      "terraform",
      "Validate reviewed plan artifact",
    );
    expect(validateArtifact.run).toContain("selected.tfplan.enc");
    expect(validateArtifact.run).toContain(
      "Reviewed artifact contains a plaintext Terraform plan",
    );
    expect(validateArtifact.run).toContain("EXPECTED_SOURCE_SHA");
    const decrypt = step(infra, "terraform", "Decrypt reviewed plan");
    expect(decrypt.run).toContain("terraform-plan-envelope.mjs");
    expect(decrypt.run).toContain("actual_digest");
    const apply = step(infra, "terraform", "Apply reviewed plan");
    expect(apply.run).toContain("terraform apply");
    expect(apply.run).not.toContain("terraform plan");
    const upload = step(infra, "terraform", "Upload reviewed plan artifact");
    expect(upload.with?.name).toBe(
      "terraform-plan-$" + "{{ github.run_id }}-$" + "{{ github.run_attempt }}",
    );
    expect(
      infra.jobs?.terraform?.env?.TERRAFORM_PLAN_ARTIFACT_PUBLIC_KEY,
    ).toContain("vars.TERRAFORM_PLAN_ARTIFACT_PUBLIC_KEY");
    expect(infra.jobs?.terraform?.env).not.toHaveProperty(
      "TERRAFORM_PLAN_ARTIFACT_PRIVATE_KEY",
    );
    expect(decrypt.env?.TERRAFORM_PLAN_ARTIFACT_PRIVATE_KEY).toContain(
      "secrets.TERRAFORM_PLAN_ARTIFACT_PRIVATE_KEY",
    );
    expect(infraSource).not.toContain("TERRAFORM_PLAN_ARTIFACT_KEY");
    const summary = step(
      infra,
      "terraform",
      "Summarize reviewed plan identity",
    );
    expect(summary.run).toContain("Artifact digest: sha256:$ARTIFACT_DIGEST");
    expect(infraSource).not.toContain(
      "$RUNNER_TEMP/terraform-plan-artifact/selected.tfplan\n",
    );
  });

  test("derives Terraform deploy branches from the selected environment", () => {
    const deployBranch = infra.jobs?.terraform?.env?.TF_VAR_deploy_branch;
    expect(deployBranch).toContain("inputs.environment == 'production'");
    expect(deployBranch).toContain("'main' || 'develop'");
    expect(deployBranch).not.toContain("vars.DEPLOY_BRANCH");

    const preflight = step(
      infra,
      "terraform",
      "Validate canonical environment contract",
    );
    expect(preflight.run).toContain(
      'require_exact TF_VAR_deploy_branch "$TF_VAR_deploy_branch" "main"',
    );
    expect(preflight.run).toContain(
      'require_exact TF_VAR_deploy_branch "$TF_VAR_deploy_branch" "develop"',
    );
    expect(preflight.run).toContain("https://api.eliza.app");
    expect(preflight.run).toContain("https://api-staging.eliza.app");
    expect(preflight.run).not.toContain('echo "$actual"');
  });

  test("passes and verifies the generalized Pages edge inventory contract", () => {
    const environment = infra.jobs?.terraform?.env ?? {};
    const bindings = {
      TF_VAR_dns_record_import_ids: "DNS_RECORD_IMPORT_IDS_JSON",
      TF_VAR_canonical_edge_wildcard_origins:
        "CANONICAL_EDGE_WILDCARD_ORIGINS_JSON",
      TF_VAR_canonical_service_origins: "CANONICAL_SERVICE_ORIGINS_JSON",
      TF_VAR_railway_tunnel_dns_records: "RAILWAY_TUNNEL_DNS_RECORDS_JSON",
      TF_VAR_canonical_edge_certificate_packs:
        "CANONICAL_EDGE_CERTIFICATE_PACKS_JSON",
      TF_VAR_legacy_redirect_wildcard_origins:
        "LEGACY_REDIRECT_WILDCARD_ORIGINS_JSON",
      TF_VAR_legacy_redirect_certificate_packs:
        "LEGACY_REDIRECT_CERTIFICATE_PACKS_JSON",
    } as const;
    for (const [terraformName, githubName] of Object.entries(bindings)) {
      expect(environment[terraformName]).toContain(`vars.${githubName}`);
    }
    expect(environment).not.toHaveProperty(
      "TF_VAR_canonical_staging_agent_certificate_hosts",
    );

    const credentialCheck = step(
      infra,
      "terraform",
      "Validate credentials and state operation",
    );
    for (const githubName of Object.values(bindings)) {
      expect(credentialCheck.run).toContain(githubName);
    }
    expect(credentialCheck.run).toContain("values were not printed");

    const outputCheck = step(
      infra,
      "terraform",
      "Verify Pages domain and certificate state",
    );
    for (const output of [
      "pages_domains",
      "canonical_edge",
      "railway_tunnel_dns",
      "redirect_dns",
      "legacy_certificate_packs",
    ]) {
      expect(outputCheck.run).toContain(`terraform output -json ${output}`);
    }
    expect(outputCheck.run).toContain("requireProxiedRecords");
    expect(outputCheck.run).toContain("requireDnsOnlyRecords");
    expect(outputCheck.run).toContain("requireActivePacks");
    expect(infraSource).not.toContain("staging_agent_edge");
    expect(infraSource).not.toContain(
      "CANONICAL_STAGING_AGENT_CERTIFICATE_HOSTS_JSON",
    );
  });

  test("requires GitHub-authoritative provisioning settings and preserves host secrets", () => {
    const preflight = step(
      provisioning,
      "deploy",
      "Validate canonical deploy configuration and shared secrets",
    );
    expect(preflight.id).toBe("deploy_config");
    const requiredManifest = preflight.run?.slice(
      preflight.run.indexOf("required_deploy_settings=("),
      preflight.run.indexOf("\nmissing=()"),
    );
    expect(requiredManifest).toContain("required_deploy_settings=(");
    for (const name of [
      "DEPLOY_HOST",
      "DEPLOY_SSH_KEY",
      "HEADSCALE_API_URL",
      "HEADSCALE_PUBLIC_URL",
      "HEADSCALE_API_KEY",
      "DATABASE_URL",
    ]) {
      expect(requiredManifest).toContain(`\n  ${name}\n`);
    }
    expect(requiredManifest).not.toContain("CONTAINERS_SSH_KEY");
    expect(requiredManifest).not.toContain("SECRETS_MASTER_KEY");
    expect(preflight.run).toContain(
      "Missing required provisioning settings for GitHub environment $TARGET_ENVIRONMENT",
    );
    expect(preflight.run).toContain("exit 1");
    expect(preflight.run).not.toContain("skipping provisioning-worker deploy");
    expect(preflight.run).not.toContain("GitHub environment `production`");
    expect(preflight.run).not.toContain('echo "$value"');
    expect(preflight.run).toContain("https://headscale.eliza.app");
    expect(preflight.run).toContain("https://headscale-staging.eliza.app");
    expect(preflight.run).toContain('"cloud.eliza.app"');
    expect(preflight.run).toContain('"cloud-staging.eliza.app"');

    const remoteDeploy = step(
      provisioning,
      "deploy",
      "Deploy and restart worker",
    );
    const remoteScript = remoteDeploy.with?.script;
    expect(remoteScript).toContain("required_host_settings=(");
    for (const name of workerSecretNames) {
      expect(remoteScript).toContain(`\n  ${name}\n`);
    }
    expect(remoteScript).toContain(
      "Provisioning host is missing required setting name(s)",
    );
    expect(remoteScript).toContain("values were not printed");
    expect(remoteScript).not.toContain('echo "$val"');
  });

  test("fails the apps worker closed when its declared host is absent", () => {
    const preflight = step(appsWorker, "deploy", "Check deploy configuration");
    expect(preflight.run).toContain("for name in DEPLOY_HOST DEPLOY_SSH_KEY");
    expect(preflight.run).toContain("Apps worker deploy blocked");
    expect(preflight.run).toContain("exit 1");
    expect(preflight.run).not.toContain("skipping apps-worker deploy");
    expect(preflight.run).not.toContain('echo "$value"');
  });

  test("validates canonical Worker routes before any cutover mutation", () => {
    const steps = cloud.jobs?.["deploy-api"]?.steps ?? [];
    const preflightIndex = steps.findIndex(
      (candidate) => candidate.name === "Validate canonical routing contract",
    );
    const mutationIndex = steps.findIndex(
      (candidate) =>
        candidate.name === "Disable staging session exchange before cutover",
    );
    expect(preflightIndex).toBeGreaterThan(0);
    expect(preflightIndex).toBeLessThan(mutationIndex);

    const preflight = steps[preflightIndex];
    expect(preflight?.run).toContain("https://eliza.app");
    expect(preflight?.run).toContain("https://staging.eliza.app");
    expect(preflight?.run).toContain("https://cloud.eliza.app");
    expect(preflight?.run).toContain("https://cloud-staging.eliza.app");
    expect(preflight?.run).toContain("https://relay.eliza.app");
    expect(preflight?.run).toContain("https://relay-staging.eliza.app");
    expect(preflight?.run).not.toContain('echo "$value"');
  });

  test("publishes configured shared secrets and preserves absent Worker values", () => {
    const publish = step(cloud, "deploy-api", "Publish Worker AI secrets");
    for (const name of cloudWorkerSecretNames) {
      expect(publish.env?.[name]).toContain("secrets.");
      expect(publish.run).toContain(`\n  ${name}\n`);
    }
    expect(publish.run).toContain("managed_worker_provisioning_secrets=(");
    expect(publish.run).toContain('publish_secret "$name" || exit 1');
    expect(publish.run).toContain(
      'echo "::notice::$name is not configured; skipping"',
    );
    expect(publish.run).not.toContain("required_worker_provisioning_secrets=(");
    for (const name of requiredAuthWorkerSecretNames) {
      expect(publish.env?.[name]).toContain("secrets.");
      expect(publish.run).toContain(`\n  ${name} \\\n`);
    }
    expect(publish.env?.STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS).toContain(
      "vars.STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS",
    );
    expect(publish.env?.STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS).toContain(
      "vars.STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS",
    );
    expect(
      publish.env?.STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS,
    ).toContain("vars.STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS");
  });

  test("verifies required Worker binding names after deploy without reading values", () => {
    const steps = cloud.jobs?.["deploy-api"]?.steps ?? [];
    const deployIndex = steps.findIndex(
      (candidate) => candidate.name === "Deploy to Cloudflare Workers",
    );
    const inventoryIndex = steps.findIndex(
      (candidate) =>
        candidate.name === "Verify required Worker secret binding names",
    );
    const healthIndex = steps.findIndex(
      (candidate) => candidate.name === "Verify deployed API commit",
    );
    expect(deployIndex).toBeGreaterThan(0);
    expect(inventoryIndex).toBeGreaterThan(deployIndex);
    expect(inventoryIndex).toBeLessThan(healthIndex);

    const inventory = steps[inventoryIndex];
    expect(inventory?.run).toContain("wrangler@4.100.0 secret list");
    expect(inventory?.run).toContain("--format json");
    for (const name of cloudWorkerSecretNames) {
      expect(inventory?.run).toContain(`\n    "${name}",\n`);
    }
    for (const name of requiredAuthWorkerSecretNames) {
      expect(inventory?.run).toContain(`\n    "${name}",\n`);
    }
    expect(inventory?.run).toContain(
      "Missing required Worker secret binding name(s)",
    );
    expect(inventory?.run).toContain("values were not read");
  });

  test("handles only the Pages project already-exists outcome", () => {
    const bootstrap = step(
      cloud,
      "deploy-app",
      "Ensure eliza-app Pages project exists",
    );
    expect(bootstrap.run).toContain("pages project create eliza-app");
    expect(bootstrap.run).toContain("grep -Eqi 'already exists|");
    expect(bootstrap.run).toContain(
      "Unable to create or confirm the eliza-app Pages project",
    );
    expect(bootstrap.run).toContain("exit 1");
    expect(bootstrap.run).not.toContain("|| true");
    expect(bootstrap.run).not.toContain("2>/dev/null");
  });

  test("verifies both browser hosts and exact API and OIDC proxy routes", () => {
    const verify = step(cloud, "deploy-app", "Verify Pages frontend freshness");
    expect(verify.env?.MARKETING_URL).toContain("https://eliza.app");
    expect(verify.env?.MARKETING_URL).toContain("https://staging.eliza.app");
    expect(verify.env?.CLOUD_APP_URL).toContain("https://cloud.eliza.app");
    expect(verify.env?.CLOUD_APP_URL).toContain(
      "https://cloud-staging.eliza.app",
    );
    expect(verify.run).toContain(
      'for served_url in "$MARKETING_URL" "$CLOUD_APP_URL"',
    );
    expect(verify.run).toContain('verify_exact_api_route "$served_url/api"');
    expect(verify.run).toContain(
      'verify_json_endpoint "$served_url/.well-known/openid-configuration" discovery',
    );
    expect(verify.run).toContain(
      'verify_json_endpoint "$served_url/.well-known/oidc/jwks.json" jwks',
    );
    expect(verify.run).toContain(
      "node packages/cloud/scripts/verify-steward-oauth-callbacks.mjs",
    );
    expect(verify.run).toContain('--callback-url "$served_url/login"');
    expect(verify.run).toContain('tenant_id="elizacloud-staging"');
    expect(verify.run).toContain("OIDC issuer mismatch");
    expect(cloudSource).not.toContain(
      "pages project create eliza-app --production-branch=main 2>/dev/null || true",
    );
  });
});
