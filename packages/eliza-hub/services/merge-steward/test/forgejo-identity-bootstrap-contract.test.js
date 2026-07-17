import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const BOOTSTRAP_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh",
  import.meta.url,
);
const VALIDATOR_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/validate-env.sh",
  import.meta.url,
);
const POST_DEPLOY_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/post-deploy-check.sh",
  import.meta.url,
);
const EXAMPLE_ENV_PATH = new URL(
  "../../../deployment/hetzner-staging/.env.example",
  import.meta.url,
);
const STAGING_README_PATH = new URL(
  "../../../deployment/hetzner-staging/README.md",
  import.meta.url,
);
const SSO_PLAN_PATH = new URL(
  "../../../docs/eliza-cloud-sso-plan.md",
  import.meta.url,
);

describe("Forgejo identity bootstrap contract", () => {
  it("keeps identity bootstrap read-only by default and apply-gated", async () => {
    const script = await readFile(BOOTSTRAP_PATH, "utf8");

    assert.match(script, /APPLY_BOOTSTRAP="\$\{APPLY_BOOTSTRAP:-false\}"/);
    assert.match(script, /admin user create/);
    assert.match(script, /admin auth add-oauth/);
    assert.match(script, /--provider=openidConnect/);
    assert.match(script, /POSTGRES_SERVICE="\$\{POSTGRES_SERVICE:-postgres\}"/);
    assert.match(script, /login_source/);
    assert.match(script, /OpenIDConnectAutoDiscoveryURL/);
    assert.match(script, /ClientID/);
    assert.match(script, /RequiredClaimName/);
    assert.match(script, /GroupClaimName/);
    assert.match(script, /ELIZA_CLOUD_OIDC_DISCOVERY_URL/);
    assert.match(script, /FORGEJO_OIDC_SCOPES/);
    assert.match(script, /FORGEJO_RECOVERY_ADMIN_USERNAME/);
    assert.match(script, /FORGEJO_STEWARD_TOKEN/);
    assert.match(script, /VALIDATE_STEWARD="\$CHECK_STEWARD_TOKEN"/);
    assert.match(script, /Eliza Cloud OIDC auth source config matches env/);
    assert.match(script, /IDENTITY_BOOTSTRAP_EVIDENCE_OUT/);
    assert.match(script, /identity-bootstrap-evidence\.v1/);
    assert.match(script, /eliza-hub-identity-bootstrap-evidence\.json/);
    assert.doesNotMatch(script, /generate-access-token/);
    assert.doesNotMatch(script, /set -x/);
    assert.doesNotMatch(script, /cfg->>'ClientSecret'/);
  });

  it("requires the private env inputs needed for recovery admin and Eliza Cloud SSO", async () => {
    const validator = await readFile(VALIDATOR_PATH, "utf8");
    const envExample = await readFile(EXAMPLE_ENV_PATH, "utf8");

    assert.match(validator, /FORGEJO_RECOVERY_ADMIN_USERNAME/);
    assert.match(validator, /FORGEJO_RECOVERY_ADMIN_EMAIL/);
    assert.match(validator, /FORGEJO_RECOVERY_ADMIN_PASSWORD/);
    assert.match(validator, /FORGEJO_OIDC_AUTH_NAME/);
    assert.match(validator, /FORGEJO_OIDC_SCOPES/);
    assert.match(envExample, /FORGEJO_RECOVERY_ADMIN_PASSWORD=/);
    assert.match(envExample, /FORGEJO_OIDC_AUTH_NAME=elizacloud/);
    assert.match(
      envExample,
      /FORGEJO_OIDC_SCOPES="openid email profile groups"/,
    );
    assert.match(envExample, /FORGEJO_STEWARD_EMAIL=/);
  });

  it("wires the identity check into staging post-deploy and operator docs", async () => {
    const postDeploy = await readFile(POST_DEPLOY_PATH, "utf8");
    const stagingReadme = await readFile(STAGING_README_PATH, "utf8");
    const ssoPlan = await readFile(SSO_PLAN_PATH, "utf8");

    assert.match(postDeploy, /bootstrap-forgejo-identity\.sh/);
    assert.match(postDeploy, /APPLY_BOOTSTRAP=false/);
    assert.match(stagingReadme, /bootstrap-forgejo-identity\.sh/);
    assert.match(stagingReadme, /APPLY_BOOTSTRAP=true/);
    assert.match(stagingReadme, /CHECK_STEWARD_TOKEN=false/);
    assert.match(stagingReadme, /OIDC auth source config drift/);
    assert.match(stagingReadme, /eliza-hub-identity-bootstrap-evidence\.json/);
    assert.match(ssoPlan, /bootstrap-forgejo-identity\.sh/);
    assert.match(ssoPlan, /login_source/);
    assert.match(ssoPlan, /config drift/);
    assert.match(ssoPlan, /sso\.bootstrapEvidence/);
  });
});
