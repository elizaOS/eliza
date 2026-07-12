import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

const execFileAsync = promisify(execFile);
const VALIDATOR_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/validate-env.sh",
  import.meta.url,
);
const EXAMPLE_ENV_PATH = new URL(
  "../../../deployment/hetzner-staging/.env.example",
  import.meta.url,
);

describe("staging env validator", () => {
  it("accepts a hardened full staging env", async () => {
    const envFile = await writeTempEnv(hardenedEnv());

    const result = await runValidator(envFile, {
      VALIDATE_STEWARD: "true",
      VALIDATE_RUNNER: "true",
      VALIDATE_RUNNER_REGISTRATION: "true",
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /env validation passed/);
  });

  it("rejects the committed example env placeholders", async () => {
    const result = await runValidator(EXAMPLE_ENV_PATH.pathname, {
      VALIDATE_STEWARD: "true",
      VALIDATE_RUNNER: "true",
      VALIDATE_RUNNER_REGISTRATION: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FORGEJO_IMAGE/);
    assert.match(result.stderr, /FORGEJO_DB_PASSWORD/);
    assert.match(result.stderr, /failed with/);
  });

  it("rejects public binds unless explicitly allowed", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_HTTP_BIND: "0.0.0.0",
    });

    const blocked = await runValidator(envFile, { VALIDATE_STEWARD: "true" });
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /FORGEJO_HTTP_BIND/);

    const allowed = await runValidator(envFile, {
      VALIDATE_STEWARD: "true",
      ALLOW_PUBLIC_BINDS: "true",
    });
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(allowed.stderr, /ALLOW_PUBLIC_BINDS=true/);
  });

  it("rejects host executor labels for the staging runner", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_RUNNER_LABELS: "ubuntu-latest:host,self-hosted:host",
    });

    const result = await runValidator(envFile, {
      VALIDATE_STEWARD: "false",
      VALIDATE_RUNNER: "true",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FORGEJO_RUNNER_LABELS/);
  });

  it("rejects enabled mail until SMTP delivery settings are complete", async () => {
    const smtpPassword = "smtp-password-1234567890";
    const incompleteEnv = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_MAIL_ENABLED: "true",
      FORGEJO_SMTP_PASSWORD: smtpPassword,
    });

    const blocked = await runValidator(incompleteEnv, {
      VALIDATE_STEWARD: "true",
    });
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /FORGEJO_SMTP_ADDR/);
    assert.match(blocked.stderr, /FORGEJO_MAIL_FROM/);
    assert.doesNotMatch(blocked.stderr, new RegExp(smtpPassword));

    const completeEnv = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_MAIL_ENABLED: "true",
      FORGEJO_SMTP_ADDR: "smtp.git.eliza.test",
      FORGEJO_SMTP_PORT: "587",
      FORGEJO_MAIL_FROM: "noreply@git.eliza.test",
      FORGEJO_SMTP_USER: "eliza-hub-smtp",
      FORGEJO_SMTP_PASSWORD: smtpPassword,
    });

    const allowed = await runValidator(completeEnv, {
      VALIDATE_STEWARD: "true",
    });
    assert.equal(allowed.code, 0, allowed.stderr);
  });

  it("rejects email confirmation when mail is disabled", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_MAIL_ENABLED: "false",
      FORGEJO_REGISTER_EMAIL_CONFIRM: "true",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FORGEJO_REGISTER_EMAIL_CONFIRM/);
  });

  it("requires OAuth auto-registration and guarded account linking", async () => {
    const disabledRegistration = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION: "false",
    });
    const unsafeLinking = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_OAUTH2_ACCOUNT_LINKING: "auto",
    });

    const blockedRegistration = await runValidator(disabledRegistration, {
      VALIDATE_STEWARD: "true",
    });
    const blockedLinking = await runValidator(unsafeLinking, {
      VALIDATE_STEWARD: "true",
    });

    assert.notEqual(blockedRegistration.code, 0);
    assert.match(
      blockedRegistration.stderr,
      /FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION/,
    );
    assert.notEqual(blockedLinking.code, 0);
    assert.match(blockedLinking.stderr, /FORGEJO_OAUTH2_ACCOUNT_LINKING/);
  });

  it("requires explicit Eliza Cloud tenant and steward OIDC gates", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_OIDC_REQUIRED_CLAIM_NAME: "",
      MERGE_STEWARD_OIDC_REQUIRED_GROUPS: "",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FORGEJO_OIDC_REQUIRED_CLAIM_NAME/);
    assert.match(result.stderr, /MERGE_STEWARD_OIDC_REQUIRED_GROUPS/);
  });

  it("rejects live integration without Forgejo enrichment", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_ENRICHMENT_ENABLED: "false",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@git.staging.eliza.internal/elizaos/eliza.git",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FORGEJO_ENRICHMENT_ENABLED/);
  });

  it("rejects live integration without strict work reservations", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "false",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@git.staging.eliza.internal/elizaos/eliza.git",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS/,
    );
  });

  it("rejects live integration without durable Work item links", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "false",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@git.staging.eliza.internal/elizaos/eliza.git",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS/,
    );
  });

  it("rejects live integration without agent branch namespaces", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "false",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@git.staging.eliza.internal/elizaos/eliza.git",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE/);
  });

  it("rejects live integration without verified agent run receipts", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "false",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@git.staging.eliza.internal/elizaos/eliza.git",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT/,
    );
  });

  it("rejects live integration without an agent identity registry", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "false",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@git.staging.eliza.internal/elizaos/eliza.git",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY/,
    );
  });

  it("allows live integration to rely on a Postgres-backed steward agent identity registry", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@git.staging.eliza.internal/elizaos/eliza.git",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.equal(result.code, 0, result.stderr);
  });

  it("rejects live integration without the agent run receipt signing secret", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET: "",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@git.staging.eliza.internal/elizaos/eliza.git",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET/);
  });

  it("rejects production steward validation without Eliza Cloud OIDC", async () => {
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      MERGE_STEWARD_OIDC_ENABLED: "false",
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MERGE_STEWARD_OIDC_ENABLED/);
  });

  it("reports secret failures without printing secret values", async () => {
    const leakedValue = "too-short-secret-value";
    const envFile = await writeTempEnv({
      ...hardenedEnv(),
      FORGEJO_SECRET_KEY: leakedValue,
    });

    const result = await runValidator(envFile, { VALIDATE_STEWARD: "true" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FORGEJO_SECRET_KEY/);
    assert.doesNotMatch(result.stderr, new RegExp(leakedValue));
  });
});

async function runValidator(envFile, extraEnv = {}) {
  try {
    const result = await execFileAsync(VALIDATOR_PATH.pathname, [], {
      env: {
        PATH: process.env.PATH,
        ENV_FILE: envFile,
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

async function writeTempEnv(values) {
  const dir = await mkdtempInTestRoot("eliza-hub-env-");
  const envFile = path.join(dir, ".env");
  await writeFile(
    envFile,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    "utf8",
  );
  return envFile;
}

function hardenedEnv() {
  return {
    COMPOSE_PROJECT_NAME: "eliza-forgejo-staging",
    FORGEJO_IMAGE: "codeberg.org/forgejo/forgejo:15",
    POSTGRES_IMAGE: "postgres:16-alpine",
    MERGE_STEWARD_IMAGE: "registry.internal/eliza/merge-steward:20260706",
    FORGEJO_RUNNER_IMAGE: "data.forgejo.org/forgejo/runner:12",
    FORGEJO_RUNNER_DIND_IMAGE: "docker:28-dind",
    FORGEJO_DOMAIN: "git.staging.eliza.internal",
    FORGEJO_ROOT_URL: "https://git.staging.eliza.internal/",
    FORGEJO_SSH_DOMAIN: "git.staging.eliza.internal",
    FORGEJO_PUBLIC_SSH_PORT: "22",
    FORGEJO_HTTP_BIND: "127.0.0.1",
    FORGEJO_HTTP_PORT: "3000",
    FORGEJO_SSH_BIND: "127.0.0.1",
    FORGEJO_SSH_PORT: "2222",
    FORGEJO_RECOVERY_ADMIN_USERNAME: "eliza-recovery-admin",
    FORGEJO_RECOVERY_ADMIN_EMAIL: "eliza-recovery-admin@staging.eliza.internal",
    FORGEJO_RECOVERY_ADMIN_PASSWORD: "recovery-admin-password-1234567890",
    FORGEJO_DB_NAME: "forgejo",
    FORGEJO_DB_USER: "forgejo",
    FORGEJO_DB_PASSWORD: "db-password-12345678901234567890",
    FORGEJO_SECRET_KEY: "forgejo-secret-key-12345678901234567890", // gitleaks:allow - synthetic validator fixture
    FORGEJO_INTERNAL_TOKEN: "forgejo-internal-token-123456789012345",
    FORGEJO_OAUTH2_JWT_SECRET: "forgejo-oauth2-jwt-secret-1234567890",
    FORGEJO_ACTIONS_ENABLED: "true",
    FORGEJO_ACTIONS_URL: "https://git.staging.eliza.internal/actions",
    FORGEJO_ACTION_LOG_RETENTION_DAYS: "14",
    FORGEJO_ACTION_ARTIFACT_RETENTION_DAYS: "14",
    FORGEJO_MAIL_ENABLED: "false",
    FORGEJO_REGISTER_EMAIL_CONFIRM: "false",
    FORGEJO_RUNNER_INSTANCE: "https://git.staging.eliza.internal/",
    FORGEJO_RUNNER_NAME: "eliza-staging-docker-1",
    FORGEJO_RUNNER_LABELS:
      "docker:docker://node:24-bookworm,node-24:docker://node:24-bookworm,ubuntu-latest:docker://node:24-bookworm",
    FORGEJO_RUNNER_REGISTRATION_TOKEN: "runner-registration-token-123456",
    FORGEJO_OIDC_AUTH_NAME: "elizacloud",
    FORGEJO_OIDC_SCOPES: "openid email profile groups",
    FORGEJO_OIDC_SKIP_LOCAL_2FA: "true",
    FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION: "true",
    FORGEJO_OAUTH2_REGISTER_EMAIL_CONFIRM: "false",
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
    ELIZA_CLOUD_FORGEJO_CLIENT_SECRET: "forgejo-oidc-client-secret-1234567890",
    ELIZA_CLOUD_STEWARD_AUDIENCE: "eliza-merge-steward",
    FORGEJO_THEMES: "forgejo-auto,forgejo-light,forgejo-dark,eliza,eliza-light",
    FORGEJO_DEFAULT_THEME: "eliza",
    MERGE_STEWARD_HTTP_BIND: "127.0.0.1",
    MERGE_STEWARD_HTTP_PORT: "8080",
    MERGE_STEWARD_DEPLOYMENT_MODE: "production",
    MERGE_STEWARD_DATABASE_URL:
      "postgres://forgejo:db-password@postgres:5432/forgejo",
    FORGEJO_STEWARD_USERNAME: "eliza-merge-steward",
    FORGEJO_STEWARD_EMAIL: "eliza-merge-steward@staging.eliza.internal",
    FORGEJO_STEWARD_TOKEN: "forgejo-steward-token-123456789012345",
    FORGEJO_WEBHOOK_SECRET: "forgejo-webhook-secret-123456789012345",
    MERGE_STEWARD_API_AUTH_REQUIRED: "true",
    MERGE_STEWARD_API_TOKEN: "merge-steward-api-token-123456789012",
    MERGE_STEWARD_METRICS_ENABLED: "true",
    MERGE_STEWARD_METRICS_AUTH_REQUIRED: "true",
    MERGE_STEWARD_OIDC_ENABLED: "true",
    MERGE_STEWARD_OIDC_REQUIRED_ROLES: "steward,maintainer",
    MERGE_STEWARD_OIDC_REQUIRED_GROUPS: "eliza-team",
    MERGE_STEWARD_OIDC_ADMIN_ROLES: "steward-admin",
    MERGE_STEWARD_OIDC_ADMIN_GROUPS: "eliza-admins",
    MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
    MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
    MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
    MERGE_STEWARD_REQUIRE_AGENT_RUN_RECEIPT: "false",
    MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "false",
    MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV:
      "MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET",
    MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET:
      "agent-run-receipt-secret-1234567890",
    MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "false",
    MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "false",
    MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "false",
    MERGE_STEWARD_AGENT_BRANCH_NAMESPACE_PREFIX: "agent",
    MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "false",
    MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "eliza-smoke-agent",
    FORGEJO_FEEDBACK_ENABLED: "false",
    FORGEJO_FEEDBACK_DRY_RUN: "true",
    FORGEJO_ENRICHMENT_ENABLED: "false",
    FORGEJO_PROTECTED_BRANCHES: "main,develop",
    FORGEJO_REQUIRED_CHECKS: "unit,lint",
    MERGE_STEWARD_INTEGRATION_ENABLED: "false",
    MERGE_STEWARD_INTEGRATION_DRY_RUN: "true",
    MERGE_STEWARD_INTEGRATION_EXECUTOR: "none",
    MERGE_STEWARD_INTEGRATION_ALLOW_EMPTY_CHECKS: "false",
    MERGE_STEWARD_WORKER_ENABLED: "false",
    MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "false",
    MERGE_STEWARD_WORKER_LEASE_ENABLED: "true",
  };
}
