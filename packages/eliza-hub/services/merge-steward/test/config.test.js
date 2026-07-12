import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig, validateRuntimeConfig } from "../src/config.js";

describe("merge steward config", () => {
  it("parses final merge execution options", () => {
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_MERGE_METHOD: "squash",
      MERGE_STEWARD_INTEGRATION_DELETE_BRANCH_AFTER_MERGE: "true",
      MERGE_STEWARD_INTEGRATION_MERGE_TITLE: "Merge via Eliza Steward",
      MERGE_STEWARD_INTEGRATION_MERGE_MESSAGE:
        "Integration branch checks passed.",
      MERGE_STEWARD_INTEGRATION_MAX_BATCH_SIZE: "3",
    });

    assert.equal(config.integration.mergeMethod, "squash");
    assert.equal(config.integration.deleteBranchAfterMerge, true);
    assert.equal(config.integration.mergeTitle, "Merge via Eliza Steward");
    assert.equal(
      config.integration.mergeMessage,
      "Integration branch checks passed.",
    );
    assert.equal(config.integration.maxBatchSize, 3);
  });

  it("defaults local Git integration workdirs to a disk-backed cache root", () => {
    const config = loadConfig({
      HOME: "/home/eliza",
    });

    assert.equal(
      config.integration.gitWorkDir,
      "/home/eliza/.cache/eliza-hub/merge-steward-workdir",
    );
  });

  it("parses Eliza Cloud OIDC options", () => {
    const config = loadConfig({
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_JWKS_URL: "https://cloud.example.invalid/jwks",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_OIDC_REQUIRED_ROLES: "steward,maintainer",
      MERGE_STEWARD_OIDC_REQUIRED_GROUPS: "eliza-team",
      MERGE_STEWARD_OIDC_ADMIN_ROLES: "steward-admin",
      MERGE_STEWARD_OIDC_ADMIN_GROUPS: "eliza-admins,platform",
    });

    assert.equal(config.oidc.enabled, true);
    assert.equal(config.oidc.issuerUrl, "https://cloud.example.invalid");
    assert.equal(
      config.oidc.discoveryUrl,
      "https://cloud.example.invalid/.well-known/openid-configuration",
    );
    assert.equal(config.oidc.jwksUrl, "https://cloud.example.invalid/jwks");
    assert.equal(config.oidc.audience, "eliza-merge-steward");
    assert.deepEqual(config.oidc.requiredRoles, ["steward", "maintainer"]);
    assert.deepEqual(config.oidc.requiredGroups, ["eliza-team"]);
    assert.deepEqual(config.oidc.adminRoles, ["steward-admin"]);
    assert.deepEqual(config.oidc.adminGroups, ["eliza-admins", "platform"]);
  });

  it("parses deployment mode for runtime preflight", () => {
    const config = loadConfig({ MERGE_STEWARD_DEPLOYMENT_MODE: "production" });

    assert.equal(config.deployment.mode, "production");
  });

  it("parses agent run receipt verification options", () => {
    const config = loadConfig({
      MERGE_STEWARD_REQUIRE_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_AGENT_BRANCH_NAMESPACE_PREFIX: "bots",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-codex, agent-docs",
      MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV: "ELIZA_AGENT_RECEIPT_SECRET",
    });

    assert.equal(config.policy.requireAgentRunReceiptForAgentPrs, true);
    assert.equal(config.policy.requireVerifiedAgentRunReceiptForAgentPrs, true);
    assert.equal(config.policy.requireWorkReservationForAgentPrs, true);
    assert.equal(config.policy.requireWorkItemForAgentPrs, true);
    assert.equal(config.policy.requireAgentBranchNamespaceForAgentPrs, true);
    assert.equal(config.policy.agentBranchNamespacePrefix, "bots");
    assert.equal(config.policy.requireAgentIdentityRegistryForAgentPrs, true);
    assert.deepEqual(config.policy.knownAgentIds, [
      "agent-codex",
      "agent-docs",
    ]);
    assert.equal(
      config.agentRunReceipt.signatureSecretEnv,
      "ELIZA_AGENT_RECEIPT_SECRET",
    );
  });

  it("warns when strict agent identity registry mode has no env bootstrap list", () => {
    const config = loadConfig({
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "",
    });
    const preflight = validateRuntimeConfig(config, {});

    assert.equal(preflight.ok, true);
    assert.ok(
      preflight.warnings.some(
        (warning) => warning.code === "agent_identity_registry_bootstrap_empty",
      ),
    );
  });

  it("parses metrics options and defaults production metrics to authenticated", () => {
    const local = loadConfig({
      MERGE_STEWARD_METRICS_ENABLED: "true",
      MERGE_STEWARD_METRICS_AUTH_REQUIRED: "false",
    });
    const production = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      MERGE_STEWARD_METRICS_ENABLED: "true",
    });

    assert.equal(local.metrics.enabled, true);
    assert.equal(local.metrics.authRequired, false);
    assert.equal(production.metrics.enabled, true);
    assert.equal(production.metrics.authRequired, true);
  });

  it("keeps local mode permissive for private demo storage", () => {
    const config = loadConfig({ QUEUE_STORE_PATH: "/state/queue.json" });
    const preflight = validateRuntimeConfig(config, {});

    assert.equal(preflight.ok, true);
    assert.equal(preflight.mode, "local");
    assert.deepEqual(
      preflight.warnings.map((warning) => warning.code),
      ["json_store_staging_only"],
    );
  });

  it("blocks unsafe production runtime configuration", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      MERGE_STEWARD_API_AUTH_REQUIRED: "false",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "false",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "false",
    });
    const preflight = validateRuntimeConfig(config, {});

    assert.equal(preflight.ok, false);
    assert.deepEqual(
      preflight.errors.map((error) => error.code),
      [
        "webhook_secret_missing",
        "postgres_required",
        "control_api_auth_required",
        "oidc_required",
        "webhook_delivery_id_required",
        "event_gate_required",
      ],
    );
  });

  it("blocks unauthenticated production metrics", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_OIDC_REQUIRED_GROUPS: "eliza-team",
      MERGE_STEWARD_OIDC_ADMIN_GROUPS: "eliza-admins",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      MERGE_STEWARD_METRICS_ENABLED: "true",
      MERGE_STEWARD_METRICS_AUTH_REQUIRED: "false",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_API_TOKEN: "token",
    });

    assert.equal(preflight.ok, false);
    assert.deepEqual(
      preflight.errors.map((error) => error.code),
      ["metrics_auth_required"],
    );
  });

  it("passes a hardened production runtime configuration", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_OIDC_REQUIRED_GROUPS: "eliza-team",
      MERGE_STEWARD_OIDC_ADMIN_GROUPS: "eliza-admins",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_API_TOKEN: "token",
    });

    assert.equal(preflight.ok, true);
    assert.equal(preflight.mode, "production");
    assert.deepEqual(preflight.errors, []);
  });

  it("requires production OIDC role or group claim gates", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_API_TOKEN: "token",
    });

    assert.equal(preflight.ok, false);
    assert.deepEqual(
      preflight.errors.map((error) => error.code),
      ["oidc_required_claims_missing", "oidc_admin_claims_missing"],
    );
  });

  it("requires Eliza Cloud OIDC for production control APIs even with a static token", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_API_TOKEN: "token",
    });

    assert.equal(preflight.ok, false);
    assert.deepEqual(
      preflight.errors.map((error) => error.code),
      ["oidc_required"],
    );
  });

  it("parses merge worker options", () => {
    const config = loadConfig({
      MERGE_STEWARD_WORKER_ENABLED: "true",
      MERGE_STEWARD_WORKER_ID: "steward-worker-one",
      MERGE_STEWARD_WORKER_POLL_INTERVAL_MS: "2500",
      MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "true",
      MERGE_STEWARD_WORKER_MAX_CONSECUTIVE_ERRORS: "2",
      MERGE_STEWARD_WORKER_LEASE_ENABLED: "true",
      MERGE_STEWARD_WORKER_LEASE_ID: "merge-queue-eliza",
      MERGE_STEWARD_WORKER_LEASE_TTL_MS: "45000",
      MERGE_STEWARD_WORKER_LEASE_HEARTBEAT_INTERVAL_MS: "15000",
      MERGE_STEWARD_WORKER_STALE_QUEUE_ITEM_MS: "180000",
    });

    assert.equal(config.worker.enabled, true);
    assert.equal(config.worker.workerId, "steward-worker-one");
    assert.equal(config.worker.pollIntervalMs, 2500);
    assert.equal(config.worker.confirmLiveExecution, true);
    assert.equal(config.worker.maxConsecutiveErrors, 2);
    assert.equal(config.worker.leaseEnabled, true);
    assert.equal(config.worker.leaseId, "merge-queue-eliza");
    assert.equal(config.worker.leaseTtlMs, 45000);
    assert.equal(config.worker.leaseHeartbeatIntervalMs, 15000);
    assert.equal(config.worker.staleQueueItemMs, 180000);
  });

  it("blocks enabled workers without live confirmed integration", () => {
    const config = loadConfig({
      MERGE_STEWARD_WORKER_ENABLED: "true",
      MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "false",
    });
    const preflight = validateRuntimeConfig(config, {});

    assert.equal(preflight.ok, false);
    assert.deepEqual(
      preflight.errors.map((error) => error.code),
      ["worker_live_integration_required", "worker_confirmation_required"],
    );
  });

  it("allows live batching when local-git merge train prerequisites are present", () => {
    const config = loadConfig({
      FORGEJO_BASE_URL: "https://git.example.invalid",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_INTEGRATION_BATCHING: "true",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_FORGEJO_TOKEN: "token",
    });

    assert.equal(preflight.ok, true);
  });

  it("blocks enabled workers with invalid lease settings", () => {
    const config = loadConfig({
      FORGEJO_BASE_URL: "https://git.example.invalid",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_WORKER_ENABLED: "true",
      MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "true",
      MERGE_STEWARD_WORKER_LEASE_ID: "",
      MERGE_STEWARD_WORKER_LEASE_TTL_MS: "3000",
      MERGE_STEWARD_WORKER_LEASE_HEARTBEAT_INTERVAL_MS: "3000",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_FORGEJO_TOKEN: "token",
    });

    assert.equal(preflight.ok, false);
    assert.deepEqual(
      preflight.errors.map((error) => error.code),
      [
        "worker_lease_id_missing",
        "worker_lease_ttl_invalid",
        "worker_lease_heartbeat_invalid",
      ],
    );
  });

  it("blocks enabled workers with an unsafe stale queue recovery threshold", () => {
    const config = loadConfig({
      FORGEJO_BASE_URL: "https://git.example.invalid",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_WORKER_ENABLED: "true",
      MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "true",
      MERGE_STEWARD_WORKER_LEASE_TTL_MS: "30000",
      MERGE_STEWARD_WORKER_STALE_QUEUE_ITEM_MS: "5000",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_FORGEJO_TOKEN: "token",
    });

    assert.equal(preflight.ok, false);
    assert.ok(
      preflight.errors.some(
        (error) => error.code === "worker_stale_queue_item_invalid",
      ),
    );
  });

  it("requires durable worker leases for production workers", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_OIDC_REQUIRED_GROUPS: "eliza-team",
      MERGE_STEWARD_OIDC_ADMIN_GROUPS: "eliza-admins",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_WORKER_ENABLED: "true",
      MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "true",
      MERGE_STEWARD_WORKER_LEASE_ENABLED: "false",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_FORGEJO_TOKEN: "token",
      TEST_API_TOKEN: "api-token",
    });

    assert.equal(preflight.ok, false);
    assert.ok(
      preflight.errors.some((error) => error.code === "worker_lease_required"),
    );
  });

  it("requires Forgejo enrichment for production live integration", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_FORGEJO_TOKEN: "token",
      TEST_API_TOKEN: "api-token",
    });

    assert.equal(preflight.ok, false);
    assert.ok(
      preflight.errors.some(
        (error) => error.code === "live_enrichment_required",
      ),
    );
  });

  it("requires strict work reservations for production live integration", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_FORGEJO_TOKEN: "token",
      TEST_API_TOKEN: "api-token",
    });

    assert.equal(preflight.ok, false);
    assert.ok(
      preflight.errors.some(
        (error) => error.code === "work_reservation_required",
      ),
    );
  });

  it("requires durable work item links for production live integration", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_FORGEJO_TOKEN: "token",
      TEST_API_TOKEN: "api-token",
    });

    assert.equal(preflight.ok, false);
    assert.ok(
      preflight.errors.some((error) => error.code === "work_item_required"),
    );
  });

  it("requires agent branch namespaces for production live integration", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_FORGEJO_TOKEN: "token",
      TEST_API_TOKEN: "api-token",
    });

    assert.equal(preflight.ok, false);
    assert.ok(
      preflight.errors.some(
        (error) => error.code === "agent_branch_namespace_required",
      ),
    );
  });

  it("requires verified agent run receipts for production live integration", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_FORGEJO_TOKEN: "token",
      TEST_API_TOKEN: "api-token",
    });

    assert.equal(preflight.ok, false);
    assert.ok(
      preflight.errors.some(
        (error) => error.code === "verified_agent_run_receipt_required",
      ),
    );
  });

  it("requires strict agent identity registry for production live integration", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV: "TEST_AGENT_RECEIPT_SECRET",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_FORGEJO_TOKEN: "token",
      TEST_API_TOKEN: "api-token",
      TEST_AGENT_RECEIPT_SECRET: "agent-run-receipt-secret-1234567890",
    });

    assert.equal(preflight.ok, false);
    assert.ok(
      preflight.errors.some(
        (error) => error.code === "agent_identity_registry_required",
      ),
    );
  });

  it("requires the verified agent run receipt signing secret for production live integration", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV: "TEST_AGENT_RECEIPT_SECRET",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_FORGEJO_TOKEN: "token",
      TEST_API_TOKEN: "api-token",
    });

    assert.equal(preflight.ok, false);
    assert.ok(
      preflight.errors.some(
        (error) => error.code === "agent_run_receipt_secret_missing",
      ),
    );
  });

  it("passes production worker preflight with explicit live confirmation", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      FORGEJO_BASE_URL: "https://git.example.invalid",
      DATABASE_URL: "postgres://steward:secret@postgres:5432/steward",
      FORGEJO_WEBHOOK_SECRET_ENV: "TEST_WEBHOOK_SECRET",
      FORGEJO_TOKEN_ENV: "TEST_FORGEJO_TOKEN",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "TEST_API_TOKEN",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_DISCOVERY_URL:
        "https://cloud.example.invalid/.well-known/openid-configuration",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_OIDC_REQUIRED_GROUPS: "eliza-team",
      MERGE_STEWARD_OIDC_ADMIN_GROUPS: "eliza-admins",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
      MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
      FORGEJO_ENRICHMENT_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_REMOTE_URL:
        "ssh://git@example.invalid/elizaos/eliza.git",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV: "TEST_AGENT_RECEIPT_SECRET",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "eliza-smoke-agent",
      MERGE_STEWARD_WORKER_ENABLED: "true",
      MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "true",
    });
    const preflight = validateRuntimeConfig(config, {
      TEST_WEBHOOK_SECRET: "secret",
      TEST_FORGEJO_TOKEN: "token",
      TEST_API_TOKEN: "api-token",
      TEST_AGENT_RECEIPT_SECRET: "agent-run-receipt-secret-1234567890",
    });

    assert.equal(preflight.ok, true);
    assert.deepEqual(preflight.errors, []);
    assert.ok(
      preflight.warnings.some(
        (warning) => warning.code === "worker_push_branch_disabled",
      ),
    );
  });
});
