import { encodeStewardSegment, resolveStewardUrl } from "./client.js";
import {
  PRODUCTION_EVIDENCE_FILENAME,
  PRODUCTION_EVIDENCE_TEMPLATE_COMMAND,
  PRODUCTION_EVIDENCE_TEMPLATE_FILENAME,
  PRODUCTION_EVIDENCE_TEMPLATE_PATH,
  PRODUCTION_EVIDENCE_USAGE,
} from "./production-evidence-template.js";

const DEFAULT_REQUIRED_METRICS = Object.freeze([
  "eliza_merge_steward_info",
  "eliza_merge_steward_ready",
  "eliza_merge_steward_check_ok",
  "eliza_merge_steward_agent_identity_registry_required",
  "eliza_merge_steward_work_item_required",
  "eliza_merge_steward_known_agent_id_count",
  "eliza_merge_steward_queue_items",
  "eliza_merge_steward_runs",
  "eliza_merge_steward_agent_performance_agents",
  "eliza_merge_steward_agent_routing_recommendations",
  "eliza_merge_steward_scrape_errors",
]);

const DISCOVERY_PATH = "/.well-known/eliza-hub.json";
const OPENAPI_PATH = "/openapi.json";

export async function runDeploymentDoctor({
  baseUrl,
  token,
  fetchImpl = fetch,
  requireMetrics = true,
  requireProductApis = true,
  requiredMetrics = DEFAULT_REQUIRED_METRICS,
  smokeRepo = "elizaos/eliza",
  smokeAgent = "eliza-smoke-agent",
} = {}) {
  if (!baseUrl) {
    throw new TypeError("Deployment doctor requires a base URL");
  }

  const target = normalizeBaseUrl(baseUrl);
  const checks = [];

  const health = await fetchJson(fetchImpl, stewardUrl(target, "/health"), {
    token,
  });
  checks.push(
    checkFromHttpJson({
      name: "health",
      response: health,
      validate: (body) => body?.ok === true,
      errorCode: "health_not_ok",
    }),
  );

  const ready = await fetchJson(fetchImpl, stewardUrl(target, "/ready"), {
    token,
  });
  const readyCheck = checkFromHttpJson({
    name: "ready",
    response: ready,
    validate: (body) => body?.ok === true,
    errorCode: "ready_not_ok",
  });
  checks.push(readyCheck);

  const discovery = await fetchJson(
    fetchImpl,
    stewardUrl(target, DISCOVERY_PATH),
    { token },
  );
  checks.push(
    checkFromHttpJson({
      name: "discovery_manifest",
      response: discovery,
      validate: (body) =>
        body?.service === "eliza-merge-steward" &&
        body?.links?.self === DISCOVERY_PATH &&
        body?.links?.openapi === OPENAPI_PATH &&
        body?.links?.githubParity === "/api/github-parity" &&
        body?.links?.productionReadiness === "/api/production-readiness" &&
        body?.links?.productionCutover === "/api/production-cutover" &&
        body?.links?.productionEvidenceTemplate ===
          "/api/production-evidence-template" &&
        body?.links?.search === "/api/search" &&
        body?.links?.workItems === "/api/work-items" &&
        body?.links?.workItem === "/api/work-items/item" &&
        body?.links?.workItemTransition === "/api/work-items/transition" &&
        body?.links?.workCycles === "/api/work-cycles" &&
        body?.links?.workCycle === "/api/work-cycles/item" &&
        body?.links?.workCycleTransition === "/api/work-cycles/transition" &&
        body?.links?.workModules === "/api/work-modules" &&
        body?.links?.workModule === "/api/work-modules/item" &&
        body?.links?.workModuleTransition === "/api/work-modules/transition" &&
        body?.links?.workProgress === "/api/work-progress" &&
        body?.links?.workViews === "/api/work-views" &&
        body?.links?.workView === "/api/work-views/item" &&
        body?.links?.workViewEvaluation === "/api/work-views/evaluate" &&
        body?.links?.workViewTransition === "/api/work-views/transition" &&
        body?.links?.workPages === "/api/work-pages" &&
        body?.links?.workPage === "/api/work-pages/item" &&
        body?.links?.workPageTransition === "/api/work-pages/transition" &&
        body?.links?.workDashboard === "/api/work-dashboard" &&
        body?.links?.workContext === "/api/work-context" &&
        body?.links?.workIntake === "/api/work-intake" &&
        body?.links?.workIntakeApply === "/api/work-intake/apply" &&
        body?.links?.mergeTrain === "/api/merge-train" &&
        body?.links?.queueItemActionPlan === "/api/queue/item/action-plan" &&
        body?.links?.queueSimulation === "/api/queue/simulate" &&
        body?.links?.pullRequestBrief === "/api/pr/brief" &&
        body?.links?.reviewAssignment === "/api/review/assignment" &&
        body?.links?.patchConflictPrediction ===
          "/api/patch/conflict-prediction" &&
        body?.links?.releaseNotes === "/api/releases/notes" &&
        body?.links?.agentActionPlanTemplate ===
          "/api/agents/{agentId}/action-plan" &&
        body?.links?.agentSubmissionGateTemplate ===
          "/api/agents/{agentId}/submission-gate" &&
        body?.links?.agentWorkPreflightTemplate ===
          "/api/agents/{agentId}/work-preflight" &&
        body?.links?.agentWorkReservationTemplate ===
          "/api/agents/{agentId}/work-reservation" &&
        body?.links?.releaseReadiness === "/api/release-readiness" &&
        body?.links?.repositoryProtection === "/api/repository-protection" &&
        body?.links?.ciValidationPlan === "/api/ci/validation-plan" &&
        body?.links?.agentIdentities === "/api/agent-identities" &&
        body?.links?.agentBootstrapTemplate ===
          "/api/agents/{agentId}/bootstrap" &&
        body?.links?.agentCockpitTemplate === "/api/agents/{agentId}/cockpit" &&
        body?.links?.fleetCoordination === "/api/fleet-coordination" &&
        Array.isArray(body?.capabilities) &&
        body.capabilities.includes("agent_routing") &&
        body.capabilities.includes("repo_search") &&
        body.capabilities.includes("work_items") &&
        body.capabilities.includes("work_cycles") &&
        body.capabilities.includes("work_modules") &&
        body.capabilities.includes("work_progress") &&
        body.capabilities.includes("work_views") &&
        body.capabilities.includes("work_view_evaluation") &&
        body.capabilities.includes("work_pages") &&
        body.capabilities.includes("work_dashboard") &&
        body.capabilities.includes("work_context_resume") &&
        body.capabilities.includes("agent_bootstrap") &&
        body.capabilities.includes("agent_cockpit") &&
        body.capabilities.includes("merge_train_plan") &&
        body.capabilities.includes("queue_item_action_plan") &&
        body.capabilities.includes("agent_action_plan") &&
        body.capabilities.includes("queue_simulation") &&
        body.capabilities.includes("agent_submission_gate") &&
        body.capabilities.includes("agent_work_preflight") &&
        body.capabilities.includes("agent_work_reservation") &&
        body.capabilities.includes("agent_identity_registry_policy") &&
        body.capabilities.includes("release_readiness") &&
        body.capabilities.includes("fleet_coordination_contract") &&
        body.capabilities.includes("repository_protection") &&
        body.capabilities.includes("ci_failure_analysis") &&
        body.capabilities.includes("ci_validation_plan") &&
        body.capabilities.includes("pull_request_brief") &&
        body.capabilities.includes("review_assignment") &&
        body.capabilities.includes("patch_conflict_prediction") &&
        body.capabilities.includes("release_notes") &&
        body.capabilities.includes("claim_next") &&
        body.capabilities.includes("github_parity_matrix") &&
        body.capabilities.includes("production_readiness_checklist") &&
        body.capabilities.includes("production_cutover_plan") &&
        body.capabilities.includes("production_evidence_inventory") &&
        body.capabilities.includes("production_evidence_template") &&
        body?.githubParity?.status ===
          "forgejo_plus_eliza_not_full_github_parity" &&
        body?.githubParity?.link === "/api/github-parity" &&
        body?.githubParity?.githubDropInReplacement === false &&
        body?.githubParity?.productionReadyWithoutPrivateEvidence === false &&
        body?.githubParity?.migrationGuardrailIds?.includes(
          "not_drop_in_github",
        ) &&
        body?.githubParity?.migrationGuardrailIds?.includes(
          "live_merges_evidence_gated",
        ) &&
        body?.githubParity?.agentNativeAdditionIds?.includes("agent_cockpit") &&
        body?.githubParity?.agentNativeAdditionIds?.includes(
          "queue_item_action_plans",
        ) &&
        body?.productionReadiness?.status ===
          "blocked_until_private_evidence_passes" &&
        body?.productionReadiness?.link === "/api/production-readiness" &&
        body?.productionReadiness?.privateEvidenceRequired === true &&
        validDiscoveryMergeExecutionHints(body?.clientHints?.mergeExecution) &&
        validDiscoveryProductionEvidenceHints(
          body?.clientHints?.productionEvidence,
        ) &&
        body?.surfaces?.projectBoard?.authority === "eliza_computed" &&
        body?.surfaces?.projectBoard?.forgejoProjectsSync === "not_enabled" &&
        body?.surfaces?.workItems?.authority === "eliza_steward" &&
        body?.surfaces?.workPlanning?.authority === "eliza_steward" &&
        body?.surfaces?.discussions?.status ===
          "not_supported_as_native_discussions" &&
        body?.surfaces?.mergeQueue?.authority === "eliza_steward",
      errorCode: "discovery_manifest_not_ok",
    }),
  );

  const openapi = await fetchJson(
    fetchImpl,
    stewardUrl(target, discovery.body?.links?.openapi ?? OPENAPI_PATH),
    { token },
  );
  checks.push(
    checkFromHttpJson({
      name: "openapi_contract",
      response: openapi,
      validate: (body) =>
        body?.openapi === "3.1.0" &&
        body?.info?.title === "Eliza Merge Steward API" &&
        Boolean(body?.paths?.[DISCOVERY_PATH]?.get) &&
        Boolean(body?.paths?.["/api/github-parity"]?.get) &&
        Boolean(body?.paths?.["/api/production-readiness"]?.get) &&
        Boolean(body?.paths?.["/api/production-cutover"]?.get) &&
        Boolean(body?.paths?.["/api/production-evidence-template"]?.get) &&
        Boolean(body?.paths?.["/api/queue/simulate"]?.post) &&
        Boolean(body?.paths?.["/api/search"]?.get) &&
        Boolean(body?.paths?.["/api/search"]?.post) &&
        Boolean(body?.paths?.["/api/work-items"]?.get) &&
        Boolean(body?.paths?.["/api/work-items"]?.post) &&
        Boolean(body?.paths?.["/api/work-items/item"]?.get) &&
        Boolean(body?.paths?.["/api/work-items/transition"]?.post) &&
        Boolean(body?.paths?.["/api/work-cycles"]?.get) &&
        Boolean(body?.paths?.["/api/work-cycles"]?.post) &&
        Boolean(body?.paths?.["/api/work-cycles/item"]?.get) &&
        Boolean(body?.paths?.["/api/work-cycles/transition"]?.post) &&
        Boolean(body?.paths?.["/api/work-modules"]?.get) &&
        Boolean(body?.paths?.["/api/work-modules"]?.post) &&
        Boolean(body?.paths?.["/api/work-modules/item"]?.get) &&
        Boolean(body?.paths?.["/api/work-modules/transition"]?.post) &&
        Boolean(body?.paths?.["/api/work-progress"]?.get) &&
        Boolean(body?.paths?.["/api/work-views"]?.get) &&
        Boolean(body?.paths?.["/api/work-views"]?.post) &&
        Boolean(body?.paths?.["/api/work-views/item"]?.get) &&
        Boolean(body?.paths?.["/api/work-views/evaluate"]?.get) &&
        Boolean(body?.paths?.["/api/work-views/evaluate"]?.post) &&
        Boolean(body?.paths?.["/api/work-views/transition"]?.post) &&
        Boolean(body?.paths?.["/api/work-pages"]?.get) &&
        Boolean(body?.paths?.["/api/work-pages"]?.post) &&
        Boolean(body?.paths?.["/api/work-pages/item"]?.get) &&
        Boolean(body?.paths?.["/api/work-pages/transition"]?.post) &&
        Boolean(body?.paths?.["/api/work-dashboard"]?.get) &&
        Boolean(body?.paths?.["/api/work-context"]?.get) &&
        Boolean(body?.paths?.["/api/work-intake"]?.get) &&
        Boolean(body?.paths?.["/api/work-intake/apply"]?.post) &&
        Boolean(body?.paths?.["/api/merge-train"]?.get) &&
        Boolean(body?.paths?.["/api/queue/item/action-plan"]?.get) &&
        Boolean(body?.paths?.["/api/fleet-coordination"]?.get) &&
        Boolean(body?.paths?.["/api/agent-routing"]?.get) &&
        Boolean(body?.paths?.["/api/agents/{agentId}/bootstrap"]?.get) &&
        Boolean(body?.paths?.["/api/agents/{agentId}/cockpit"]?.get) &&
        Boolean(body?.paths?.["/api/agents/{agentId}/action-plan"]?.post) &&
        Boolean(body?.paths?.["/api/agents/{agentId}/submission-gate"]?.post) &&
        Boolean(body?.paths?.["/api/agents/{agentId}/work-preflight"]?.post) &&
        Boolean(
          body?.paths?.["/api/agents/{agentId}/work-reservation"]?.post,
        ) &&
        Boolean(body?.paths?.["/api/release-readiness"]?.get) &&
        Boolean(body?.paths?.["/api/repository-protection"]?.get) &&
        Boolean(body?.paths?.["/api/agent-identities"]?.get) &&
        Boolean(body?.paths?.["/api/agent-identities"]?.post) &&
        Boolean(body?.paths?.["/api/ci/failure-analysis"]?.post) &&
        Boolean(body?.paths?.["/api/ci/validation-plan"]?.post) &&
        Boolean(body?.paths?.["/api/pr/brief"]?.post) &&
        Boolean(body?.paths?.["/api/review/assignment"]?.post) &&
        Boolean(body?.paths?.["/api/patch/conflict-prediction"]?.post) &&
        Boolean(body?.paths?.["/api/releases/notes"]?.post),
      errorCode: "openapi_contract_not_ok",
    }),
  );

  if (ready.body) {
    const runtimePreflight = findReadyCheck(ready.body, "runtime_preflight");
    checks.push({
      name: "runtime_preflight",
      ok: runtimePreflight?.ok === true,
      status: runtimePreflight?.ok === true ? "ok" : "failed",
      errors: runtimePreflight?.errors ?? [],
      warnings: runtimePreflight?.warnings ?? [],
    });

    checks.push(strictWorkReservationCheck(ready.body.configuration));
    checks.push(strictWorkItemCheck(ready.body.configuration));
    checks.push(agentBranchNamespaceCheck(ready.body.configuration));
    checks.push(verifiedAgentRunReceiptCheck(ready.body.configuration));
    checks.push(agentIdentityRegistryCheck(ready.body.configuration));

    if (
      ready.body.configuration?.workerEnabled === true &&
      ready.body.configuration?.workerLeaseEnabled === true
    ) {
      const workerLease = findReadyCheck(ready.body, "worker_lease");
      checks.push({
        name: "worker_lease",
        ok: workerLease?.ok === true,
        status: workerLease?.ok === true ? "ok" : "failed",
        leaseId: workerLease?.leaseId ?? null,
        ownerId: workerLease?.ownerId ?? null,
        expiresAt: workerLease?.expiresAt ?? null,
        error: workerLease?.error ?? null,
      });
    }
  }

  if (requireMetrics) {
    const metrics = await fetchText(fetchImpl, stewardUrl(target, "/metrics"), {
      token,
    });
    const missingMetrics = metrics.ok
      ? missingMetricNames(metrics.body, requiredMetrics)
      : requiredMetrics;
    checks.push({
      name: "metrics",
      ok: metrics.ok && missingMetrics.length === 0,
      statusCode: metrics.statusCode,
      status: metrics.ok && missingMetrics.length === 0 ? "ok" : "failed",
      missingMetrics,
      error: metrics.error ?? null,
    });
  }

  if (requireProductApis) {
    const workflowUrl = stewardUrl(target, "/api/workflows", {
      readiness: false,
    });
    const workflow = await fetchJson(fetchImpl, workflowUrl, { token });
    checks.push(
      checkFromHttpJson({
        name: "workflow_api",
        response: workflow,
        validate: (body) =>
          body?.workflow &&
          Array.isArray(body.workflow.cards) &&
          typeof body.workflow.operations?.status === "string" &&
          typeof body.workflow.operations?.mergeQueue?.status === "string",
        errorCode: "workflow_api_not_ok",
      }),
    );

    const githubParity = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/github-parity"),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "github_parity_api",
        response: githubParity,
        validate: (body) =>
          body?.parity?.status ===
            "forgejo_plus_eliza_not_full_github_parity" &&
          body?.parity?.summary?.githubDropInReplacement === false &&
          body?.parity?.summary?.productionReadyWithoutPrivateEvidence ===
            false &&
          Array.isArray(body?.parity?.migrationGuardrails) &&
          Array.isArray(body?.parity?.surfaces) &&
          body.parity.migrationGuardrails.some(
            (guardrail) => guardrail.id === "not_drop_in_github",
          ) &&
          body.parity.migrationGuardrails.some(
            (guardrail) => guardrail.id === "live_merges_evidence_gated",
          ) &&
          body.parity.surfaces.some(
            (surface) =>
              surface.id === "merge_queue" &&
              surface.status === "eliza_steward",
          ) &&
          body.parity.surfaces.some(
            (surface) =>
              surface.id === "discussions" &&
              surface.status === "not_supported" &&
              surface.githubDropInReplacement === false,
          ),
        errorCode: "github_parity_api_not_ok",
      }),
    );

    const productionReadiness = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/production-readiness"),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "production_readiness_api",
        response: productionReadiness,
        validate: (body) =>
          body?.productionReadiness?.status ===
            "blocked_until_private_evidence_passes" &&
          body?.productionReadiness?.privateEvidenceRequired === true &&
          Array.isArray(body?.productionReadiness?.domains) &&
          body.productionReadiness.domains.some(
            (domain) =>
              domain.id === "sso_registration" &&
              domain.evidenceBlock === "sso",
          ) &&
          body.productionReadiness.domains.some(
            (domain) =>
              domain.id === "merge_queue_rollout" &&
              domain.evidenceBlock === "mergeQueueRollout",
          ) &&
          Array.isArray(
            body?.productionReadiness?.authoritativeGate?.gateChecks,
          ),
        errorCode: "production_readiness_api_not_ok",
      }),
    );

    const productionCutover = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/production-cutover"),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "production_cutover_api",
        response: productionCutover,
        validate: (body) =>
          body?.productionCutover?.readOnly === true &&
          body?.productionCutover?.status === "blocked" &&
          body?.productionCutover?.privateEvidenceRequired === true &&
          body?.productionCutover?.guardrails?.liveAgentMergesAllowed ===
            false &&
          Array.isArray(body?.productionCutover?.phases) &&
          Array.isArray(body?.productionCutover?.executionPlan?.orderedSteps),
        errorCode: "production_cutover_api_not_ok",
      }),
    );

    const productionEvidenceTemplate = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/production-evidence-template"),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "production_evidence_template_api",
        response: productionEvidenceTemplate,
        validate: (body) =>
          body?.productionEvidenceTemplate?.readOnly === true &&
          body?.productionEvidenceTemplate?.privateEvidenceRequired === true &&
          body?.productionEvidenceTemplate?.storesPrivateEvidence === false &&
          body?.productionEvidenceTemplate?.templatePassesProductionGate ===
            false &&
          body?.productionEvidenceTemplate?.summary?.shapeValid === true &&
          Array.isArray(body?.productionEvidenceTemplate?.requiredBlocks) &&
          body.productionEvidenceTemplate.requiredBlocks.includes("sso") &&
          body?.productionEvidenceTemplate?.usage?.inventoryCommand ===
            PRODUCTION_EVIDENCE_USAGE.inventoryCommand &&
          body?.productionEvidenceTemplate?.usage?.assembleCommand ===
            PRODUCTION_EVIDENCE_USAGE.assembleCommand &&
          body?.productionEvidenceTemplate?.usage?.gateCommand ===
            PRODUCTION_EVIDENCE_USAGE.gateCommand &&
          body?.productionEvidenceTemplate?.template?.sso?.smokeEvidence ===
            null &&
          body?.productionEvidenceTemplate?.template?.sso?.bootstrapEvidence ===
            null,
        errorCode: "production_evidence_template_api_not_ok",
      }),
    );

    const projectBoardUrl = stewardUrl(target, "/api/project-board", {
      repo: smokeRepo,
      readiness: false,
    });
    const projectBoard = await fetchJson(fetchImpl, projectBoardUrl, { token });
    checks.push(
      checkFromHttpJson({
        name: "project_board_api",
        response: projectBoard,
        validate: (body) => body?.board && Array.isArray(body.board.columns),
        errorCode: "project_board_api_not_ok",
      }),
    );

    const workItems = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-items", {
        repo: smokeRepo,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_items_api",
        response: workItems,
        validate: (body) => body && Array.isArray(body.workItems),
        errorCode: "work_items_api_not_ok",
      }),
    );

    const workCycles = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-cycles", {
        repo: smokeRepo,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_cycles_api",
        response: workCycles,
        validate: (body) => body && Array.isArray(body.workCycles),
        errorCode: "work_cycles_api_not_ok",
      }),
    );

    const workModules = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-modules", {
        repo: smokeRepo,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_modules_api",
        response: workModules,
        validate: (body) => body && Array.isArray(body.workModules),
        errorCode: "work_modules_api_not_ok",
      }),
    );

    const workProgress = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-progress", {
        repo: smokeRepo,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_progress_api",
        response: workProgress,
        validate: (body) =>
          body?.workProgress &&
          typeof body.workProgress.summary?.total === "number",
        errorCode: "work_progress_api_not_ok",
      }),
    );

    const workViews = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-views", {
        repo: smokeRepo,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_views_api",
        response: workViews,
        validate: (body) => body && Array.isArray(body.workViews),
        errorCode: "work_views_api_not_ok",
      }),
    );

    const workViewEvaluation = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-views/evaluate"),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          maxItems: 5,
          maxPages: 5,
          view: {
            repo: smokeRepo,
            title: "Smoke docs view",
            kind: "kanban",
            filters: {
              packages: ["docs"],
            },
          },
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_view_evaluation_api",
        response: workViewEvaluation,
        validate: (body) =>
          body?.workViewEvaluation &&
          Array.isArray(body.workViewEvaluation.rows) &&
          Array.isArray(body.workViewEvaluation.columns) &&
          typeof body.workViewEvaluation.summary?.totalItems === "number",
        errorCode: "work_view_evaluation_api_not_ok",
      }),
    );

    const workPages = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-pages", {
        repo: smokeRepo,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_pages_api",
        response: workPages,
        validate: (body) => body && Array.isArray(body.workPages),
        errorCode: "work_pages_api_not_ok",
      }),
    );

    const fleetCoordination = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/fleet-coordination", {
        repo: smokeRepo,
        ownerAgentId: smokeAgent,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "fleet_coordination_api",
        response: fleetCoordination,
        validate: (body) =>
          body?.coordinationContract &&
          Array.isArray(body.coordinationContract.sharedLevers),
        errorCode: "fleet_coordination_api_not_ok",
      }),
    );

    const workContext = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-context", {
        repo: smokeRepo,
        ownerAgentId: smokeAgent,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_context_api",
        response: workContext,
        validate: (body) =>
          body?.workContext?.readOnly === true &&
          Array.isArray(body.workContext.nextActions),
        errorCode: "work_context_api_not_ok",
      }),
    );

    const workDashboard = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-dashboard", {
        repo: smokeRepo,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_dashboard_api",
        response: workDashboard,
        validate: (body) =>
          body?.workDashboard &&
          Array.isArray(body.workDashboard.views?.builtIn),
        errorCode: "work_dashboard_api_not_ok",
      }),
    );

    const workIntake = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/work-intake", {
        repo: smokeRepo,
      }),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "work_intake_api",
        response: workIntake,
        validate: (body) =>
          body?.workIntake && Array.isArray(body.workIntake.actions),
        errorCode: "work_intake_api_not_ok",
      }),
    );

    const mergeQueueUrl = stewardUrl(target, "/api/merge-queue", {
      repo: smokeRepo,
      readiness: false,
    });
    const mergeQueue = await fetchJson(fetchImpl, mergeQueueUrl, { token });
    checks.push(
      checkFromHttpJson({
        name: "merge_queue_api",
        response: mergeQueue,
        validate: (body) =>
          body?.mergeQueue &&
          Array.isArray(body.mergeQueue.lanes) &&
          typeof body.mergeQueue.diagnostics?.health === "string",
        errorCode: "merge_queue_api_not_ok",
      }),
    );

    const mergeTrainUrl = stewardUrl(target, "/api/merge-train", {
      repo: smokeRepo,
      readiness: false,
    });
    const mergeTrain = await fetchJson(fetchImpl, mergeTrainUrl, { token });
    checks.push(
      checkFromHttpJson({
        name: "merge_train_api",
        response: mergeTrain,
        validate: (body) =>
          body?.mergeTrain?.readOnly === true &&
          body?.mergeTrain?.selectedTrain &&
          body?.mergeTrain?.preflight?.status &&
          Array.isArray(body?.mergeTrain?.lanes) &&
          Array.isArray(body?.mergeTrain?.labels),
        errorCode: "merge_train_api_not_ok",
      }),
    );

    const search = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/search"),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          query: "smoke action log",
          documents: [
            {
              kind: "actions_log",
              id: "smoke-actions-log",
              repo: smokeRepo,
              title: "smoke action log",
              body: "Smoke Actions log for deployment doctor search verification.",
            },
          ],
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "search_api",
        response: search,
        validate: (body) =>
          body?.search?.summary?.matchedDocuments === 1 &&
          Array.isArray(body?.search?.results) &&
          body.search.results[0]?.kind === "actions_log",
        errorCode: "search_api_not_ok",
      }),
    );

    const queueSimulation = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/queue/simulate"),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          targetBranch: "main",
          proposedItem: {
            id: `${smokeRepo}#0-simulation`,
            repo: smokeRepo,
            pullRequestId: 0,
            sourceBranch: `agent/${smokeAgent.replaceAll("/", "-")}/queue-simulation`,
            targetBranch: "main",
            ownerAgentId: smokeAgent,
            authorKind: "agent",
            agentKnown: true,
            hasIssueLink: true,
            hasExecutionPlan: true,
            hasValidationPlan: true,
            targetProtected: true,
            reviewSatisfied: true,
            headShaMatches: true,
            changedFiles: ["README.md"],
            affectedPackages: ["docs"],
            requiredChecks: [],
          },
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "queue_simulation_api",
        response: queueSimulation,
        validate: (body) =>
          body?.simulation?.readOnly === true &&
          Array.isArray(body?.simulation?.proposed) &&
          body.simulation.proposed.length === 1 &&
          Boolean(body?.simulation?.baseline?.counts) &&
          Boolean(body?.simulation?.simulated?.counts),
        errorCode: "queue_simulation_api_not_ok",
      }),
    );

    const agentIdentities = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/agent-identities"),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "agent_identities_api",
        response: agentIdentities,
        validate: (body) =>
          body &&
          Array.isArray(body.agents) &&
          body.summary &&
          typeof body.summary.knownAgentIdCount === "number",
        errorCode: "agent_identities_api_not_ok",
      }),
    );

    const releaseReadinessUrl = stewardUrl(target, "/api/release-readiness", {
      repo: smokeRepo,
      readiness: false,
    });
    const releaseReadiness = await fetchJson(fetchImpl, releaseReadinessUrl, {
      token,
    });
    checks.push(
      checkFromHttpJson({
        name: "release_readiness_api",
        response: releaseReadiness,
        validate: (body) =>
          body?.releaseReadiness?.status &&
          Array.isArray(body.releaseReadiness.checks),
        errorCode: "release_readiness_api_not_ok",
      }),
    );

    const repositoryProtectionUrl = stewardUrl(
      target,
      "/api/repository-protection",
      {
        repo: smokeRepo,
        requireLive: false,
      },
    );
    const repositoryProtection = await fetchJson(
      fetchImpl,
      repositoryProtectionUrl,
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "repository_protection_api",
        response: repositoryProtection,
        validate: (body) =>
          body?.repositoryProtection?.status &&
          Array.isArray(body.repositoryProtection.checks),
        errorCode: "repository_protection_api_not_ok",
      }),
    );

    const agentInsightsUrl = stewardUrl(target, "/api/agent-insights", {
      repo: smokeRepo,
      readiness: false,
    });
    const agentInsights = await fetchJson(fetchImpl, agentInsightsUrl, {
      token,
    });
    checks.push(
      checkFromHttpJson({
        name: "agent_insights_api",
        response: agentInsights,
        validate: (body) =>
          body?.insights && Array.isArray(body.insights.recommendations),
        errorCode: "agent_insights_api_not_ok",
      }),
    );

    const agentCapacityUrl = stewardUrl(target, "/api/agents", {
      repo: smokeRepo,
      readiness: false,
    });
    const agentCapacity = await fetchJson(fetchImpl, agentCapacityUrl, {
      token,
    });
    checks.push(
      checkFromHttpJson({
        name: "agent_capacity_api",
        response: agentCapacity,
        validate: (body) => body?.agents && Array.isArray(body.agents.agents),
        errorCode: "agent_capacity_api_not_ok",
      }),
    );

    const agentPerformanceUrl = stewardUrl(target, "/api/agent-performance", {
      repo: smokeRepo,
      readiness: false,
    });
    const agentPerformance = await fetchJson(fetchImpl, agentPerformanceUrl, {
      token,
    });
    checks.push(
      checkFromHttpJson({
        name: "agent_performance_api",
        response: agentPerformance,
        validate: (body) =>
          body?.performance && Array.isArray(body.performance.agents),
        errorCode: "agent_performance_api_not_ok",
      }),
    );

    const agentRoutingUrl = stewardUrl(target, "/api/agent-routing", {
      repo: smokeRepo,
      readiness: false,
    });
    const agentRouting = await fetchJson(fetchImpl, agentRoutingUrl, { token });
    checks.push(
      checkFromHttpJson({
        name: "agent_routing_api",
        response: agentRouting,
        validate: (body) =>
          body?.routing && Array.isArray(body.routing.recommendations),
        errorCode: "agent_routing_api_not_ok",
      }),
    );

    const agentBootstrap = await fetchJson(
      fetchImpl,
      stewardUrl(
        target,
        `/api/agents/${encodeStewardSegment(smokeAgent)}/bootstrap`,
        {
          repo: smokeRepo,
          readiness: false,
        },
      ),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "agent_bootstrap_api",
        response: agentBootstrap,
        validate: (body) =>
          body?.bootstrap?.agentId === smokeAgent &&
          body?.bootstrap?.links?.workPreflight &&
          Array.isArray(body?.bootstrap?.nextActions),
        errorCode: "agent_bootstrap_api_not_ok",
      }),
    );

    const agentCockpit = await fetchJson(
      fetchImpl,
      stewardUrl(
        target,
        `/api/agents/${encodeStewardSegment(smokeAgent)}/cockpit`,
        {
          repo: smokeRepo,
          targetBranch: "main",
          readiness: false,
        },
      ),
      { token },
    );
    checks.push(
      checkFromHttpJson({
        name: "agent_cockpit_api",
        response: agentCockpit,
        validate: (body) =>
          body?.cockpit?.agentId === smokeAgent &&
          body?.cockpit?.readOnly === true &&
          body?.cockpit?.summary &&
          Array.isArray(body?.cockpit?.focusCards) &&
          Array.isArray(body?.cockpit?.nextActions),
        errorCode: "agent_cockpit_api_not_ok",
      }),
    );

    const agentActionPlan = await fetchJson(
      fetchImpl,
      stewardUrl(
        target,
        `/api/agents/${encodeStewardSegment(smokeAgent)}/action-plan`,
      ),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          targetBranch: "main",
          query: "smoke action plan",
          commands: ["turbo run typecheck --filter=@elizaos/core"],
          proposedItem: {
            repo: smokeRepo,
            targetBranch: "main",
            sourceBranch: `agent/${smokeAgent}/smoke-action-plan`,
            ownerAgentId: smokeAgent,
            authorKind: "agent",
            agentKnown: true,
            hasIssueLink: true,
            hasExecutionPlan: true,
            hasValidationPlan: true,
            changedFiles: ["README.md"],
            affectedPackages: ["docs"],
          },
          documents: [
            {
              kind: "actions_log",
              id: "doctor-action-plan-log",
              repo: smokeRepo,
              targetBranch: "main",
              ownerAgentId: smokeAgent,
              title: "smoke action plan",
              body: "smoke action plan context",
            },
          ],
          readiness: false,
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "agent_action_plan_api",
        response: agentActionPlan,
        validate: (body) =>
          body?.actionPlan?.readOnly === true &&
          body?.actionPlan?.agentId === smokeAgent &&
          body?.actionPlan?.decision?.state &&
          Array.isArray(body?.actionPlan?.checks) &&
          Array.isArray(body?.actionPlan?.nextSteps) &&
          Array.isArray(body?.actionPlan?.labels),
        errorCode: "agent_action_plan_api_not_ok",
      }),
    );

    const agentSubmissionGate = await fetchJson(
      fetchImpl,
      stewardUrl(
        target,
        `/api/agents/${encodeStewardSegment(smokeAgent)}/submission-gate`,
      ),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          proposedItem: {
            repo: smokeRepo,
            ownerAgentId: smokeAgent,
            authorKind: "agent",
            agentKnown: true,
            hasIssueLink: true,
            hasExecutionPlan: true,
            hasValidationPlan: true,
            changedFiles: ["README.md"],
            requiredChecks: [],
          },
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "agent_submission_gate_api",
        response: agentSubmissionGate,
        validate: (body) =>
          body?.gate?.decision?.allowed === true &&
          Array.isArray(body?.gate?.labels),
        errorCode: "agent_submission_gate_api_not_ok",
      }),
    );

    const agentWorkPreflight = await fetchJson(
      fetchImpl,
      stewardUrl(
        target,
        `/api/agents/${encodeStewardSegment(smokeAgent)}/work-preflight`,
      ),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          targetBranch: "main",
          changedFiles: ["README.md"],
          affectedPackages: ["docs"],
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "agent_work_preflight_api",
        response: agentWorkPreflight,
        validate: (body) =>
          body?.preflight?.decision?.allowed === true &&
          Array.isArray(body?.preflight?.suggestedClaims) &&
          body.preflight.suggestedClaims.length > 0,
        errorCode: "agent_work_preflight_api_not_ok",
      }),
    );

    const agentWorkReservation = await fetchJson(
      fetchImpl,
      stewardUrl(
        target,
        `/api/agents/${encodeStewardSegment(smokeAgent)}/work-reservation`,
      ),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          targetBranch: "main",
          changedFiles: ["README.md"],
          affectedPackages: ["docs"],
          dryRun: true,
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "agent_work_reservation_api",
        response: agentWorkReservation,
        validate: (body) =>
          body?.reservation?.dryRun === true &&
          body?.reservation?.reason === "dry_run" &&
          body?.reservation?.workItemAction === "planned" &&
          body?.reservation?.plannedWorkItem?.state === "claimed" &&
          Array.isArray(body?.reservation?.requestedClaims) &&
          body.reservation.requestedClaims.length > 0,
        errorCode: "agent_work_reservation_api_not_ok",
      }),
    );

    const ciFailureAnalysis = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/ci/failure-analysis"),
      {
        token,
        method: "POST",
        body: {
          item: {
            id: `${smokeRepo}#0`,
            repo: smokeRepo,
            ownerAgentId: smokeAgent,
          },
          checks: [
            {
              name: "smoke",
              conclusion: "failure",
              log: "AssertionError: smoke failure route test",
            },
          ],
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "ci_failure_analysis_api",
        response: ciFailureAnalysis,
        validate: (body) =>
          body?.analysis?.summary?.primaryCategory === "test_failure",
        errorCode: "ci_failure_analysis_api_not_ok",
      }),
    );

    const ciValidationPlan = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/ci/validation-plan"),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          ownerAgentId: smokeAgent,
          changedFiles: ["packages/core/src/runtime.ts"],
          commands: ["turbo run typecheck --filter=@elizaos/core"],
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "ci_validation_plan_api",
        response: ciValidationPlan,
        validate: (body) =>
          body?.validationPlan?.decision?.allowed === true &&
          Array.isArray(body?.validationPlan?.commands) &&
          body.validationPlan.commands.some(
            (command) => command.scope === "scoped",
          ),
        errorCode: "ci_validation_plan_api_not_ok",
      }),
    );

    const pullRequestBrief = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/pr/brief"),
      {
        token,
        method: "POST",
        body: {
          item: {
            id: `${smokeRepo}#0`,
            repo: smokeRepo,
            pullRequestId: 0,
            ownerAgentId: smokeAgent,
            authorKind: "agent",
            agentKnown: true,
            hasIssueLink: true,
            hasExecutionPlan: true,
            hasValidationPlan: true,
            targetProtected: true,
            reviewSatisfied: true,
            headShaMatches: true,
            changedFiles: ["README.md"],
            requiredChecks: [],
          },
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "pull_request_brief_api",
        response: pullRequestBrief,
        validate: (body) =>
          Array.isArray(body?.brief?.labels) &&
          body.brief.labels.includes("risk:low"),
        errorCode: "pull_request_brief_api_not_ok",
      }),
    );

    const reviewAssignment = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/review/assignment"),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          targetBranch: "main",
          ownerAgentId: smokeAgent,
          changedFiles: ["README.md"],
          affectedPackages: ["docs"],
          now: new Date().toISOString(),
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "review_assignment_api",
        response: reviewAssignment,
        validate: (body) =>
          body?.assignment?.decision?.state &&
          Array.isArray(body?.assignment?.suggestedReviewers) &&
          Array.isArray(body?.assignment?.labels),
        errorCode: "review_assignment_api_not_ok",
      }),
    );

    const patchConflictPrediction = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/patch/conflict-prediction"),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          targetBranch: "main",
          ownerAgentId: smokeAgent,
          changedFiles: ["README.md"],
          affectedPackages: ["docs"],
          now: new Date().toISOString(),
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "patch_conflict_prediction_api",
        response: patchConflictPrediction,
        validate: (body) =>
          body?.prediction?.prediction?.safeToStart === true &&
          Array.isArray(body?.prediction?.labels),
        errorCode: "patch_conflict_prediction_api_not_ok",
      }),
    );

    const releaseNotes = await fetchJson(
      fetchImpl,
      stewardUrl(target, "/api/releases/notes"),
      {
        token,
        method: "POST",
        body: {
          repo: smokeRepo,
          version: "smoke",
          items: [
            {
              repo: smokeRepo,
              pullRequestId: 0,
              title: "feat: smoke release note",
              authorKind: "agent",
              ownerAgentId: smokeAgent,
              targetBranch: "main",
              pullRequestMerged: true,
              mergedAt: new Date().toISOString(),
              affectedPackages: ["core"],
              labels: ["feature"],
            },
          ],
        },
      },
    );
    checks.push(
      checkFromHttpJson({
        name: "release_notes_api",
        response: releaseNotes,
        validate: (body) =>
          body?.notes?.summary?.totalMergedPullRequests === 1 &&
          typeof body?.notes?.markdown === "string" &&
          body.notes.markdown.includes("smoke release note"),
        errorCode: "release_notes_api_not_ok",
      }),
    );

    const agentInboxUrl = stewardUrl(
      target,
      `/api/agents/${encodeStewardSegment(smokeAgent)}/inbox`,
      {
        repo: smokeRepo,
        readiness: false,
      },
    );
    const agentInbox = await fetchJson(fetchImpl, agentInboxUrl, { token });
    checks.push(
      checkFromHttpJson({
        name: "agent_inbox_api",
        response: agentInbox,
        validate: (body) => body?.inbox && Array.isArray(body.inbox.cards),
        errorCode: "agent_inbox_api_not_ok",
      }),
    );
  }

  return {
    ok: checks.every((check) => check.ok === true),
    target: target.href.replace(/\/$/, ""),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function strictWorkReservationCheck(configuration = {}) {
  const liveIntegrationActive =
    configuration?.integrationEnabled === true &&
    configuration?.integrationDryRun === false;
  const strictWorkReservations =
    configuration?.requireWorkReservationForAgentPrs === true;
  const ok = !liveIntegrationActive || strictWorkReservations;

  return {
    name: "strict_work_reservations",
    ok,
    status: ok ? "ok" : "failed",
    liveIntegrationActive,
    integrationEnabled: configuration?.integrationEnabled === true,
    integrationDryRun: configuration?.integrationDryRun !== false,
    requireWorkReservationForAgentPrs: strictWorkReservations,
    error: ok ? null : "live_integration_requires_strict_work_reservations",
  };
}

function strictWorkItemCheck(configuration = {}) {
  const liveIntegrationActive =
    configuration?.integrationEnabled === true &&
    configuration?.integrationDryRun === false;
  const strictWorkItems = configuration?.requireWorkItemForAgentPrs === true;
  const ok = !liveIntegrationActive || strictWorkItems;

  return {
    name: "strict_work_items",
    ok,
    status: ok ? "ok" : "failed",
    liveIntegrationActive,
    integrationEnabled: configuration?.integrationEnabled === true,
    integrationDryRun: configuration?.integrationDryRun !== false,
    requireWorkItemForAgentPrs: strictWorkItems,
    error: ok ? null : "live_integration_requires_strict_work_items",
  };
}

function agentBranchNamespaceCheck(configuration = {}) {
  const liveIntegrationActive =
    configuration?.integrationEnabled === true &&
    configuration?.integrationDryRun === false;
  const strictAgentBranchNamespaces =
    configuration?.requireAgentBranchNamespaceForAgentPrs === true;
  const ok = !liveIntegrationActive || strictAgentBranchNamespaces;

  return {
    name: "strict_agent_branch_namespaces",
    ok,
    status: ok ? "ok" : "failed",
    liveIntegrationActive,
    integrationEnabled: configuration?.integrationEnabled === true,
    integrationDryRun: configuration?.integrationDryRun !== false,
    requireAgentBranchNamespaceForAgentPrs: strictAgentBranchNamespaces,
    error: ok ? null : "live_integration_requires_agent_branch_namespaces",
  };
}

function verifiedAgentRunReceiptCheck(configuration = {}) {
  const liveIntegrationActive =
    configuration?.integrationEnabled === true &&
    configuration?.integrationDryRun === false;
  const verifiedAgentRunReceipts =
    configuration?.requireVerifiedAgentRunReceiptForAgentPrs === true;
  const ok = !liveIntegrationActive || verifiedAgentRunReceipts;

  return {
    name: "verified_agent_run_receipts",
    ok,
    status: ok ? "ok" : "failed",
    liveIntegrationActive,
    integrationEnabled: configuration?.integrationEnabled === true,
    integrationDryRun: configuration?.integrationDryRun !== false,
    requireVerifiedAgentRunReceiptForAgentPrs: verifiedAgentRunReceipts,
    error: ok ? null : "live_integration_requires_verified_agent_run_receipts",
  };
}

function agentIdentityRegistryCheck(configuration = {}) {
  const liveIntegrationActive =
    configuration?.integrationEnabled === true &&
    configuration?.integrationDryRun === false;
  const registryRequired =
    configuration?.requireAgentIdentityRegistryForAgentPrs === true;
  const knownAgentIdCount = Number.isFinite(configuration?.knownAgentIdCount)
    ? configuration.knownAgentIdCount
    : 0;
  const ok =
    !liveIntegrationActive || (registryRequired && knownAgentIdCount > 0);

  return {
    name: "agent_identity_registry",
    ok,
    status: ok ? "ok" : "failed",
    liveIntegrationActive,
    integrationEnabled: configuration?.integrationEnabled === true,
    integrationDryRun: configuration?.integrationDryRun !== false,
    requireAgentIdentityRegistryForAgentPrs: registryRequired,
    knownAgentIdCount,
    error: ok ? null : "live_integration_requires_agent_identity_registry",
  };
}

function validDiscoveryMergeExecutionHints(hints = {}) {
  const liveIntegrationActive =
    hints.integrationEnabled === true && hints.integrationDryRun === false;

  return (
    typeof hints.integrationEnabled === "boolean" &&
    typeof hints.integrationDryRun === "boolean" &&
    hints.liveIntegrationActive === liveIntegrationActive &&
    typeof hints.workerEnabled === "boolean" &&
    typeof hints.workerLiveExecutionConfirmed === "boolean" &&
    typeof hints.workerLeaseEnabled === "boolean" &&
    hints.liveAgentMergesEvidenceGated === true &&
    hints.liveAgentMergesAllowedWithoutProductionEvidence === false &&
    hints.productionCutoverRequired === true
  );
}

function validDiscoveryProductionEvidenceHints(hints = {}) {
  return (
    hints.artifactRootEnv === "ELIZA_ARTIFACT_ROOT" &&
    hints.templateFile === PRODUCTION_EVIDENCE_TEMPLATE_FILENAME &&
    hints.assembledEvidenceFile === PRODUCTION_EVIDENCE_FILENAME &&
    hints.templateEndpoint === PRODUCTION_EVIDENCE_TEMPLATE_PATH &&
    hints.commands?.template === PRODUCTION_EVIDENCE_TEMPLATE_COMMAND &&
    hints.commands?.inventory === PRODUCTION_EVIDENCE_USAGE.inventoryCommand &&
    hints.commands?.assemble === PRODUCTION_EVIDENCE_USAGE.assembleCommand &&
    hints.commands?.gate === PRODUCTION_EVIDENCE_USAGE.gateCommand &&
    hints.strictGateRequired === true &&
    hints.inventoryMustPassBeforeAssemble === true &&
    hints.generatedEvidenceMustStayPrivate === true
  );
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("Deployment doctor URL must use http or https");
  }
  url.search = "";
  url.hash = "";
  return url;
}

function stewardUrl(target, path, query = {}) {
  return resolveStewardUrl(target, path, query);
}

async function fetchJson(fetchImpl, url, { token, method = "GET", body } = {}) {
  const response = await safeFetch(fetchImpl, url, { token, method, body });
  if (!response.response) return response;
  let responseBody = null;
  try {
    responseBody = await response.response.json();
  } catch (error) {
    // error-policy:J3 non-JSON response body becomes an explicit failed check
    // result
    return {
      ok: false,
      statusCode: response.response.status,
      body: null,
      error: error instanceof Error ? error.message : "invalid_json",
    };
  }
  return {
    ok: response.response.ok,
    statusCode: response.response.status,
    body: responseBody,
  };
}

async function fetchText(fetchImpl, url, { token } = {}) {
  const response = await safeFetch(fetchImpl, url, { token });
  if (!response.response) return response;
  const body = await response.response.text();
  return {
    ok: response.response.ok,
    statusCode: response.response.status,
    body,
  };
}

async function safeFetch(fetchImpl, url, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  try {
    return {
      response: await fetchImpl(url, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    };
  } catch (error) {
    // error-policy:J1 doctor probe boundary: network failure becomes a
    // structured failed check, which is exactly what the report exists to show
    return {
      ok: false,
      statusCode: null,
      body: null,
      error: error instanceof Error ? error.message : "fetch_failed",
    };
  }
}

function checkFromHttpJson({ name, response, validate, errorCode }) {
  const ok = response.ok === true && validate(response.body);
  return {
    name,
    ok,
    statusCode: response.statusCode,
    status: ok ? "ok" : "failed",
    error: ok ? null : (response.error ?? response.body?.error ?? errorCode),
  };
}

function findReadyCheck(body = {}, name) {
  return (body.checks ?? []).find((check) => check.name === name) ?? null;
}

function missingMetricNames(body, requiredMetrics) {
  return requiredMetrics.filter((name) => !metricExists(body, name));
}

function metricExists(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(?:# HELP\\s+${escaped}\\b|${escaped}(?:\\{|\\s))`,
    "m",
  ).test(body);
}
