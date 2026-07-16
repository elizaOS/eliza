import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { buildDiscoveryManifest, DISCOVERY_PATH } from "../src/discovery.js";

describe("agent discovery manifest", () => {
  it("describes stable agent-native capabilities and route links", () => {
    const manifest = buildDiscoveryManifest({
      config: loadConfig(),
      version: "0.1.0",
    });

    assert.equal(manifest.service, "eliza-merge-steward");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.discoveryVersion, 1);
    assert.equal(manifest.links.self, DISCOVERY_PATH);
    assert.equal(manifest.links.openapi, "/openapi.json");
    assert.equal(manifest.links.githubParity, "/api/github-parity");
    assert.equal(
      manifest.links.productionReadiness,
      "/api/production-readiness",
    );
    assert.equal(manifest.links.productionCutover, "/api/production-cutover");
    assert.equal(
      manifest.links.productionEvidenceTemplate,
      "/api/production-evidence-template",
    );
    assert.equal(manifest.links.search, "/api/search");
    assert.equal(manifest.links.workItems, "/api/work-items");
    assert.equal(manifest.links.workItem, "/api/work-items/item");
    assert.equal(
      manifest.links.workItemTransition,
      "/api/work-items/transition",
    );
    assert.equal(manifest.links.workCycles, "/api/work-cycles");
    assert.equal(manifest.links.workCycle, "/api/work-cycles/item");
    assert.equal(
      manifest.links.workCycleTransition,
      "/api/work-cycles/transition",
    );
    assert.equal(manifest.links.workModules, "/api/work-modules");
    assert.equal(manifest.links.workModule, "/api/work-modules/item");
    assert.equal(
      manifest.links.workModuleTransition,
      "/api/work-modules/transition",
    );
    assert.equal(manifest.links.workProgress, "/api/work-progress");
    assert.equal(manifest.links.workViews, "/api/work-views");
    assert.equal(manifest.links.workView, "/api/work-views/item");
    assert.equal(manifest.links.workViewEvaluation, "/api/work-views/evaluate");
    assert.equal(
      manifest.links.workViewTransition,
      "/api/work-views/transition",
    );
    assert.equal(manifest.links.workPages, "/api/work-pages");
    assert.equal(manifest.links.workPage, "/api/work-pages/item");
    assert.equal(
      manifest.links.workPageTransition,
      "/api/work-pages/transition",
    );
    assert.equal(manifest.links.workDashboard, "/api/work-dashboard");
    assert.equal(manifest.links.workContext, "/api/work-context");
    assert.equal(manifest.links.workIntake, "/api/work-intake");
    assert.equal(manifest.links.workIntakeApply, "/api/work-intake/apply");
    assert.equal(manifest.links.mergeTrain, "/api/merge-train");
    assert.equal(
      manifest.links.queueItemActionPlan,
      "/api/queue/item/action-plan",
    );
    assert.equal(manifest.links.queueSimulation, "/api/queue/simulate");
    assert.equal(
      manifest.links.agentSubmissionGateTemplate,
      "/api/agents/{agentId}/submission-gate",
    );
    assert.equal(manifest.links.releaseReadiness, "/api/release-readiness");
    assert.equal(
      manifest.links.repositoryProtection,
      "/api/repository-protection",
    );
    assert.equal(manifest.links.ciFailureAnalysis, "/api/ci/failure-analysis");
    assert.equal(manifest.links.ciValidationPlan, "/api/ci/validation-plan");
    assert.equal(manifest.links.pullRequestBrief, "/api/pr/brief");
    assert.equal(manifest.links.reviewAssignment, "/api/review/assignment");
    assert.equal(
      manifest.links.patchConflictPrediction,
      "/api/patch/conflict-prediction",
    );
    assert.equal(manifest.links.releaseNotes, "/api/releases/notes");
    assert.equal(manifest.links.agentIdentities, "/api/agent-identities");
    assert.equal(
      manifest.links.agentBootstrapTemplate,
      "/api/agents/{agentId}/bootstrap",
    );
    assert.equal(
      manifest.links.agentCockpitTemplate,
      "/api/agents/{agentId}/cockpit",
    );
    assert.equal(
      manifest.links.agentActionPlanTemplate,
      "/api/agents/{agentId}/action-plan",
    );
    assert.equal(
      manifest.links.agentWorkPreflightTemplate,
      "/api/agents/{agentId}/work-preflight",
    );
    assert.equal(
      manifest.links.agentWorkReservationTemplate,
      "/api/agents/{agentId}/work-reservation",
    );
    assert.equal(
      manifest.links.agentInboxTemplate,
      "/api/agents/{agentId}/inbox",
    );
    assert.equal(manifest.links.fleetCoordination, "/api/fleet-coordination");
    for (const [name, link] of Object.entries(manifest.links)) {
      assert.equal(
        typeof link,
        "string",
        `discovery link ${name} must be a string`,
      );
    }
    for (const templateKey of [
      "agentBootstrapTemplate",
      "agentCockpitTemplate",
      "agentActionPlanTemplate",
      "agentSubmissionGateTemplate",
      "agentWorkPreflightTemplate",
      "agentWorkReservationTemplate",
      "agentInboxTemplate",
      "claimAssignmentTemplate",
      "claimNextTemplate",
    ]) {
      assert.match(manifest.links[templateKey], /\{agentId\}/);
    }
    assert.equal(manifest.auth.requiredForApiRoutes, false);
    assert.deepEqual(manifest.auth.modes, ["local_optional"]);
    assert.equal(manifest.auth.oidc, null);
    assert.equal(manifest.auth.bearerHeader, "Authorization: Bearer <token>");
    assert.deepEqual(manifest.auth.webhookSignatureHeaders, [
      "X-Forgejo-Signature",
      "X-Gitea-Signature",
      "X-Hub-Signature-256",
    ]);
    assert.equal(manifest.clientHints.pathParametersMustBeUrlEncoded, true);
    assert.equal(manifest.clientHints.productionMode, false);
    assert.equal(manifest.clientHints.agentBranchNamespace.required, false);
    assert.equal(manifest.clientHints.agentBranchNamespace.prefix, "agent");
    assert.equal(
      manifest.clientHints.agentBranchNamespace.pattern,
      "agent/{agentId}/",
    );
    assert.equal(manifest.clientHints.agentRunReceipts.required, false);
    assert.equal(manifest.clientHints.agentRunReceipts.verified, false);
    assert.equal(
      manifest.clientHints.agentRunReceipts.signatureAlgorithm,
      "hmac-sha256",
    );
    assert.equal(manifest.clientHints.workItems.requiredForAgentPrs, false);
    assert.equal(manifest.clientHints.workItems.linkRequiredBeforeMerge, true);
    assert.deepEqual(manifest.clientHints.workItems.matchKeys, [
      "pullRequestId",
      "taskId",
      "issueId",
    ]);
    assert.deepEqual(manifest.clientHints.workItems.activeStates, [
      "backlog",
      "ready",
      "in_progress",
      "blocked",
    ]);
    assert.deepEqual(manifest.clientHints.workItems.terminalStates, [
      "done",
      "cancelled",
    ]);
    assert.equal(manifest.clientHints.agentIdentityRegistry.required, false);
    assert.equal(
      manifest.clientHints.agentIdentityRegistry.knownAgentIdCount,
      0,
    );
    assert.equal(
      manifest.clientHints.agentIdentityRegistry.configuredAgentIdCount,
      0,
    );
    assert.equal(
      manifest.clientHints.agentIdentityRegistry.persistedActiveAgentIdCount,
      0,
    );
    assert.equal(
      manifest.clientHints.agentIdentityRegistry.identifier,
      "ownerAgentId",
    );
    assert.equal(manifest.clientHints.mergeExecution.integrationEnabled, false);
    assert.equal(manifest.clientHints.mergeExecution.integrationDryRun, true);
    assert.equal(
      manifest.clientHints.mergeExecution.liveIntegrationActive,
      false,
    );
    assert.equal(manifest.clientHints.mergeExecution.executor, "none");
    assert.equal(manifest.clientHints.mergeExecution.batchingAllowed, false);
    assert.equal(manifest.clientHints.mergeExecution.maxBatchSize, null);
    assert.equal(
      manifest.clientHints.mergeExecution.branchPrefix,
      "eliza-queue",
    );
    assert.equal(manifest.clientHints.mergeExecution.branchPushEnabled, false);
    assert.equal(
      manifest.clientHints.mergeExecution.emptyRequiredChecksAllowed,
      false,
    );
    assert.equal(manifest.clientHints.mergeExecution.workerEnabled, false);
    assert.equal(
      manifest.clientHints.mergeExecution.workerLiveExecutionConfirmed,
      false,
    );
    assert.equal(manifest.clientHints.mergeExecution.workerLeaseEnabled, true);
    assert.equal(
      manifest.clientHints.mergeExecution.workerLeaseIdConfigured,
      true,
    );
    assert.equal(
      manifest.clientHints.mergeExecution.liveAgentMergesEvidenceGated,
      true,
    );
    assert.equal(
      manifest.clientHints.mergeExecution
        .liveAgentMergesAllowedWithoutProductionEvidence,
      false,
    );
    assert.equal(
      manifest.clientHints.mergeExecution.productionCutoverRequired,
      true,
    );
    assert.ok(manifest.capabilities.includes("agent_routing"));
    assert.ok(manifest.capabilities.includes("repo_search"));
    assert.ok(manifest.capabilities.includes("work_items"));
    assert.ok(manifest.capabilities.includes("agent_work_item_policy"));
    assert.ok(manifest.capabilities.includes("work_cycles"));
    assert.ok(manifest.capabilities.includes("work_modules"));
    assert.ok(manifest.capabilities.includes("work_progress"));
    assert.ok(manifest.capabilities.includes("work_views"));
    assert.ok(manifest.capabilities.includes("work_view_evaluation"));
    assert.ok(manifest.capabilities.includes("work_pages"));
    assert.ok(manifest.capabilities.includes("work_dashboard"));
    assert.ok(manifest.capabilities.includes("work_context_resume"));
    assert.ok(manifest.capabilities.includes("work_intake"));
    assert.ok(manifest.capabilities.includes("merge_train_plan"));
    assert.ok(manifest.capabilities.includes("queue_item_action_plan"));
    assert.ok(manifest.capabilities.includes("agent_bootstrap"));
    assert.ok(manifest.capabilities.includes("agent_cockpit"));
    assert.ok(manifest.capabilities.includes("agent_action_plan"));
    assert.ok(manifest.capabilities.includes("queue_simulation"));
    assert.ok(manifest.capabilities.includes("agent_submission_gate"));
    assert.ok(manifest.capabilities.includes("agent_work_preflight"));
    assert.ok(manifest.capabilities.includes("agent_work_reservation"));
    assert.ok(manifest.capabilities.includes("agent_branch_namespace_policy"));
    assert.ok(
      manifest.capabilities.includes("verified_agent_run_receipt_policy"),
    );
    assert.ok(manifest.capabilities.includes("agent_identity_registry_policy"));
    assert.ok(manifest.capabilities.includes("release_readiness"));
    assert.ok(manifest.capabilities.includes("repository_protection"));
    assert.ok(manifest.capabilities.includes("ci_failure_analysis"));
    assert.ok(manifest.capabilities.includes("ci_validation_plan"));
    assert.ok(manifest.capabilities.includes("pull_request_brief"));
    assert.ok(manifest.capabilities.includes("review_assignment"));
    assert.ok(manifest.capabilities.includes("patch_conflict_prediction"));
    assert.ok(manifest.capabilities.includes("release_notes"));
    assert.ok(manifest.capabilities.includes("claim_next"));
    assert.ok(manifest.capabilities.includes("fleet_coordination_contract"));
    assert.ok(manifest.capabilities.includes("github_parity_matrix"));
    assert.ok(manifest.capabilities.includes("production_readiness_checklist"));
    assert.ok(manifest.capabilities.includes("production_cutover_plan"));
    assert.ok(manifest.capabilities.includes("production_evidence_inventory"));
    assert.ok(manifest.capabilities.includes("production_evidence_template"));
    assert.ok(manifest.capabilities.includes("signed_forgejo_webhooks"));
    assert.equal(
      manifest.githubParity.status,
      "forgejo_plus_eliza_not_full_github_parity",
    );
    assert.equal(manifest.githubParity.link, "/api/github-parity");
    assert.equal(manifest.githubParity.githubDropInReplacement, false);
    assert.equal(
      manifest.githubParity.productionReadyWithoutPrivateEvidence,
      false,
    );
    assert.ok(
      manifest.githubParity.migrationGuardrailIds.includes(
        "not_drop_in_github",
      ),
    );
    assert.ok(
      manifest.githubParity.migrationGuardrailIds.includes(
        "live_merges_evidence_gated",
      ),
    );
    assert.ok(
      manifest.githubParity.agentNativeAdditionIds.includes("agent_cockpit"),
    );
    assert.ok(
      manifest.githubParity.agentNativeAdditionIds.includes(
        "queue_item_action_plans",
      ),
    );
    assert.ok(
      manifest.githubParity.unsupportedNativeSurfaces.includes("discussions"),
    );
    assert.ok(
      manifest.githubParity.partialOrDelegatedSurfaces.includes("actions"),
    );
    assert.equal(
      manifest.productionReadiness.status,
      "blocked_until_private_evidence_passes",
    );
    assert.equal(
      manifest.productionReadiness.link,
      "/api/production-readiness",
    );
    assert.equal(manifest.productionReadiness.privateEvidenceRequired, true);
    assert.ok(
      manifest.productionReadiness.requiredEvidenceBlocks.includes("sso"),
    );
    assert.equal(manifest.surfaces.git.authority, "forgejo_native");
    assert.equal(manifest.surfaces.projectBoard.authority, "eliza_computed");
    assert.equal(
      manifest.surfaces.projectBoard.forgejoProjectsSync,
      "not_enabled",
    );
    assert.equal(
      manifest.surfaces.fleetCoordination.authority,
      "eliza_steward",
    );
    assert.equal(
      manifest.surfaces.fleetCoordination.link,
      "/api/fleet-coordination",
    );
    assert.equal(manifest.surfaces.workItems.authority, "eliza_steward");
    assert.equal(manifest.surfaces.workPlanning.authority, "eliza_steward");
    assert.equal(
      manifest.surfaces.workPlanning.links.progress,
      "/api/work-progress",
    );
    assert.equal(manifest.surfaces.workPlanning.links.views, "/api/work-views");
    assert.equal(
      manifest.surfaces.workPlanning.links.viewEvaluation,
      "/api/work-views/evaluate",
    );
    assert.equal(manifest.surfaces.workPlanning.links.pages, "/api/work-pages");
    assert.equal(
      manifest.surfaces.workPlanning.links.dashboard,
      "/api/work-dashboard",
    );
    assert.equal(
      manifest.surfaces.workPlanning.links.context,
      "/api/work-context",
    );
    assert.equal(
      manifest.surfaces.workPlanning.links.agentCockpitTemplate,
      "/api/agents/{agentId}/cockpit",
    );
    assert.equal(
      manifest.surfaces.workPlanning.links.intake,
      "/api/work-intake",
    );
    assert.equal(
      manifest.surfaces.workPlanning.links.intakeApply,
      "/api/work-intake/apply",
    );
    assert.equal(manifest.surfaces.mergeQueue.authority, "eliza_steward");
    assert.equal(manifest.surfaces.mergeQueue.trainPlan, "/api/merge-train");
    assert.equal(
      manifest.surfaces.mergeQueue.queueItemActionPlan,
      "/api/queue/item/action-plan",
    );
    assert.equal(
      manifest.surfaces.discussions.status,
      "not_supported_as_native_discussions",
    );
    assert.ok(
      manifest.surfaces.discussions.replacementSurfaces.includes(
        "human_requests",
      ),
    );
    for (const [name, surface] of Object.entries(manifest.surfaces)) {
      assert.equal(
        typeof surface.authority,
        "string",
        `surface ${name} must publish authority`,
      );
      assert.equal(
        typeof surface.notes,
        "string",
        `surface ${name} must publish notes`,
      );
    }
  });

  it("reports hardened auth and webhook hints without exposing secret values", () => {
    const config = loadConfig({
      MERGE_STEWARD_DEPLOYMENT_MODE: "production",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_OIDC_ENABLED: "true",
      OIDC_ISSUER_URL: "https://cloud.example.invalid",
      OIDC_AUDIENCE: "eliza-merge-steward",
      MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_AGENT_BRANCH_NAMESPACE_PREFIX: "bots",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-codex,agent-docs",
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
      MERGE_STEWARD_INTEGRATION_BATCHING: "true",
      MERGE_STEWARD_INTEGRATION_MAX_BATCH_SIZE: "3",
      MERGE_STEWARD_INTEGRATION_BRANCH_PREFIX: "eliza-live-queue",
      MERGE_STEWARD_INTEGRATION_PUSH_BRANCH: "true",
      MERGE_STEWARD_WORKER_ENABLED: "true",
      MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "true",
      MERGE_STEWARD_WORKER_LEASE_ENABLED: "true",
      MERGE_STEWARD_WORKER_LEASE_ID: "merge-queue-prod",
    });
    const manifest = buildDiscoveryManifest({
      config,
      version: "0.1.0",
      agentIdentityRegistry: {
        knownAgentIdCount: 3,
        configuredAgentIdCount: 2,
        persistedActiveAgentIdCount: 1,
      },
    });
    const serialized = JSON.stringify(manifest);

    assert.equal(manifest.auth.requiredForApiRoutes, true);
    assert.deepEqual(manifest.auth.modes, ["oidc_bearer", "static_bearer"]);
    assert.equal(manifest.auth.oidc.issuer, "https://cloud.example.invalid");
    assert.equal(manifest.auth.oidc.audience, "eliza-merge-steward");
    assert.equal(manifest.auth.bearerHeader, "Authorization: Bearer <token>");
    assert.deepEqual(manifest.auth.webhookSignatureHeaders, [
      "X-Forgejo-Signature",
      "X-Gitea-Signature",
      "X-Hub-Signature-256",
    ]);
    assert.equal(manifest.clientHints.apiRoutesUseBearerAuth, true);
    assert.equal(manifest.clientHints.idempotentWebhookDeliveryIds, true);
    assert.equal(manifest.clientHints.productionMode, true);
    assert.equal(manifest.clientHints.agentBranchNamespace.required, true);
    assert.equal(manifest.clientHints.agentBranchNamespace.prefix, "bots");
    assert.equal(
      manifest.clientHints.agentBranchNamespace.pattern,
      "bots/{agentId}/",
    );
    assert.equal(manifest.clientHints.agentRunReceipts.required, true);
    assert.equal(manifest.clientHints.agentRunReceipts.verified, true);
    assert.equal(manifest.clientHints.workItems.requiredForAgentPrs, true);
    assert.deepEqual(manifest.clientHints.workItems.activeStates, [
      "backlog",
      "ready",
      "in_progress",
      "blocked",
    ]);
    assert.deepEqual(manifest.clientHints.workItems.terminalStates, [
      "done",
      "cancelled",
    ]);
    assert.equal(manifest.clientHints.agentIdentityRegistry.required, true);
    assert.equal(
      manifest.clientHints.agentIdentityRegistry.knownAgentIdCount,
      3,
    );
    assert.equal(
      manifest.clientHints.agentIdentityRegistry.configuredAgentIdCount,
      2,
    );
    assert.equal(
      manifest.clientHints.agentIdentityRegistry.persistedActiveAgentIdCount,
      1,
    );
    assert.equal(manifest.clientHints.mergeExecution.integrationEnabled, true);
    assert.equal(manifest.clientHints.mergeExecution.integrationDryRun, false);
    assert.equal(
      manifest.clientHints.mergeExecution.liveIntegrationActive,
      true,
    );
    assert.equal(manifest.clientHints.mergeExecution.executor, "local-git");
    assert.equal(manifest.clientHints.mergeExecution.batchingAllowed, true);
    assert.equal(manifest.clientHints.mergeExecution.maxBatchSize, 3);
    assert.equal(
      manifest.clientHints.mergeExecution.branchPrefix,
      "eliza-live-queue",
    );
    assert.equal(manifest.clientHints.mergeExecution.branchPushEnabled, true);
    assert.equal(manifest.clientHints.mergeExecution.workerEnabled, true);
    assert.equal(
      manifest.clientHints.mergeExecution.workerLiveExecutionConfirmed,
      true,
    );
    assert.equal(manifest.clientHints.mergeExecution.workerLeaseEnabled, true);
    assert.equal(
      manifest.clientHints.mergeExecution.workerLeaseIdConfigured,
      true,
    );
    assert.equal(
      manifest.clientHints.mergeExecution.liveAgentMergesEvidenceGated,
      true,
    );
    assert.equal(
      manifest.clientHints.mergeExecution
        .liveAgentMergesAllowedWithoutProductionEvidence,
      false,
    );
    assert.equal(
      manifest.clientHints.mergeExecution.productionCutoverRequired,
      true,
    );
    assert.equal(
      manifest.clientHints.productionEvidence.artifactRootEnv,
      "ELIZA_ARTIFACT_ROOT",
    );
    assert.equal(
      manifest.clientHints.productionEvidence.templateFile,
      "eliza-hub-production-evidence.template.json",
    );
    assert.equal(
      manifest.clientHints.productionEvidence.assembledEvidenceFile,
      "eliza-hub-production-evidence.json",
    );
    assert.equal(
      manifest.clientHints.productionEvidence.templateEndpoint,
      "/api/production-evidence-template",
    );
    assert.match(
      manifest.clientHints.productionEvidence.commands.template,
      /production-evidence-template/,
    );
    assert.match(
      manifest.clientHints.productionEvidence.commands.inventory,
      /production-evidence-inventory\.mjs --strict/,
    );
    assert.match(
      manifest.clientHints.productionEvidence.commands.assemble,
      /production-evidence-assemble\.mjs/,
    );
    assert.match(
      manifest.clientHints.productionEvidence.commands.gate,
      /production-gate --strict/,
    );
    assert.equal(
      manifest.clientHints.productionEvidence.strictGateRequired,
      true,
    );
    assert.equal(
      manifest.clientHints.productionEvidence.inventoryMustPassBeforeAssemble,
      true,
    );
    assert.equal(
      manifest.clientHints.productionEvidence.generatedEvidenceMustStayPrivate,
      true,
    );
    assert.doesNotMatch(serialized, /MERGE_STEWARD_API_TOKEN/);
    assert.doesNotMatch(serialized, /FORGEJO_WEBHOOK_SECRET/);
    assert.doesNotMatch(serialized, /merge-queue-prod/);
  });
});
