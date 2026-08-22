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
  if?: string;
  env?: Record<string, string>;
  environment?: string;
  needs?: string | string[];
  "runs-on"?:
    | string
    | {
        group?: string;
        labels?: string[];
      };
  steps?: WorkflowStep[];
  strategy?: {
    matrix?: {
      include?: Array<Record<string, string>>;
    };
  };
}

interface Workflow {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
    queue?: string;
  };
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

// `cloud-cf-deploy.yml` is the trigger/admission/approval entry point; every
// Cloudflare mutation (deploy-api, deploy-app) runs in the reusable
// `cloud-cf-release.yml` it calls, so the mutation contracts are read there.
const cloudSource = read(".github/workflows/cloud-cf-release.yml");
const cloud = parse(".github/workflows/cloud-cf-release.yml");
const cloudDeploy = parse(".github/workflows/cloud-cf-deploy.yml");
const cloudApiWranglerSource = read("packages/cloud/api/wrangler.toml");
const infraSource = read(".github/workflows/infra.yml");
const infra = parse(".github/workflows/infra.yml");
const slopHubSource = read(".github/workflows/slophub-cutover.yml");
const slopHub = parse(".github/workflows/slophub-cutover.yml");
const prodOpsSource = read(".github/workflows/prod-ops-runner.yml");
const prodOps = parse(".github/workflows/prod-ops-runner.yml");
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
  "GATEWAY_INTERNAL_SECRET",
] as const;

describe("canonical cloud deployment environment contract", () => {
  test("records the staging certificate with the upload action digest shape", () => {
    expect(cloudDeploy.jobs?.["certify-staging-release"]?.if).toContain(
      "needs.release.outputs.superseded != 'true'",
    );
    const record = step(
      cloudDeploy,
      "certify-staging-release",
      "Record certification identity",
    );

    expect(record.env?.ARTIFACT_DIGEST).toContain(
      "steps.upload.outputs.artifact-digest",
    );
    expect(record.run).toContain('[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]');
    const digestVariable = "$" + "{ARTIFACT_DIGEST}";
    expect(record.run).toContain(`(sha256:${digestVariable})`);
    expect(record.run).not.toContain(
      '[[ "$ARTIFACT_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
    );
  });

  test("queues apps-worker deploys per environment without per-SHA races", () => {
    expect(appsWorker.concurrency?.group).toContain("deploy-apps-worker-");
    expect(appsWorker.concurrency?.group).not.toContain("github.sha");
    expect(appsWorker.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(appsWorker.concurrency?.queue).toBe("max");
    const source = step(appsWorker, "deploy", "Resolve exact deploy source");
    const deploy = step(appsWorker, "deploy", "Deploy and restart apps worker");
    const health = step(appsWorker, "deploy", "Health check");
    expect(source.run).toContain("/git/ref/heads/$TARGET_BRANCH");
    expect(source.run).toContain('echo "sha=$target_sha"');
    expect(deploy.with?.envs).toContain("TARGET_SHA");
    expect(deploy.with?.script).toContain("apps-worker-deployed-sha");
    expect(deploy.with?.script).toContain("skipping redundant queued build");
    expect(deploy.with?.script).toContain('deployed_head" = "$TARGET_SHA"');
    expect(deploy.with?.script).toContain('origin "$TARGET_SHA"');
    expect(health.with?.envs).toContain("TARGET_SHA");
    expect(health.with?.script).toContain(
      "sudo tee /var/lib/eliza/apps-worker-deployed-sha",
    );
    expect(health.with?.script).toContain('deployed_head" != "$TARGET_SHA"');
  });

  test("runs genuine Shared Eliza in staging and production", () => {
    const staging = cloudApiWranglerSource.slice(
      cloudApiWranglerSource.indexOf("[env.staging.vars]"),
      cloudApiWranglerSource.indexOf("[env.production.vars]"),
    );
    const production = cloudApiWranglerSource.slice(
      cloudApiWranglerSource.indexOf("[env.production.vars]"),
    );

    for (const environment of [staging, production]) {
      expect(environment).toContain('name = "SHARED_RUNTIME_CONVERSATIONS"');
      expect(environment).toContain('class_name = "SharedRuntimeConversation"');
      expect(environment).not.toContain("SHARED_ELIZA_AGENT_RUNTIME");
    }
  });

  test("enables Shared semantic memory only in the staging prove-out", () => {
    const staging = cloudApiWranglerSource.slice(
      cloudApiWranglerSource.indexOf("[env.staging.vars]"),
      cloudApiWranglerSource.indexOf("[env.production.vars]"),
    );
    const production = cloudApiWranglerSource.slice(
      cloudApiWranglerSource.indexOf("[env.production.vars]"),
    );

    for (const flag of [
      "SHARED_MEMORY_TABLES_ENABLED",
      "SHARED_RECALL_ENABLED",
    ]) {
      expect(staging).toContain(`${flag} = "true"`);
      expect(production).not.toContain(flag);
    }
  });

  test("keeps Shared Discord reminder delivery bound across Worker deploys", () => {
    const staging = cloudApiWranglerSource.slice(
      cloudApiWranglerSource.indexOf("[env.staging.vars]"),
      cloudApiWranglerSource.indexOf("[env.production.vars]"),
    );
    const production = cloudApiWranglerSource.slice(
      cloudApiWranglerSource.indexOf("[env.production.vars]"),
    );

    expect(staging).toContain(
      'ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL = "https://gateway-discord-staging-staging.up.railway.app"',
    );
    expect(production).toContain(
      'ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL = "https://gateway-discord-production.up.railway.app"',
    );
  });

  test("keeps the fixed SlopHub cutover behind a reviewed production plan", () => {
    const triggerBlock = slopHubSource.slice(
      slopHubSource.indexOf("on:"),
      slopHubSource.indexOf("\nconcurrency:"),
    );
    expect(triggerBlock).toContain("workflow_dispatch:");
    expect(triggerBlock).toContain("default: plan");
    for (const forbiddenTrigger of ["push:", "pull_request:", "schedule:"]) {
      expect(triggerBlock).not.toContain(forbiddenTrigger);
    }
    for (const forbiddenTargetInput of [
      "dns_name:",
      "zone_name:",
      "server_id:",
      "firewall_id:",
      "target_ipv4:",
    ]) {
      expect(triggerBlock).not.toContain(forbiddenTargetInput);
    }

    expect(slopHub.jobs?.cutover?.needs).toBe("validate-source");
    expect(slopHub.jobs?.cutover?.environment).toBe("production");
    expect(slopHub.jobs?.["validate-source"]?.["runs-on"]).toBe("ubuntu-24.04");
    expect(slopHub.jobs?.cutover?.["runs-on"]).toBe("ubuntu-24.04");
    expect(slopHub.jobs?.cutover?.env).toBeUndefined();
    expect(
      step(slopHub, "validate-source", "Require production main").run,
    ).toContain('"refs/heads/main"');
    const reviewedRun = step(slopHub, "cutover", "Validate reviewed plan run");
    expect(reviewedRun.run).toContain(
      'run.path !== ".github/workflows/slophub-cutover.yml"',
    );
    expect(reviewedRun.run).toContain("run.run_attempt");
    const artifact = step(slopHub, "cutover", "Resolve reviewed plan artifact");
    expect(artifact.run).toContain("artifact.digest");
    expect(artifact.run).toContain("artifact.workflow_run?.id");
    expect(artifact.run).toContain("EXPECTED_RUN_ATTEMPT");
    const checkout = slopHub.jobs?.cutover?.steps?.find((candidate) =>
      candidate.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.ref).toContain(
      "steps.reviewed-run.outputs.source_sha",
    );
    for (const name of ["Plan fixed cutover", "Apply reviewed cutover"]) {
      const operator = step(slopHub, "cutover", name);
      expect(operator.env?.CLOUDFLARE_ACCOUNT_ID).toContain(
        "secrets.CLOUDFLARE_ACCOUNT_ID",
      );
      expect(operator.env?.CLOUDFLARE_API_TOKEN).toContain(
        "secrets.CLOUDFLARE_API_TOKEN",
      );
      expect(operator.env?.HCLOUD_TOKEN).toContain("secrets.HCLOUD_TOKEN");
    }
    for (const action of slopHub.jobs?.cutover?.steps?.filter(
      (candidate) => candidate.uses,
    ) ?? []) {
      expect(action.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
      expect(action.env?.HCLOUD_TOKEN).toBeUndefined();
    }
    expect(slopHubSource).toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(slopHubSource).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(slopHubSource).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(slopHubSource).not.toMatch(/wallet|payment|payout|settlement/i);
    expect(cloudApiWranglerSource).toContain(
      `OIDC_REDIRECT_URI_ALIASES = '{"elizahub":["https://git.slop.cash/user/oauth2/elizacloud/callback"]}'`,
    );
    expect(requiredAuthWorkerSecretNames).toContain("OIDC_CLIENTS");
    expect([...requiredAuthWorkerSecretNames]).not.toContain(
      "OIDC_REDIRECT_URI_ALIASES",
    );
    expect(cloudSource).not.toContain("secrets.OIDC_REDIRECT_URI_ALIASES");
  });

  test("reserves prod-ops for a protected manual main-branch doctor", () => {
    const triggerBlock = prodOpsSource.slice(
      prodOpsSource.indexOf("on:"),
      prodOpsSource.indexOf("\nconcurrency:"),
    );
    expect(triggerBlock).toContain("workflow_dispatch:");
    for (const forbiddenTrigger of ["push:", "pull_request:", "schedule:"]) {
      expect(triggerBlock).not.toContain(forbiddenTrigger);
    }
    expect(prodOps.jobs?.doctor?.needs).toBe("validate-source");
    expect(prodOps.jobs?.doctor?.environment).toBe("production");
    expect(prodOps.jobs?.["validate-source"]?.["runs-on"]).toBe("ubuntu-24.04");
    expect(prodOps.jobs?.doctor?.["runs-on"]).toEqual({
      group: "prod-ops",
      labels: ["self-hosted", "Linux", "X64", "$" + "{{ matrix.slot }}"],
    });
    expect(prodOps.jobs?.doctor?.strategy?.matrix?.include).toEqual([
      {
        slot: "prod-ops-1",
        runner_name_prefix: "eliza-prod-ops-1-",
      },
      {
        slot: "prod-ops-2",
        runner_name_prefix: "eliza-prod-ops-2-",
      },
    ]);
    expect(
      step(prodOps, "validate-source", "Require production main").run,
    ).toContain('"refs/heads/main"');
    expect(infra.jobs?.["validate-source"]?.["runs-on"]).toBe("ubuntu-24.04");
    expect(infra.jobs?.terraform?.["runs-on"]).toBe("ubuntu-24.04");
    const doctor = step(
      prodOps,
      "doctor",
      "Verify runner identity and workload isolation",
    );
    expect(doctor.run).toContain("/etc/eliza/prod-ops-runner");
    expect(doctor.run).toContain("public_pr_jobs=forbidden");
    for (const forbiddenService of [
      "forgejo",
      "caddy",
      "eliza-provisioning-worker",
      "docker",
    ]) {
      expect(doctor.run).toContain(forbiddenService);
    }
  });

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

  test("validates quoted Terraform state addresses through the executable parser", () => {
    const validate = step(
      infra,
      "terraform",
      "Validate credentials and state operation",
    );
    expect(validate.run).toContain(
      'node packages/scripts/validate-terraform-state-address.mjs "$STATE_ADDRESS"',
    );
    expect(validate.run).not.toContain('$STATE_ADDRESS" =~');
  });

  test("selects the dedicated Pages credential without changing other Terraform roots", () => {
    const token = infra.jobs?.terraform?.env?.CLOUDFLARE_API_TOKEN;
    expect(token).toContain("inputs.component == 'pages-domains'");
    expect(token).toContain("secrets.CLOUDFLARE_PAGES_API_TOKEN");
    expect(token).toContain("|| secrets.CLOUDFLARE_API_TOKEN");
    expect(token?.match(/secrets\.CLOUDFLARE_PAGES_API_TOKEN/g)).toHaveLength(
      1,
    );
    expect(token?.match(/secrets\.CLOUDFLARE_API_TOKEN/g)).toHaveLength(1);
  });

  test("applies only an encrypted, service-bound artifact from a successful plan attempt", () => {
    const plan = step(infra, "terraform", "Plan");
    expect(plan.run).toContain("terraform plan");
    const packagePlan = step(infra, "terraform", "Package reviewed plan");
    expect(packagePlan.run).toContain("sha256sum selected.tfplan");
    expect(packagePlan.run).toContain(
      '--arg planScope "$TERRAFORM_PLAN_SCOPE"',
    );
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
    expect(validateArtifact.run).toContain(
      "planScope: process.env.TERRAFORM_PLAN_SCOPE",
    );
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

  test("can isolate additive canonical wildcard resources from unrelated Pages drift", () => {
    const validate = step(
      infra,
      "terraform",
      "Validate credentials and state operation",
    );
    expect(validate.run).toContain(
      '[ "$' + '{{ inputs.component }}" = "pages-domains" ]',
    );
    expect(validate.run).toContain(
      '[ "$TERRAFORM_PLAN_SCOPE" = "canonical-edge-additive" ]',
    );
    expect(validate.run).toContain('[ "$OPERATION" != "state-rm" ]');

    const plan = step(infra, "terraform", "Plan");
    expect(plan.run).toContain('select((.value.id // "") == "")');
    expect(plan.run).toContain(
      '"-target=cloudflare_certificate_pack.canonical_edge[\\"$key\\"]"',
    );
    expect(plan.run).toContain('site_wildcard="*.sites.eliza.app"');
    expect(plan.run).toContain('site_wildcard="*.sites-staging.eliza.app"');
    expect(plan.run).toContain(
      '"-target=cloudflare_dns_record.canonical_edge_wildcard[\\"$site_wildcard|$origin\\"]"',
    );
    expect(plan.run).toContain("terraform show -json selected.tfplan");
    expect(plan.run).toContain(
      "validate-terraform-canonical-edge-additive-plan.mjs",
    );
    expect(plan.run).not.toContain("legacy_redirect");
    expect(plan.run).not.toContain("cloudflare_dns_record.pages");

    const scopedPlanValidation = step(
      infra,
      "terraform",
      "Validate additive canonical edge plan",
    );
    expect(scopedPlanValidation.run).toContain(
      "terraform show -json selected.tfplan",
    );
    expect(scopedPlanValidation.run).toContain(
      "validate-terraform-canonical-edge-additive-plan.mjs",
    );

    const scopedVerification = step(
      infra,
      "terraform",
      "Verify additive canonical edge state",
    );
    expect(scopedVerification.run).toContain(
      'terraform refresh "${refresh_args[@]}"',
    );
    expect(scopedVerification.run).toContain(
      'refresh_args+=("-target=$address")',
    );
    expect(scopedVerification.run).not.toContain(
      "terraform refresh -no-color -input=false",
    );
    expect(scopedVerification.run).toContain(
      "canonical-edge-reviewed-plan.json",
    );
    expect(scopedVerification.run).toContain("canonical.certificate_packs");
    expect(scopedVerification.run).not.toContain("legacy_certificate_packs");

    const cleanup = step(infra, "terraform", "Remove plaintext reviewed plan");
    expect(cleanup.run).toContain(
      'shred -u "$RUNNER_TEMP/canonical-edge-reviewed-plan.json"',
    );
    const planCleanup = step(
      infra,
      "terraform",
      "Remove plaintext planned state",
    );
    expect(planCleanup.run).toContain(
      'shred -u "$RUNNER_TEMP/canonical-edge-reviewed-plan.json"',
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
      "Verify full Pages domain and certificate state",
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
    expect(outputCheck.run).toContain(
      "validate-terraform-pages-domain-state.mjs",
    );
    expect(outputCheck.run).toContain('"$TF_VAR_environment"');
    expect(outputCheck.run).not.toContain("node -e '");
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
    expect(preflight.run).toContain("http://127.0.0.1:8081");
    expect(preflight.run).toContain("http://127.0.0.1:8080");
    expect(preflight.run).toContain(
      'echo "HEADSCALE_API_URL=$resolved_headscale_api_url" >> "$GITHUB_ENV"',
    );
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

  test("queues configured shared secrets and preserves absent Worker values", () => {
    const publish = step(
      cloud,
      "deploy-api",
      "Prepare Worker secrets for atomic deploy",
    );
    for (const name of cloudWorkerSecretNames) {
      expect(publish.env?.[name]).toContain("secrets.");
      expect(publish.run).toContain(`\n  ${name}\n`);
    }
    expect(publish.run).toContain("managed_worker_provisioning_secrets=(");
    expect(publish.run).toContain('queue_secret "$name" || exit 1');
    expect(publish.run).toContain(
      'echo "::notice::$name is not configured; skipping"',
    );
    expect(publish.run).not.toContain("required_worker_provisioning_secrets=(");
    for (const name of [
      "ELIZA_APNS_KEY",
      "ELIZA_APNS_KEY_ID",
      "ELIZA_APNS_TEAM_ID",
      "ELIZA_APNS_TOPIC",
      "ELIZA_APNS_PRODUCTION",
    ]) {
      expect(publish.env?.[name]).toBeDefined();
      expect(publish.run).toContain(`\n  ${name} \\\n`);
    }
    expect(publish.env?.ELIZA_APNS_KEY).toContain("secrets.ELIZA_APNS_KEY");
    expect(publish.env?.ELIZA_APNS_TOPIC).toContain("vars.ELIZA_APNS_TOPIC");
    expect(publish.env?.ELIZA_APNS_PRODUCTION).toContain(
      "vars.ELIZA_APNS_PRODUCTION",
    );
    expect(publish.run).toContain("verify_apns_binding_candidates");
    expect(publish.run).toContain("partial existing or configured bindings");
    expect(publish.run).toContain('ELIZA_APNS_TOPIC" != "ai.elizaos.app');
    expect(publish.run).toContain('ELIZA_APNS_PRODUCTION" != "0"');
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
    expect(inventory?.run).toContain("wrangler@4.116.0 secret list");
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
    expect(inventory?.run).toContain(
      "Personal Shared APNs bindings are partial",
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

  test("scopes post-deploy routing verification to the deployed environment", () => {
    const resolve = step(
      cloud,
      "verify-routing",
      "Resolve deployed environment",
    );
    expect(resolve.env?.TARGET_ENVIRONMENT).toContain(
      "inputs.target_environment",
    );
    expect(resolve.run).toContain("set -euo pipefail");
    expect(resolve.run).toContain("staging|production");
    expect(resolve.run).toContain(
      'echo "environment=$TARGET_ENVIRONMENT" >> "$GITHUB_OUTPUT"',
    );
    expect(resolve.run).not.toContain('echo "environment=$env"');

    const verify = step(
      cloud,
      "verify-routing",
      "Verify the just-deployed environment serves itself",
    );
    expect(verify.run).toContain(
      '--environment "${' + '{ steps.env.outputs.environment }}"',
    );
    expect(verify.run).toContain("--require-beacon");
  });
});
