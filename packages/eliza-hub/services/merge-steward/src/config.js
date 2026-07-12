import { DEFAULT_POLICY } from "./policy.js";
import { defaultIntegrationWorkDir } from "./runtime-paths.js";

export function loadConfig(env = process.env) {
  const deploymentMode = parseDeploymentMode(
    env.MERGE_STEWARD_DEPLOYMENT_MODE ?? "local",
  );
  const apiAuthRequired = parseBoolean(
    env.MERGE_STEWARD_API_AUTH_REQUIRED,
    false,
  );
  const workerLeaseTtlMs = parseInteger(
    env.MERGE_STEWARD_WORKER_LEASE_TTL_MS,
    30000,
  );
  return {
    port: parseInteger(env.PORT, 8787),
    deployment: {
      mode: deploymentMode,
    },
    forgejoBaseUrl: env.FORGEJO_BASE_URL ?? null,
    forgejoTokenEnv: env.FORGEJO_TOKEN_ENV ?? "FORGEJO_STEWARD_TOKEN",
    webhookSecretEnv:
      env.FORGEJO_WEBHOOK_SECRET_ENV ?? "FORGEJO_WEBHOOK_SECRET",
    databaseUrl: env.DATABASE_URL || env.MERGE_STEWARD_DATABASE_URL || null,
    queueStorePath: env.QUEUE_STORE_PATH ?? null,
    apiAuth: {
      required: apiAuthRequired,
      tokenEnv: env.MERGE_STEWARD_API_TOKEN_ENV ?? "MERGE_STEWARD_API_TOKEN",
    },
    metrics: {
      enabled: parseBoolean(env.MERGE_STEWARD_METRICS_ENABLED, true),
      authRequired: parseBoolean(
        env.MERGE_STEWARD_METRICS_AUTH_REQUIRED,
        deploymentMode === "production" || apiAuthRequired,
      ),
    },
    oidc: {
      enabled: parseBoolean(
        env.MERGE_STEWARD_OIDC_ENABLED ?? env.OIDC_ENABLED,
        false,
      ),
      issuerUrl: env.OIDC_ISSUER_URL ?? env.ELIZA_CLOUD_OIDC_ISSUER_URL ?? null,
      discoveryUrl:
        env.OIDC_DISCOVERY_URL ?? env.ELIZA_CLOUD_OIDC_DISCOVERY_URL ?? null,
      jwksUrl: env.OIDC_JWKS_URL ?? env.ELIZA_CLOUD_OIDC_JWKS_URL ?? null,
      audience: env.OIDC_AUDIENCE ?? env.ELIZA_CLOUD_STEWARD_AUDIENCE ?? null,
      requiredRoles: parseList(env.MERGE_STEWARD_OIDC_REQUIRED_ROLES, []),
      requiredGroups: parseList(env.MERGE_STEWARD_OIDC_REQUIRED_GROUPS, []),
      adminRoles: parseList(env.MERGE_STEWARD_OIDC_ADMIN_ROLES, []),
      adminGroups: parseList(env.MERGE_STEWARD_OIDC_ADMIN_GROUPS, []),
      clockTolerance: env.MERGE_STEWARD_OIDC_CLOCK_TOLERANCE ?? "60s",
    },
    agentRunReceipt: {
      signatureSecretEnv:
        env.MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET_ENV ??
        DEFAULT_POLICY.agentRunReceiptSignatureSecretEnv,
    },
    webhook: {
      requireDeliveryId: parseBoolean(
        env.MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID,
        false,
      ),
    },
    eventGate: {
      enabled: parseBoolean(env.MERGE_STEWARD_EVENT_GATE_ENABLED, false),
      repositories: parseList(env.MERGE_STEWARD_EVENT_GATE_REPOSITORIES, []),
      trustedActors: parseList(env.MERGE_STEWARD_EVENT_GATE_TRUSTED_ACTORS, []),
      allowedKinds: parseList(env.MERGE_STEWARD_EVENT_GATE_ALLOWED_KINDS, []),
      commentCommandPrefixes: parseList(
        env.MERGE_STEWARD_EVENT_GATE_COMMAND_PREFIXES,
        ["/eliza", "/steward"],
      ),
      allowForkPullRequests: parseBoolean(
        env.MERGE_STEWARD_EVENT_GATE_ALLOW_FORKS,
        false,
      ),
    },
    http: {
      maxBodyBytes: parseInteger(env.MERGE_STEWARD_MAX_BODY_BYTES, 1024 * 1024),
    },
    feedback: {
      enabled: parseBoolean(env.FORGEJO_FEEDBACK_ENABLED, false),
      dryRun: parseBoolean(env.FORGEJO_FEEDBACK_DRY_RUN, true),
      syncLabels: parseBoolean(env.FORGEJO_FEEDBACK_LABELS, true),
      postComments: parseBoolean(env.FORGEJO_FEEDBACK_COMMENTS, true),
      stewardUsername: env.FORGEJO_STEWARD_USERNAME ?? "eliza-merge-steward",
    },
    enrichment: {
      enabled: parseBoolean(env.FORGEJO_ENRICHMENT_ENABLED, false),
      protectedBranches: parseList(env.FORGEJO_PROTECTED_BRANCHES, [
        "main",
        "develop",
      ]),
      requiredChecks: parseList(env.FORGEJO_REQUIRED_CHECKS, []),
      pageLimit: parseInteger(env.FORGEJO_ENRICHMENT_PAGE_LIMIT, 50),
      maxPages: parseInteger(env.FORGEJO_ENRICHMENT_MAX_PAGES, 10),
    },
    integration: {
      enabled: parseBoolean(env.MERGE_STEWARD_INTEGRATION_ENABLED, false),
      dryRun: parseBoolean(env.MERGE_STEWARD_INTEGRATION_DRY_RUN, true),
      executor: env.MERGE_STEWARD_INTEGRATION_EXECUTOR ?? "none",
      allowBatching: parseBoolean(
        env.MERGE_STEWARD_INTEGRATION_BATCHING,
        false,
      ),
      maxBatchSize: parseInteger(
        env.MERGE_STEWARD_INTEGRATION_MAX_BATCH_SIZE,
        null,
      ),
      branchPrefix:
        env.MERGE_STEWARD_INTEGRATION_BRANCH_PREFIX ?? "eliza-queue",
      branchMode: env.MERGE_STEWARD_INTEGRATION_BRANCH_MODE ?? "reset",
      allowEmptyRequiredChecks: parseBoolean(
        env.MERGE_STEWARD_INTEGRATION_ALLOW_EMPTY_CHECKS,
        false,
      ),
      gitRemoteUrl: env.MERGE_STEWARD_INTEGRATION_REMOTE_URL ?? null,
      gitWorkDir:
        env.MERGE_STEWARD_INTEGRATION_WORK_DIR ??
        defaultIntegrationWorkDir(env),
      gitBinary: env.MERGE_STEWARD_INTEGRATION_GIT_BINARY ?? "git",
      pushBranch: parseBoolean(
        env.MERGE_STEWARD_INTEGRATION_PUSH_BRANCH,
        false,
      ),
      mergeMethod: env.MERGE_STEWARD_INTEGRATION_MERGE_METHOD ?? "merge",
      deleteBranchAfterMerge: parseBoolean(
        env.MERGE_STEWARD_INTEGRATION_DELETE_BRANCH_AFTER_MERGE,
        false,
      ),
      mergeTitle: env.MERGE_STEWARD_INTEGRATION_MERGE_TITLE || undefined,
      mergeMessage: env.MERGE_STEWARD_INTEGRATION_MERGE_MESSAGE || undefined,
      checkPollAttempts: parseInteger(env.MERGE_STEWARD_CHECK_POLL_ATTEMPTS, 1),
      checkPollIntervalMs: parseInteger(
        env.MERGE_STEWARD_CHECK_POLL_INTERVAL_MS,
        0,
      ),
    },
    worker: {
      enabled: parseBoolean(env.MERGE_STEWARD_WORKER_ENABLED, false),
      workerId: env.MERGE_STEWARD_WORKER_ID ?? "merge-steward-worker",
      pollIntervalMs: parseInteger(
        env.MERGE_STEWARD_WORKER_POLL_INTERVAL_MS,
        5000,
      ),
      confirmLiveExecution: parseBoolean(
        env.MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION,
        false,
      ),
      maxConsecutiveErrors: parseInteger(
        env.MERGE_STEWARD_WORKER_MAX_CONSECUTIVE_ERRORS,
        5,
      ),
      leaseEnabled: parseBoolean(env.MERGE_STEWARD_WORKER_LEASE_ENABLED, true),
      leaseId: env.MERGE_STEWARD_WORKER_LEASE_ID ?? "merge-queue",
      leaseTtlMs: workerLeaseTtlMs,
      leaseHeartbeatIntervalMs: parseInteger(
        env.MERGE_STEWARD_WORKER_LEASE_HEARTBEAT_INTERVAL_MS,
        10000,
      ),
      staleQueueItemMs: parseInteger(
        env.MERGE_STEWARD_WORKER_STALE_QUEUE_ITEM_MS,
        Math.max(120000, workerLeaseTtlMs * 4),
      ),
    },
    policy: {
      ...DEFAULT_POLICY,
      maxLowRiskChangedLines: parseInteger(
        env.MAX_LOW_RISK_CHANGED_LINES,
        DEFAULT_POLICY.maxLowRiskChangedLines,
      ),
      maxMediumRiskChangedLines: parseInteger(
        env.MAX_MEDIUM_RISK_CHANGED_LINES,
        DEFAULT_POLICY.maxMediumRiskChangedLines,
      ),
      staleAfterTargetCommits: parseInteger(
        env.STALE_AFTER_TARGET_COMMITS,
        DEFAULT_POLICY.staleAfterTargetCommits,
      ),
      maxRetries: parseInteger(env.MAX_RETRIES, DEFAULT_POLICY.maxRetries),
      requireAgentRunReceiptForAgentPrs: parseBoolean(
        env.MERGE_STEWARD_REQUIRE_AGENT_RUN_RECEIPT,
        DEFAULT_POLICY.requireAgentRunReceiptForAgentPrs,
      ),
      requireVerifiedAgentRunReceiptForAgentPrs: parseBoolean(
        env.MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT,
        DEFAULT_POLICY.requireVerifiedAgentRunReceiptForAgentPrs,
      ),
      requireAgentIdentityRegistryForAgentPrs: parseBoolean(
        env.MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY,
        DEFAULT_POLICY.requireAgentIdentityRegistryForAgentPrs,
      ),
      knownAgentIds: parseList(
        env.MERGE_STEWARD_AGENT_IDENTITY_REGISTRY,
        DEFAULT_POLICY.knownAgentIds,
      ),
      requireWorkItemForAgentPrs: parseBoolean(
        env.MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS,
        DEFAULT_POLICY.requireWorkItemForAgentPrs,
      ),
      requireWorkReservationForAgentPrs: parseBoolean(
        env.MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS,
        DEFAULT_POLICY.requireWorkReservationForAgentPrs,
      ),
      requireAgentBranchNamespaceForAgentPrs: parseBoolean(
        env.MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE,
        DEFAULT_POLICY.requireAgentBranchNamespaceForAgentPrs,
      ),
      agentBranchNamespacePrefix:
        env.MERGE_STEWARD_AGENT_BRANCH_NAMESPACE_PREFIX ??
        DEFAULT_POLICY.agentBranchNamespacePrefix,
    },
  };
}

export function validateRuntimeConfig(
  config = loadConfig(),
  env = process.env,
) {
  const mode = config.deployment?.mode ?? "local";
  const errors = [];
  const warnings = [];
  const hasWebhookSecret = hasEnvValue(env, config.webhookSecretEnv);
  const hasForgejoToken = hasEnvValue(env, config.forgejoTokenEnv);
  const hasStaticApiToken = hasEnvValue(env, config.apiAuth?.tokenEnv);
  const hasAgentRunReceiptSecret = hasEnvValue(
    env,
    config.agentRunReceipt?.signatureSecretEnv,
  );
  const oidcEnabled = config.oidc?.enabled === true;
  const strictProduction = mode === "production";

  if (!["local", "staging", "production"].includes(mode)) {
    add(
      errors,
      "invalid_deployment_mode",
      "MERGE_STEWARD_DEPLOYMENT_MODE must be local, staging, or production.",
    );
  }

  if (oidcEnabled && !config.oidc?.issuerUrl) {
    add(
      errors,
      "oidc_issuer_missing",
      "OIDC auth is enabled but OIDC_ISSUER_URL is not configured.",
    );
  }
  if (oidcEnabled && !config.oidc?.audience) {
    add(
      errors,
      "oidc_audience_missing",
      "OIDC auth is enabled but OIDC_AUDIENCE is not configured.",
    );
  }
  if (
    strictProduction &&
    oidcEnabled &&
    !config.oidc?.discoveryUrl &&
    !config.oidc?.jwksUrl
  ) {
    add(
      errors,
      "oidc_discovery_missing",
      "Production OIDC auth requires OIDC_DISCOVERY_URL or OIDC_JWKS_URL.",
    );
  }

  if (config.apiAuth?.required === true && !hasStaticApiToken && !oidcEnabled) {
    add(
      errors,
      "api_auth_token_missing",
      "MERGE_STEWARD_API_AUTH_REQUIRED is true but no static API token or OIDC auth is configured.",
    );
  }

  if (strictProduction) {
    if (!hasWebhookSecret) {
      add(
        errors,
        "webhook_secret_missing",
        "Production mode requires FORGEJO_WEBHOOK_SECRET.",
      );
    }

    if (!config.databaseUrl) {
      add(
        errors,
        "postgres_required",
        "Production mode requires DATABASE_URL or MERGE_STEWARD_DATABASE_URL.",
      );
    }

    if (config.apiAuth?.required !== true && !oidcEnabled) {
      add(
        errors,
        "control_api_auth_required",
        "Production mode requires authenticated control APIs.",
      );
    }

    if (!oidcEnabled) {
      add(
        errors,
        "oidc_required",
        "Production mode requires Eliza Cloud OIDC auth.",
      );
    }

    if (
      oidcEnabled &&
      !config.oidc?.requiredRoles?.length &&
      !config.oidc?.requiredGroups?.length
    ) {
      add(
        errors,
        "oidc_required_claims_missing",
        "Production OIDC auth requires at least one allowed role or group claim gate.",
      );
    }

    if (
      oidcEnabled &&
      !config.oidc?.adminRoles?.length &&
      !config.oidc?.adminGroups?.length
    ) {
      add(
        errors,
        "oidc_admin_claims_missing",
        "Production OIDC auth requires at least one admin role or group claim gate for privileged operations.",
      );
    }

    if (config.webhook?.requireDeliveryId !== true) {
      add(
        errors,
        "webhook_delivery_id_required",
        "Production mode requires webhook delivery ID replay protection.",
      );
    }

    if (config.eventGate?.enabled !== true) {
      add(
        errors,
        "event_gate_required",
        "Production mode requires the Forgejo event gate.",
      );
    } else if (!config.eventGate.repositories?.length) {
      add(
        errors,
        "event_gate_repositories_missing",
        "Production event gating requires at least one allowed repository.",
      );
    }

    if (
      config.metrics?.enabled === true &&
      config.metrics?.authRequired !== true
    ) {
      add(
        errors,
        "metrics_auth_required",
        "Production metrics require bearer or OIDC auth.",
      );
    }
  } else {
    if (!config.databaseUrl && config.queueStorePath) {
      add(
        warnings,
        "json_store_staging_only",
        "JSON queue storage is for local or private single-process staging only.",
      );
    }
  }

  if (
    (config.feedback?.enabled === true ||
      config.enrichment?.enabled === true) &&
    !config.forgejoBaseUrl
  ) {
    add(
      errors,
      "forgejo_base_url_missing",
      "Forgejo API features require FORGEJO_BASE_URL.",
    );
  }

  if (
    config.policy?.requireAgentIdentityRegistryForAgentPrs === true &&
    !config.policy?.knownAgentIds?.length
  ) {
    add(
      warnings,
      "agent_identity_registry_bootstrap_empty",
      "Strict agent identity registry mode has no env bootstrap list; /ready must prove persisted active agents before live merges.",
    );
  }

  if (
    config.feedback?.enabled === true &&
    config.feedback?.dryRun === false &&
    !hasForgejoToken
  ) {
    add(
      errors,
      "forgejo_token_missing_for_feedback",
      "Live Forgejo feedback requires the steward bot token.",
    );
  }

  if (
    strictProduction &&
    config.enrichment?.enabled === true &&
    !hasForgejoToken
  ) {
    add(
      errors,
      "forgejo_token_missing_for_enrichment",
      "Production Forgejo enrichment requires the steward bot token.",
    );
  }

  if (
    config.integration?.enabled === true &&
    config.integration?.dryRun === false
  ) {
    validateLiveIntegrationConfig({
      config,
      errors,
      warnings,
      hasForgejoToken,
      hasAgentRunReceiptSecret,
      strictProduction,
    });
  }

  if (config.worker?.enabled === true) {
    validateWorkerConfig({ config, errors, warnings, strictProduction });
  }

  return {
    ok: errors.length === 0,
    mode,
    errors,
    warnings,
  };
}

function validateLiveIntegrationConfig({
  config,
  errors,
  warnings,
  hasForgejoToken,
  hasAgentRunReceiptSecret,
  strictProduction,
}) {
  if (!config.forgejoBaseUrl) {
    add(
      errors,
      "forgejo_base_url_missing_for_integration",
      "Live integration requires FORGEJO_BASE_URL.",
    );
  }

  if (!hasForgejoToken) {
    add(
      errors,
      "forgejo_token_missing_for_integration",
      "Live integration requires the steward bot token.",
    );
  }

  if (config.integration.executor !== "local-git") {
    add(
      errors,
      "integration_executor_missing",
      "Live integration requires a configured executor.",
    );
  }

  if (
    config.integration.executor === "local-git" &&
    !config.integration.gitRemoteUrl
  ) {
    add(
      errors,
      "integration_remote_missing",
      "The local-git integration executor requires a git remote URL.",
    );
  }

  if (
    strictProduction &&
    config.integration.allowEmptyRequiredChecks === true
  ) {
    add(
      errors,
      "empty_required_checks_forbidden",
      "Production live integration cannot allow empty required checks.",
    );
  }

  if (strictProduction && config.enrichment?.enabled !== true) {
    add(
      errors,
      "live_enrichment_required",
      "Production live integration requires Forgejo enrichment to refresh PR facts before merging.",
    );
  }

  if (
    strictProduction &&
    config.policy?.requireWorkReservationForAgentPrs !== true
  ) {
    add(
      errors,
      "work_reservation_required",
      "Production live integration requires MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS=true.",
    );
  }

  if (strictProduction && config.policy?.requireWorkItemForAgentPrs !== true) {
    add(
      errors,
      "work_item_required",
      "Production live integration requires MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS=true.",
    );
  }

  if (
    strictProduction &&
    config.policy?.requireAgentBranchNamespaceForAgentPrs !== true
  ) {
    add(
      errors,
      "agent_branch_namespace_required",
      "Production live integration requires MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE=true.",
    );
  }

  if (
    strictProduction &&
    config.policy?.requireVerifiedAgentRunReceiptForAgentPrs !== true
  ) {
    add(
      errors,
      "verified_agent_run_receipt_required",
      "Production live integration requires MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT=true.",
    );
  }

  if (
    strictProduction &&
    config.policy?.requireAgentIdentityRegistryForAgentPrs !== true
  ) {
    add(
      errors,
      "agent_identity_registry_required",
      "Production live integration requires MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true.",
    );
  }

  if (
    strictProduction &&
    config.policy?.requireVerifiedAgentRunReceiptForAgentPrs === true &&
    !hasAgentRunReceiptSecret
  ) {
    add(
      errors,
      "agent_run_receipt_secret_missing",
      `Production verified agent run receipts require ${config.agentRunReceipt?.signatureSecretEnv}.`,
    );
  }

  if (strictProduction && !config.enrichment?.requiredChecks?.length) {
    add(
      warnings,
      "process_required_checks_empty",
      "No process-level required checks are configured; ensure every production repository policy defines checks.",
    );
  }
}

function validateWorkerConfig({ config, errors, warnings, strictProduction }) {
  if (
    config.integration?.enabled !== true ||
    config.integration?.dryRun !== false
  ) {
    add(
      errors,
      "worker_live_integration_required",
      "The merge worker requires live integration execution.",
    );
  }

  if (config.worker?.confirmLiveExecution !== true) {
    add(
      errors,
      "worker_confirmation_required",
      "The merge worker requires explicit live-execution confirmation.",
    );
  }

  if (
    !Number.isInteger(config.worker?.pollIntervalMs) ||
    config.worker.pollIntervalMs < 1000
  ) {
    add(
      errors,
      "worker_poll_interval_invalid",
      "The merge worker poll interval must be at least 1000ms.",
    );
  }

  if (
    !Number.isInteger(config.worker?.maxConsecutiveErrors) ||
    config.worker.maxConsecutiveErrors < 1
  ) {
    add(
      errors,
      "worker_error_limit_invalid",
      "The merge worker max consecutive errors must be at least 1.",
    );
  }

  if (strictProduction && config.worker?.leaseEnabled !== true) {
    add(
      errors,
      "worker_lease_required",
      "Production merge workers require the durable worker lease.",
    );
  }

  if (config.worker?.leaseEnabled === true) {
    if (!config.worker.leaseId) {
      add(
        errors,
        "worker_lease_id_missing",
        "The merge worker lease id must be configured.",
      );
    }

    if (
      !Number.isInteger(config.worker?.leaseTtlMs) ||
      config.worker.leaseTtlMs < 5000
    ) {
      add(
        errors,
        "worker_lease_ttl_invalid",
        "The merge worker lease TTL must be at least 5000ms.",
      );
    }

    if (
      !Number.isInteger(config.worker?.leaseHeartbeatIntervalMs) ||
      config.worker.leaseHeartbeatIntervalMs < 1000 ||
      config.worker.leaseHeartbeatIntervalMs >= config.worker.leaseTtlMs
    ) {
      add(
        errors,
        "worker_lease_heartbeat_invalid",
        "The merge worker lease heartbeat interval must be at least 1000ms and less than the lease TTL.",
      );
    }
  }

  if (
    !Number.isInteger(config.worker?.staleQueueItemMs) ||
    config.worker.staleQueueItemMs < config.worker.leaseTtlMs
  ) {
    add(
      errors,
      "worker_stale_queue_item_invalid",
      "The merge worker stale queue item threshold must be at least the worker lease TTL.",
    );
  }

  if (strictProduction && config.integration?.pushBranch !== true) {
    add(
      warnings,
      "worker_push_branch_disabled",
      "The production merge worker can run, but integration branch pushing is disabled.",
    );
  }
}

function parseInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase()))
    return true;
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase()))
    return false;
  return fallback;
}

function parseList(value, fallback) {
  if (value == null || value === "") return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDeploymentMode(value) {
  const normalized = String(value ?? "local")
    .trim()
    .toLowerCase();
  return normalized || "local";
}

function hasEnvValue(env, name) {
  return Boolean(name && env[name]);
}

function add(list, code, message) {
  list.push({ code, message });
}
