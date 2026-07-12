import {
  buildGithubParitySummary,
  GITHUB_PARITY_PATH,
} from "./github-parity.js";
import {
  PRODUCTION_EVIDENCE_FILENAME,
  PRODUCTION_EVIDENCE_TEMPLATE_COMMAND,
  PRODUCTION_EVIDENCE_TEMPLATE_FILENAME,
  PRODUCTION_EVIDENCE_TEMPLATE_PATH,
  PRODUCTION_EVIDENCE_USAGE,
} from "./production-evidence-template.js";
import {
  buildProductionReadinessSummary,
  PRODUCTION_CUTOVER_PATH,
  PRODUCTION_READINESS_PATH,
} from "./production-readiness.js";

export const DISCOVERY_PATH = "/.well-known/eliza-hub.json";

const CAPABILITIES = Object.freeze([
  "openapi_contract",
  "project_board",
  "work_items",
  "agent_work_item_policy",
  "work_cycles",
  "work_modules",
  "work_progress",
  "work_views",
  "work_view_evaluation",
  "work_pages",
  "work_dashboard",
  "work_context_resume",
  "work_intake",
  "merge_queue",
  "merge_train_plan",
  "queue_item_action_plan",
  "repo_search",
  "agent_insights",
  "agent_capacity",
  "agent_performance",
  "agent_routing",
  "agent_bootstrap",
  "agent_cockpit",
  "agent_action_plan",
  "queue_simulation",
  "agent_submission_gate",
  "agent_work_preflight",
  "agent_work_reservation",
  "agent_branch_namespace_policy",
  "verified_agent_run_receipt_policy",
  "agent_identity_registry_policy",
  "release_readiness",
  "repository_protection",
  "ci_failure_analysis",
  "ci_validation_plan",
  "pull_request_brief",
  "review_assignment",
  "patch_conflict_prediction",
  "release_notes",
  "agent_inbox",
  "claim_assignment",
  "claim_next",
  "claim_transfer",
  "coordination_summary",
  "fleet_coordination_contract",
  "queue_policy",
  "queue_worker",
  "repo_policies",
  "run_runtime",
  "attempt_recovery",
  "human_approvals",
  "human_requests",
  "external_signals",
  "prometheus_metrics",
  "signed_forgejo_webhooks",
  "github_parity_matrix",
  "production_readiness_checklist",
  "production_cutover_plan",
  "production_evidence_inventory",
  "production_evidence_template",
]);

export function buildDiscoveryManifest({
  config = {},
  version = "0.1.0",
  agentIdentityRegistry,
} = {}) {
  return {
    schema: "https://eliza.hub/schemas/agent-git-discovery.v1",
    service: "eliza-merge-steward",
    name: "Eliza Hub Merge Steward",
    version,
    discoveryVersion: 1,
    generatedAt: new Date().toISOString(),
    auth: buildAuthManifest(config),
    capabilities: [...CAPABILITIES],
    githubParity: buildGithubParitySummary(),
    productionReadiness: buildProductionReadinessSummary(),
    surfaces: buildSurfaceManifest(),
    links: {
      self: DISCOVERY_PATH,
      openapi: "/openapi.json",
      githubParity: GITHUB_PARITY_PATH,
      productionReadiness: PRODUCTION_READINESS_PATH,
      productionCutover: PRODUCTION_CUTOVER_PATH,
      productionEvidenceTemplate: PRODUCTION_EVIDENCE_TEMPLATE_PATH,
      health: "/health",
      readiness: "/ready",
      metrics: "/metrics",
      workflows: "/api/workflows",
      projectBoard: "/api/project-board",
      workItems: "/api/work-items",
      workItem: "/api/work-items/item",
      workItemTransition: "/api/work-items/transition",
      workCycles: "/api/work-cycles",
      workCycle: "/api/work-cycles/item",
      workCycleTransition: "/api/work-cycles/transition",
      workModules: "/api/work-modules",
      workModule: "/api/work-modules/item",
      workModuleTransition: "/api/work-modules/transition",
      workProgress: "/api/work-progress",
      workViews: "/api/work-views",
      workView: "/api/work-views/item",
      workViewEvaluation: "/api/work-views/evaluate",
      workViewTransition: "/api/work-views/transition",
      workPages: "/api/work-pages",
      workPage: "/api/work-pages/item",
      workPageTransition: "/api/work-pages/transition",
      workDashboard: "/api/work-dashboard",
      workContext: "/api/work-context",
      workIntake: "/api/work-intake",
      workIntakeApply: "/api/work-intake/apply",
      mergeQueue: "/api/merge-queue",
      mergeTrain: "/api/merge-train",
      queueItemActionPlan: "/api/queue/item/action-plan",
      search: "/api/search",
      queueSimulation: "/api/queue/simulate",
      releaseReadiness: "/api/release-readiness",
      repositoryProtection: "/api/repository-protection",
      agentInsights: "/api/agent-insights",
      agentCapacity: "/api/agents",
      agentIdentities: "/api/agent-identities",
      agentPerformance: "/api/agent-performance",
      agentRouting: "/api/agent-routing",
      agentBootstrapTemplate: "/api/agents/{agentId}/bootstrap",
      agentCockpitTemplate: "/api/agents/{agentId}/cockpit",
      agentActionPlanTemplate: "/api/agents/{agentId}/action-plan",
      agentSubmissionGateTemplate: "/api/agents/{agentId}/submission-gate",
      agentWorkPreflightTemplate: "/api/agents/{agentId}/work-preflight",
      agentWorkReservationTemplate: "/api/agents/{agentId}/work-reservation",
      ciFailureAnalysis: "/api/ci/failure-analysis",
      ciValidationPlan: "/api/ci/validation-plan",
      pullRequestBrief: "/api/pr/brief",
      reviewAssignment: "/api/review/assignment",
      patchConflictPrediction: "/api/patch/conflict-prediction",
      releaseNotes: "/api/releases/notes",
      agentInboxTemplate: "/api/agents/{agentId}/inbox",
      claimAssignmentTemplate: "/api/agents/{agentId}/claim-assignment",
      claimNextTemplate: "/api/agents/{agentId}/claim-next",
      coordination: "/api/coordination",
      fleetCoordination: "/api/fleet-coordination",
      claims: "/api/claims",
      claimTransfer: "/api/claims/transfer",
      queue: "/api/queue",
      queueRunOnce: "/api/queue/run-once",
      repoPolicies: "/api/repo-policies",
      runs: "/api/runs",
      approvals: "/api/approvals",
      humanRequests: "/api/human-requests",
      signals: "/api/signals",
      forgejoWebhook: "/api/webhooks/forgejo",
    },
    clientHints: {
      pathParametersMustBeUrlEncoded: true,
      apiRoutesUseBearerAuth:
        config.apiAuth?.required === true || config.oidc?.enabled === true,
      webhookRouteUsesHmacSignature: true,
      idempotentWebhookDeliveryIds: config.webhook?.requireDeliveryId === true,
      productionMode: config.deployment?.mode === "production",
      agentBranchNamespace: {
        required:
          config.policy?.requireAgentBranchNamespaceForAgentPrs === true,
        prefix: config.policy?.agentBranchNamespacePrefix ?? "agent",
        pattern: `${config.policy?.agentBranchNamespacePrefix ?? "agent"}/{agentId}/`,
      },
      agentRunReceipts: {
        required:
          config.policy?.requireAgentRunReceiptForAgentPrs === true ||
          config.policy?.requireVerifiedAgentRunReceiptForAgentPrs === true,
        verified:
          config.policy?.requireVerifiedAgentRunReceiptForAgentPrs === true,
        signatureAlgorithm: "hmac-sha256",
      },
      workItems: {
        requiredForAgentPrs: config.policy?.requireWorkItemForAgentPrs === true,
        linkRequiredBeforeMerge: true,
        matchKeys: ["pullRequestId", "taskId", "issueId"],
        activeStates: ["backlog", "ready", "in_progress", "blocked"],
        terminalStates: ["done", "cancelled"],
      },
      agentIdentityRegistry: {
        required:
          config.policy?.requireAgentIdentityRegistryForAgentPrs === true,
        knownAgentIdCount:
          agentIdentityRegistry?.knownAgentIdCount ??
          config.policy?.knownAgentIds?.length ??
          0,
        configuredAgentIdCount:
          agentIdentityRegistry?.configuredAgentIdCount ??
          config.policy?.knownAgentIds?.length ??
          0,
        persistedActiveAgentIdCount:
          agentIdentityRegistry?.persistedActiveAgentIdCount ?? 0,
        identifier: "ownerAgentId",
      },
      mergeExecution: buildMergeExecutionHints(config),
      productionEvidence: buildProductionEvidenceHints(),
    },
  };
}

function buildProductionEvidenceHints() {
  return {
    artifactRootEnv: "ELIZA_ARTIFACT_ROOT",
    templateFile: PRODUCTION_EVIDENCE_TEMPLATE_FILENAME,
    assembledEvidenceFile: PRODUCTION_EVIDENCE_FILENAME,
    templateEndpoint: PRODUCTION_EVIDENCE_TEMPLATE_PATH,
    commands: {
      template: PRODUCTION_EVIDENCE_TEMPLATE_COMMAND,
      inventory: PRODUCTION_EVIDENCE_USAGE.inventoryCommand,
      assemble: PRODUCTION_EVIDENCE_USAGE.assembleCommand,
      gate: PRODUCTION_EVIDENCE_USAGE.gateCommand,
    },
    strictGateRequired: true,
    inventoryMustPassBeforeAssemble: true,
    generatedEvidenceMustStayPrivate: true,
  };
}

function buildMergeExecutionHints(config) {
  const integrationEnabled = config.integration?.enabled === true;
  const integrationDryRun = config.integration?.dryRun !== false;
  const liveIntegrationActive =
    integrationEnabled && integrationDryRun === false;

  return {
    integrationEnabled,
    integrationDryRun,
    liveIntegrationActive,
    executor: config.integration?.executor ?? "none",
    batchingAllowed: config.integration?.allowBatching === true,
    maxBatchSize: config.integration?.maxBatchSize ?? null,
    branchPrefix: config.integration?.branchPrefix ?? "eliza-queue",
    branchPushEnabled: config.integration?.pushBranch === true,
    emptyRequiredChecksAllowed:
      config.integration?.allowEmptyRequiredChecks === true,
    workerEnabled: config.worker?.enabled === true,
    workerLiveExecutionConfirmed: config.worker?.confirmLiveExecution === true,
    workerLeaseEnabled: config.worker?.leaseEnabled === true,
    workerLeaseIdConfigured: Boolean(config.worker?.leaseId),
    liveAgentMergesEvidenceGated: true,
    liveAgentMergesAllowedWithoutProductionEvidence: false,
    productionCutoverRequired: true,
  };
}

function buildSurfaceManifest() {
  return {
    git: {
      authority: "forgejo_native",
      source: "forgejo",
      notes:
        "Repositories, branches, tags, commits, pull requests, issues, releases, packages, wiki, and Actions remain Forgejo-owned.",
    },
    projectBoard: {
      authority: "eliza_computed",
      source: "merge_steward_queue_state",
      link: "/api/project-board",
      forgejoProjectsSync: "not_enabled",
      notes:
        "Kanban columns are computed for Eliza Cloud and agent clients; they are not a Forgejo Projects v2 clone.",
    },
    fleetCoordination: {
      authority: "eliza_steward",
      source: "merge_steward_coordination_policy",
      link: "/api/fleet-coordination",
      notes:
        "Agent-readable claim protocol, board flow, evidence expectations, and shared-lever exclusivity rules for fleet work.",
    },
    workItems: {
      authority: "eliza_steward",
      source: "merge_steward_work_items",
      link: "/api/work-items",
      related: ["/api/work-cycles", "/api/work-modules", "/api/work-progress"],
      notes:
        "Durable agent work records connect intent, repo scope, owners, paths, packages, cycles, modules, linked issues, linked PRs, and state.",
    },
    workPlanning: {
      authority: "eliza_steward",
      source: "merge_steward_work_cycles_modules_pages",
      links: {
        cycles: "/api/work-cycles",
        modules: "/api/work-modules",
        pages: "/api/work-pages",
        progress: "/api/work-progress",
        views: "/api/work-views",
        viewEvaluation: "/api/work-views/evaluate",
        dashboard: "/api/work-dashboard",
        context: "/api/work-context",
        agentCockpitTemplate: "/api/agents/{agentId}/cockpit",
        intake: "/api/work-intake",
        intakeApply: "/api/work-intake/apply",
      },
      forgejoNativeEquivalent: "not_available",
      notes:
        "Eliza Work cycles, modules, pages, saved views, dashboards, context resume packets, queue-to-work intake automation, and progress snapshots provide GitHub Projects-style planning and runbook context for agent swarms.",
    },
    mergeQueue: {
      authority: "eliza_steward",
      source: "merge_steward_policy_runtime",
      link: "/api/merge-queue",
      trainPlan: "/api/merge-train",
      queueItemActionPlan: "/api/queue/item/action-plan",
      forgejoNativeEquivalent: "not_available",
      notes:
        "Merge queue decisions and read-only train plans come from Merge Steward policy, queue state, live protection audits, and guarded integration execution.",
    },
    discussions: {
      authority: "not_forgejo_native",
      status: "not_supported_as_native_discussions",
      replacementSurfaces: [
        "pull_request_comments",
        "human_requests",
        "approvals",
        "signals",
      ],
      notes:
        "Use PR comments and Eliza Steward human-request/approval flows until a first-class discussion sync exists.",
    },
    actions: {
      authority: "forgejo_actions",
      source: "forgejo_runner_pool",
      marketplaceCompatibility: "not_guaranteed",
      notes:
        "Forgejo Actions are supported for trusted checks; GitHub Marketplace parity is not assumed.",
    },
  };
}

function buildAuthManifest(config = {}) {
  const modes = [];
  if (config.oidc?.enabled === true) {
    modes.push("oidc_bearer");
  }
  if (config.apiAuth?.required === true) {
    modes.push("static_bearer");
  }
  if (modes.length === 0) {
    modes.push("local_optional");
  }

  return {
    requiredForApiRoutes:
      config.apiAuth?.required === true || config.oidc?.enabled === true,
    modes,
    oidc:
      config.oidc?.enabled === true
        ? {
            issuer: config.oidc.issuerUrl ?? null,
            audience: config.oidc.audience ?? null,
          }
        : null,
    bearerHeader: "Authorization: Bearer <token>",
    webhookSignatureHeaders: [
      "X-Forgejo-Signature",
      "X-Gitea-Signature",
      "X-Hub-Signature-256",
    ],
  };
}
