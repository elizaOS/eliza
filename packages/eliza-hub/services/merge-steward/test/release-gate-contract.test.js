import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

const execFileAsync = promisify(execFile);

const RELEASE_GATE_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/release-gate.sh",
  import.meta.url,
);
const STAGING_COMPOSE_PATH = new URL(
  "../../../deployment/hetzner-staging/compose.yml",
  import.meta.url,
);
const BACKUP_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/backup-evidence.mjs",
  import.meta.url,
);
const DATABASE_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/database-evidence.mjs",
  import.meta.url,
);
const IMAGE_PROVENANCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/image-provenance-evidence.mjs",
  import.meta.url,
);
const MAIL_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/mail-evidence.mjs",
  import.meta.url,
);
const MERGE_QUEUE_LIVE_DRILL_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/merge-queue-live-drill-evidence.mjs",
  import.meta.url,
);
const MERGE_QUEUE_ROLLOUT_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/merge-queue-rollout-evidence.mjs",
  import.meta.url,
);
const OBSERVABILITY_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/observability-evidence.mjs",
  import.meta.url,
);
const PRODUCTION_EVIDENCE_ASSEMBLER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
  import.meta.url,
);
const PRODUCTION_EVIDENCE_INVENTORY_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/production-evidence-inventory.mjs",
  import.meta.url,
);
const REPOSITORY_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/repository-evidence.mjs",
  import.meta.url,
);
const RUNNER_SMOKE_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/runner-smoke-evidence.mjs",
  import.meta.url,
);
const SECRET_MANAGEMENT_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/secret-management-evidence.mjs",
  import.meta.url,
);
const SECURITY_REVIEW_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/security-review-evidence.mjs",
  import.meta.url,
);
const SSO_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/sso-evidence.mjs",
  import.meta.url,
);
const STEWARD_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/steward-evidence.mjs",
  import.meta.url,
);
const STORAGE_EVIDENCE_HELPER_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/storage-evidence.mjs",
  import.meta.url,
);
const RESTORE_DRILL_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/restore-drill.sh",
  import.meta.url,
);
const SCHEDULED_BACKUP_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/run-scheduled-backup.sh",
  import.meta.url,
);
const BACKUP_SYSTEMD_SERVICE_PATH = new URL(
  "../../../deployment/hetzner-staging/systemd/eliza-hub-backup.service.example",
  import.meta.url,
);
const BACKUP_SYSTEMD_TIMER_PATH = new URL(
  "../../../deployment/hetzner-staging/systemd/eliza-hub-backup.timer.example",
  import.meta.url,
);
const HOST_PREFLIGHT_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/host-preflight.sh",
  import.meta.url,
);
const MERGE_QUEUE_ROLLOUT_DRILL_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/merge-queue-rollout-drill.sh",
  import.meta.url,
);
const POST_DEPLOY_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/post-deploy-check.sh",
  import.meta.url,
);
const STAGING_README_PATH = new URL(
  "../../../deployment/hetzner-staging/README.md",
  import.meta.url,
);
const PILOT_BOOTSTRAP_PATH = new URL(
  "../../../deployment/hetzner-staging/pilot-bootstrap.md",
  import.meta.url,
);
const RUNBOOK_PATH = new URL(
  "../../../deployment/hetzner-staging/release/README.md",
  import.meta.url,
);
const CHECKLIST_PATH = new URL(
  "../../../deployment/hetzner-staging/release/CHECKLIST.md",
  import.meta.url,
);
const PRODUCTION_EVIDENCE_TEMPLATE_PATH = new URL(
  "../../../deployment/hetzner-staging/release/production-evidence.example.json",
  import.meta.url,
);
const REVERSE_PROXY_CADDY_PATH = new URL(
  "../../../deployment/hetzner-staging/reverse-proxy/Caddyfile.example",
  import.meta.url,
);
const REVERSE_PROXY_README_PATH = new URL(
  "../../../deployment/hetzner-staging/reverse-proxy/README.md",
  import.meta.url,
);
const INFRASTRUCTURE_VALIDATOR_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/validate-infrastructure.sh",
  import.meta.url,
);
const INFRASTRUCTURE_MAIN_PATH = new URL(
  "../../../deployment/hetzner-staging/terraform/main.tf",
  import.meta.url,
);
const INFRASTRUCTURE_VERSIONS_PATH = new URL(
  "../../../deployment/hetzner-staging/terraform/versions.tf",
  import.meta.url,
);
const INFRASTRUCTURE_VARIABLES_PATH = new URL(
  "../../../deployment/hetzner-staging/terraform/variables.tf",
  import.meta.url,
);
const INFRASTRUCTURE_CLOUD_INIT_PATH = new URL(
  "../../../deployment/hetzner-staging/terraform/cloud-init.yaml.tftpl",
  import.meta.url,
);
const INFRASTRUCTURE_BACKEND_EXAMPLE_PATH = new URL(
  "../../../deployment/hetzner-staging/terraform/backend.hcl.example",
  import.meta.url,
);

describe("staging release gate contract", () => {
  it("keeps the release gate read-only and wired to existing validators", async () => {
    const script = await readFile(RELEASE_GATE_PATH, "utf8");

    assert.match(script, /validate-env\.sh/);
    assert.match(script, /host-preflight\.sh/);
    assert.match(script, /docker compose .*config/s);
    assert.match(script, /check_compose_steward_oidc_env/);
    assert.match(script, /MERGE_STEWARD_OIDC_ADMIN_ROLES/);
    assert.match(script, /MERGE_STEWARD_OIDC_ADMIN_GROUPS/);
    assert.match(script, /steward OIDC env renders/);
    assert.match(
      script,
      /shellcheck "\$DEPLOY_DIR"\/scripts\/\*\.sh "\$REPO_ROOT"\/scripts\/\*\.sh/,
    );
    assert.match(script, /reverse-proxy\/Caddyfile\.example/);
    assert.match(script, /reverse-proxy\/README\.md/);
    assert.match(script, /merge-queue-rollout-drill\.sh/);
    assert.match(script, /deploy\.sh/);
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/backup-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/database-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/image-provenance-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/mail-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/merge-queue-live-drill-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/merge-queue-rollout-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/observability-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/pilot-bootstrap\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/production-evidence-assemble\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/production-evidence-inventory\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/repository-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/runner-smoke-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/secret-management-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/security-review-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/sso-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/sso-smoke-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/steward-evidence\.mjs"/,
    );
    assert.match(
      script,
      /node --check "\$DEPLOY_DIR\/scripts\/storage-evidence\.mjs"/,
    );
    assert.match(script, /private-reference-scan\.sh/);
    assert.match(script, /validate-infrastructure\.sh/);
    assert.match(script, /Hetzner and Cloudflare infrastructure validates/);
    assert.match(script, /npm run check/);
    assert.match(script, /npm test/);
    assert.match(script, /npm audit/);
    assert.match(
      script,
      /RELEASE_GATE_MODE="\$\{RELEASE_GATE_MODE:-staging\}"/,
    );
    assert.match(script, /VALIDATE_PRODUCTION_GATE/);
    assert.match(script, /VALIDATE_PRODUCTION_INVENTORY/);
    assert.match(script, /PRODUCTION_EVIDENCE_FILE/);
    assert.match(script, /PRODUCTION_GATE_VALIDATE_ARTIFACTS/);
    assert.match(script, /PRODUCTION_GATE_VALIDATE_FRESHNESS/);
    assert.match(script, /production-gate/);
    assert.match(script, /production-gate --strict/);
    assert.match(script, /backup-evidence\.mjs/);
    assert.match(script, /backup-offsite\.sh/);
    assert.match(script, /restore-offsite-check\.sh/);
    assert.match(script, /run-scheduled-backup\.sh/);
    assert.match(script, /eliza-hub-backup\.service\.example/);
    assert.match(script, /eliza-hub-backup\.timer\.example/);
    assert.match(script, /database-evidence\.mjs/);
    assert.match(script, /image-provenance-evidence\.mjs/);
    assert.match(script, /mail-evidence\.mjs/);
    assert.match(script, /merge-queue-live-drill-evidence\.mjs/);
    assert.match(script, /merge-queue-rollout-evidence\.mjs/);
    assert.match(script, /observability-evidence\.mjs/);
    assert.match(script, /pilot-bootstrap\.mjs/);
    assert.match(script, /production-evidence-assemble\.mjs/);
    assert.match(script, /production-evidence-inventory\.mjs/);
    assert.match(script, /--artifact-root "\$ELIZA_ARTIFACT_ROOT"/);
    assert.match(script, /--out "\$PRODUCTION_EVIDENCE_FILE"/);
    assert.match(script, /repository-evidence\.mjs/);
    assert.match(script, /runner-smoke-evidence\.mjs/);
    assert.match(script, /secret-management-evidence\.mjs/);
    assert.match(script, /security-review-evidence\.mjs/);
    assert.match(script, /sso-evidence\.mjs/);
    assert.match(script, /sso-smoke-evidence\.mjs/);
    assert.match(script, /steward-evidence\.mjs/);
    assert.match(script, /storage-evidence\.mjs/);
    assert.match(script, /runner-evidence\.sh/);
    assert.match(script, /restore-drill\.sh/);
    assert.match(script, /merge-queue-rollout-drill\.sh/);
    assert.match(script, /scripts\/deploy\.sh/);
    assert.match(script, /print_production_gate_summary/);
    assert.match(script, /evidenceShape/);
    assert.match(script, /shapeErrors/);
    assert.match(script, /status --porcelain/);
    assert.doesNotMatch(
      script,
      /^\s*(?:docker\s+compose|compose_base|compose_runner)\b.*\b(?:up|stop|rm|pull|push)\b/m,
    );
  });

  it("keeps infrastructure provisioning protected and validation non-mutating", async () => {
    const [validator, main, versions, variables, cloudInit, backendExample] =
      await Promise.all([
        readFile(INFRASTRUCTURE_VALIDATOR_PATH, "utf8"),
        readFile(INFRASTRUCTURE_MAIN_PATH, "utf8"),
        readFile(INFRASTRUCTURE_VERSIONS_PATH, "utf8"),
        readFile(INFRASTRUCTURE_VARIABLES_PATH, "utf8"),
        readFile(INFRASTRUCTURE_CLOUD_INIT_PATH, "utf8"),
        readFile(INFRASTRUCTURE_BACKEND_EXAMPLE_PATH, "utf8"),
      ]);

    assert.match(versions, /cloudflare\/cloudflare/);
    assert.match(versions, /version\s*=\s*"~> 5\.21\.0"/);
    assert.match(versions, /hetznercloud\/hcloud/);
    assert.match(versions, /version\s*=\s*"~> 1\.66\.0"/);
    assert.match(versions, /backend "s3"/);
    assert.match(versions, /required_version\s*=\s*">= 1\.10\.0, < 2\.0\.0"/);

    assert.match(main, /resource "hcloud_primary_ip" "forge"/);
    assert.match(main, /auto_delete\s*=\s*false/);
    assert.match(main, /delete_protection\s*=\s*var\.enable_delete_protection/);
    assert.match(
      main,
      /rebuild_protection\s*=\s*var\.enable_delete_protection/,
    );
    assert.match(main, /backups\s*=\s*var\.enable_hcloud_backups/);
    assert.match(main, /data "cloudflare_ip_ranges" "edge"/);
    assert.match(main, /resource "cloudflare_dns_record" "web"/);
    assert.match(main, /proxied\s*=\s*var\.cloudflare_proxy_web/);
    assert.match(main, /resource "cloudflare_dns_record" "ssh"/);
    assert.match(
      main,
      /resource "cloudflare_dns_record" "ssh"[\s\S]*?proxied\s*=\s*false/,
    );
    assert.match(main, /operator_ssh_port and git_ssh_port must differ/);
    assert.match(main, /web_hostname and ssh_hostname must differ/);
    assert.match(
      variables,
      /variable "cloudflare_proxy_web"[\s\S]*?default\s*=\s*false/,
    );
    assert.match(backendExample, /use_lockfile\s*=\s*true/);
    assert.doesNotMatch(backendExample, /^\s*encrypt\s*=/m);

    assert.match(cloudInit, /disable_root: true/);
    assert.match(cloudInit, /ssh_pwauth: false/);
    assert.match(cloudInit, /docker-compose-v2/);
    assert.match(cloudInit, /\n {2}- age\n/);
    assert.match(cloudInit, /\n {2}- rclone\n/);
    assert.match(cloudInit, /\/srv\/eliza-hub\/shared\/backups/);
    assert.match(cloudInit, /unattended-upgrades/);
    assert.match(cloudInit, /bootstrap-complete/);

    assert.match(validator, /fmt -check -recursive/);
    assert.match(validator, /init \\/);
    assert.match(validator, /-backend=false/);
    assert.match(validator, /-lockfile=readonly/);
    assert.match(validator, /validate -no-color/);
    assert.doesNotMatch(validator, /\b(?:plan|apply|destroy|import)\b/);
  });

  it("requires production evidence when the release gate is in production mode", async () => {
    const script = await readFile(RELEASE_GATE_PATH, "utf8");

    assert.match(
      script,
      /if \[\[ "\$RELEASE_GATE_MODE" == "production" \]\]; then/,
    );
    assert.match(
      script,
      /VALIDATE_PRODUCTION_GATE="\$\{VALIDATE_PRODUCTION_GATE:-true\}"/,
    );
    assert.match(
      script,
      /VALIDATE_PRODUCTION_INVENTORY="\$\{VALIDATE_PRODUCTION_INVENTORY:-true\}"/,
    );
    assert.match(
      script,
      /VALIDATE_PRODUCTION_GATE must be true when RELEASE_GATE_MODE=production/,
    );
    assert.match(
      script,
      /VALIDATE_PRODUCTION_INVENTORY must be true when RELEASE_GATE_MODE=production/,
    );
    assert.match(
      script,
      /PRODUCTION_EVIDENCE_FILE is required when VALIDATE_PRODUCTION_GATE=true/,
    );
    assert.match(script, /production_artifact_validation=true/);
    assert.match(script, /production_freshness_validation=true/);
    assert.match(script, /RELEASE_GATE_MODE must be staging or production/);
  });

  it("smoke-runs the staging release gate without real Docker or npm work", async () => {
    const result = await runReleaseGateSmoke({ RELEASE_GATE_MODE: "staging" });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /RELEASE_GATE_MODE=staging/);
    assert.match(result.stdout, /VALIDATE_PRODUCTION_GATE=false/);
    assert.match(result.stdout, /VALIDATE_PRODUCTION_INVENTORY=false/);
    assert.match(result.stdout, /release gate passed/);
  });

  it("smoke-runs production mode and fails closed without evidence", async () => {
    const result = await runReleaseGateSmoke({
      RELEASE_GATE_MODE: "production",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /RELEASE_GATE_MODE=production/);
    assert.match(result.stdout, /VALIDATE_PRODUCTION_GATE=true/);
    assert.match(result.stdout, /VALIDATE_PRODUCTION_INVENTORY=true/);
    assert.match(
      result.stdout,
      /production evidence gate passes when enabled\.\.\. failed/,
    );
    assert.match(
      result.stderr,
      /PRODUCTION_EVIDENCE_FILE is required when VALIDATE_PRODUCTION_GATE=true/,
    );
    assert.match(result.stderr, /1 release gate check\(s\) failed/);
  });

  it("keeps steward migrations as a one-shot dependency before HTTP boot", async () => {
    const compose = await readFile(STAGING_COMPOSE_PATH, "utf8");

    assert.match(compose, /merge-steward-migrate:/);
    assert.match(compose, /merge-steward-migrate:[\s\S]*?restart: "no"/);
    assert.match(
      compose,
      /merge-steward-migrate:[\s\S]*?DATABASE_URL: \$\{MERGE_STEWARD_DATABASE_URL:\?set MERGE_STEWARD_DATABASE_URL/,
    );
    assert.match(
      compose,
      /merge-steward-migrate:[\s\S]*?command: \["npm", "run", "migrate"\]/,
    );
    assert.match(
      compose,
      /merge-steward:[\s\S]*?depends_on:[\s\S]*?merge-steward-migrate:[\s\S]*?condition: service_completed_successfully/,
    );
  });

  it("keeps post-deploy verification wired to product APIs", async () => {
    const script = await readFile(POST_DEPLOY_PATH, "utf8");

    assert.match(script, /\.well-known\/eliza-hub\.json/);
    assert.match(script, /openapi\.json/);
    assert.match(script, /api\/workflows\?readiness=false/);
    assert.match(script, /api\/github-parity/);
    assert.match(script, /api\/production-readiness/);
    assert.match(script, /api\/production-cutover/);
    assert.match(script, /api\/production-evidence-template/);
    assert.match(script, /production-evidence-inventory\\.mjs --strict/);
    assert.match(
      script,
      /api\/project-board\?repo=\$smoke_repo_query&readiness=false/,
    );
    assert.match(script, /api\/work-items\?repo=\$smoke_repo_query/);
    assert.match(script, /api\/work-pages\?repo=\$smoke_repo_query/);
    assert.match(
      script,
      /api\/fleet-coordination\?repo=\$smoke_repo_query&ownerAgentId=\$smoke_agent_path/,
    );
    assert.match(
      script,
      /api\/work-context\?repo=\$smoke_repo_query&ownerAgentId=\$smoke_agent_path/,
    );
    assert.match(script, /api\/work-intake\?repo=\$smoke_repo_query/);
    assert.match(
      script,
      /api\/merge-queue\?repo=\$smoke_repo_query&readiness=false/,
    );
    assert.match(script, /diagnostics/);
    assert.match(
      script,
      /api\/merge-train\?repo=\$smoke_repo_query&readiness=false/,
    );
    assert.match(script, /mergeTrain/);
    assert.match(script, /api\/search/);
    assert.match(script, /search:actions-log/);
    assert.match(script, /api\/queue\/simulate/);
    assert.match(script, /queue-simulation/);
    assert.match(script, /api\/agent-identities/);
    assert.match(
      script,
      /api\/release-readiness\?repo=\$smoke_repo_query&readiness=false/,
    );
    assert.match(
      script,
      /api\/repository-protection\?repo=\$smoke_repo_query&requireLive=false/,
    );
    assert.match(script, /repositoryProtection/);
    assert.match(
      script,
      /api\/agent-insights\?repo=\$smoke_repo_query&readiness=false/,
    );
    assert.match(
      script,
      /api\/agent-performance\?repo=\$smoke_repo_query&readiness=false/,
    );
    assert.match(
      script,
      /api\/agent-routing\?repo=\$smoke_repo_query&readiness=false/,
    );
    assert.match(
      script,
      /api\/agents\/\$smoke_agent_path\/bootstrap\?repo=\$smoke_repo_query&readiness=false/,
    );
    assert.match(script, /agent bootstrap/);
    assert.match(
      script,
      /api\/agents\/\$smoke_agent_path\/cockpit\?repo=\$smoke_repo_query&targetBranch=main&readiness=false/,
    );
    assert.match(script, /"cockpit"/);
    assert.match(script, /api\/agents\/\$smoke_agent_path\/action-plan/);
    assert.match(script, /agent-action-plan:/);
    assert.match(script, /api\/agents\/\$smoke_agent_path\/submission-gate/);
    assert.match(script, /submission:allowed/);
    assert.match(script, /api\/agents\/\$smoke_agent_path\/work-preflight/);
    assert.match(script, /work-preflight:allowed/);
    assert.match(script, /api\/agents\/\$smoke_agent_path\/work-reservation/);
    assert.match(script, /work-reservation:dry-run/);
    assert.match(script, /api\/ci\/failure-analysis/);
    assert.match(script, /primaryCategory/);
    assert.match(script, /api\/ci\/validation-plan/);
    assert.match(script, /turbo run typecheck --filter=@elizaos\/core/);
    assert.match(script, /api\/pr\/brief/);
    assert.match(script, /risk:low/);
    assert.match(script, /api\/review\/assignment/);
    assert.match(script, /review-assignment:/);
    assert.match(script, /api\/patch\/conflict-prediction/);
    assert.match(script, /patch-conflict:clear/);
    assert.match(
      script,
      /api\/agents\/\$smoke_agent_path\/inbox\?repo=\$smoke_repo_query&readiness=false/,
    );
    assert.match(script, /theme-eliza\.css/);
    assert.match(script, /Forgejo Eliza theme asset and default theme render/);
    assert.match(script, /production_evidence_inventory/);
    assert.match(script, /POST_DEPLOY_EVIDENCE_OUTPUT/);
    assert.match(script, /post-deploy-evidence\.v1/);
    assert.match(script, /record_check "\$name" "pass"/);
    assert.match(script, /record_check "\$name" "fail"/);
    assert.match(script, /wrote post-deploy evidence/);
    assert.match(
      script,
      /Merge Steward discovery manifest and OpenAPI contract respond with production evidence hints/,
    );
    assert.match(
      script,
      /production readiness, production cutover, evidence template/,
    );
    assert.match(script, /merge-queue-rollout-drill\.sh/);
    assert.match(script, /MERGE_QUEUE_ROLLOUT_CHECK_DOCTOR=false/);
    assert.match(script, /Merge queue rollout drill stays safely gated/);
    assert.match(script, /MERGE_STEWARD_SMOKE_REPO/);
    assert.match(script, /MERGE_STEWARD_SMOKE_AGENT/);
    assert.match(script, /agent identities/);
  });

  it("documents a TLS reverse proxy for Forgejo and steward base-path routing", async () => {
    const caddyfile = await readFile(REVERSE_PROXY_CADDY_PATH, "utf8");
    const readme = await readFile(REVERSE_PROXY_README_PATH, "utf8");

    assert.match(caddyfile, /git\.staging\.example\.invalid/);
    assert.match(caddyfile, /Strict-Transport-Security/);
    assert.match(caddyfile, /handle_path \/steward\/\*/);
    assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:8080/);
    assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:3000/);
    assert.match(caddyfile, /header_up Host \{host\}/);
    assert.match(
      readme,
      /MERGE_STEWARD_URL=https:\/\/git\.staging\.example\.invalid\/steward/,
    );
    assert.match(readme, /SSH is not handled by Caddy/);
  });

  it("keeps host preflight read-only and focused on deploy prerequisites", async () => {
    const script = await readFile(HOST_PREFLIGHT_PATH, "utf8");
    const help = await execFileAsync("bash", [
      HOST_PREFLIGHT_PATH.pathname,
      "--help",
    ]);

    assert.match(help.stdout, /Read-only host checks/);
    assert.match(help.stdout, /CHECK_DNS=true\|false/);
    assert.match(script, /validate-env\.sh/);
    assert.match(script, /docker compose version/);
    assert.match(script, /docker info/);
    assert.match(script, /require_command age/);
    assert.match(script, /require_command rclone/);
    assert.match(script, /REQUIRE_REVERSE_PROXY/);
    assert.match(script, /FORGEJO_DOMAIN resolves/);
    assert.doesNotMatch(
      script,
      /^\s*docker(?:\s+compose)?\b.*\b(?:up|stop|rm|pull|push|run)\b/m,
    );
  });

  it("keeps merge queue rollout drill safe by default", async () => {
    const script = await readFile(MERGE_QUEUE_ROLLOUT_DRILL_PATH, "utf8");

    assert.match(script, /\/api\/queue\/integration-plan/);
    assert.match(script, /\/api\/queue\/integration-execution/);
    assert.match(script, /\/api\/queue\/run-once/);
    assert.match(script, /confirm":false/);
    assert.match(script, /integration_execution_not_confirmed/);
    assert.match(script, /no confirmation token is sent/);
    assert.match(script, /npm run doctor/);
    assert.match(script, /MERGE_QUEUE_ROLLOUT_SMOKE_REPO/);
    assert.match(script, /MERGE_QUEUE_ROLLOUT_EVIDENCE_OUT/);
    assert.match(script, /mergeQueueRolloutDrill/);
    assert.doesNotMatch(script, /"confirm":true/);
    assert.doesNotMatch(script, /\bgit\s+push\b/);
    assert.doesNotMatch(script, /\bmerge_original_pull_request\b.*executed/);
  });

  it("generates backup evidence from a verified bundle and cryptographic off-site receipts", async () => {
    const envFile = await writeTempEnv({
      UNRELATED_SECRET: "backup-secret-do-not-print",
    });
    const backupDir = await writeTempBackupBundle();
    const receipts = await writeTempOffsiteBackupReceipts(backupDir);
    const auditDir = await mkdtempInTestRoot("backup-audit-output-");
    const auditOutput = path.join(auditDir, "backup-audit.json");

    const result = await runBackupEvidenceHelper(envFile, backupDir, {
      BACKUP_EVIDENCE_SCHEDULED: "true",
      BACKUP_EVIDENCE_OFFSITE_UPLOAD_RECEIPT: receipts.uploadPath,
      BACKUP_EVIDENCE_OFFSITE_RESTORE_RECEIPT: receipts.restorePath,
      BACKUP_EVIDENCE_AUDIT_OUTPUT: auditOutput,
      BACKUP_EVIDENCE_NOW: "2026-07-06T12:30:00Z",
    });

    assert.equal(result.code, 0, result.stderr);
    const audit = JSON.parse(await readFile(auditOutput, "utf8")).backupAudit;
    assert.equal(audit.status, "verified");
    assert.equal(audit.productionReady, true);
    assert.equal(audit.backupDir, backupDir);
    assert.equal(audit.checks.length, 10);
    assert.ok(audit.checks.every((check) => check.status === "pass"));
    assert.equal(
      audit.offsiteUploadReceipt.sha256,
      await sha256File(receipts.uploadPath),
    );
    assert.equal(
      audit.offsiteRestoreReceipt.sha256,
      await sha256File(receipts.restorePath),
    );

    const body = JSON.parse(result.stdout);
    assert.equal(body.backups.scheduled, true);
    assert.equal(body.backups.offHost, true);
    assert.equal(body.backups.encrypted, true);
    assert.equal(body.backups.lastBackupAt, "2026-07-06T12:00:00.000Z");
    assert.equal(body.backups.lastRestoreCheckAt, "2026-07-06T12:30:00.000Z");
    assert.equal(body.backups.backupEvidence.source, auditOutput);
    assert.equal(
      body.backups.backupEvidence.sha256,
      await sha256File(auditOutput),
    );
    assert.equal(body.backups.backupEvidence.checkCount, 10);
    assert.deepEqual(
      body.backups.backupEvidence.offsiteUploadReceipt,
      audit.offsiteUploadReceipt,
    );
    assert.deepEqual(
      body.backups.backupEvidence.offsiteRestoreReceipt,
      audit.offsiteRestoreReceipt,
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /backup-secret-do-not-print/,
    );
  });

  it("fails backup evidence when checksum drift is detected", async () => {
    const envFile = await writeTempEnv({
      UNRELATED_SECRET: "backup-secret-keep-private",
    });
    const backupDir = await writeTempBackupBundle({ checksumDrift: true });

    const result = await runBackupEvidenceHelper(envFile, backupDir, {
      BACKUP_EVIDENCE_NOW: "2026-07-06T12:30:00Z",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /checksum mismatch/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /backup-secret-keep-private/,
    );
  });

  it("rejects a recovery receipt that predates its upload receipt", async () => {
    const envFile = await writeTempEnv({});
    const backupDir = await writeTempBackupBundle();
    const receipts = await writeTempOffsiteBackupReceipts(backupDir);
    const restoreReceipt = JSON.parse(
      await readFile(receipts.restorePath, "utf8"),
    );
    restoreReceipt.checkedAt = "2026-07-06T12:10:00.000Z";
    await writeFile(
      receipts.restorePath,
      `${JSON.stringify(restoreReceipt, null, 2)}\n`,
      { mode: 0o600 },
    );

    const result = await runBackupEvidenceHelper(envFile, backupDir, {
      BACKUP_EVIDENCE_SCHEDULED: "true",
      BACKUP_EVIDENCE_OFFSITE_UPLOAD_RECEIPT: receipts.uploadPath,
      BACKUP_EVIDENCE_OFFSITE_RESTORE_RECEIPT: receipts.restorePath,
      BACKUP_EVIDENCE_NOW: "2026-07-06T12:30:00Z",
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /restore receipt checkedAt must not predate the upload receipt/,
    );
    assert.equal(result.stdout, "");
  });

  it("generates database evidence from Postgres config, migrations, and restore drill output", async () => {
    const envFile = await writeTempEnv({
      MERGE_STEWARD_DATABASE_URL:
        "postgres://forgejo:db-password-keep-private@postgres:5432/forgejo",
      UNRELATED_SECRET: "database-secret-do-not-print",
    });
    const migrationOutput = await writeTempText(
      "database-migration-output-",
      "migration.log",
      '[MergeStewardMigrate] complete {"applied":["001_steward_runtime.sql"],"skipped":[]}\n',
    );
    const restoreOutput = await writeTempText(
      "database-restore-output-",
      "restore.log",
      [
        "[restore-drill] restore drill passed",
        "backup=/var/lib/eliza-hub-artifacts/backup",
        "postgres_image=postgres:16-alpine",
        "database=forgejo",
        "verified_tables=steward_schema_migrations,steward_queue_items,steward_runs,steward_events,steward_agent_claims,steward_worker_leases",
        "",
      ].join("\n"),
    );
    const auditDir = await mkdtempInTestRoot("database-audit-output-");
    const auditOutput = path.join(auditDir, "database-audit.json");

    const result = await runDatabaseEvidenceHelper(envFile, {
      migrationOutput,
      restoreOutput,
      extraEnv: {
        DATABASE_EVIDENCE_AUDIT_OUTPUT: auditOutput,
        DATABASE_EVIDENCE_NOW: "2026-07-06T12:40:00Z",
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(auditOutput, "utf8")), {
      databaseAudit: {
        checkedAt: "2026-07-06T12:40:00.000Z",
        status: "verified",
        productionReady: true,
        evidence: {
          forgejoPostgres: true,
          stewardPostgres: true,
          migrationsApplied: true,
          emptyHostRestoreDrillPassed: true,
          checksumDriftClean: true,
        },
        migrationOutput: {
          source: migrationOutput,
          sha256: await sha256File(migrationOutput),
        },
        restoreDrillOutput: {
          source: restoreOutput,
          sha256: await sha256File(restoreOutput),
        },
        verifiedTables: [
          "steward_schema_migrations",
          "steward_queue_items",
          "steward_runs",
          "steward_events",
          "steward_agent_claims",
          "steward_worker_leases",
        ],
        checks: [
          { name: "forgejo_postgres_configured", status: "pass", details: {} },
          { name: "steward_postgres_configured", status: "pass", details: {} },
          {
            name: "migration_output_verified",
            status: "pass",
            details: {
              source: migrationOutput,
              sha256: await sha256File(migrationOutput),
            },
          },
          {
            name: "restore_drill_output_verified",
            status: "pass",
            details: {
              source: restoreOutput,
              sha256: await sha256File(restoreOutput),
              verifiedTables: [
                "steward_schema_migrations",
                "steward_queue_items",
                "steward_runs",
                "steward_events",
                "steward_agent_claims",
                "steward_worker_leases",
              ],
            },
          },
          { name: "checksum_drift_clean", status: "pass", details: {} },
        ],
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      database: {
        databaseEvidence: {
          source: auditOutput,
          sha256: await sha256File(auditOutput),
          checkedAt: "2026-07-06T12:40:00.000Z",
          status: "verified",
          productionReady: true,
          migrationOutputSource: migrationOutput,
          migrationOutputSha256: await sha256File(migrationOutput),
          restoreDrillOutputSource: restoreOutput,
          restoreDrillOutputSha256: await sha256File(restoreOutput),
          checkCount: 5,
          verifiedTableCount: 6,
        },
        forgejoPostgres: true,
        stewardPostgres: true,
        migrationsApplied: true,
        emptyHostRestoreDrillPassed: true,
        checksumDriftClean: true,
      },
    });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /db-password-keep-private|database-secret-do-not-print/,
    );
  });

  it("fails database evidence on malformed attestations without printing database URLs", async () => {
    const envFile = await writeTempEnv({
      MERGE_STEWARD_DATABASE_URL:
        "postgres://forgejo:db-password-keep-private@postgres:5432/forgejo",
    });

    const result = await runDatabaseEvidenceHelper(envFile, {
      extraEnv: {
        DATABASE_EVIDENCE_CHECKSUM_DRIFT_CLEAN: "clean",
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /DATABASE_EVIDENCE_CHECKSUM_DRIFT_CLEAN/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /db-password-keep-private/,
    );
  });

  it("generates non-secret image provenance evidence from staging image config", async () => {
    const dir = await mkdtempInTestRoot("image-provenance-output-");
    const provenanceOutput = path.join(dir, "image-provenance-audit.json");
    const envFile = await writeTempEnv({
      FORGEJO_IMAGE: "codeberg.org/forgejo/forgejo:12",
      FORGEJO_IMAGE_DIGEST: digest("a"),
      MERGE_STEWARD_IMAGE:
        "registry.example.invalid:5000/tools/merge-steward:20260706",
      MERGE_STEWARD_IMAGE_DIGEST: digest("b"),
      FORGEJO_RUNNER_IMAGE: "data.forgejo.org/forgejo/runner:12",
      FORGEJO_RUNNER_IMAGE_DIGEST: "c".repeat(64),
      FORGEJO_RUNNER_DIND_IMAGE: "docker.io/library/docker:28-dind",
      FORGEJO_RUNNER_DIND_IMAGE_DIGEST: digest("d"),
      UNRELATED_SECRET: "do-not-print-this-value",
    });

    const result = await runImageProvenanceHelper(envFile, {
      IMAGE_PROVENANCE_STEWARD_IMAGE_BUILT_BY_CI: "true",
      IMAGE_PROVENANCE_STEWARD_IMAGE_SIGNATURE_VERIFIED: "true",
      IMAGE_PROVENANCE_SBOM_GENERATED: "true",
      IMAGE_PROVENANCE_VULNERABILITY_SCAN_CLEAN: "true",
      IMAGE_PROVENANCE_CHECKED_AT: "2026-07-06T00:01:00.000Z",
      IMAGE_PROVENANCE_PROVENANCE_OUTPUT: provenanceOutput,
    });
    const expectedImages = {
      forgejoImage: `codeberg.org/forgejo/forgejo@${digest("a")}`,
      stewardImage: `registry.example.invalid:5000/tools/merge-steward@${digest("b")}`,
      runnerImage: `data.forgejo.org/forgejo/runner@${digest("c")}`,
      dindImage: `docker.io/library/docker@${digest("d")}`,
    };

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(provenanceOutput, "utf8")), {
      imageProvenanceAudit: {
        checkedAt: "2026-07-06T00:01:00.000Z",
        status: "verified",
        productionReady: true,
        images: expectedImages,
        evidence: {
          stewardImageBuiltByCi: true,
          stewardImageSignatureVerified: true,
          sbomGenerated: true,
          vulnerabilityScanClean: true,
        },
        checks: [
          { name: "images_digest_pinned", status: "pass" },
          { name: "stewardImageBuiltByCi", status: "pass" },
          { name: "stewardImageSignatureVerified", status: "pass" },
          { name: "sbomGenerated", status: "pass" },
          { name: "vulnerabilityScanClean", status: "pass" },
        ],
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      imageProvenance: {
        ...expectedImages,
        provenanceEvidence: {
          source: provenanceOutput,
          sha256: await sha256File(provenanceOutput),
          checkedAt: "2026-07-06T00:01:00.000Z",
          imageCount: 4,
          checkCount: 5,
        },
        stewardImageBuiltByCi: true,
        stewardImageSignatureVerified: true,
        sbomGenerated: true,
        vulnerabilityScanClean: true,
      },
    });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /UNRELATED_SECRET|do-not-print-this-value/,
    );
  });

  it("fails image provenance generation without digest evidence and does not print env secrets", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_IMAGE: "codeberg.org/forgejo/forgejo:12",
      MERGE_STEWARD_IMAGE:
        "registry.example.invalid/tools/merge-steward:20260706",
      FORGEJO_RUNNER_IMAGE: "data.forgejo.org/forgejo/runner:12",
      FORGEJO_RUNNER_DIND_IMAGE: "docker.io/library/docker:28-dind",
      UNRELATED_SECRET: "keep-this-private",
    });

    const result = await runImageProvenanceHelper(envFile);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FORGEJO_IMAGE_DIGEST/);
    assert.match(result.stderr, /MERGE_STEWARD_IMAGE_DIGEST/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /UNRELATED_SECRET|keep-this-private/,
    );
  });

  it("generates mail evidence from private SMTP config and smoke attestations", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_MAIL_ENABLED: "true",
      FORGEJO_SMTP_ADDR: "smtp.git.eliza.test",
      FORGEJO_SMTP_PORT: "587",
      FORGEJO_MAIL_FROM: "noreply@git.eliza.test",
      FORGEJO_SMTP_USER: "eliza-hub-smtp",
      FORGEJO_SMTP_PASSWORD: "smtp-password-do-not-print",
    });
    const auditDir = await mkdtempInTestRoot("mail-audit-output-");
    const auditOutput = path.join(auditDir, "mail-smoke-audit.json");

    const result = await runMailEvidenceHelper(envFile, {
      MAIL_EVIDENCE_INVITE_SMOKE_PASSED: "true",
      MAIL_EVIDENCE_PASSWORD_RESET_SMOKE_PASSED: "true",
      MAIL_EVIDENCE_NOTIFICATION_SMOKE_PASSED: "true",
      MAIL_EVIDENCE_AUDIT_OUTPUT: auditOutput,
    });

    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const checkedAt = body.mail.mailEvidence.checkedAt;
    assert.match(checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(JSON.parse(await readFile(auditOutput, "utf8")), {
      mailAudit: {
        checkedAt,
        status: "verified",
        productionReady: true,
        evidence: {
          smtpConfigured: true,
          inviteSmokePassed: true,
          passwordResetSmokePassed: true,
          notificationSmokePassed: true,
        },
        checks: [
          { name: "smtp_configured", status: "pass" },
          { name: "invite_smoke_passed", status: "pass" },
          { name: "password_reset_smoke_passed", status: "pass" },
          { name: "notification_smoke_passed", status: "pass" },
        ],
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      mail: {
        mailEvidence: {
          source: auditOutput,
          sha256: await sha256File(auditOutput),
          checkedAt,
          status: "verified",
          productionReady: true,
          checkCount: 4,
        },
        smtpConfigured: true,
        inviteSmokePassed: true,
        passwordResetSmokePassed: true,
        notificationSmokePassed: true,
      },
    });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /smtp-password-do-not-print/,
    );
  });

  it("fails mail evidence on malformed smoke attestations without printing SMTP secrets", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_MAIL_ENABLED: "true",
      FORGEJO_SMTP_ADDR: "smtp.git.eliza.test",
      FORGEJO_SMTP_PORT: "587",
      FORGEJO_MAIL_FROM: "noreply@git.eliza.test",
      FORGEJO_SMTP_USER: "eliza-hub-smtp",
      FORGEJO_SMTP_PASSWORD: "smtp-password-keep-private",
    });

    const result = await runMailEvidenceHelper(envFile, {
      MAIL_EVIDENCE_INVITE_SMOKE_PASSED: "done",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MAIL_EVIDENCE_INVITE_SMOKE_PASSED/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /smtp-password-keep-private/,
    );
  });

  it("generates observability evidence from private launch attestations", async () => {
    const envFile = await writeTempEnv({});
    const auditDir = await mkdtempInTestRoot("observability-audit-output-");
    const auditOutput = path.join(auditDir, "observability-audit.json");

    const result = await runObservabilityEvidenceHelper(envFile, {
      OBSERVABILITY_EVIDENCE_PROMETHEUS_SCRAPE_OK: "true",
      OBSERVABILITY_EVIDENCE_ALERT_RULES_LOADED: "true",
      OBSERVABILITY_EVIDENCE_ALERT_ROUTING_CONFIGURED: "true",
      OBSERVABILITY_EVIDENCE_LOGS_COLLECTED: "true",
      OBSERVABILITY_EVIDENCE_LOG_RETENTION_DAYS: "30",
      OBSERVABILITY_EVIDENCE_NO_PAGE_ALERTS_FIRING: "true",
      OBSERVABILITY_EVIDENCE_AUDIT_OUTPUT: auditOutput,
    });

    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const checkedAt = body.observability.observabilityEvidence.checkedAt;

    assert.match(checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(JSON.parse(await readFile(auditOutput, "utf8")), {
      observabilityAudit: {
        checkedAt,
        status: "verified",
        productionReady: true,
        evidence: {
          prometheusScrapeOk: true,
          alertRulesLoaded: true,
          alertRoutingConfigured: true,
          logsCollected: true,
          logRetentionDays: 30,
          noPageAlertsFiring: true,
        },
        checks: [
          { name: "prometheus_scrape_ok", status: "pass" },
          { name: "alert_rules_loaded", status: "pass" },
          { name: "alert_routing_configured", status: "pass" },
          { name: "logs_collected", status: "pass" },
          { name: "log_retention_days_sufficient", status: "pass" },
          { name: "no_page_alerts_firing", status: "pass" },
        ],
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      observability: {
        prometheusScrapeOk: true,
        alertRulesLoaded: true,
        alertRoutingConfigured: true,
        logsCollected: true,
        logRetentionDays: 30,
        noPageAlertsFiring: true,
        observabilityEvidence: {
          source: auditOutput,
          sha256: await sha256File(auditOutput),
          checkedAt,
          status: "verified",
          productionReady: true,
          checkCount: 6,
        },
      },
    });
  });

  it("fails observability evidence on malformed numeric attestations", async () => {
    const envFile = await writeTempEnv({});

    const result = await runObservabilityEvidenceHelper(envFile, {
      OBSERVABILITY_EVIDENCE_LOG_RETENTION_DAYS: "thirty",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /OBSERVABILITY_EVIDENCE_LOG_RETENTION_DAYS/);
    assert.equal(result.stdout, "");
  });

  it("generates merge queue rollout evidence from private launch attestations", async () => {
    const envFile = await writeTempEnv({
      UNRELATED_SECRET: "merge-queue-secret-do-not-print",
    });
    const drillJson = await writeTempJson(mergeQueueRolloutDrillEvidence());
    const liveDrillJson = await writeTempJson(
      mergeQueueRolloutLiveDrillEvidence(),
    );

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON: liveDrillJson,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      mergeQueueRollout: {
        dryRunPassed: true,
        stagedLiveDrillPassed: true,
        workerLeaseVerified: true,
        strictWorkReservationsEnforced: true,
        strictWorkItemsEnforced: true,
        strictAgentBranchNamespacesEnforced: true,
        verifiedAgentRunReceiptsEnforced: true,
        agentIdentityRegistryEnforced: true,
        stackDependencyOrderEnforced: true,
        rollbackDrillPassed: true,
        humanApprovalRecorded: true,
        dryRunEvidence: {
          source: drillJson,
          sha256: await sha256File(drillJson),
          checkedAt: "2026-07-06T00:00:00.000Z",
          checkCount: 5,
        },
        liveDrillEvidence: {
          source: liveDrillJson,
          sha256: await sha256File(liveDrillJson),
          checkedAt: "2026-07-06T00:30:00.000Z",
          runId: "run:elizaos/eliza#9001:attempt:1",
        },
      },
    });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /merge-queue-secret-do-not-print/,
    );
  });

  it("generates merge queue live drill evidence from run-once and run events", async () => {
    const dir = await mkdtempInTestRoot("merge-queue-live-drill-");
    const output = path.join(dir, "live-drill.json");

    await withMockStewardServer(
      async ({ request, url }) => {
        if (
          request.method === "GET" &&
          url.pathname === "/api/release-readiness"
        ) {
          return jsonResponse(200, mergeQueueStackDependencyReleaseReadiness());
        }

        if (request.method === "GET" && url.pathname === "/ready") {
          return jsonResponse(200, {
            ok: true,
            checkedAt: "2026-07-06T00:00:00.000Z",
            configuration: {
              workerEnabled: true,
              workerLeaseEnabled: true,
              integrationDryRun: false,
              requireWorkReservationForAgentPrs: true,
              requireWorkItemForAgentPrs: true,
              requireAgentBranchNamespaceForAgentPrs: true,
              requireVerifiedAgentRunReceiptForAgentPrs: true,
              requireAgentIdentityRegistryForAgentPrs: true,
              knownAgentIdCount: 1,
            },
            checks: [
              {
                name: "worker_lease",
                ok: true,
                leaseId: "merge-queue",
                ownerId: "worker-a",
                expiresAt: "2999-07-06T00:00:30.000Z",
              },
            ],
          });
        }

        if (
          request.method === "POST" &&
          url.pathname === "/api/queue/run-once"
        ) {
          return jsonResponse(200, mergeQueueLiveRunOnceResult());
        }

        if (
          request.method === "GET" &&
          url.pathname.startsWith("/api/runs/") &&
          url.pathname.endsWith("/events")
        ) {
          return jsonResponse(200, {
            events: [
              { type: "IntegrationActionStarted" },
              { type: "IntegrationActionFinished" },
              { type: "QueueItemMerged" },
            ],
          });
        }

        return jsonResponse(404, { error: "not_found" });
      },
      async ({ baseUrl, requests }) => {
        const result = await runMergeQueueLiveDrillEvidenceHelper({
          ALLOW_ENV_ONLY: "true",
          MERGE_STEWARD_URL: baseUrl,
          MERGE_STEWARD_API_TOKEN: "steward-token-do-not-print",
          MERGE_QUEUE_LIVE_DRILL_OUTPUT: output,
          MERGE_QUEUE_LIVE_DRILL_WORKER_ID: "staged-live-worker",
          MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION: "true",
          MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED: "true",
          MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED: "true",
          MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED: "true",
        });

        assert.equal(result.code, 0, result.stderr);
        const evidence = JSON.parse(await readFile(output, "utf8"));
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.stagedLiveDrillPassed,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.workerLeaseVerified,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.strictWorkReservationsEnforced,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.strictWorkItemsEnforced,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill
            .strictAgentBranchNamespacesEnforced,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.verifiedAgentRunReceiptsEnforced,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.agentIdentityRegistryEnforced,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.stackDependencyOrderEnforced,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.stackDependencyOrderProof.valid,
          true,
        );
        assert.deepEqual(
          evidence.mergeQueueRolloutLiveDrill.stackDependencyOrderProof
            .blockedItemIds,
          ["elizaos/eliza#9002"],
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.readiness.configuration
            .requireWorkReservationForAgentPrs,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.readiness.configuration
            .requireWorkItemForAgentPrs,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.readiness.configuration
            .requireAgentBranchNamespaceForAgentPrs,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.readiness.configuration
            .requireVerifiedAgentRunReceiptForAgentPrs,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.readiness.configuration
            .requireAgentIdentityRegistryForAgentPrs,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.readiness.configuration
            .knownAgentIdCount,
          1,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.rollbackDrillPassed,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.humanApprovalRecorded,
          true,
        );
        assert.equal(
          evidence.mergeQueueRolloutLiveDrill.runId,
          "run:elizaos/eliza#9001:attempt:1",
        );
        assert.equal(evidence.mergeQueueRolloutLiveDrill.events.length, 3);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /steward-token-do-not-print/,
        );

        const runOnceRequest = requests.find(
          (entry) => entry.url.pathname === "/api/queue/run-once",
        );
        assert.equal(
          runOnceRequest.headers.authorization,
          "Bearer steward-token-do-not-print",
        );
        assert.deepEqual(runOnceRequest.body, {
          workerId: "staged-live-worker",
          confirm: true,
        });
      },
    );
  });

  it("refuses merge queue live drill evidence without explicit live confirmation", async () => {
    const result = await runMergeQueueLiveDrillEvidenceHelper({
      ALLOW_ENV_ONLY: "true",
      MERGE_STEWARD_URL: "http://127.0.0.1:9",
      MERGE_STEWARD_API_TOKEN: "steward-token-keep-private",
      MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED: "true",
      MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION=true/,
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /steward-token-keep-private/,
    );
  });

  it("refuses merge queue live drill evidence without stack dependency order proof", async () => {
    const result = await runMergeQueueLiveDrillEvidenceHelper({
      ALLOW_ENV_ONLY: "true",
      MERGE_STEWARD_URL: "http://127.0.0.1:9",
      MERGE_STEWARD_API_TOKEN: "steward-token-keep-private",
      MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION: "true",
      MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED: "true",
      MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED=true/,
    );
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /steward-token-keep-private/,
    );
  });

  it("refuses merge queue live drill evidence without strict work reservations", async () => {
    const dir = await mkdtempInTestRoot("merge-queue-live-drill-unreserved-");
    const output = path.join(dir, "live-drill.json");

    await withMockStewardServer(
      async ({ request, url }) => {
        if (
          request.method === "GET" &&
          url.pathname === "/api/release-readiness"
        ) {
          return jsonResponse(200, mergeQueueStackDependencyReleaseReadiness());
        }

        if (request.method === "GET" && url.pathname === "/ready") {
          return jsonResponse(200, {
            ok: true,
            checkedAt: "2026-07-06T00:00:00.000Z",
            configuration: {
              workerEnabled: true,
              workerLeaseEnabled: true,
              integrationDryRun: false,
              requireWorkReservationForAgentPrs: false,
              requireWorkItemForAgentPrs: true,
              requireAgentBranchNamespaceForAgentPrs: true,
              requireVerifiedAgentRunReceiptForAgentPrs: true,
              requireAgentIdentityRegistryForAgentPrs: true,
              knownAgentIdCount: 1,
            },
            checks: [
              {
                name: "worker_lease",
                ok: true,
                leaseId: "merge-queue",
                ownerId: "worker-a",
                expiresAt: "2999-07-06T00:00:30.000Z",
              },
            ],
          });
        }

        if (
          request.method === "POST" &&
          url.pathname === "/api/queue/run-once"
        ) {
          return jsonResponse(200, mergeQueueLiveRunOnceResult());
        }

        if (
          request.method === "GET" &&
          url.pathname.startsWith("/api/runs/") &&
          url.pathname.endsWith("/events")
        ) {
          return jsonResponse(200, {
            events: [
              { type: "IntegrationActionStarted" },
              { type: "IntegrationActionFinished" },
            ],
          });
        }

        return jsonResponse(404, { error: "not_found" });
      },
      async ({ baseUrl }) => {
        const result = await runMergeQueueLiveDrillEvidenceHelper({
          ALLOW_ENV_ONLY: "true",
          MERGE_STEWARD_URL: baseUrl,
          MERGE_STEWARD_API_TOKEN: "steward-token-do-not-print",
          MERGE_QUEUE_LIVE_DRILL_OUTPUT: output,
          MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION: "true",
          MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED: "true",
          MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED: "true",
          MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED: "true",
        });

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /strict work reservations/);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /steward-token-do-not-print/,
        );
      },
    );
  });

  it("refuses merge queue live drill evidence without durable Work item links", async () => {
    const dir = await mkdtempInTestRoot("merge-queue-live-drill-untracked-");
    const output = path.join(dir, "live-drill.json");

    await withMockStewardServer(
      async ({ request, url }) => {
        if (
          request.method === "GET" &&
          url.pathname === "/api/release-readiness"
        ) {
          return jsonResponse(200, mergeQueueStackDependencyReleaseReadiness());
        }

        if (request.method === "GET" && url.pathname === "/ready") {
          return jsonResponse(200, {
            ok: true,
            checkedAt: "2026-07-06T00:00:00.000Z",
            configuration: {
              workerEnabled: true,
              workerLeaseEnabled: true,
              integrationDryRun: false,
              requireWorkReservationForAgentPrs: true,
              requireWorkItemForAgentPrs: false,
              requireAgentBranchNamespaceForAgentPrs: true,
              requireVerifiedAgentRunReceiptForAgentPrs: true,
              requireAgentIdentityRegistryForAgentPrs: true,
              knownAgentIdCount: 1,
            },
            checks: [
              {
                name: "worker_lease",
                ok: true,
                leaseId: "merge-queue",
                ownerId: "worker-a",
                expiresAt: "2999-07-06T00:00:30.000Z",
              },
            ],
          });
        }

        if (
          request.method === "POST" &&
          url.pathname === "/api/queue/run-once"
        ) {
          return jsonResponse(200, mergeQueueLiveRunOnceResult());
        }

        if (
          request.method === "GET" &&
          url.pathname.startsWith("/api/runs/") &&
          url.pathname.endsWith("/events")
        ) {
          return jsonResponse(200, {
            events: [
              { type: "IntegrationActionStarted" },
              { type: "IntegrationActionFinished" },
            ],
          });
        }

        return jsonResponse(404, { error: "not_found" });
      },
      async ({ baseUrl }) => {
        const result = await runMergeQueueLiveDrillEvidenceHelper({
          ALLOW_ENV_ONLY: "true",
          MERGE_STEWARD_URL: baseUrl,
          MERGE_STEWARD_API_TOKEN: "steward-token-do-not-print",
          MERGE_QUEUE_LIVE_DRILL_OUTPUT: output,
          MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION: "true",
          MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED: "true",
          MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED: "true",
          MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED: "true",
        });

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /strict Work items/);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /steward-token-do-not-print/,
        );
      },
    );
  });

  it("fails merge queue rollout evidence when dry-run proof is only an attestation", async () => {
    const envFile = await writeTempEnv({
      UNRELATED_SECRET: "merge-queue-secret-keep-private",
    });

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRY_RUN_PASSED: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /merge-queue-secret-keep-private/,
    );
  });

  it("fails merge queue rollout evidence when the safe drill artifact has failed checks", async () => {
    const envFile = await writeTempEnv({});
    const drillJson = await writeTempJson(
      mergeQueueRolloutDrillEvidence({
        dryRunPassed: false,
        checks: [
          { name: "Merge Steward /ready is ok", ok: true },
          {
            name: "synthetic queue item creates an integration plan",
            ok: false,
          },
        ],
      }),
    );

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRY_RUN_PASSED: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /did not prove dryRunPassed=true|failed rollout drill checks/,
    );
    assert.equal(result.stdout, "");
  });

  it("fails merge queue rollout evidence when staged live proof is only an attestation", async () => {
    const envFile = await writeTempEnv({
      UNRELATED_SECRET: "merge-queue-secret-keep-private",
    });
    const drillJson = await writeTempJson(mergeQueueRolloutDrillEvidence());

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_STAGED_LIVE_DRILL_PASSED: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /merge-queue-secret-keep-private/,
    );
  });

  it("fails merge queue rollout evidence when the staged live artifact lacks action checkpoints", async () => {
    const envFile = await writeTempEnv({});
    const drillJson = await writeTempJson(mergeQueueRolloutDrillEvidence());
    const liveDrillJson = await writeTempJson(
      mergeQueueRolloutLiveDrillEvidence({
        events: [{ type: "QueueItemMerged" }],
      }),
    );

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON: liveDrillJson,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /action checkpoint events/);
    assert.equal(result.stdout, "");
  });

  it("fails merge queue rollout evidence when the staged live artifact lacks strict reservations", async () => {
    const envFile = await writeTempEnv({});
    const drillJson = await writeTempJson(mergeQueueRolloutDrillEvidence());
    const liveDrillJson = await writeTempJson(
      mergeQueueRolloutLiveDrillEvidence({
        strictWorkReservationsEnforced: false,
        readiness: {
          ok: true,
          configuration: {
            requireWorkReservationForAgentPrs: false,
            requireWorkItemForAgentPrs: true,
          },
        },
      }),
    );

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON: liveDrillJson,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /strictWorkReservationsEnforced/);
    assert.equal(result.stdout, "");
  });

  it("fails merge queue rollout evidence when the staged live artifact lacks durable Work items", async () => {
    const envFile = await writeTempEnv({});
    const drillJson = await writeTempJson(mergeQueueRolloutDrillEvidence());
    const liveDrillJson = await writeTempJson(
      mergeQueueRolloutLiveDrillEvidence({
        strictWorkItemsEnforced: false,
        readiness: {
          ok: true,
          configuration: {
            requireWorkReservationForAgentPrs: true,
            requireWorkItemForAgentPrs: false,
            requireAgentBranchNamespaceForAgentPrs: true,
            requireVerifiedAgentRunReceiptForAgentPrs: true,
            requireAgentIdentityRegistryForAgentPrs: true,
            knownAgentIdCount: 1,
          },
        },
      }),
    );

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON: liveDrillJson,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /strictWorkItemsEnforced/);
    assert.equal(result.stdout, "");
  });

  it("fails merge queue rollout evidence when the staged live artifact lacks agent branch namespaces", async () => {
    const envFile = await writeTempEnv({});
    const drillJson = await writeTempJson(mergeQueueRolloutDrillEvidence());
    const liveDrillJson = await writeTempJson(
      mergeQueueRolloutLiveDrillEvidence({
        strictAgentBranchNamespacesEnforced: false,
        readiness: {
          ok: true,
          configuration: {
            requireWorkReservationForAgentPrs: true,
            requireWorkItemForAgentPrs: true,
            requireAgentBranchNamespaceForAgentPrs: false,
            requireVerifiedAgentRunReceiptForAgentPrs: true,
            requireAgentIdentityRegistryForAgentPrs: true,
            knownAgentIdCount: 1,
          },
        },
      }),
    );

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON: liveDrillJson,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /strictAgentBranchNamespacesEnforced/);
    assert.equal(result.stdout, "");
  });

  it("fails merge queue rollout evidence when the staged live artifact lacks verified agent run receipts", async () => {
    const envFile = await writeTempEnv({});
    const drillJson = await writeTempJson(mergeQueueRolloutDrillEvidence());
    const liveDrillJson = await writeTempJson(
      mergeQueueRolloutLiveDrillEvidence({
        verifiedAgentRunReceiptsEnforced: false,
        readiness: {
          ok: true,
          configuration: {
            requireWorkReservationForAgentPrs: true,
            requireWorkItemForAgentPrs: true,
            requireAgentBranchNamespaceForAgentPrs: true,
            requireVerifiedAgentRunReceiptForAgentPrs: false,
            requireAgentIdentityRegistryForAgentPrs: true,
            knownAgentIdCount: 1,
          },
        },
      }),
    );

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON: liveDrillJson,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /verifiedAgentRunReceiptsEnforced/);
    assert.equal(result.stdout, "");
  });

  it("fails merge queue rollout evidence when the staged live artifact lacks an agent identity registry", async () => {
    const envFile = await writeTempEnv({});
    const drillJson = await writeTempJson(mergeQueueRolloutDrillEvidence());
    const liveDrillJson = await writeTempJson(
      mergeQueueRolloutLiveDrillEvidence({
        agentIdentityRegistryEnforced: false,
        readiness: {
          ok: true,
          configuration: {
            requireWorkReservationForAgentPrs: true,
            requireWorkItemForAgentPrs: true,
            requireAgentBranchNamespaceForAgentPrs: true,
            requireVerifiedAgentRunReceiptForAgentPrs: true,
            requireAgentIdentityRegistryForAgentPrs: false,
            knownAgentIdCount: 0,
          },
        },
      }),
    );

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON: liveDrillJson,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /agentIdentityRegistryEnforced/);
    assert.equal(result.stdout, "");
  });

  it("fails merge queue rollout evidence when the staged live artifact lacks stack dependency order proof", async () => {
    const envFile = await writeTempEnv({});
    const drillJson = await writeTempJson(mergeQueueRolloutDrillEvidence());
    const liveDrillJson = await writeTempJson(
      mergeQueueRolloutLiveDrillEvidence({
        stackDependencyOrderEnforced: false,
      }),
    );

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON: drillJson,
      MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON: liveDrillJson,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /stackDependencyOrderEnforced/);
    assert.equal(result.stdout, "");
  });

  it("fails merge queue rollout evidence on malformed attestations", async () => {
    const envFile = await writeTempEnv({
      UNRELATED_SECRET: "merge-queue-secret-keep-private",
    });

    const result = await runMergeQueueRolloutEvidenceHelper(envFile, {
      MERGE_QUEUE_ROLLOUT_EVIDENCE_DRY_RUN_PASSED: "done",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MERGE_QUEUE_ROLLOUT_EVIDENCE_DRY_RUN_PASSED/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /merge-queue-secret-keep-private/,
    );
  });

  it("generates security review evidence from launch approval attestations", async () => {
    const envFile = await writeTempEnv({
      UNRELATED_SECRET: "security-review-secret-do-not-print",
    });
    const auditDir = await mkdtempInTestRoot("security-review-audit-output-");
    const auditOutput = path.join(auditDir, "security-review-audit.json");

    const result = await runSecurityReviewEvidenceHelper(envFile, {
      SECURITY_REVIEW_EVIDENCE_AUTH_REVIEWED: "true",
      SECURITY_REVIEW_EVIDENCE_TOKENS_REVIEWED: "true",
      SECURITY_REVIEW_EVIDENCE_RUNNER_EXECUTION_REVIEWED: "true",
      SECURITY_REVIEW_EVIDENCE_REPO_PERMISSIONS_REVIEWED: "true",
      SECURITY_REVIEW_EVIDENCE_APPROVED_BY: "eliza-security",
      SECURITY_REVIEW_EVIDENCE_APPROVED_AT: "2026-07-06T13:00:00Z",
      SECURITY_REVIEW_EVIDENCE_AUDIT_OUTPUT: auditOutput,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(auditOutput, "utf8")), {
      securityReviewAudit: {
        checkedAt: "2026-07-06T13:00:00.000Z",
        status: "approved",
        productionReady: true,
        approvedBy: "eliza-security",
        approvedAt: "2026-07-06T13:00:00.000Z",
        reviewedSurfaces: [
          "authReviewed",
          "tokensReviewed",
          "runnerExecutionReviewed",
          "repoPermissionsReviewed",
        ],
        evidence: {
          authReviewed: true,
          tokensReviewed: true,
          runnerExecutionReviewed: true,
          repoPermissionsReviewed: true,
        },
        checks: [
          { name: "auth_reviewed", status: "pass" },
          { name: "tokens_reviewed", status: "pass" },
          { name: "runner_execution_reviewed", status: "pass" },
          { name: "repo_permissions_reviewed", status: "pass" },
          { name: "approved_by_recorded", status: "pass" },
          { name: "approved_at_recorded", status: "pass" },
        ],
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      securityReview: {
        securityEvidence: {
          source: auditOutput,
          sha256: await sha256File(auditOutput),
          checkedAt: "2026-07-06T13:00:00.000Z",
          status: "approved",
          productionReady: true,
          approvedBy: "eliza-security",
          approvedAt: "2026-07-06T13:00:00.000Z",
          checkCount: 6,
          reviewedSurfaceCount: 4,
        },
        authReviewed: true,
        tokensReviewed: true,
        runnerExecutionReviewed: true,
        repoPermissionsReviewed: true,
        approvedBy: "eliza-security",
        approvedAt: "2026-07-06T13:00:00.000Z",
      },
    });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /security-review-secret-do-not-print/,
    );
  });

  it("fails security review evidence on malformed approval attestations", async () => {
    const envFile = await writeTempEnv({
      UNRELATED_SECRET: "security-review-secret-keep-private",
    });

    const result = await runSecurityReviewEvidenceHelper(envFile, {
      SECURITY_REVIEW_EVIDENCE_AUTH_REVIEWED: "true",
      SECURITY_REVIEW_EVIDENCE_APPROVED_AT: "not-a-date",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SECURITY_REVIEW_EVIDENCE_APPROVED_AT/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /security-review-secret-keep-private/,
    );
  });

  it("assembles production evidence fragments without manual JSON editing", async () => {
    const template = await writeTempJson({
      $schema: "schema.json",
      domain: { forgejoDomain: "placeholder.invalid" },
      sso: { issuerUrl: "https://placeholder.invalid" },
      backups: { includes: [] },
      database: { forgejoPostgres: false },
      imageProvenance: { forgejoImage: null },
      steward: { readyProductionMode: false },
      mergeQueueRollout: { dryRunPassed: false },
      securityReview: { approvedBy: null },
      runner: { isolated: false },
      mail: { smtpConfigured: false },
      observability: { prometheusScrapeOk: false },
      deployment: { applied: false },
    });
    const domain = await writeTempJson({
      domainEvidence: {
        status: "ready",
        checkedAt: "2026-07-06T00:00:00.000Z",
        domain: {
          forgejoRootUrl: "https://git.eliza.test/",
          forgejoDomain: "git.eliza.test",
          tlsVerified: true,
          rootUrlCanonical: true,
          reverseProxyReviewed: true,
        },
        checks: [
          { name: "https_url", ok: true },
          { name: "host_matches", ok: true },
          { name: "tls_fetch", ok: true },
          { name: "canonical_root_url", ok: true },
          { name: "reverse_proxy_reviewed", ok: true },
        ],
      },
    });
    const runner = await writeTempJson({
      runner: {
        smokeEvidence: {
          source:
            "/var/lib/eliza-hub-artifacts/eliza-hub-runner-smoke-evidence.json",
          sha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          checkedAt: "2026-07-06T00:03:00.000Z",
          repository: "elizaos/eliza",
          workflow: "runner-smoke.yml",
          runId: 42,
          workflowRunUrl:
            "https://git.eliza.test/elizaos/eliza/actions/runs/42",
        },
        auditEvidence: {
          source:
            "/var/lib/eliza-hub-artifacts/eliza-hub-runner-isolation-audit.json",
          sha256:
            "9999999999999999999999999999999999999999999999999999999999999999",
          checkedAt: "2026-07-06T00:04:00.000Z",
          status: "isolated",
          checkCount: 11,
        },
        isolated: true,
        noHostDockerSocket: true,
        noHostLabels: true,
        registrationTested: true,
        trustedSmokeWorkflowPassed: true,
        egressReviewed: true,
        secretExposureReviewed: true,
      },
    });
    const mail = await writeTempJson({
      mail: {
        mailEvidence: {
          source: "/var/lib/eliza-hub-artifacts/mail-smoke-audit.json",
          sha256:
            "1313131313131313131313131313131313131313131313131313131313131313",
          checkedAt: "2026-07-06T00:26:00.000Z",
          status: "verified",
          productionReady: true,
          checkCount: 4,
        },
        smtpConfigured: true,
        inviteSmokePassed: true,
        passwordResetSmokePassed: true,
        notificationSmokePassed: true,
      },
    });
    const storage = await writeTempJson({
      storage: {
        storageEvidence: {
          source: "/var/lib/eliza-hub-artifacts/storage-retention-audit.json",
          sha256:
            "1414141414141414141414141414141414141414141414141414141414141414",
          checkedAt: "2026-07-06T00:27:00.000Z",
          status: "verified",
          productionReady: true,
          checkCount: 5,
        },
        sizingReviewed: true,
        artifactRetentionConfigured: true,
        packageRetentionConfigured: true,
        lfsCapacityReviewed: true,
        logRetentionConfigured: true,
      },
    });
    const observability = await writeTempJson({
      observability: {
        observabilityEvidence: {
          source: "/var/lib/eliza-hub-artifacts/observability-audit.json",
          sha256:
            "1515151515151515151515151515151515151515151515151515151515151515",
          checkedAt: "2026-07-06T00:28:00.000Z",
          status: "verified",
          productionReady: true,
          checkCount: 6,
        },
        prometheusScrapeOk: true,
        alertRulesLoaded: true,
        alertRoutingConfigured: true,
        logsCollected: true,
        logRetentionDays: 30,
        noPageAlertsFiring: true,
      },
    });
    const sso = await writeTempJson({
      sso: {
        issuerUrl: "https://cloud.eliza.test",
        smokeEvidence: {
          source: "/var/lib/eliza-hub-artifacts/sso-smoke.json",
          sha256:
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          checkedAt: "2026-07-06T00:05:00.000Z",
        },
        bootstrapEvidence: {
          source:
            "/var/lib/eliza-hub-artifacts/eliza-hub-identity-bootstrap-evidence.json",
          sha256:
            "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
          checkedAt: "2026-07-06T00:04:00.000Z",
          status: "passed",
          checkCount: 8,
        },
        oidcProviderStaged: true,
        forgejoOidcSourceConfigured: true,
        smokeTested: true,
        humanIdentitySmokePassed: true,
        agentIdentitySmokePassed: true,
        serviceIdentitySmokePassed: true,
        publicRegistrationLocked: true,
        autoCreateRestrictedToIssuer: true,
        recoveryAdminVerified: true,
      },
    });
    const offsiteReceipts = exampleOffsiteReceiptSummaries({
      backupCreatedAt: "2026-07-06T12:00:00.000Z",
      uploadCheckedAt: "2026-07-06T12:15:00.000Z",
      restoreCheckedAt: "2026-07-06T12:30:00.000Z",
    });
    const backups = await writeTempJson({
      backups: {
        scheduled: true,
        offHost: true,
        encrypted: true,
        backupEvidence: {
          source: "/var/lib/eliza-hub-artifacts/backup-audit.json",
          sha256:
            "7777777777777777777777777777777777777777777777777777777777777777",
          checkedAt: "2026-07-06T12:31:00.000Z",
          status: "verified",
          productionReady: true,
          backupCreatedAt: "2026-07-06T12:00:00.000Z",
          restoreCheckedAt: "2026-07-06T12:30:00.000Z",
          componentCount: 6,
          checkCount: 10,
          ...offsiteReceipts,
        },
        lastBackupAt: "2026-07-06T12:00:00.000Z",
        lastRestoreCheckAt: "2026-07-06T12:30:00.000Z",
        includes: [
          "repositories",
          "database",
          "attachments",
          "packages",
          "lfs",
          "configuration",
        ],
      },
    });
    const database = await writeTempJson({
      database: {
        databaseEvidence: {
          source: "/var/lib/eliza-hub-artifacts/database-audit.json",
          sha256:
            "2222222222222222222222222222222222222222222222222222222222222222",
          checkedAt: "2026-07-06T12:40:00.000Z",
          status: "verified",
          productionReady: true,
          migrationOutputSource:
            "/var/lib/eliza-hub-artifacts/merge-steward-migrate.log",
          migrationOutputSha256:
            "5555555555555555555555555555555555555555555555555555555555555555",
          restoreDrillOutputSource:
            "/var/lib/eliza-hub-artifacts/restore-drill.log",
          restoreDrillOutputSha256:
            "6666666666666666666666666666666666666666666666666666666666666666",
          checkCount: 5,
          verifiedTableCount: 6,
        },
        forgejoPostgres: true,
        stewardPostgres: true,
        migrationsApplied: true,
        emptyHostRestoreDrillPassed: true,
        checksumDriftClean: true,
      },
    });
    const imageProvenance = await writeTempJson({
      imageProvenance: {
        forgejoImage:
          "codeberg.org/forgejo/forgejo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        stewardImage:
          "registry.eliza.test/eliza/merge-steward@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        runnerImage:
          "data.forgejo.org/forgejo/runner@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        dindImage:
          "docker.io/library/docker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        provenanceEvidence: {
          source: "/var/lib/eliza-hub-artifacts/image-provenance-audit.json",
          sha256:
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          checkedAt: "2026-07-06T00:01:00.000Z",
          imageCount: 4,
          checkCount: 5,
        },
        stewardImageBuiltByCi: true,
        stewardImageSignatureVerified: true,
        sbomGenerated: true,
        vulnerabilityScanClean: true,
      },
    });
    const steward = await writeTempJson({
      steward: {
        preflight: {
          ok: true,
          mode: "production",
          errors: [],
        },
        doctor: {
          ok: true,
        },
        preflightEvidence: {
          source: "/var/lib/eliza-hub-artifacts/steward-preflight.json",
          sha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          checkedAt: "2026-07-06T00:10:00.000Z",
          mode: "production",
          errorCount: 0,
        },
        doctorEvidence: {
          source: "/var/lib/eliza-hub-artifacts/steward-doctor.json",
          sha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          target: "https://steward.eliza.test",
          checkedAt: "2026-07-06T00:15:00.000Z",
          checkCount: 21,
        },
        readyProductionMode: true,
        labelMirroringTested: true,
        botTokenPermissionsReviewed: true,
        strictWorkReservationsEnforced: true,
        strictWorkItemsEnforced: true,
        strictAgentBranchNamespacesEnforced: true,
        verifiedAgentRunReceiptsEnforced: true,
        agentIdentityRegistryEnforced: true,
      },
    });
    const mergeQueueRollout = await writeTempJson({
      mergeQueueRollout: {
        dryRunPassed: true,
        stagedLiveDrillPassed: true,
        workerLeaseVerified: true,
        strictWorkReservationsEnforced: true,
        strictWorkItemsEnforced: true,
        strictAgentBranchNamespacesEnforced: true,
        verifiedAgentRunReceiptsEnforced: true,
        agentIdentityRegistryEnforced: true,
        stackDependencyOrderEnforced: true,
        rollbackDrillPassed: true,
        humanApprovalRecorded: true,
        dryRunEvidence: {
          source: "/var/lib/eliza-hub-artifacts/merge-queue-rollout-drill.json",
          sha256:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          checkedAt: "2026-07-06T00:00:00.000Z",
          checkCount: 5,
        },
        liveDrillEvidence: {
          source: "/var/lib/eliza-hub-artifacts/merge-queue-live-drill.json",
          sha256:
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          checkedAt: "2026-07-06T00:30:00.000Z",
          runId: "run:elizaos/eliza#9001:attempt:1",
        },
      },
    });
    const pilotBootstrap = await writeTempJson({
      schema: "https://eliza.hub/schemas/pilot-bootstrap-evidence.v1",
      status: "passed",
      dryRun: false,
      startedAt: "2026-07-06T12:45:00.000Z",
      finishedAt: "2026-07-06T12:46:00.000Z",
      repo: {
        owner: "elizaos",
        name: "eliza",
        fullName: "elizaos/eliza",
        targetBranch: "main",
      },
      upstream: {
        host: "github.com",
        pathname: "/elizaos/eliza.git",
        service: "github",
      },
      migration: {
        sourceService: "github",
        direction: "pull",
        mirror: true,
        private: true,
      },
      requiredChecks: ["runner-smoke / smoke", "merge-steward / gate"],
      trustedAgentIds: ["agent-codex", "agent-docs"],
      summary: {
        productionReady: true,
        stepCount: 9,
        requiredCheckCount: 2,
        trustedAgentCount: 2,
        mirrorVerified: true,
        defaultBranchVerified: true,
        webhookVerified: true,
        branchProtectionVerified: true,
        repoPolicyVerified: true,
        agentIdentitiesSynced: true,
        pilotSurfacesVerified: true,
        pullMirrorOnly: true,
      },
      steps: [
        { index: 1, name: "forgejo-api-schema", status: "verified" },
        {
          index: 2,
          name: "mirror-repository",
          status: "created",
          mirror: true,
          private: true,
        },
        {
          index: 3,
          name: "verify-default-branch",
          status: "verified",
          branch: "main",
        },
        { index: 4, name: "steward-webhook", status: "created" },
        { index: 5, name: "branch-protection", status: "created" },
        { index: 6, name: "repo-policy", status: "upserted" },
        { index: 7, name: "repo-policy-verify", status: "verified" },
        { index: 8, name: "agent-identities", status: "synced" },
        { index: 9, name: "pilot-surfaces", status: "verified" },
      ],
    });
    const secrets = await writeTempJson({
      secrets: {
        secretEvidence: {
          source: "/var/lib/eliza-hub-artifacts/secret-management-audit.json",
          sha256:
            "1212121212121212121212121212121212121212121212121212121212121212",
          checkedAt: "2026-07-06T00:25:00.000Z",
          status: "verified",
          productionReady: true,
          groupCount: 4,
          checkCount: 7,
        },
        externalSecretStore: true,
        rotationPolicyDocumented: true,
        appIniSecretsIssued: true,
        runnerTokenIssued: true,
        oauthSecretsIssued: true,
        webhookSecretsIssued: true,
        noPlaintextSecretsCommitted: true,
      },
    });
    const securityReview = await writeTempJson({
      securityReview: {
        securityEvidence: {
          source: "/var/lib/eliza-hub-artifacts/security-review-audit.json",
          sha256:
            "8888888888888888888888888888888888888888888888888888888888888888",
          checkedAt: "2026-07-06T13:00:00.000Z",
          status: "approved",
          productionReady: true,
          approvedBy: "eliza-security",
          approvedAt: "2026-07-06T13:00:00.000Z",
          checkCount: 6,
          reviewedSurfaceCount: 4,
        },
        authReviewed: true,
        tokensReviewed: true,
        runnerExecutionReviewed: true,
        repoPermissionsReviewed: true,
        approvedBy: "eliza-security",
        approvedAt: "2026-07-06T13:00:00.000Z",
      },
    });
    const postDeployReceipt = await writeTempJson({
      schema: "https://eliza.hub/schemas/post-deploy-evidence.v1",
      status: "passed",
      startedAt: "2026-07-06T13:05:00.000Z",
      finishedAt: "2026-07-06T13:06:00.000Z",
      targets: {
        forgejoLocalUrl: "https://git.eliza.test/",
        stewardLocalUrl: "https://git.eliza.test/steward",
      },
      summary: {
        total: 6,
        passed: 6,
        failed: 0,
        unknown: 0,
        warnings: 0,
      },
      checks: [
        { name: "Forgejo HTTP responds", status: "pass" },
        {
          name: "Forgejo Eliza theme asset and default theme render",
          status: "pass",
        },
        { name: "Merge Steward /ready is ok", status: "pass" },
        {
          name: "Merge Steward workflow, parity, production readiness, production cutover, evidence template, board, work items, work view evaluation, work pages, fleet coordination, work context, merge queue diagnostics, merge train plan, search, queue simulation, agent identities, insights, agents, agent performance, agent routing, agent bootstrap, agent cockpit, agent action plan, submission gate, work preflight, work reservation, CI failure analysis, validation plan, PR brief, review assignment, patch conflict prediction, and agent inbox APIs respond",
          status: "pass",
        },
        { name: "Merge Steward deployment doctor passes", status: "pass" },
        {
          name: "Merge queue rollout drill stays safely gated",
          status: "pass",
        },
      ],
    });
    const deployReceipt = await writeTempJson({
      schema: "https://eliza.hub/schemas/deploy-evidence.v1",
      status: "passed",
      mode: "rolling",
      dryRun: false,
      startedAt: "2026-07-06T13:00:00.000Z",
      finishedAt: "2026-07-06T13:05:00.000Z",
      options: {
        postDeployCheck: true,
      },
      files: {
        postDeployEvidence: postDeployReceipt,
      },
      steps: [
        {
          index: 1,
          phase: "preflight",
          name: "verify Forgejo image exists",
          command: "docker image inspect forgejo",
        },
        {
          index: 2,
          phase: "preflight",
          name: "verify Merge Steward image exists",
          command: "docker image inspect merge-steward",
        },
        {
          index: 3,
          phase: "rolling",
          name: "verify dependency health",
          command: "docker compose ps postgres forgejo",
        },
        {
          index: 4,
          phase: "rolling",
          name: "run merge steward migrations",
          command: "docker compose up merge-steward-migrate",
        },
        {
          index: 5,
          phase: "rolling",
          name: "restart application services",
          command: "docker compose up -d forgejo merge-steward",
        },
        {
          index: 6,
          phase: "post-deploy",
          name: "run post deploy checks",
          command: "post-deploy-check.sh",
        },
      ],
    });

    const result = await runProductionEvidenceAssembler([
      "--template",
      template,
      domain,
      runner,
      mail,
      storage,
      observability,
      sso,
      backups,
      database,
      imageProvenance,
      steward,
      mergeQueueRollout,
      pilotBootstrap,
      secrets,
      securityReview,
      deployReceipt,
    ]);
    const body = JSON.parse(result.stdout);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.$schema, "schema.json");
    assert.equal(body.domain.forgejoDomain, "git.eliza.test");
    assert.equal(body.domain.probeEvidence.source, domain);
    assert.equal(body.domain.probeEvidence.sha256, await sha256File(domain));
    assert.equal(
      body.domain.probeEvidence.checkedAt,
      "2026-07-06T00:00:00.000Z",
    );
    assert.equal(body.domain.probeEvidence.status, "ready");
    assert.equal(body.domain.probeEvidence.checkCount, 5);
    assert.equal(body.sso.issuerUrl, "https://cloud.eliza.test");
    assert.deepEqual(body.backups.includes, [
      "repositories",
      "database",
      "attachments",
      "packages",
      "lfs",
      "configuration",
    ]);
    assert.equal(body.backups.backupEvidence.checkCount, 10);
    assert.equal(body.database.migrationsApplied, true);
    assert.equal(body.database.databaseEvidence.verifiedTableCount, 6);
    assert.equal(body.imageProvenance.provenanceEvidence.checkCount, 5);
    assert.equal(body.steward.readyProductionMode, true);
    assert.equal(body.steward.strictWorkReservationsEnforced, true);
    assert.equal(body.steward.strictWorkItemsEnforced, true);
    assert.equal(body.steward.strictAgentBranchNamespacesEnforced, true);
    assert.equal(body.steward.verifiedAgentRunReceiptsEnforced, true);
    assert.equal(body.steward.agentIdentityRegistryEnforced, true);
    assert.equal(
      body.steward.preflightEvidence.source,
      "/var/lib/eliza-hub-artifacts/steward-preflight.json",
    );
    assert.equal(body.steward.doctorEvidence.checkCount, 21);
    assert.equal(body.mergeQueueRollout.dryRunPassed, true);
    assert.equal(body.mergeQueueRollout.strictWorkReservationsEnforced, true);
    assert.equal(body.mergeQueueRollout.strictWorkItemsEnforced, true);
    assert.equal(
      body.mergeQueueRollout.strictAgentBranchNamespacesEnforced,
      true,
    );
    assert.equal(body.mergeQueueRollout.verifiedAgentRunReceiptsEnforced, true);
    assert.equal(body.mergeQueueRollout.agentIdentityRegistryEnforced, true);
    assert.equal(body.mergeQueueRollout.stackDependencyOrderEnforced, true);
    assert.equal(
      body.githubMigration.pilotBootstrapEvidence.source,
      pilotBootstrap,
    );
    assert.equal(
      body.githubMigration.pilotBootstrapEvidence.sha256,
      await sha256File(pilotBootstrap),
    );
    assert.equal(body.githubMigration.pilotBootstrapEvidence.dryRun, false);
    assert.equal(
      body.githubMigration.pilotBootstrapEvidence.repo,
      "elizaos/eliza",
    );
    assert.equal(
      body.githubMigration.pilotBootstrapEvidence.upstreamHost,
      "github.com",
    );
    assert.equal(body.githubMigration.pilotBootstrapEvidence.stepCount, 9);
    assert.equal(body.githubMigration.pilotBootstrapPassed, true);
    assert.equal(body.githubMigration.pullMirrorOnly, true);
    assert.equal(body.secrets.secretEvidence.checkCount, 7);
    assert.equal(body.securityReview.approvedBy, "eliza-security");
    assert.equal(body.securityReview.securityEvidence.reviewedSurfaceCount, 4);
    assert.equal(body.runner.isolated, true);
    assert.equal(body.mail.mailEvidence.checkCount, 4);
    assert.equal(body.mail.notificationSmokePassed, true);
    assert.equal(body.storage.storageEvidence.checkCount, 5);
    assert.equal(body.observability.observabilityEvidence.checkCount, 6);
    assert.equal(body.deployment.mode, "rolling");
    assert.equal(body.deployment.applied, true);
    assert.equal(body.deployment.postDeployVerified, true);
    assert.equal(body.deployment.deployEvidence.source, deployReceipt);
    assert.equal(
      body.deployment.deployEvidence.sha256,
      await sha256File(deployReceipt),
    );
    assert.equal(
      body.deployment.deployEvidence.postDeployEvidenceSource,
      postDeployReceipt,
    );
    assert.equal(
      body.deployment.deployEvidence.postDeployEvidenceSha256,
      await sha256File(postDeployReceipt),
    );
    assert.equal(body.deployment.postDeployEvidence.source, postDeployReceipt);
    assert.equal(body.deployment.postDeployEvidence.checkCount, 6);
  });

  it("inventories production evidence fragments before assembly", async () => {
    const artifactRoot = await mkdtempInTestRoot(
      "production-evidence-inventory-",
    );
    const domainFragmentPath = path.join(artifactRoot, "domain-evidence.json");
    const ssoFragmentPath = path.join(artifactRoot, "sso-evidence.json");
    const backupFragmentPath = path.join(artifactRoot, "backup-evidence.json");
    await writeFile(
      domainFragmentPath,
      `${JSON.stringify({
        domainEvidence: {
          domain: {
            forgejoRootUrl: "https://git.eliza.test/",
            forgejoDomain: "git.eliza.test",
          },
        },
      })}\n`,
    );
    await writeFile(ssoFragmentPath, "{not-json");
    await writeFile(
      backupFragmentPath,
      `${JSON.stringify({ mail: { smtpConfigured: true } })}\n`,
    );

    const result = await runProductionEvidenceInventory([
      "--artifact-root",
      artifactRoot,
      "--generated-at",
      "2026-07-07T00:00:00.000Z",
    ]);
    const strict = await runProductionEvidenceInventory([
      "--artifact-root",
      artifactRoot,
      "--generated-at",
      "2026-07-07T00:00:00.000Z",
      "--strict",
    ]);
    const body = JSON.parse(result.stdout);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      body.schema,
      "https://eliza.hub/schemas/production-evidence-inventory.v1",
    );
    assert.equal(body.complete, false);
    assert.equal(body.summary.total, 16);
    assert.equal(body.summary.present, 1);
    assert.equal(body.summary.invalid, 1);
    assert.equal(body.summary.wrongBlock, 1);
    assert.equal(body.summary.missing, 13);
    assert.equal(body.summary.filesWithDigest, 3);
    assert.equal(body.nextAction.domainId, "sso_registration");
    assert.equal(body.nextAction.status, "invalid_json");
    assert.match(
      body.nextAction.helperSteps[0].command,
      /bootstrap-forgejo-identity\.sh/,
    );
    assert.match(
      body.nextAction.helperSteps[1].command,
      /sso-smoke-evidence\.mjs/,
    );
    assert.match(body.assemble.command, /production-evidence-assemble\.mjs/);
    assert.equal(body.assemble.ready, false);
    const domainFragment = body.fragments.find(
      (fragment) => fragment.domainId === "domain_tls",
    );
    const ssoFragment = body.fragments.find(
      (fragment) => fragment.domainId === "sso_registration",
    );
    const backupFragment = body.fragments.find(
      (fragment) => fragment.domainId === "backup_restore",
    );
    const missingFragment = body.fragments.find(
      (fragment) => fragment.domainId === "database_migration",
    );
    assert.equal(
      domainFragment.file.sha256,
      await sha256File(domainFragmentPath),
    );
    assert.equal(ssoFragment.file.sha256, await sha256File(ssoFragmentPath));
    assert.equal(
      backupFragment.file.sha256,
      await sha256File(backupFragmentPath),
    );
    assert.equal(typeof domainFragment.file.sizeBytes, "number");
    assert.match(domainFragment.file.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(missingFragment.file, null);
    assert.notEqual(strict.code, 0);
    assert.match(strict.stderr, /incomplete/);
    assert.doesNotMatch(
      result.stdout + result.stderr + strict.stdout + strict.stderr,
      /secret-token/,
    );
  });

  it("marks production evidence inventory complete when every expected fragment is present", async () => {
    const parent = await mkdtempInTestRoot(
      "production-evidence-inventory-ready-",
    );
    const artifactRoot = path.join(parent, "artifact root");
    await mkdir(artifactRoot, { recursive: true });
    await writeInventoryFragments(artifactRoot);

    const result = await runProductionEvidenceInventory([
      "--artifact-root",
      artifactRoot,
      "--out",
      path.join(artifactRoot, "final evidence.json"),
      "--generated-at",
      "2026-07-07T00:00:00.000Z",
      "--strict",
    ]);
    const body = JSON.parse(result.stdout);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.complete, true);
    assert.equal(body.summary.present, 16);
    assert.equal(body.summary.missing, 0);
    assert.equal(body.summary.invalid, 0);
    assert.equal(body.summary.wrongBlock, 0);
    assert.equal(body.summary.filesWithDigest, 16);
    assert.equal(body.nextAction, null);
    assert.equal(body.assemble.ready, true);
    assert.equal(body.assemble.fragmentPaths.length, 16);
    assert.match(body.assemble.command, /production-evidence-assemble\.mjs/);
    assert.match(
      body.assemble.command,
      /'[^']*artifact root\/domain-evidence\.json'/,
    );
    const runnerFragment = body.fragments.find(
      (fragment) => fragment.domainId === "runner_isolation",
    );
    assert.match(runnerFragment.supportedBlocks[0], /runner/);
    assert.match(runnerFragment.file.sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof runnerFragment.file.sizeBytes, "number");
  });

  it("generates repository protection evidence from env policy and reviews", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_PROTECTED_BRANCHES: "main, develop, main",
      FORGEJO_REQUIRED_CHECKS: "unit,lint, release-gate",
    });

    const result = await runRepositoryEvidenceHelper(envFile, {
      REPOSITORY_EVIDENCE_FORK_POLICY_REVIEWED: "true",
      REPOSITORY_EVIDENCE_ACTIONS_POLICY_REVIEWED: "true",
      REPOSITORY_EVIDENCE_ADMIN_BYPASS_REVIEWED: "true",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      repository: {
        protectedBranches: ["main", "develop"],
        requiredChecks: ["unit", "lint", "release-gate"],
        forkPolicyReviewed: true,
        actionsPolicyReviewed: true,
        adminBypassReviewed: true,
        liveProtectionEvidence: null,
      },
    });
  });

  it("generates repository protection evidence from a live protection audit", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_PROTECTED_BRANCHES: "main",
      FORGEJO_REQUIRED_CHECKS: "unit",
    });
    const protectionJson = await writeTempJson({
      repositoryProtection: {
        computedAt: "2026-07-06T00:20:00.000Z",
        status: "protected",
        productionReady: true,
        policy: {
          protectedBranches: ["develop", "release/**"],
          requiredChecks: ["unit", "lint", "release-gate"],
        },
        live: {
          available: true,
          required: true,
        },
        checks: [
          {
            name: "fork_policy_reviewed",
            status: "pass",
          },
        ],
      },
    });

    const result = await runRepositoryEvidenceHelper(envFile, {
      REPOSITORY_EVIDENCE_REQUIRE_LIVE: "true",
      REPOSITORY_EVIDENCE_REPOSITORY_PROTECTION_JSON: protectionJson,
      REPOSITORY_EVIDENCE_ACTIONS_POLICY_REVIEWED: "true",
      REPOSITORY_EVIDENCE_ADMIN_BYPASS_REVIEWED: "true",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      repository: {
        protectedBranches: ["develop", "release/**"],
        requiredChecks: ["unit", "lint", "release-gate"],
        forkPolicyReviewed: true,
        actionsPolicyReviewed: true,
        adminBypassReviewed: true,
        liveProtectionEvidence: {
          source: protectionJson,
          sha256: await sha256File(protectionJson),
          checkedAt: "2026-07-06T00:20:00.000Z",
          status: "protected",
          productionReady: true,
          liveAvailable: true,
          liveRequired: true,
          checkCount: 1,
        },
      },
    });
  });

  it("writes fetched live repository protection audits to a local artifact", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_PROTECTED_BRANCHES: "main",
      FORGEJO_REQUIRED_CHECKS: "unit",
    });
    const dir = await mkdtempInTestRoot("repository-protection-output-");
    const outputPath = path.join(dir, "repository-protection.json");
    const repositoryProtection = {
      checkedAt: "2026-07-06T00:21:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "main",
      status: "protected",
      productionReady: true,
      policy: {
        protectedBranches: ["main"],
        requiredChecks: ["merge-steward"],
      },
      live: {
        available: true,
        required: true,
      },
      checks: [
        { name: "repo_policy_present", status: "pass" },
        { name: "queue_policy_enabled", status: "pass" },
        { name: "protected_branches_configured", status: "pass" },
        { name: "required_checks_configured", status: "pass" },
        { name: "trusted_actors_configured", status: "pass" },
        { name: "fork_policy_reviewed", status: "pass" },
        { name: "live_branch_protection_verified", status: "pass" },
        { name: "live_required_checks_verified", status: "pass" },
      ],
    };

    await withMockStewardServer(
      () => jsonResponse(200, { repositoryProtection }),
      async ({ baseUrl, requests }) => {
        const result = await runRepositoryEvidenceHelper(envFile, {
          REPOSITORY_EVIDENCE_REQUIRE_LIVE: "true",
          REPOSITORY_EVIDENCE_STEWARD_URL: baseUrl,
          REPOSITORY_EVIDENCE_REPO: "elizaos/eliza",
          REPOSITORY_EVIDENCE_TARGET_BRANCH: "main",
          REPOSITORY_EVIDENCE_REPOSITORY_PROTECTION_OUTPUT: outputPath,
          REPOSITORY_EVIDENCE_ACTIONS_POLICY_REVIEWED: "true",
          REPOSITORY_EVIDENCE_ADMIN_BYPASS_REVIEWED: "true",
        });

        assert.equal(result.code, 0, result.stderr);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url.pathname, "/api/repository-protection");
        assert.equal(requests[0].url.searchParams.get("repo"), "elizaos/eliza");
        assert.equal(requests[0].url.searchParams.get("targetBranch"), "main");
        assert.equal(requests[0].url.searchParams.get("requireLive"), "true");
        assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
          repositoryProtection,
        });
        assert.deepEqual(JSON.parse(result.stdout), {
          repository: {
            protectedBranches: ["main"],
            requiredChecks: ["merge-steward"],
            forkPolicyReviewed: true,
            actionsPolicyReviewed: true,
            adminBypassReviewed: true,
            liveProtectionEvidence: {
              source: outputPath,
              sha256: await sha256File(outputPath),
              checkedAt: "2026-07-06T00:21:00.000Z",
              status: "protected",
              productionReady: true,
              liveAvailable: true,
              liveRequired: true,
              checkCount: 8,
            },
          },
        });
      },
    );
  });

  it("fails repository evidence when required live protection is not production-ready", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_PROTECTED_BRANCHES: "main",
      FORGEJO_REQUIRED_CHECKS: "unit",
    });
    const protectionJson = await writeTempJson({
      repositoryProtection: {
        status: "watch",
        productionReady: false,
        policy: {
          protectedBranches: ["main"],
          requiredChecks: ["unit"],
        },
        live: {
          available: false,
          required: true,
        },
      },
    });

    const result = await runRepositoryEvidenceHelper(envFile, {
      REPOSITORY_EVIDENCE_REQUIRE_LIVE: "true",
      REPOSITORY_EVIDENCE_REPOSITORY_PROTECTION_JSON: protectionJson,
      REPOSITORY_EVIDENCE_ACTIONS_POLICY_REVIEWED: "true",
      REPOSITORY_EVIDENCE_ADMIN_BYPASS_REVIEWED: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /repository protection audit must be production-ready/,
    );
    assert.equal(result.stdout, "");
  });

  it("lets repository evidence use explicit branch and check overrides", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_PROTECTED_BRANCHES: "main",
      FORGEJO_REQUIRED_CHECKS: "unit",
    });

    const result = await runRepositoryEvidenceHelper(envFile, {
      REPOSITORY_EVIDENCE_PROTECTED_BRANCHES: "main,release",
      REPOSITORY_EVIDENCE_REQUIRED_CHECKS: "unit,lint,security",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).repository.protectedBranches, [
      "main",
      "release",
    ]);
    assert.deepEqual(JSON.parse(result.stdout).repository.requiredChecks, [
      "unit",
      "lint",
      "security",
    ]);
  });

  it("fails repository evidence on malformed review attestations", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_PROTECTED_BRANCHES: "main",
      FORGEJO_REQUIRED_CHECKS: "unit",
    });

    const result = await runRepositoryEvidenceHelper(envFile, {
      REPOSITORY_EVIDENCE_FORK_POLICY_REVIEWED: "reviewed",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /REPOSITORY_EVIDENCE_FORK_POLICY_REVIEWED/);
    assert.equal(result.stdout, "");
  });

  it("keeps runner smoke evidence helper wired to Forgejo Actions without printing tokens", async () => {
    const helper = await readFile(RUNNER_SMOKE_EVIDENCE_HELPER_PATH, "utf8");

    assert.match(helper, /actions\/workflows/);
    assert.match(helper, /dispatches/);
    assert.match(helper, /actions\/runs/);
    assert.match(helper, /RUNNER_SMOKE_FORGEJO_TOKEN/);
    assert.match(helper, /FORGEJO_STEWARD_TOKEN/);
    assert.match(helper, /RUNNER_SMOKE_DISPATCH/);
    assert.match(helper, /RUNNER_SMOKE_EVIDENCE_OUTPUT/);
    assert.doesNotMatch(helper, /console\.(?:log|error)\([^)]*token/i);
  });

  it("generates SSO evidence from private OIDC config and launch attestations", async () => {
    const bootstrapJson = await writeTempJson(identityBootstrapEvidence());
    const envFile = await writeTempEnv({
      ...ssoEnv(),
      SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON: bootstrapJson,
      UNRELATED_SECRET: "keep-this-private",
    });

    const result = await runSsoEvidenceHelper(envFile, {
      SSO_EVIDENCE_SMOKE_TESTED: "true",
      SSO_EVIDENCE_HUMAN_IDENTITY_SMOKE_PASSED: "true",
      SSO_EVIDENCE_AGENT_IDENTITY_SMOKE_PASSED: "true",
      SSO_EVIDENCE_SERVICE_IDENTITY_SMOKE_PASSED: "true",
      SSO_EVIDENCE_AUTO_CREATE_RESTRICTED_TO_ISSUER: "true",
      SSO_EVIDENCE_RECOVERY_ADMIN_VERIFIED: "true",
    });

    assert.equal(result.code, 0, result.stderr);
    const bootstrapSha = await sha256File(bootstrapJson);
    assert.deepEqual(JSON.parse(result.stdout), {
      sso: {
        issuerUrl: "https://cloud.eliza.test",
        smokeEvidence: null,
        bootstrapEvidence: {
          source: bootstrapJson,
          sha256: bootstrapSha,
          checkedAt: "2026-07-06T00:04:00.000Z",
          status: "passed",
          checkCount: 8,
        },
        oidcProviderStaged: true,
        forgejoOidcSourceConfigured: true,
        smokeTested: true,
        humanIdentitySmokePassed: true,
        agentIdentitySmokePassed: true,
        serviceIdentitySmokePassed: true,
        publicRegistrationLocked: true,
        autoCreateRestrictedToIssuer: true,
        recoveryAdminVerified: true,
      },
    });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /oidc-client-secret-do-not-print|keep-this-private/,
    );
  });

  it("generates SSO evidence from structured smoke JSON", async () => {
    const bootstrapJson = await writeTempJson(identityBootstrapEvidence());
    const envFile = await writeTempEnv(ssoEnv());
    const smokeJson = await writeTempJson({
      ssoSmoke: {
        issuerUrl: "https://cloud.eliza.test",
        checkedAt: "2026-07-06T00:05:00.000Z",
        oidcLoginSucceeded: true,
        humanIdentitySmokePassed: true,
        agentTokenClaimsVerified: true,
        serviceTokenClaimsVerified: true,
        publicRegistrationLocked: true,
        nonIssuerRejected: true,
        recoveryAdminLoginSucceeded: true,
      },
    });

    const result = await runSsoEvidenceHelper(envFile, {
      SSO_EVIDENCE_SMOKE_JSON: smokeJson,
      SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON: bootstrapJson,
    });

    assert.equal(result.code, 0, result.stderr);
    const smokeSha = await sha256File(smokeJson);
    const bootstrapSha = await sha256File(bootstrapJson);
    assert.deepEqual(JSON.parse(result.stdout), {
      sso: {
        issuerUrl: "https://cloud.eliza.test",
        smokeEvidence: {
          source: smokeJson,
          sha256: smokeSha,
          checkedAt: "2026-07-06T00:05:00.000Z",
        },
        bootstrapEvidence: {
          source: bootstrapJson,
          sha256: bootstrapSha,
          checkedAt: "2026-07-06T00:04:00.000Z",
          status: "passed",
          checkCount: 8,
        },
        oidcProviderStaged: true,
        forgejoOidcSourceConfigured: true,
        smokeTested: true,
        humanIdentitySmokePassed: true,
        agentIdentitySmokePassed: true,
        serviceIdentitySmokePassed: true,
        publicRegistrationLocked: true,
        autoCreateRestrictedToIssuer: true,
        recoveryAdminVerified: true,
      },
    });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /oidc-client-secret-do-not-print/,
    );
  });

  it("fails SSO evidence when Forgejo OIDC source proof is claimed without identity bootstrap evidence", async () => {
    const envFile = await writeTempEnv(ssoEnv());

    const result = await runSsoEvidenceHelper(envFile, {
      SSO_EVIDENCE_FORGEJO_OIDC_SOURCE_CONFIGURED: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /oidc-client-secret-do-not-print/,
    );
  });

  it("fails SSO smoke JSON when the issuer does not match private config", async () => {
    const envFile = await writeTempEnv({
      ...ssoEnv(),
      ELIZA_CLOUD_FORGEJO_CLIENT_SECRET:
        "oidc-client-secret-keep-private-123456",
    });
    const smokeJson = await writeTempJson({
      ssoSmoke: {
        issuerUrl: "https://other-cloud.eliza.test",
        oidcLoginSucceeded: true,
      },
    });

    const result = await runSsoEvidenceHelper(envFile, {
      SSO_EVIDENCE_SMOKE_JSON: smokeJson,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /issuerUrl does not match/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /oidc-client-secret-keep-private/,
    );
  });

  it("fails SSO smoke JSON when the smoke result is not an object", async () => {
    const envFile = await writeTempEnv({
      ...ssoEnv(),
      ELIZA_CLOUD_FORGEJO_CLIENT_SECRET:
        "oidc-client-secret-keep-private-123456",
    });
    const smokeJson = await writeTempJson({
      ssoSmoke: ["not", "an", "object"],
    });

    const result = await runSsoEvidenceHelper(envFile, {
      SSO_EVIDENCE_SMOKE_JSON: smokeJson,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ssoSmoke must be a JSON object/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /oidc-client-secret-keep-private/,
    );
  });

  it("fails SSO evidence on malformed attestations without printing OIDC secrets", async () => {
    const envFile = await writeTempEnv({
      ...ssoEnv(),
      ELIZA_CLOUD_FORGEJO_CLIENT_SECRET:
        "oidc-client-secret-keep-private-123456",
    });

    const result = await runSsoEvidenceHelper(envFile, {
      SSO_EVIDENCE_SMOKE_TESTED: "done",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SSO_EVIDENCE_SMOKE_TESTED/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /oidc-client-secret-keep-private/,
    );
  });

  it("fails SSO evidence when identity smoke is claimed without a login smoke", async () => {
    const envFile = await writeTempEnv({
      ...ssoEnv(),
      ELIZA_CLOUD_FORGEJO_CLIENT_SECRET:
        "oidc-client-secret-keep-private-123456",
    });

    const result = await runSsoEvidenceHelper(envFile, {
      SSO_EVIDENCE_HUMAN_IDENTITY_SMOKE_PASSED: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SSO_EVIDENCE_HUMAN_IDENTITY_SMOKE_PASSED/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /oidc-client-secret-keep-private/,
    );
  });

  it("fails SSO evidence when OAuth auto-registration or tenant gates are missing", async () => {
    const envFile = await writeTempEnv({
      ...ssoEnv(),
      FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION: "false",
      FORGEJO_OIDC_REQUIRED_CLAIM_NAME: "",
    });

    const result = await runSsoEvidenceHelper(envFile, {
      SSO_EVIDENCE_SMOKE_TESTED: "true",
      SSO_EVIDENCE_AUTO_CREATE_RESTRICTED_TO_ISSUER: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /SSO_EVIDENCE_AUTO_CREATE_RESTRICTED_TO_ISSUER/,
    );
    assert.equal(result.stdout, "");
  });

  it("generates steward runtime evidence from preflight, doctor, and operator attestations", async () => {
    const envFile = await writeTempEnv({
      UNRELATED_SECRET: "steward-secret-do-not-print",
    });
    const preflight = await writeTempJson({
      preflight: {
        ok: true,
        mode: "production",
        errors: [],
        checkedAt: "2026-07-06T00:10:00.000Z",
        warnings: [
          {
            code: "worker_push_branch_disabled",
            detail: "do-not-print-detail",
          },
        ],
      },
    });
    const doctor = await writeTempJson({
      doctor: {
        ok: true,
        target: "https://steward.eliza.test",
        checkedAt: "2026-07-06T00:15:00.000Z",
        checks: [{ name: "runtime_preflight", ok: true }],
      },
    });

    const result = await runStewardEvidenceHelper(envFile, {
      preflight,
      doctor,
      extraEnv: {
        MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
        MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
        MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
        MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
        MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
        STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED: "true",
        STEWARD_EVIDENCE_BOT_TOKEN_PERMISSIONS_REVIEWED: "true",
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      steward: {
        preflight: {
          ok: true,
          mode: "production",
          errors: [],
        },
        doctor: {
          ok: true,
        },
        preflightEvidence: {
          source: preflight,
          sha256: await sha256File(preflight),
          checkedAt: "2026-07-06T00:10:00.000Z",
          mode: "production",
          errorCount: 0,
        },
        doctorEvidence: {
          source: doctor,
          sha256: await sha256File(doctor),
          target: "https://steward.eliza.test",
          checkedAt: "2026-07-06T00:15:00.000Z",
          checkCount: 1,
        },
        readyProductionMode: true,
        labelMirroringTested: true,
        botTokenPermissionsReviewed: true,
        strictWorkReservationsEnforced: true,
        strictWorkItemsEnforced: true,
        strictAgentBranchNamespacesEnforced: true,
        verifiedAgentRunReceiptsEnforced: true,
        agentIdentityRegistryEnforced: true,
      },
    });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /steward-secret-do-not-print|do-not-print-detail/,
    );
  });

  it("fails steward runtime evidence when production mode is ready without strict work reservations", async () => {
    const envFile = await writeTempEnv({
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "false",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
    });
    const preflight = await writeTempJson({
      preflight: {
        ok: true,
        mode: "production",
        errors: [],
        checkedAt: "2026-07-06T00:10:00.000Z",
      },
    });
    const doctor = await writeTempJson({
      doctor: {
        ok: true,
        target: "https://steward.eliza.test",
        checkedAt: "2026-07-06T00:15:00.000Z",
        checks: [{ name: "runtime_preflight", ok: true }],
      },
    });

    const result = await runStewardEvidenceHelper(envFile, {
      preflight,
      doctor,
      extraEnv: {
        STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED: "true",
        STEWARD_EVIDENCE_BOT_TOKEN_PERMISSIONS_REVIEWED: "true",
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS/,
    );
    assert.equal(result.stdout, "");
  });

  it("fails steward runtime evidence when production mode is ready without durable Work item links", async () => {
    const envFile = await writeTempEnv({
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "false",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
    });
    const preflight = await writeTempJson({
      preflight: {
        ok: true,
        mode: "production",
        errors: [],
        checkedAt: "2026-07-06T00:10:00.000Z",
      },
    });
    const doctor = await writeTempJson({
      doctor: {
        ok: true,
        target: "https://steward.eliza.test",
        checkedAt: "2026-07-06T00:15:00.000Z",
        checks: [{ name: "runtime_preflight", ok: true }],
      },
    });

    const result = await runStewardEvidenceHelper(envFile, {
      preflight,
      doctor,
      extraEnv: {
        STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED: "true",
        STEWARD_EVIDENCE_BOT_TOKEN_PERMISSIONS_REVIEWED: "true",
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS/,
    );
    assert.equal(result.stdout, "");
  });

  it("fails steward runtime evidence when production mode is ready without agent branch namespaces", async () => {
    const envFile = await writeTempEnv({
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "false",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
    });
    const preflight = await writeTempJson({
      preflight: {
        ok: true,
        mode: "production",
        errors: [],
        checkedAt: "2026-07-06T00:10:00.000Z",
      },
    });
    const doctor = await writeTempJson({
      doctor: {
        ok: true,
        target: "https://steward.eliza.test",
        checkedAt: "2026-07-06T00:15:00.000Z",
        checks: [{ name: "runtime_preflight", ok: true }],
      },
    });

    const result = await runStewardEvidenceHelper(envFile, {
      preflight,
      doctor,
      extraEnv: {
        STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED: "true",
        STEWARD_EVIDENCE_BOT_TOKEN_PERMISSIONS_REVIEWED: "true",
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE/);
    assert.equal(result.stdout, "");
  });

  it("fails steward runtime evidence when production mode is ready without verified agent run receipts", async () => {
    const envFile = await writeTempEnv({
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "false",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
    });
    const preflight = await writeTempJson({
      preflight: {
        ok: true,
        mode: "production",
        errors: [],
        checkedAt: "2026-07-06T00:10:00.000Z",
      },
    });
    const doctor = await writeTempJson({
      doctor: {
        ok: true,
        target: "https://steward.eliza.test",
        checkedAt: "2026-07-06T00:15:00.000Z",
        checks: [{ name: "runtime_preflight", ok: true }],
      },
    });

    const result = await runStewardEvidenceHelper(envFile, {
      preflight,
      doctor,
      extraEnv: {
        STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED: "true",
        STEWARD_EVIDENCE_BOT_TOKEN_PERMISSIONS_REVIEWED: "true",
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT/,
    );
    assert.equal(result.stdout, "");
  });

  it("fails steward runtime evidence when production mode is ready without an agent identity registry", async () => {
    const envFile = await writeTempEnv({
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "false",
    });
    const preflight = await writeTempJson({
      preflight: {
        ok: true,
        mode: "production",
        errors: [],
        checkedAt: "2026-07-06T00:10:00.000Z",
      },
    });
    const doctor = await writeTempJson({
      doctor: {
        ok: true,
        target: "https://steward.eliza.test",
        checkedAt: "2026-07-06T00:15:00.000Z",
        checks: [{ name: "runtime_preflight", ok: true }],
      },
    });

    const result = await runStewardEvidenceHelper(envFile, {
      preflight,
      doctor,
      extraEnv: {
        STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED: "true",
        STEWARD_EVIDENCE_BOT_TOKEN_PERMISSIONS_REVIEWED: "true",
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY/,
    );
    assert.equal(result.stdout, "");
  });

  it("fails steward evidence on malformed attestations", async () => {
    const envFile = await writeTempEnv({});
    const preflight = await writeTempJson({
      preflight: {
        ok: true,
        mode: "production",
        errors: [],
        checkedAt: "2026-07-06T00:10:00.000Z",
      },
    });
    const doctor = await writeTempJson({
      doctor: {
        ok: true,
        target: "https://steward.eliza.test",
        checkedAt: "2026-07-06T00:15:00.000Z",
        checks: [{ name: "runtime_preflight", ok: true }],
      },
    });

    const result = await runStewardEvidenceHelper(envFile, {
      preflight,
      doctor,
      extraEnv: {
        STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED: "done",
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED/);
    assert.equal(result.stdout, "");
  });

  it("generates non-secret secret management evidence from staging secret state", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_RECOVERY_ADMIN_PASSWORD: "recovery-admin-password-123456",
      FORGEJO_DB_PASSWORD: "forgejo-db-password-123456789",
      FORGEJO_SECRET_KEY: "forgejo-secret-key-12345678901234567890", // gitleaks:allow - synthetic evidence fixture
      FORGEJO_INTERNAL_TOKEN: "forgejo-internal-token-1234567890123456",
      FORGEJO_OAUTH2_JWT_SECRET: "forgejo-oauth2-jwt-secret-1234567890",
      FORGEJO_RUNNER_REGISTRATION_TOKEN: "runner-registration-token",
      ELIZA_CLOUD_FORGEJO_CLIENT_SECRET: "eliza-cloud-client-secret-123456",
      FORGEJO_STEWARD_TOKEN: "forgejo-steward-token-123456789",
      FORGEJO_WEBHOOK_SECRET: "forgejo-webhook-secret-123456789012345",
      MERGE_STEWARD_API_TOKEN: "merge-steward-api-token-123456",
      UNRELATED_SECRET: "do-not-print-this-secret-value",
    });
    const auditDir = await mkdtempInTestRoot("secret-management-audit-output-");
    const auditOutput = path.join(auditDir, "secret-management-audit.json");

    const result = await runSecretManagementHelper(envFile, {
      SECRET_EVIDENCE_EXTERNAL_SECRET_STORE: "true",
      SECRET_EVIDENCE_ROTATION_POLICY_DOCUMENTED: "true",
      SECRET_EVIDENCE_AUDIT_OUTPUT: auditOutput,
    });

    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const checkedAt = body.secrets.secretEvidence.checkedAt;
    assert.match(checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(JSON.parse(await readFile(auditOutput, "utf8")), {
      secretManagementAudit: {
        checkedAt,
        status: "verified",
        productionReady: true,
        issuedGroups: [
          "appIniSecretsIssued",
          "runnerTokenIssued",
          "oauthSecretsIssued",
          "webhookSecretsIssued",
        ],
        evidence: {
          externalSecretStore: true,
          rotationPolicyDocumented: true,
          appIniSecretsIssued: true,
          runnerTokenIssued: true,
          oauthSecretsIssued: true,
          webhookSecretsIssued: true,
          noPlaintextSecretsCommitted: true,
        },
        checks: [
          { name: "external_secret_store", status: "pass" },
          { name: "rotation_policy_documented", status: "pass" },
          { name: "app_ini_secrets_issued", status: "pass" },
          { name: "runner_token_issued", status: "pass" },
          { name: "oauth_secrets_issued", status: "pass" },
          { name: "webhook_secrets_issued", status: "pass" },
          { name: "private_reference_scan_passed", status: "pass" },
        ],
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      secrets: {
        secretEvidence: {
          source: auditOutput,
          sha256: await sha256File(auditOutput),
          checkedAt,
          status: "verified",
          productionReady: true,
          groupCount: 4,
          checkCount: 7,
        },
        externalSecretStore: true,
        rotationPolicyDocumented: true,
        appIniSecretsIssued: true,
        runnerTokenIssued: true,
        oauthSecretsIssued: true,
        webhookSecretsIssued: true,
        noPlaintextSecretsCommitted: true,
      },
    });
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /UNRELATED_SECRET|do-not-print-this-secret-value/,
    );
  });

  it("fails secret management evidence on malformed attestations without printing env secrets", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_SECRET_KEY: "keep-this-secret-key-private-1234567890", // gitleaks:allow - synthetic non-disclosure fixture
      UNRELATED_SECRET: "keep-this-private-too",
    });

    const result = await runSecretManagementHelper(envFile, {
      SECRET_EVIDENCE_EXTERNAL_SECRET_STORE: "probably",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SECRET_EVIDENCE_EXTERNAL_SECRET_STORE/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /UNRELATED_SECRET|keep-this-private-too|keep-this-secret-key-private/,
    );
  });

  it("generates storage evidence from action retention and operator reviews", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_ACTION_ARTIFACT_RETENTION_DAYS: "14",
      FORGEJO_ACTION_LOG_RETENTION_DAYS: "14",
    });
    const auditDir = await mkdtempInTestRoot("storage-audit-output-");
    const auditOutput = path.join(auditDir, "storage-retention-audit.json");

    const result = await runStorageEvidenceHelper(envFile, {
      STORAGE_EVIDENCE_SIZING_REVIEWED: "true",
      STORAGE_EVIDENCE_PACKAGE_RETENTION_CONFIGURED: "true",
      STORAGE_EVIDENCE_LFS_CAPACITY_REVIEWED: "true",
      STORAGE_EVIDENCE_AUDIT_OUTPUT: auditOutput,
    });

    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const checkedAt = body.storage.storageEvidence.checkedAt;
    assert.match(checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(JSON.parse(await readFile(auditOutput, "utf8")), {
      storageAudit: {
        checkedAt,
        status: "verified",
        productionReady: true,
        retention: {
          actionArtifactRetentionDays: 14,
          actionLogRetentionDays: 14,
        },
        evidence: {
          sizingReviewed: true,
          artifactRetentionConfigured: true,
          packageRetentionConfigured: true,
          lfsCapacityReviewed: true,
          logRetentionConfigured: true,
        },
        checks: [
          { name: "sizing_reviewed", status: "pass" },
          { name: "artifact_retention_configured", status: "pass" },
          { name: "package_retention_configured", status: "pass" },
          { name: "lfs_capacity_reviewed", status: "pass" },
          { name: "log_retention_configured", status: "pass" },
        ],
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      storage: {
        storageEvidence: {
          source: auditOutput,
          sha256: await sha256File(auditOutput),
          checkedAt,
          status: "verified",
          productionReady: true,
          checkCount: 5,
        },
        sizingReviewed: true,
        artifactRetentionConfigured: true,
        packageRetentionConfigured: true,
        lfsCapacityReviewed: true,
        logRetentionConfigured: true,
      },
    });
  });

  it("fails storage evidence on malformed attestations", async () => {
    const envFile = await writeTempEnv({
      FORGEJO_ACTION_ARTIFACT_RETENTION_DAYS: "14",
      FORGEJO_ACTION_LOG_RETENTION_DAYS: "14",
    });

    const result = await runStorageEvidenceHelper(envFile, {
      STORAGE_EVIDENCE_PACKAGE_RETENTION_CONFIGURED: "maybe",
    });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /STORAGE_EVIDENCE_PACKAGE_RETENTION_CONFIGURED/,
    );
    assert.equal(result.stdout, "");
  });

  it("keeps the disposable restore drill explicit and isolated", async () => {
    const script = await readFile(RESTORE_DRILL_PATH, "utf8");
    const help = await execFileAsync("bash", [
      RESTORE_DRILL_PATH.pathname,
      "--help",
    ]);

    assert.match(help.stdout, /RESTORE_DRILL_CONFIRM_EMPTY_TARGET=true/);
    assert.match(script, /RESTORE_DRILL_CONFIRM_EMPTY_TARGET/);
    assert.match(script, /restore-check\.sh/);
    assert.match(script, /postgres\/pg_dumpall\.sql/);
    assert.match(script, /docker run[\s\S]*--rm[\s\S]*127\.0\.0\.1::5432/);
    assert.match(script, /docker rm -f "\$CONTAINER_NAME"/);
    assert.match(script, /services\/merge-steward\/src\/migrate\.js/);
    assert.match(script, /steward_schema_migrations/);
    assert.match(script, /steward_worker_leases/);
  });

  it("keeps scheduled off-site backups dry-run-first and timer execution hardened", async () => {
    const dir = await mkdtempInTestRoot("scheduled-backup-dry-run-");
    const backupRoot = path.join(dir, "backups");
    const recipientsFile = path.join(dir, "recipients.txt");
    await writeFile(recipientsFile, "age1test-only-public-recipient\n", {
      mode: 0o600,
    });
    const envFile = await writeTempEnv({
      BACKUP_ROOT: backupRoot,
      BACKUP_OFFSITE_REMOTE: "r2:eliza-hub-backups/staging",
      BACKUP_AGE_RECIPIENTS_FILE: recipientsFile,
    });

    const result = await execFileAsync(
      "bash",
      [SCHEDULED_BACKUP_PATH.pathname, "--dry-run"],
      {
        env: {
          ...process.env,
          ENV_FILE: envFile,
        },
      },
    );
    const body = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    assert.equal(body.dryRun, true);
    assert.equal(body.backupRoot, backupRoot);
    await assert.rejects(access(backupRoot));

    const script = await readFile(SCHEDULED_BACKUP_PATH, "utf8");
    const service = await readFile(BACKUP_SYSTEMD_SERVICE_PATH, "utf8");
    const timer = await readFile(BACKUP_SYSTEMD_TIMER_PATH, "utf8");
    assert.match(
      script,
      /BACKUP_SCHEDULE_DRY_RUN="\$\{BACKUP_SCHEDULE_DRY_RUN:-true\}"/,
    );
    assert.match(script, /flock -n 9/);
    assert.match(
      script,
      /backup-offsite\.sh" --backup-dir "\$backup_dir" --apply/,
    );
    assert.match(service, /NoNewPrivileges=true/);
    assert.match(service, /ProtectSystem=strict/);
    assert.match(service, /ReadWritePaths=\/srv\/eliza-hub\/shared/);
    assert.doesNotMatch(service, /BACKUP_AGE_IDENTITY_FILE/);
    assert.match(timer, /Persistent=true/);
    assert.match(timer, /RandomizedDelaySec=20m/);
  });

  it("documents the private pilot repository bootstrap path", async () => {
    const readme = await readFile(STAGING_README_PATH, "utf8");
    const pilot = await readFile(PILOT_BOOTSTRAP_PATH, "utf8");

    assert.match(readme, /pilot-bootstrap\.md/);
    assert.match(
      readme,
      /mirror import, webhook, branch protection, runner smoke workflow, repo policy/,
    );
    assert.match(pilot, /# Private Pilot Bootstrap/);
    assert.match(pilot, /scripts\/pilot-bootstrap\.mjs/);
    assert.match(pilot, /PILOT_BOOTSTRAP_DRY_RUN=true/);
    assert.match(pilot, /PILOT_BOOTSTRAP_EVIDENCE_OUT/);
    assert.match(pilot, /\$\{FORGEJO_ROOT_URL\}swagger\.v1\.json/);
    assert.match(pilot, /\$\{FORGEJO_ROOT_URL\}api\/swagger/);
    assert.match(pilot, /Authorization: token/);
    assert.match(pilot, /Authorization: Bearer/);
    assert.match(pilot, /api\/v1\/repos\/migrate/);
    assert.match(pilot, /mirror: true/);
    assert.match(pilot, /mirror_interval: "10m"/);
    assert.match(pilot, /private: true/);
    assert.match(
      pilot,
      /api\/v1\/repos\/\$\{ELIZA_HUB_REPO_OWNER\}\/\$\{ELIZA_HUB_REPO_NAME\}\/hooks/,
    );
    assert.match(pilot, /type: "forgejo"/);
    assert.match(pilot, /content_type: "json"/);
    assert.match(pilot, /api\/webhooks\/forgejo/);
    assert.match(pilot, /pull_request_review/);
    assert.match(
      pilot,
      /api\/v1\/repos\/\$\{ELIZA_HUB_REPO_OWNER\}\/\$\{ELIZA_HUB_REPO_NAME\}\/branch_protections/,
    );
    assert.match(pilot, /enable_status_check: true/);
    assert.match(pilot, /status_check_contexts: \$status_check_contexts/);
    assert.match(pilot, /block_on_outdated_branch: true/);
    assert.match(pilot, /required_approvals: 1/);
    assert.match(pilot, /\.forgejo\/workflows\/runner-smoke\.yml/);
    assert.match(pilot, /RUNNER_SMOKE_REPO="\$ELIZA_HUB_REPO"/);
    assert.match(pilot, /runner-evidence\.sh/);
    assert.match(pilot, /api\/repo-policies/);
    assert.match(pilot, /queueMode: "batched"/);
    assert.match(pilot, /maxBatchSize: 4/);
    assert.match(pilot, /requireWorkReservation: true/);
    assert.match(pilot, /requireVerifiedAgentRunReceipt: true/);
    assert.match(pilot, /api\/repository-protection/);
    assert.match(pilot, /requireLive=true/);
    assert.match(pilot, /agent-identities sync/);
    assert.match(pilot, /api\/agent-identities\?status=active/);
    assert.match(pilot, /api\/project-board/);
    assert.match(pilot, /api\/work-dashboard/);
    assert.match(pilot, /api\/merge-queue/);
    assert.match(pilot, /merge-queue-rollout-drill\.sh/);
    assert.match(pilot, /MERGE_STEWARD_WORKER_ENABLED=false/);
    assert.match(pilot, /MERGE_STEWARD_INTEGRATION_EXECUTION_ENABLED=false/);
  });

  it("documents backup, post-deploy verification, and rollback triggers", async () => {
    const runbook = await readFile(RUNBOOK_PATH, "utf8");

    assert.match(runbook, /release-gate\.sh/);
    assert.match(runbook, /host-preflight\.sh/);
    assert.match(runbook, /backup\.sh/);
    assert.match(runbook, /backup-offsite\.sh/);
    assert.match(runbook, /restore-check\.sh/);
    assert.match(runbook, /restore-offsite-check\.sh/);
    assert.match(runbook, /run-scheduled-backup\.sh/);
    assert.match(runbook, /restore-drill\.sh/);
    assert.match(runbook, /backup-evidence\.mjs/);
    assert.match(runbook, /database-evidence\.mjs/);
    assert.match(runbook, /image-provenance-evidence\.mjs/);
    assert.match(runbook, /mail-evidence\.mjs/);
    assert.match(runbook, /eliza-hub-runner-production-evidence\.json/);
    assert.match(runbook, /merge-queue-live-drill-evidence\.mjs/);
    assert.match(runbook, /merge-queue-rollout-evidence\.mjs/);
    assert.match(runbook, /observability-evidence\.mjs/);
    assert.match(runbook, /production-evidence-assemble\.mjs/);
    assert.match(runbook, /production-evidence-inventory\.mjs/);
    assert.match(runbook, /--strict/);
    assert.match(runbook, /repository-evidence\.mjs/);
    assert.match(runbook, /runner-smoke-evidence\.mjs/);
    assert.match(runbook, /secret-management-evidence\.mjs/);
    assert.match(runbook, /security-review-evidence\.mjs/);
    assert.match(runbook, /sso-evidence\.mjs/);
    assert.match(runbook, /sso-smoke-evidence\.mjs/);
    assert.match(runbook, /steward-evidence\.mjs/);
    assert.match(runbook, /storage-evidence\.mjs/);
    assert.match(runbook, /FORGEJO_IMAGE_DIGEST/);
    assert.match(runbook, /## Image Promotion/);
    assert.match(runbook, /docker save "\$MERGE_STEWARD_IMAGE"/);
    assert.match(
      runbook,
      /docker load -i \/srv\/eliza-hub\/merge-steward-image\.tar/,
    );
    assert.match(runbook, /docker image inspect "\$MERGE_STEWARD_IMAGE"/);
    assert.match(runbook, /### First Boot/);
    assert.match(runbook, /### Rolling Release/);
    assert.match(runbook, /up -d --wait postgres forgejo/);
    assert.match(runbook, /up merge-steward-migrate/);
    assert.match(runbook, /up --no-deps merge-steward-migrate/);
    assert.match(runbook, /MAIL_EVIDENCE_INVITE_SMOKE_PASSED/);
    assert.match(runbook, /mail-smoke-audit\.json/);
    assert.match(runbook, /OBSERVABILITY_EVIDENCE_LOG_RETENTION_DAYS/);
    assert.match(runbook, /--require-live/);
    assert.match(runbook, /--steward-url "\$MERGE_STEWARD_URL"/);
    assert.match(runbook, /forkPolicyReviewed.*inferred/s);
    assert.match(runbook, /SECRET_EVIDENCE_EXTERNAL_SECRET_STORE/);
    assert.match(runbook, /secret-management-audit\.json/);
    assert.match(runbook, /SSO_EVIDENCE_SMOKE_TESTED/);
    assert.match(runbook, /--offsite-upload-receipt/);
    assert.match(runbook, /--offsite-restore-receipt/);
    assert.match(runbook, /--expected-receipt-sha256/);
    assert.doesNotMatch(runbook, /BACKUP_EVIDENCE_OFF_HOST/);
    assert.match(runbook, /DATABASE_EVIDENCE_MIGRATIONS_APPLIED/);
    assert.match(runbook, /MERGE_QUEUE_ROLLOUT_EVIDENCE_DRY_RUN_PASSED/);
    assert.match(runbook, /MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION/);
    assert.match(
      runbook,
      /MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED/,
    );
    assert.match(runbook, /SECURITY_REVIEW_EVIDENCE_APPROVED_BY/);
    assert.match(runbook, /STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED/);
    assert.match(
      runbook,
      /MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS/,
    );
    assert.match(runbook, /MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS/);
    assert.match(runbook, /MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE/);
    assert.match(runbook, /MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT/);
    assert.match(runbook, /MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY/);
    assert.match(runbook, /STORAGE_EVIDENCE_SIZING_REVIEWED/);
    assert.match(runbook, /storage-retention-audit\.json/);
    assert.match(runbook, /observability-audit\.json/);
    assert.match(runbook, /production-gate/);
    assert.match(runbook, /production-evidence\.example\.json/);
    assert.match(runbook, /RELEASE_GATE_MODE=production/);
    assert.match(runbook, /mode defaults `VALIDATE_PRODUCTION_GATE=true`/);
    assert.match(runbook, /`VALIDATE_PRODUCTION_INVENTORY=true`/);
    assert.match(runbook, /production-evidence-inventory\.mjs --strict/);
    assert.match(runbook, /preflightEvidence/);
    assert.match(runbook, /doctorEvidence/);
    assert.match(runbook, /re-reads the domain probe/);
    assert.match(runbook, /re-reads the backup audit/);
    assert.match(
      runbook,
      /security\s+review source artifacts referenced by the\s+private evidence file/,
    );
    assert.match(runbook, /stale or\s+future-dated/);
    assert.match(runbook, /post-deploy-check\.sh/);
    assert.match(runbook, /files\.postDeployEvidence/);
    assert.match(runbook, /eliza-hub-post-deploy-evidence\.json/);
    assert.match(runbook, /pilot-bootstrap\.mjs --apply/);
    assert.match(runbook, /eliza-hub-pilot-bootstrap-evidence\.json/);
    assert.match(runbook, /`githubMigration` block/);
    assert.match(runbook, /CI failure analysis/);
    assert.match(runbook, /bootstrap-forgejo-identity\.sh/);
    assert.match(runbook, /check-actions-runner\.sh/);
    assert.match(runbook, /Rollback Triggers/);
    assert.match(runbook, /Rollback Procedure/);
    assert.match(runbook, /empty\s+replacement staging host/);
  });

  it("keeps the release checklist focused on evidence needed for rollback", async () => {
    const checklist = await readFile(CHECKLIST_PATH, "utf8");

    assert.match(checklist, /Previous Forgejo image/);
    assert.match(checklist, /Previous Merge Steward image/);
    assert.match(checklist, /Previous runner image/);
    assert.match(checklist, /Backup bundle/);
    assert.match(checklist, /domain\.probeEvidence/);
    assert.match(checklist, /loaded onto the host successfully/);
    assert.match(checklist, /docker image inspect/);
    assert.match(
      checklist,
      /First-boot or rolling-release path selected explicitly/,
    );
    assert.match(
      checklist,
      /postgres` and `forgejo` were started and healthy before/,
    );
    assert.match(checklist, /merge-steward-migrate --no-deps/);
    assert.match(checklist, /restore-drill\.sh/);
    assert.match(checklist, /host-preflight\.sh/);
    assert.match(checklist, /backup-evidence\.mjs/);
    assert.match(checklist, /database-evidence\.mjs/);
    assert.match(checklist, /image-provenance-evidence\.mjs/);
    assert.match(checklist, /mail-evidence\.mjs/);
    assert.match(checklist, /merge-queue-rollout-evidence\.mjs/);
    assert.match(checklist, /observability-evidence\.mjs/);
    assert.match(checklist, /production-evidence-assemble\.mjs/);
    assert.match(checklist, /production-evidence-inventory\.mjs --strict/);
    assert.match(checklist, /repository-evidence\.mjs/);
    assert.match(checklist, /pilot-bootstrap\.mjs --apply/);
    assert.match(checklist, /secret-management-evidence\.mjs/);
    assert.match(checklist, /security-review-evidence\.mjs/);
    assert.match(checklist, /sso-evidence\.mjs/);
    assert.match(checklist, /steward-evidence\.mjs/);
    assert.match(checklist, /storage-evidence\.mjs/);
    assert.match(checklist, /Release commit/);
    assert.match(checklist, /Eliza Cloud OIDC/);
    assert.match(checklist, /strict\s+work-reservation enforcement/);
    assert.match(checklist, /queue\s+simulation/);
    assert.match(checklist, /eliza-hub-post-deploy-evidence\.json/);
    assert.match(checklist, /RELEASE_GATE_MODE=production/);
  });

  it("keeps a non-secret production evidence template in the release folder", async () => {
    const template = JSON.parse(
      await readFile(PRODUCTION_EVIDENCE_TEMPLATE_PATH, "utf8"),
    );

    assert.equal(
      template.$schema,
      "../../../services/merge-steward/production-evidence.schema.json",
    );
    assert.equal(template.domain.forgejoDomain, "git.example.invalid");
    assert.equal(template.domain.tlsVerified, false);
    assert.equal(template.backups.includes.length, 0);
    assert.equal(template.database.databaseEvidence, null);
    assert.equal(template.repository.liveProtectionEvidence, null);
    assert.equal(template.githubMigration.pilotBootstrapEvidence, null);
    assert.equal(template.githubMigration.pilotBootstrapPassed, false);
    assert.equal(template.secrets.secretEvidence, null);
    assert.equal(template.mail.mailEvidence, null);
    assert.equal(template.storage.storageEvidence, null);
    assert.equal(template.observability.observabilityEvidence, null);
    assert.equal(template.sso.smokeEvidence, null);
    assert.equal(template.sso.bootstrapEvidence, null);
    assert.equal(template.runner.smokeEvidence, null);
    assert.equal(template.runner.auditEvidence, null);
    assert.equal(template.steward.preflight.ok, false);
    assert.equal(template.steward.preflightEvidence, null);
    assert.equal(template.steward.doctorEvidence, null);
    assert.equal(template.steward.strictWorkReservationsEnforced, false);
    assert.equal(template.steward.strictWorkItemsEnforced, false);
    assert.equal(template.steward.strictAgentBranchNamespacesEnforced, false);
    assert.equal(template.steward.verifiedAgentRunReceiptsEnforced, false);
    assert.equal(template.steward.agentIdentityRegistryEnforced, false);
    assert.equal(template.mergeQueueRollout.dryRunPassed, false);
    assert.equal(
      template.mergeQueueRollout.strictWorkReservationsEnforced,
      false,
    );
    assert.equal(template.mergeQueueRollout.strictWorkItemsEnforced, false);
    assert.equal(
      template.mergeQueueRollout.strictAgentBranchNamespacesEnforced,
      false,
    );
    assert.equal(
      template.mergeQueueRollout.verifiedAgentRunReceiptsEnforced,
      false,
    );
    assert.equal(
      template.mergeQueueRollout.agentIdentityRegistryEnforced,
      false,
    );
    assert.equal(
      template.mergeQueueRollout.stackDependencyOrderEnforced,
      false,
    );
    assert.equal(template.mergeQueueRollout.dryRunEvidence, null);
    assert.equal(template.mergeQueueRollout.liveDrillEvidence, null);
    assert.equal(template.securityReview.securityEvidence, null);
    assert.equal(template.securityReview.approvedBy, null);
  });
});

async function runBackupEvidenceHelper(envFile, backupDir, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [BACKUP_EVIDENCE_HELPER_PATH.pathname, "--backup-dir", backupDir],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runDatabaseEvidenceHelper(
  envFile,
  { migrationOutput, restoreOutput, extraEnv = {} } = {},
) {
  const args = [];

  if (migrationOutput) {
    args.push("--migration-output", migrationOutput);
  }

  if (restoreOutput) {
    args.push("--restore-drill-output", restoreOutput);
  }

  try {
    const result = await execFileAsync(
      process.execPath,
      [DATABASE_EVIDENCE_HELPER_PATH.pathname, ...args],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runImageProvenanceHelper(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [IMAGE_PROVENANCE_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runMailEvidenceHelper(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [MAIL_EVIDENCE_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runMergeQueueRolloutEvidenceHelper(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [MERGE_QUEUE_ROLLOUT_EVIDENCE_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runMergeQueueLiveDrillEvidenceHelper(extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [MERGE_QUEUE_LIVE_DRILL_EVIDENCE_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function mergeQueueRolloutDrillEvidence(overrides = {}) {
  return {
    mergeQueueRolloutDrill: {
      dryRunPassed: true,
      stagedLiveDrillPassed: false,
      workerLeaseVerified: false,
      rollbackDrillPassed: false,
      humanApprovalRecorded: false,
      checkedAt: "2026-07-06T00:00:00.000Z",
      safeMode: true,
      stewardUrl: "https://steward.eliza.test",
      smokeRepo: "elizaos/eliza",
      smokeAgent: "eliza-smoke-agent",
      smokePullRequestId: 9001,
      checks: [
        { name: "Merge Steward /ready is ok", ok: true },
        { name: "Merge Steward deployment doctor passes", ok: true },
        { name: "synthetic queue item creates an integration plan", ok: true },
        {
          name: "manual live execution stays blocked without confirmation",
          ok: true,
        },
        {
          name: "worker run-once stays blocked without confirmation",
          ok: true,
        },
      ],
      ...overrides,
    },
  };
}

function mergeQueueLiveRunOnceResult() {
  return {
    claimed: true,
    item: { id: "elizaos/eliza#9001", queueState: "merged" },
    items: [{ id: "elizaos/eliza#9001", queueState: "merged" }],
    run: {
      id: "run:elizaos/eliza#9001:attempt:1",
      queueItemId: "elizaos/eliza#9001",
      status: "succeeded",
    },
    runs: [
      {
        id: "run:elizaos/eliza#9001:attempt:1",
        queueItemId: "elizaos/eliza#9001",
        status: "succeeded",
      },
    ],
    execution: {
      executions: [
        {
          repo: "elizaos/eliza",
          pullRequestId: 9001,
          status: "executed",
          actions: [
            { type: "ensure_integration_branch", status: "executed" },
            { type: "merge_pr_head_into_integration", status: "executed" },
            { type: "wait_for_checks", status: "executed" },
            { type: "merge_original_pull_request", status: "executed" },
          ],
        },
      ],
    },
  };
}

function mergeQueueStackDependencyReleaseReadiness() {
  return {
    releaseReadiness: {
      computedAt: "2026-07-06T00:25:00.000Z",
      filters: {
        repo: "elizaos/eliza",
        targetBranch: null,
      },
      status: "blocked",
      checks: [
        {
          name: "stack_dependency_order",
          status: "fail",
          details: {
            stackBlocked: 1,
            blockedItemIds: ["elizaos/eliza#9002"],
            nextMergeItemIds: ["elizaos/eliza#9001"],
          },
          requiredActions: ["merge_stack_parents_first"],
        },
      ],
      snapshots: {
        stackBlockedItemIds: ["elizaos/eliza#9002"],
        stackNextMergeItemIds: ["elizaos/eliza#9001"],
      },
      requiredActions: ["merge_stack_parents_first"],
    },
  };
}

function mergeQueueStackDependencyOrderProof() {
  return {
    source: "/api/release-readiness",
    repo: "elizaos/eliza",
    targetBranch: null,
    checkedAt: "2026-07-06T00:25:00.000Z",
    status: "blocked",
    stackCheckStatus: "fail",
    stackBlocked: 1,
    blockedItemIds: ["elizaos/eliza#9002"],
    nextMergeItemIds: ["elizaos/eliza#9001"],
    requiredActions: ["merge_stack_parents_first"],
    valid: true,
  };
}

function mergeQueueRolloutLiveDrillEvidence(overrides = {}) {
  return {
    mergeQueueRolloutLiveDrill: {
      stagedLiveDrillPassed: true,
      workerLeaseVerified: true,
      strictWorkReservationsEnforced: true,
      strictWorkItemsEnforced: true,
      strictAgentBranchNamespacesEnforced: true,
      verifiedAgentRunReceiptsEnforced: true,
      agentIdentityRegistryEnforced: true,
      stackDependencyOrderEnforced: true,
      stackDependencyOrderProof: mergeQueueStackDependencyOrderProof(),
      rollbackDrillPassed: true,
      humanApprovalRecorded: true,
      checkedAt: "2026-07-06T00:30:00.000Z",
      runId: "run:elizaos/eliza#9001:attempt:1",
      runOnce: {
        claimed: true,
        item: { id: "elizaos/eliza#9001", queueState: "merged" },
        run: { id: "run:elizaos/eliza#9001:attempt:1", status: "succeeded" },
        execution: {
          executions: [
            {
              repo: "elizaos/eliza",
              pullRequestId: 9001,
              status: "executed",
              actions: [
                { type: "ensure_integration_branch", status: "executed" },
                { type: "merge_pr_head_into_integration", status: "executed" },
                { type: "wait_for_checks", status: "executed" },
                { type: "merge_original_pull_request", status: "executed" },
              ],
            },
          ],
        },
      },
      events: [
        { type: "IntegrationActionStarted" },
        { type: "IntegrationActionFinished" },
        { type: "QueueItemMerged" },
      ],
      readiness: {
        ok: true,
        configuration: {
          requireWorkReservationForAgentPrs: true,
          requireWorkItemForAgentPrs: true,
          requireAgentBranchNamespaceForAgentPrs: true,
          requireVerifiedAgentRunReceiptForAgentPrs: true,
          requireAgentIdentityRegistryForAgentPrs: true,
          knownAgentIdCount: 1,
        },
      },
      ...overrides,
    },
  };
}

async function runObservabilityEvidenceHelper(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [OBSERVABILITY_EVIDENCE_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runProductionEvidenceAssembler(args) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [PRODUCTION_EVIDENCE_ASSEMBLER_PATH.pathname, ...args],
      {
        env: {
          PATH: process.env.PATH,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runProductionEvidenceInventory(args) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [PRODUCTION_EVIDENCE_INVENTORY_PATH.pathname, ...args],
      {
        env: {
          PATH: process.env.PATH,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function writeInventoryFragments(artifactRoot) {
  const fragments = [
    ["domain-evidence.json", "domain"],
    ["sso-evidence.json", "sso"],
    ["backup-evidence.json", "backups"],
    ["database-evidence.json", "database"],
    ["image-provenance.json", "imageProvenance"],
    ["eliza-hub-runner-production-evidence.json", "runner"],
    ["repository-evidence.json", "repository"],
    ["eliza-hub-pilot-bootstrap-evidence.json", "githubMigration"],
    ["secret-management.json", "secrets"],
    ["mail-evidence.json", "mail"],
    ["storage-evidence.json", "storage"],
    ["observability-evidence.json", "observability"],
    ["steward-evidence.json", "steward"],
    ["merge-queue-rollout-evidence.json", "mergeQueueRollout"],
    ["security-review-evidence.json", "securityReview"],
    ["eliza-hub-deploy-evidence.json", "deployment"],
  ];

  await Promise.all(
    fragments.map(([filename, key]) =>
      writeFile(
        path.join(artifactRoot, filename),
        `${JSON.stringify({ [key]: { inventoryPresent: true } })}\n`,
      ),
    ),
  );
}

async function runRepositoryEvidenceHelper(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [REPOSITORY_EVIDENCE_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runSecretManagementHelper(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [SECRET_MANAGEMENT_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runSecurityReviewEvidenceHelper(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [SECURITY_REVIEW_EVIDENCE_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runSsoEvidenceHelper(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [SSO_EVIDENCE_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runStewardEvidenceHelper(
  envFile,
  { preflight, doctor, extraEnv = {} } = {},
) {
  const args = [];

  if (preflight) {
    args.push("--preflight-json", preflight);
  }

  if (doctor) {
    args.push("--doctor-json", doctor);
  }

  try {
    const result = await execFileAsync(
      process.execPath,
      [STEWARD_EVIDENCE_HELPER_PATH.pathname, ...args],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function runStorageEvidenceHelper(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [STORAGE_EVIDENCE_HELPER_PATH.pathname],
      {
        env: {
          PATH: process.env.PATH,
          ENV_FILE: envFile,
          ...extraEnv,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function withMockStewardServer(handler, callback) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, `http://${request.headers.host}`);
    const body = rawBody ? JSON.parse(rawBody) : null;
    const entry = {
      method: request.method,
      url,
      headers: request.headers,
      body,
    };
    requests.push(entry);

    try {
      const result = await handler({ request, url, body, requests });
      response.writeHead(result.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "mock_server_error",
        }),
      );
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    return await callback({ baseUrl, requests });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function jsonResponse(status, body) {
  return { status, body };
}

async function writeTempEnv(values) {
  const dir = await mkdtempInTestRoot("image-provenance-env-");
  const envFile = path.join(dir, ".env");
  await writeFile(
    envFile,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8",
  );
  return envFile;
}

function ssoEnv(overrides = {}) {
  return {
    FORGEJO_OIDC_AUTH_NAME: "elizacloud",
    FORGEJO_OIDC_SCOPES: "openid email profile groups",
    FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION: "true",
    FORGEJO_OAUTH2_REGISTER_EMAIL_CONFIRM: "false",
    FORGEJO_OAUTH2_USERNAME: "nickname",
    FORGEJO_OAUTH2_ACCOUNT_LINKING: "login",
    FORGEJO_OIDC_REQUIRED_CLAIM_NAME: "tenant",
    FORGEJO_OIDC_REQUIRED_CLAIM_VALUE: "eliza",
    FORGEJO_OIDC_GROUP_CLAIM_NAME: "groups",
    FORGEJO_OIDC_ADMIN_GROUP: "eliza-admins",
    FORGEJO_OIDC_RESTRICTED_GROUP: "eliza-agents",
    ELIZA_CLOUD_OIDC_ISSUER_URL: "https://cloud.eliza.test",
    ELIZA_CLOUD_OIDC_DISCOVERY_URL:
      "https://cloud.eliza.test/.well-known/openid-configuration",
    ELIZA_CLOUD_FORGEJO_CLIENT_ID: "forgejo-staging-client",
    ELIZA_CLOUD_FORGEJO_CLIENT_SECRET: "oidc-client-secret-do-not-print-123456",
    ...overrides,
  };
}

function identityBootstrapEvidence(overrides = {}) {
  const base = {
    schema: "https://eliza.hub/schemas/identity-bootstrap-evidence.v1",
    finishedAt: "2026-07-06T00:04:00.000Z",
    status: "passed",
    options: {
      applyBootstrap: false,
      checkDiscovery: true,
      checkStewardToken: true,
    },
    targets: {
      forgejoLocalUrl: "https://git.eliza.test/",
    },
    oidc: {
      authName: "elizacloud",
      issuerUrl: "https://cloud.eliza.test",
    },
    summary: {
      total: 8,
      passed: 8,
      failed: 0,
      warnings: 0,
    },
    checks: [
      { name: "private env validates identity inputs", status: "pass" },
      { name: "compose config renders", status: "pass" },
      { name: "forgejo container is running and healthy", status: "pass" },
      { name: "forgejo CLI responds", status: "pass" },
      { name: "Eliza Cloud discovery document is valid", status: "pass" },
      { name: "local recovery admin exists", status: "pass" },
      {
        name: "Eliza Cloud OIDC auth source config matches env",
        status: "pass",
      },
      { name: "steward token authenticates as steward user", status: "pass" },
    ],
  };

  return {
    ...base,
    ...overrides,
    options: { ...base.options, ...overrides.options },
    targets: { ...base.targets, ...overrides.targets },
    oidc: { ...base.oidc, ...overrides.oidc },
    summary: { ...base.summary, ...overrides.summary },
    checks: overrides.checks ?? base.checks,
  };
}

async function writeTempJson(value) {
  const dir = await mkdtempInTestRoot("production-evidence-fragment-");
  const file = path.join(dir, "fragment.json");
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

async function writeTempText(prefix, filename, body) {
  const dir = await mkdtempInTestRoot(prefix);
  const file = path.join(dir, filename);
  await writeFile(file, body, "utf8");
  return file;
}

async function runReleaseGateSmoke(extraEnv = {}) {
  const dir = await mkdtempInTestRoot("release-gate-smoke-");
  const envFile = path.join(dir, ".env");
  const binDir = path.join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    envFile,
    `${Object.entries(releaseGateSmokeEnv())
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8",
  );
  await writeExecutable(path.join(binDir, "docker"), releaseGateDockerStub());
  await writeExecutable(path.join(binDir, "git"), releaseGateGitStub());
  await writeExecutable(
    path.join(binDir, "shellcheck"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  await writeExecutable(
    path.join(binDir, "tofu"),
    "#!/usr/bin/env bash\nexit 0\n",
  );

  try {
    const result = await execFileAsync("bash", [RELEASE_GATE_PATH.pathname], {
      env: {
        HOME: process.env.HOME,
        PATH: `${binDir}:${process.env.PATH}`,
        ENV_FILE: envFile,
        ELIZA_TMP_ROOT: path.join(dir, "tmp"),
        ELIZA_ARTIFACT_ROOT: path.join(dir, "artifacts"),
        RELEASE_GATE_STDOUT: path.join(dir, "release-gate.out"),
        RELEASE_GATE_STDERR: path.join(dir, "release-gate.err"),
        RUN_TESTS: "false",
        VALIDATE_RUNNER: "false",
        ...extraEnv,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function writeExecutable(file, body) {
  await writeFile(file, body, "utf8");
  await chmod(file, 0o755);
}

function releaseGateDockerStub() {
  return `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == "config" ]]; then
    cat <<'YAML'
services:
  merge-steward:
    environment:
      MERGE_STEWARD_OIDC_REQUIRED_ROLES: steward,maintainer
      MERGE_STEWARD_OIDC_REQUIRED_GROUPS: eliza-team
      MERGE_STEWARD_OIDC_ADMIN_ROLES: steward-admin
      MERGE_STEWARD_OIDC_ADMIN_GROUPS: eliza-admins
YAML
    exit 0
  fi
done
printf 'unexpected docker invocation: %s\\n' "$*" >&2
exit 2
`;
}

function releaseGateGitStub() {
  return `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-C" && "\${3:-}" == "status" && "\${4:-}" == "--porcelain" ]]; then
  exit 0
fi
printf 'unexpected git invocation: %s\\n' "$*" >&2
exit 2
`;
}

function releaseGateSmokeEnv() {
  return {
    COMPOSE_PROJECT_NAME: "eliza-forgejo-staging",
    POSTGRES_IMAGE: "postgres:16-alpine",
    FORGEJO_IMAGE: "codeberg.org/forgejo/forgejo:15",
    MERGE_STEWARD_IMAGE: "registry.internal/eliza/merge-steward:20260706",
    FORGEJO_DOMAIN: "git.staging.eliza.internal",
    FORGEJO_ROOT_URL: "https://git.staging.eliza.internal/",
    FORGEJO_SSH_DOMAIN: "git.staging.eliza.internal",
    FORGEJO_HTTP_BIND: "127.0.0.1",
    FORGEJO_SSH_BIND: "127.0.0.1",
    FORGEJO_RECOVERY_ADMIN_USERNAME: "eliza-recovery-admin",
    FORGEJO_RECOVERY_ADMIN_EMAIL: "eliza-recovery-admin@staging.eliza.internal",
    FORGEJO_RECOVERY_ADMIN_PASSWORD: "recovery-admin-password-1234567890",
    FORGEJO_DB_PASSWORD: "db-password-12345678901234567890",
    FORGEJO_SECRET_KEY: "forgejo-key-123456789012345678901234", // gitleaks:allow - synthetic release fixture
    FORGEJO_INTERNAL_TOKEN: "forgejo-token-1234567890123456789012",
    FORGEJO_OAUTH2_JWT_SECRET: "forgejo-jwt-123456789012345678901234", // gitleaks:allow - synthetic release fixture
    FORGEJO_ACTIONS_ENABLED: "true",
    FORGEJO_ACTIONS_URL: "https://git.staging.eliza.internal/actions",
    FORGEJO_ACTION_LOG_RETENTION_DAYS: "14",
    FORGEJO_ACTION_ARTIFACT_RETENTION_DAYS: "14",
    FORGEJO_MAIL_ENABLED: "false",
    FORGEJO_REGISTER_EMAIL_CONFIRM: "false",
    FORGEJO_OAUTH2_REGISTER_EMAIL_CONFIRM: "false",
    FORGEJO_THEMES: "forgejo-auto,forgejo-light,forgejo-dark,eliza,eliza-light",
    FORGEJO_DEFAULT_THEME: "eliza",
    FORGEJO_OIDC_AUTH_NAME: "elizacloud",
    FORGEJO_OIDC_SCOPES: "openid email profile groups",
    FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION: "true",
    FORGEJO_OAUTH2_USERNAME: "nickname",
    FORGEJO_OAUTH2_ACCOUNT_LINKING: "login",
    FORGEJO_OIDC_REQUIRED_CLAIM_NAME: "tenant",
    FORGEJO_OIDC_REQUIRED_CLAIM_VALUE: "eliza",
    FORGEJO_OIDC_GROUP_CLAIM_NAME: "groups",
    FORGEJO_OIDC_ADMIN_GROUP: "eliza-admins",
    FORGEJO_OIDC_RESTRICTED_GROUP: "eliza-agents",
    ELIZA_CLOUD_OIDC_ISSUER_URL: "https://cloud.staging.eliza.internal",
    ELIZA_CLOUD_OIDC_DISCOVERY_URL:
      "https://cloud.staging.eliza.internal/.well-known/openid-configuration",
    ELIZA_CLOUD_FORGEJO_CLIENT_ID: "eliza-hub-forgejo",
    ELIZA_CLOUD_FORGEJO_CLIENT_SECRET: "forgejo-oidc-client-12345678901234",
    MERGE_STEWARD_DEPLOYMENT_MODE: "production",
    MERGE_STEWARD_DATABASE_URL:
      "postgres://forgejo:dbpassword1234567890@postgres:5432/forgejo",
    FORGEJO_STEWARD_USERNAME: "eliza-merge-steward",
    FORGEJO_STEWARD_EMAIL: "eliza-merge-steward@staging.eliza.internal",
    FORGEJO_STEWARD_TOKEN: "forgejo-steward-token-1234567890",
    FORGEJO_WEBHOOK_SECRET: "forgejo-webhook-secret-123456789012",
    MERGE_STEWARD_API_AUTH_REQUIRED: "true",
    MERGE_STEWARD_API_TOKEN: "merge-steward-api-token-123456",
    MERGE_STEWARD_OIDC_ENABLED: "true",
    ELIZA_CLOUD_STEWARD_AUDIENCE: "eliza-merge-steward",
    MERGE_STEWARD_OIDC_REQUIRED_ROLES: "steward,maintainer",
    MERGE_STEWARD_OIDC_REQUIRED_GROUPS: "eliza-team",
    MERGE_STEWARD_OIDC_ADMIN_ROLES: "steward-admin",
    MERGE_STEWARD_OIDC_ADMIN_GROUPS: "eliza-admins",
    MERGE_STEWARD_METRICS_ENABLED: "true",
    MERGE_STEWARD_METRICS_AUTH_REQUIRED: "true",
    MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
    MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
    MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
    FORGEJO_FEEDBACK_ENABLED: "false",
    MERGE_STEWARD_INTEGRATION_ENABLED: "false",
    MERGE_STEWARD_WORKER_ENABLED: "false",
  };
}

async function writeTempBackupBundle({ checksumDrift = false } = {}) {
  const dir = await mkdtempInTestRoot("eliza-backup-");
  const files = {
    "MANIFEST.txt": [
      "name=eliza-forgejo-staging-20260706T120000Z",
      "created_utc=20260706T120000Z",
      "secrets_included=false",
      "restore_target=empty-staging-host-only",
      "",
    ].join("\n"),
    "env.keys": "FORGEJO_DOMAIN\nFORGEJO_ROOT_URL\n",
    "host/compose.yml":
      "services:\n  forgejo:\n    image: codeberg.org/forgejo/forgejo:15\n",
    "host/.env.example": "FORGEJO_DOMAIN=git.example.invalid\n",
    "postgres/pg_dumpall.sql":
      "-- PostgreSQL database cluster dump\nCREATE DATABASE forgejo;\n",
    "archives/forgejo-data.tar.gz": "fake-forgejo-data-archive\n",
    "archives/forgejo-config.tar.gz": "fake-forgejo-config-archive\n",
    "archives/eliza-custom.tar.gz": "fake-eliza-custom-archive\n",
    "archives/eliza-templates.tar.gz": "fake-eliza-templates-archive\n",
  };

  for (const [relativePath, body] of Object.entries(files)) {
    const file = path.join(dir, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
  }

  const checksumLines = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, body]) => {
      const checksumBody =
        checksumDrift && relativePath === "host/compose.yml"
          ? "drifted-compose\n"
          : body;
      return `${sha256Hex(checksumBody)}  ${relativePath}`;
    });

  await writeFile(
    path.join(dir, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
    "utf8",
  );
  return dir;
}

async function writeTempOffsiteBackupReceipts(backupDir) {
  const dir = await mkdtempInTestRoot("offsite-backup-receipts-");
  const uploadPath = path.join(dir, "upload-receipt.json");
  const restorePath = path.join(dir, "restore-receipt.json");
  const backupName = path.basename(backupDir);
  const remoteArchive = `r2:eliza-hub-backups/staging/${backupName}/${backupName}.tar.gz.age`;
  const remoteReceipt = `r2:eliza-hub-backups/staging/${backupName}/receipt.json`;
  const ciphertextSha256 = "35".repeat(32);
  const ciphertextBytes = 123456;
  const uploadReceipt = {
    schema: "https://eliza.hub/schemas/offsite-backup-receipt.v1",
    status: "verified",
    checkedAt: "2026-07-06T12:15:00.000Z",
    backupName,
    backupCreatedAt: "2026-07-06T12:00:00.000Z",
    sourceManifestSha256: await sha256File(
      path.join(backupDir, "MANIFEST.txt"),
    ),
    sourceChecksumsSha256: await sha256File(path.join(backupDir, "SHA256SUMS")),
    encryption: {
      format: "age",
      recipientsFileSha256: "37".repeat(32),
    },
    ciphertext: {
      sha256: ciphertextSha256,
      bytes: ciphertextBytes,
    },
    remoteArchive,
    remoteReceipt,
    uploadVerified: true,
    verificationMethod: "download_sha256",
  };
  await writeFile(uploadPath, `${JSON.stringify(uploadReceipt, null, 2)}\n`, {
    mode: 0o600,
  });

  const restoreReceipt = {
    schema: "https://eliza.hub/schemas/offsite-restore-receipt.v1",
    status: "verified",
    checkedAt: "2026-07-06T12:30:00.000Z",
    backupName,
    remoteReceipt,
    remoteArchive,
    uploadReceiptSha256: await sha256File(uploadPath),
    ciphertext: {
      sha256: ciphertextSha256,
      bytes: ciphertextBytes,
    },
    downloadVerified: true,
    decryptionVerified: true,
    archivePathsVerified: true,
    structuralRestoreCheckPassed: true,
  };
  await writeFile(restorePath, `${JSON.stringify(restoreReceipt, null, 2)}\n`, {
    mode: 0o600,
  });

  return { uploadPath, restorePath };
}

function exampleOffsiteReceiptSummaries({
  backupCreatedAt,
  uploadCheckedAt,
  restoreCheckedAt,
}) {
  const backupName = "eliza-forgejo-production-20260706T120000Z";
  const remoteArchive = `r2:eliza-hub-backups/production/${backupName}/${backupName}.tar.gz.age`;
  const remoteReceipt = `r2:eliza-hub-backups/production/${backupName}/receipt.json`;
  const uploadSha256 = "34".repeat(32);
  const ciphertextSha256 = "35".repeat(32);
  const ciphertextBytes = 1048576;

  return {
    offsiteUploadReceipt: {
      source:
        "/var/lib/eliza-hub-artifacts/eliza-hub-backup-offsite-receipt.json",
      sha256: uploadSha256,
      checkedAt: uploadCheckedAt,
      status: "verified",
      backupName,
      backupCreatedAt,
      remoteArchive,
      remoteReceipt,
      ciphertextSha256,
      ciphertextBytes,
      encryptionFormat: "age",
      recipientsFileSha256: "37".repeat(32),
      verificationMethod: "download_sha256",
      verified: true,
    },
    offsiteRestoreReceipt: {
      source:
        "/var/lib/eliza-hub-artifacts/eliza-hub-backup-offsite-restore-receipt.json",
      sha256: "36".repeat(32),
      checkedAt: restoreCheckedAt,
      status: "verified",
      remoteArchive,
      remoteReceipt,
      uploadReceiptSha256: uploadSha256,
      ciphertextSha256,
      ciphertextBytes,
      downloadVerified: true,
      decryptionVerified: true,
      archivePathsVerified: true,
      structuralRestoreCheckPassed: true,
      verified: true,
    },
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(file) {
  return sha256Hex(await readFile(file));
}

function digest(char) {
  return `sha256:${char.repeat(64)}`;
}
