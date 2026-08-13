/**
 * Guards the protected tunnel-proxy deploy workflow's canonical routing,
 * secret-handling, Railway state, Headscale rotation, and live smoke contracts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const workflowPath = new URL(
  ".github/workflows/deploy-tunnel-proxy.yml",
  repoRoot,
);
const source = readFileSync(workflowPath, "utf8");

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  "working-directory"?: string;
}

interface WorkflowJob {
  env?: Record<string, string>;
  environment?: string;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(source) as Workflow;
const deploy = workflow.jobs?.deploy;
const steps = deploy?.steps ?? [];

function step(name: string): WorkflowStep {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tunnel-proxy workflow step: ${name}`);
  return found;
}

describe("protected tunnel-proxy deployment workflow", () => {
  test("binds the selected protected environment and canonical branch", () => {
    expect(source).toContain(
      "RAILWAY_SERVICE_ID: $" + "{{ vars.RAILWAY_SERVICE_ID_TUNNEL_PROXY }}",
    );
    expect(deploy?.environment).toContain("inputs.environment");
    expect(deploy?.env?.DEPLOY_BRANCH).toContain(
      "inputs.environment == 'production'",
    );
    expect(deploy?.env?.DEPLOY_BRANCH).toContain("'main' || 'develop'");

    const preflight = step("Validate protected canonical configuration");
    for (const name of [
      "HEADSCALE_PUBLIC_URL",
      "TUNNEL_PROXY_HOST",
      "RAILWAY_PROJECT_ID",
      "RAILWAY_ENVIRONMENT_ID",
      "RAILWAY_SERVICE_ID",
      "RAILWAY_TOKEN",
      "DEPLOY_HOST",
      "DEPLOY_SSH_KEY",
      "DEPLOY_SSH_KNOWN_HOSTS",
      "TUNNEL_HOSTNAME_SIGNING_SECRET",
    ]) {
      expect(preflight.run).toContain(`\n  ${name}\n`);
    }
    expect(preflight.run).toContain("https://headscale.eliza.app");
    expect(preflight.run).toContain("https://headscale-staging.eliza.app");
    expect(preflight.run).toContain('"tunnel.eliza.app"');
    expect(preflight.run).toContain('"tunnel-staging.eliza.app"');
    expect(preflight.run).toContain('"refs/heads/$DEPLOY_BRANCH"');
    expect(preflight.run).not.toContain('echo "$actual"');
  });

  test("targets only the declared Railway project, environment, and service", () => {
    const install = step("Install pinned Railway CLI");
    expect(install.run).toContain("v5.38.0");
    expect(install.run).toContain(
      "72835c48a710c48c4542141bf12264823cf3a029b514f9e27994096c036c539e",
    );
    expect(install.run).toContain("sha256sum --check --status");

    const verifyTarget = step("Verify exact Railway target");
    expect(verifyTarget.run).toContain("railway status");
    expect(verifyTarget.run).toContain('--project "$RAILWAY_PROJECT_ID"');
    expect(verifyTarget.run).toContain(
      '--environment "$RAILWAY_ENVIRONMENT_ID"',
    );
    expect(verifyTarget.run).toContain('.node.name == "tunnel-proxy"');

    const volume = step("Converge persistent tsnet volume");
    expect(volume.run).toContain("railway volume");
    expect(volume.run).toContain("--mount-path /var/lib/tunnel-proxy");
    expect(volume.run).toContain('.mountPath == "/var/lib/tunnel-proxy"');

    const deploySource = step("Deploy tunnel-proxy source to Railway");
    expect(deploySource["working-directory"]).toBe(
      "packages/cloud/services/tunnel-proxy",
    );
    expect(deploySource.run).toContain("railway up");
    expect(deploySource.run).toContain('--service "$RAILWAY_SERVICE_ID"');
  });

  test("publishes secret variables through stdin without reading Railway values", () => {
    const variables = step(
      "Converge non-secret Railway variables and signing secret",
    );
    expect(variables.run).toContain(
      "printf '%s' \"$TUNNEL_HOSTNAME_SIGNING_SECRET\" | railway variable set",
    );
    expect(variables.run).toContain("TUNNEL_HOSTNAME_SIGNING_SECRET");
    expect(variables.run).toContain("--stdin");
    expect(variables.run).toContain('"TUNNEL_ALLOW_UNSIGNED_HOSTNAMES=false"');

    const headscale = step(
      "Mint proxy key and publish it without exposing the value",
    );
    expect(headscale.run).toContain("--reusable");
    expect(headscale.run).toContain("--expiration 8760h");
    expect(headscale.run).toContain("--tags tag:eliza-proxy");
    expect(headscale.run).toContain("-o StrictHostKeyChecking=yes");
    expect(headscale.run).toContain(
      '-o UserKnownHostsFile="$DEPLOY_SSH_KNOWN_HOSTS_PATH"',
    );
    expect(headscale.run).toContain('echo "::add-mask::$new_key"');
    expect(headscale.run).toContain(
      "printf '%s' \"$new_key\" | railway variable set",
    );
    expect(headscale.run).toContain("TUNNEL_PROXY_TS_AUTHKEY");
    expect(headscale.run).toContain("--stdin");
    expect(headscale.run).not.toContain('echo "$new_key"');
    expect(source).not.toContain("ssh-keyscan");
    expect(source).not.toContain("StrictHostKeyChecking=accept-new");

    expect(source).not.toContain("railway variable list");
    expect(source).not.toContain("railway variables --json");
  });

  test("attaches and verifies the exact apex and wildcard domains", () => {
    const converge = step("Converge exact Railway custom domains");
    expect(converge.run).toContain(
      'for domain in "$TUNNEL_PROXY_HOST" "*.$TUNNEL_PROXY_HOST"',
    );
    expect(converge.run).toContain("railway domain list");
    expect(converge.run).toContain('railway domain "$domain"');
    expect(converge.run).toContain("--port 8080");

    const handoff = step("Validate reviewed Railway DNS handoff");
    expect(deploy?.env?.RAILWAY_TUNNEL_DNS_RECORDS_JSON).toContain(
      "vars.RAILWAY_TUNNEL_DNS_RECORDS_JSON",
    );
    expect(handoff.run).toContain('railway domain status "$TUNNEL_PROXY_HOST"');
    expect(handoff.run).toContain(
      'railway domain status "*.$TUNNEL_PROXY_HOST"',
    );
    for (const logicalKey of [
      "apex-routing",
      "apex-verification",
      "wildcard-routing",
      "wildcard-certificate",
      "wildcard-verification",
    ]) {
      expect(handoff.run).toContain(`"${logicalKey}"`);
    }
    expect(handoff.run).toContain("DNS_RECORD_PURPOSE_ACME_DNS01_CHALLENGE");
    expect(handoff.run).toContain("railway-verify=");
    expect(handoff.run).toContain("shared-verification");
    expect(handoff.run).toContain("group_by");
    expect(handoff.run).toContain("def fqdn");
    expect(handoff.run).toContain("$GITHUB_STEP_SUMMARY");
    expect(handoff.run).toContain(
      'cmp -s "$normalized_inventory" "$normalized_configured"',
    );
    expect(handoff.run).not.toContain(
      'echo "$RAILWAY_TUNNEL_DNS_RECORDS_JSON"',
    );

    const verify = step("Verify Railway domain ownership and certificates");
    expect(verify.run).toContain('railway domain status "$domain"');
    expect(verify.run).toContain(".domain.verification.verified == true");
    expect(verify.run).toContain('.domain.syncStatus == "ACTIVE"');
    expect(verify.run).toContain(
      '.domain.certificate.status == "CERTIFICATE_STATUS_TYPE_VALID"',
    );
    expect(verify.run).toContain("RAILWAY_TUNNEL_DNS_RECORDS_JSON");
    expect(verify.run).toContain("pages-domains Terraform plan");
  });

  test("proves live health and 404 before revoking superseded keys", () => {
    const smokeIndex = steps.findIndex(
      (candidate) =>
        candidate.name ===
        "Verify canonical health and unsigned-host rejection",
    );
    const revokeIndex = steps.findIndex(
      (candidate) =>
        candidate.name === "Expire superseded Headscale proxy keys",
    );
    expect(smokeIndex).toBeGreaterThan(0);
    expect(revokeIndex).toBeGreaterThan(smokeIndex);

    const smoke = steps[smokeIndex];
    expect(smoke?.run).toContain(
      'health_url="https://$TUNNEL_PROXY_HOST/health"',
    );
    expect(smoke?.run).toContain(
      'unsigned_host="unsigned-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.$TUNNEL_PROXY_HOST"',
    );
    expect(smoke?.run).toContain('if [ "$unsigned_status" != "404" ]');

    const revoke = steps[revokeIndex];
    expect(revoke?.run).toContain("headscale preauthkeys expire --id $id");
    expect(revoke?.run).not.toContain("preauthkeys list");
  });
});
