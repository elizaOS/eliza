import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runDeploymentDoctor } from "../src/deployment-doctor.js";

describe("deployment doctor", () => {
  it("passes when health readiness and required metrics are healthy", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid/",
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(200, {
          ok: true,
          configuration: {
            integrationEnabled: true,
            integrationDryRun: false,
            requireWorkReservationForAgentPrs: true,
            requireWorkItemForAgentPrs: true,
            requireAgentBranchNamespaceForAgentPrs: true,
            requireVerifiedAgentRunReceiptForAgentPrs: true,
            requireAgentIdentityRegistryForAgentPrs: true,
            knownAgentIdCount: 1,
            workerEnabled: true,
            workerLeaseEnabled: true,
          },
          checks: [
            { name: "queue_store", ok: true },
            {
              name: "worker_lease",
              ok: true,
              leaseId: "merge-queue",
              ownerId: "worker-a",
              expiresAt: "2026-07-06T00:00:30.000Z",
            },
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, discoveryManifest()),
        "/openapi.json": jsonResponse(200, openApiContract()),
        "/metrics": textResponse(
          200,
          [
            "# HELP eliza_merge_steward_info info",
            "eliza_merge_steward_info 1",
            "eliza_merge_steward_ready 1",
            'eliza_merge_steward_check_ok{name="queue_store"} 1',
            "eliza_merge_steward_agent_identity_registry_required 1",
            "eliza_merge_steward_work_item_required 1",
            "eliza_merge_steward_known_agent_id_count 1",
            'eliza_merge_steward_queue_items{state="ready"} 1',
            'eliza_merge_steward_runs{status="running"} 1',
            'eliza_merge_steward_agent_performance_agents{health="all"} 1',
            "eliza_merge_steward_agent_routing_recommendations 0",
            'eliza_merge_steward_scrape_errors{source="none"} 0',
          ].join("\n"),
        ),
        "/api/workflows?readiness=false": jsonResponse(200, workflowResponse()),
        "/api/github-parity": jsonResponse(200, githubParityResponse()),
        "/api/production-readiness": jsonResponse(
          200,
          productionReadinessResponse(),
        ),
        "/api/production-cutover": jsonResponse(
          200,
          productionCutoverResponse(),
        ),
        "/api/production-evidence-template": jsonResponse(
          200,
          productionEvidenceTemplateResponse(),
        ),
        "/api/project-board?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          { board: { columns: [] } },
        ),
        "/api/work-items?repo=elizaos%2Feliza": jsonResponse(200, {
          workItems: [],
        }),
        "/api/work-cycles?repo=elizaos%2Feliza": jsonResponse(200, {
          workCycles: [],
        }),
        "/api/work-modules?repo=elizaos%2Feliza": jsonResponse(200, {
          workModules: [],
        }),
        "/api/work-progress?repo=elizaos%2Feliza": jsonResponse(200, {
          workProgress: { summary: { total: 0 } },
        }),
        "/api/work-views?repo=elizaos%2Feliza": jsonResponse(200, {
          workViews: [],
        }),
        "/api/work-views/evaluate": jsonResponse(
          200,
          workViewEvaluationResponse(),
        ),
        "/api/work-pages?repo=elizaos%2Feliza": jsonResponse(200, {
          workPages: [],
        }),
        "/api/fleet-coordination?repo=elizaos%2Feliza&ownerAgentId=eliza-smoke-agent":
          jsonResponse(200, fleetCoordinationResponse()),
        "/api/work-context?repo=elizaos%2Feliza&ownerAgentId=eliza-smoke-agent":
          jsonResponse(200, workContextResponse()),
        "/api/work-dashboard?repo=elizaos%2Feliza": jsonResponse(200, {
          workDashboard: { views: { builtIn: [], saved: [] } },
        }),
        "/api/work-intake?repo=elizaos%2Feliza": jsonResponse(200, {
          workIntake: { actions: [] },
        }),
        "/api/merge-queue?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          mergeQueueResponse(),
        ),
        "/api/merge-train?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          mergeTrainResponse(),
        ),
        "/api/search": jsonResponse(200, searchResponse()),
        "/api/queue/simulate": jsonResponse(200, queueSimulationResponse()),
        "/api/agent-identities": jsonResponse(200, agentIdentitiesResponse()),
        "/api/release-readiness?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, {
            releaseReadiness: { status: "idle", checks: [] },
          }),
        "/api/repository-protection?repo=elizaos%2Feliza&requireLive=false":
          jsonResponse(200, {
            repositoryProtection: { status: "watch", checks: [] },
          }),
        "/api/agent-insights?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { insights: { recommendations: [] } }),
        "/api/agents?repo=elizaos%2Feliza&readiness=false": jsonResponse(200, {
          agents: { agents: [] },
        }),
        "/api/agent-performance?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { performance: { agents: [] } }),
        "/api/agent-routing?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          { routing: { recommendations: [] } },
        ),
        "/api/agents/eliza-smoke-agent/bootstrap?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, agentBootstrapResponse()),
        "/api/agents/eliza-smoke-agent/cockpit?repo=elizaos%2Feliza&targetBranch=main&readiness=false":
          jsonResponse(200, agentCockpitResponse()),
        "/api/agents/eliza-smoke-agent/action-plan": jsonResponse(
          200,
          actionPlanResponse(),
        ),
        "/api/agents/eliza-smoke-agent/submission-gate": jsonResponse(200, {
          gate: { decision: { allowed: true }, labels: ["submission:allowed"] },
        }),
        "/api/agents/eliza-smoke-agent/work-preflight": jsonResponse(
          200,
          workPreflightResponse(),
        ),
        "/api/agents/eliza-smoke-agent/work-reservation": jsonResponse(
          200,
          workReservationResponse(),
        ),
        "/api/ci/failure-analysis": jsonResponse(200, {
          analysis: { summary: { primaryCategory: "test_failure" } },
        }),
        "/api/ci/validation-plan": jsonResponse(200, validationPlanResponse()),
        "/api/pr/brief": jsonResponse(200, {
          brief: { labels: ["risk:low", "merge-ready"] },
        }),
        "/api/review/assignment": jsonResponse(200, reviewAssignmentResponse()),
        "/api/patch/conflict-prediction": jsonResponse(
          200,
          patchConflictPredictionResponse(),
        ),
        "/api/releases/notes": jsonResponse(200, releaseNotesResponse()),
        "/api/agents/eliza-smoke-agent/inbox?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { inbox: { cards: [] } }),
      }),
    });

    assert.equal(doctor.ok, true);
    assert.equal(doctor.target, "https://steward.example.invalid");
    assert.equal(
      doctor.checks.find((check) => check.name === "worker_lease").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "strict_work_reservations")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "strict_work_reservations")
        .liveIntegrationActive,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "strict_work_items").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "strict_work_items")
        .liveIntegrationActive,
      true,
    );
    assert.equal(
      doctor.checks.find(
        (check) => check.name === "strict_agent_branch_namespaces",
      ).ok,
      true,
    );
    assert.equal(
      doctor.checks.find(
        (check) => check.name === "verified_agent_run_receipts",
      ).ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_identity_registry")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "discovery_manifest").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "openapi_contract").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "metrics").missingMetrics
        .length,
      0,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "workflow_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "github_parity_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "production_readiness_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "production_cutover_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find(
        (check) => check.name === "production_evidence_template_api",
      ).ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "project_board_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_items_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_cycles_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_modules_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_progress_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_views_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_view_evaluation_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_pages_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "fleet_coordination_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_context_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_dashboard_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_intake_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "merge_queue_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "merge_train_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "search_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "queue_simulation_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_identities_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "release_readiness_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "repository_protection_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_insights_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_capacity_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_performance_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_routing_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_bootstrap_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_cockpit_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_action_plan_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_submission_gate_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_work_preflight_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_work_reservation_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "ci_failure_analysis_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "ci_validation_plan_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "pull_request_brief_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "review_assignment_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find(
        (check) => check.name === "patch_conflict_prediction_api",
      ).ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_inbox_api").ok,
      true,
    );
  });

  it("preserves a reverse-proxy base path for every probe", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid/steward",
      smokeRepo: "elizaos/eliza",
      smokeAgent: "agent/one",
      fetchImpl: fakeFetch({
        "/steward/health": jsonResponse(200, { ok: true }),
        "/steward/ready": jsonResponse(200, {
          ok: true,
          configuration: {},
          checks: [
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/steward/.well-known/eliza-hub.json": jsonResponse(
          200,
          discoveryManifest(),
        ),
        "/steward/openapi.json": jsonResponse(200, openApiContract()),
        "/steward/metrics": textResponse(
          200,
          [
            "eliza_merge_steward_info 1",
            "eliza_merge_steward_ready 1",
            'eliza_merge_steward_check_ok{name="queue_store"} 1',
            "eliza_merge_steward_agent_identity_registry_required 0",
            "eliza_merge_steward_work_item_required 0",
            "eliza_merge_steward_known_agent_id_count 0",
            'eliza_merge_steward_queue_items{state="ready"} 1',
            'eliza_merge_steward_runs{status="running"} 1',
            'eliza_merge_steward_agent_performance_agents{health="all"} 1',
            "eliza_merge_steward_agent_routing_recommendations 0",
            'eliza_merge_steward_scrape_errors{source="none"} 0',
          ].join("\n"),
        ),
        "/steward/api/workflows?readiness=false": jsonResponse(
          200,
          workflowResponse(),
        ),
        "/steward/api/github-parity": jsonResponse(200, githubParityResponse()),
        "/steward/api/production-readiness": jsonResponse(
          200,
          productionReadinessResponse(),
        ),
        "/steward/api/production-cutover": jsonResponse(
          200,
          productionCutoverResponse(),
        ),
        "/steward/api/production-evidence-template": jsonResponse(
          200,
          productionEvidenceTemplateResponse(),
        ),
        "/steward/api/project-board?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { board: { columns: [] } }),
        "/steward/api/work-items?repo=elizaos%2Feliza": jsonResponse(200, {
          workItems: [],
        }),
        "/steward/api/work-cycles?repo=elizaos%2Feliza": jsonResponse(200, {
          workCycles: [],
        }),
        "/steward/api/work-modules?repo=elizaos%2Feliza": jsonResponse(200, {
          workModules: [],
        }),
        "/steward/api/work-progress?repo=elizaos%2Feliza": jsonResponse(200, {
          workProgress: { summary: { total: 0 } },
        }),
        "/steward/api/work-views?repo=elizaos%2Feliza": jsonResponse(200, {
          workViews: [],
        }),
        "/steward/api/work-views/evaluate": jsonResponse(
          200,
          workViewEvaluationResponse(),
        ),
        "/steward/api/work-pages?repo=elizaos%2Feliza": jsonResponse(200, {
          workPages: [],
        }),
        "/steward/api/fleet-coordination?repo=elizaos%2Feliza&ownerAgentId=agent%2Fone":
          jsonResponse(200, fleetCoordinationResponse()),
        "/steward/api/work-context?repo=elizaos%2Feliza&ownerAgentId=agent%2Fone":
          jsonResponse(200, workContextResponse()),
        "/steward/api/work-dashboard?repo=elizaos%2Feliza": jsonResponse(200, {
          workDashboard: { views: { builtIn: [], saved: [] } },
        }),
        "/steward/api/work-intake?repo=elizaos%2Feliza": jsonResponse(200, {
          workIntake: { actions: [] },
        }),
        "/steward/api/merge-queue?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, mergeQueueResponse()),
        "/steward/api/merge-train?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, mergeTrainResponse()),
        "/steward/api/search": jsonResponse(200, searchResponse()),
        "/steward/api/queue/simulate": jsonResponse(
          200,
          queueSimulationResponse(),
        ),
        "/steward/api/agent-identities": jsonResponse(
          200,
          agentIdentitiesResponse(),
        ),
        "/steward/api/release-readiness?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, {
            releaseReadiness: { status: "idle", checks: [] },
          }),
        "/steward/api/repository-protection?repo=elizaos%2Feliza&requireLive=false":
          jsonResponse(200, {
            repositoryProtection: { status: "watch", checks: [] },
          }),
        "/steward/api/agent-insights?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { insights: { recommendations: [] } }),
        "/steward/api/agents?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { agents: { agents: [] } }),
        "/steward/api/agent-performance?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { performance: { agents: [] } }),
        "/steward/api/agent-routing?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { routing: { recommendations: [] } }),
        "/steward/api/agents/agent%2Fone/bootstrap?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, agentBootstrapResponse("agent/one")),
        "/steward/api/agents/agent%2Fone/cockpit?repo=elizaos%2Feliza&targetBranch=main&readiness=false":
          jsonResponse(200, agentCockpitResponse("agent/one")),
        "/steward/api/agents/agent%2Fone/action-plan": jsonResponse(
          200,
          actionPlanResponse("agent/one"),
        ),
        "/steward/api/agents/agent%2Fone/submission-gate": jsonResponse(200, {
          gate: { decision: { allowed: true }, labels: ["submission:allowed"] },
        }),
        "/steward/api/agents/agent%2Fone/work-preflight": jsonResponse(
          200,
          workPreflightResponse(),
        ),
        "/steward/api/agents/agent%2Fone/work-reservation": jsonResponse(
          200,
          workReservationResponse(),
        ),
        "/steward/api/ci/failure-analysis": jsonResponse(200, {
          analysis: { summary: { primaryCategory: "test_failure" } },
        }),
        "/steward/api/ci/validation-plan": jsonResponse(
          200,
          validationPlanResponse(),
        ),
        "/steward/api/pr/brief": jsonResponse(200, {
          brief: { labels: ["risk:low", "merge-ready"] },
        }),
        "/steward/api/review/assignment": jsonResponse(
          200,
          reviewAssignmentResponse(),
        ),
        "/steward/api/patch/conflict-prediction": jsonResponse(
          200,
          patchConflictPredictionResponse(),
        ),
        "/steward/api/releases/notes": jsonResponse(
          200,
          releaseNotesResponse(),
        ),
        "/steward/api/agents/agent%2Fone/inbox?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { inbox: { cards: [] } }),
      }),
    });

    assert.equal(doctor.ok, true);
    assert.equal(doctor.target, "https://steward.example.invalid/steward");
  });

  it("fails when readiness preflight or metrics are missing", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(503, {
          ok: false,
          configuration: {},
          checks: [
            {
              name: "runtime_preflight",
              ok: false,
              errors: [{ code: "postgres_required" }],
              warnings: [],
            },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, discoveryManifest()),
        "/openapi.json": jsonResponse(200, openApiContract()),
        "/metrics": textResponse(200, "eliza_merge_steward_ready 0\n"),
      }),
      requireProductApis: false,
    });

    assert.equal(doctor.ok, false);
    assert.equal(
      doctor.checks.find((check) => check.name === "ready").ok,
      false,
    );
    assert.deepEqual(
      doctor.checks.find((check) => check.name === "runtime_preflight").errors,
      [{ code: "postgres_required" }],
    );
    assert.ok(
      doctor.checks
        .find((check) => check.name === "metrics")
        .missingMetrics.includes("eliza_merge_steward_queue_items"),
    );
  });

  it("fails when live integration is active without strict work reservations", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      requireMetrics: false,
      requireProductApis: false,
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(200, {
          ok: true,
          configuration: {
            integrationEnabled: true,
            integrationDryRun: false,
            requireWorkReservationForAgentPrs: false,
            requireWorkItemForAgentPrs: true,
            requireAgentBranchNamespaceForAgentPrs: true,
            requireVerifiedAgentRunReceiptForAgentPrs: true,
          },
          checks: [
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, discoveryManifest()),
        "/openapi.json": jsonResponse(200, openApiContract()),
      }),
    });
    const strictCheck = doctor.checks.find(
      (check) => check.name === "strict_work_reservations",
    );

    assert.equal(doctor.ok, false);
    assert.equal(strictCheck.ok, false);
    assert.equal(strictCheck.liveIntegrationActive, true);
    assert.equal(strictCheck.requireWorkReservationForAgentPrs, false);
    assert.equal(
      strictCheck.error,
      "live_integration_requires_strict_work_reservations",
    );
  });

  it("fails when live integration is active without durable Work item links", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      requireMetrics: false,
      requireProductApis: false,
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(200, {
          ok: true,
          configuration: {
            integrationEnabled: true,
            integrationDryRun: false,
            requireWorkReservationForAgentPrs: true,
            requireWorkItemForAgentPrs: false,
            requireAgentBranchNamespaceForAgentPrs: true,
            requireVerifiedAgentRunReceiptForAgentPrs: true,
          },
          checks: [
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, discoveryManifest()),
        "/openapi.json": jsonResponse(200, openApiContract()),
      }),
    });
    const strictCheck = doctor.checks.find(
      (check) => check.name === "strict_work_items",
    );

    assert.equal(doctor.ok, false);
    assert.equal(strictCheck.ok, false);
    assert.equal(strictCheck.liveIntegrationActive, true);
    assert.equal(strictCheck.requireWorkItemForAgentPrs, false);
    assert.equal(
      strictCheck.error,
      "live_integration_requires_strict_work_items",
    );
  });

  it("fails when live integration is active without strict agent branch namespaces", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      requireMetrics: false,
      requireProductApis: false,
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(200, {
          ok: true,
          configuration: {
            integrationEnabled: true,
            integrationDryRun: false,
            requireWorkReservationForAgentPrs: true,
            requireWorkItemForAgentPrs: true,
            requireAgentBranchNamespaceForAgentPrs: false,
            requireVerifiedAgentRunReceiptForAgentPrs: true,
          },
          checks: [
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, discoveryManifest()),
        "/openapi.json": jsonResponse(200, openApiContract()),
      }),
    });
    const strictCheck = doctor.checks.find(
      (check) => check.name === "strict_agent_branch_namespaces",
    );

    assert.equal(doctor.ok, false);
    assert.equal(strictCheck.ok, false);
    assert.equal(strictCheck.liveIntegrationActive, true);
    assert.equal(strictCheck.requireAgentBranchNamespaceForAgentPrs, false);
    assert.equal(
      strictCheck.error,
      "live_integration_requires_agent_branch_namespaces",
    );
  });

  it("fails when live integration is active without verified agent run receipts", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      requireMetrics: false,
      requireProductApis: false,
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(200, {
          ok: true,
          configuration: {
            integrationEnabled: true,
            integrationDryRun: false,
            requireWorkReservationForAgentPrs: true,
            requireWorkItemForAgentPrs: true,
            requireAgentBranchNamespaceForAgentPrs: true,
            requireVerifiedAgentRunReceiptForAgentPrs: false,
          },
          checks: [
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, discoveryManifest()),
        "/openapi.json": jsonResponse(200, openApiContract()),
      }),
    });
    const receiptCheck = doctor.checks.find(
      (check) => check.name === "verified_agent_run_receipts",
    );

    assert.equal(doctor.ok, false);
    assert.equal(receiptCheck.ok, false);
    assert.equal(receiptCheck.liveIntegrationActive, true);
    assert.equal(receiptCheck.requireVerifiedAgentRunReceiptForAgentPrs, false);
    assert.equal(
      receiptCheck.error,
      "live_integration_requires_verified_agent_run_receipts",
    );
  });

  it("fails when live integration is active without an agent identity registry", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      requireMetrics: false,
      requireProductApis: false,
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(200, {
          ok: true,
          configuration: {
            integrationEnabled: true,
            integrationDryRun: false,
            requireWorkReservationForAgentPrs: true,
            requireWorkItemForAgentPrs: true,
            requireAgentBranchNamespaceForAgentPrs: true,
            requireVerifiedAgentRunReceiptForAgentPrs: true,
            requireAgentIdentityRegistryForAgentPrs: true,
            knownAgentIdCount: 0,
          },
          checks: [
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, discoveryManifest()),
        "/openapi.json": jsonResponse(200, openApiContract()),
      }),
    });
    const registryCheck = doctor.checks.find(
      (check) => check.name === "agent_identity_registry",
    );

    assert.equal(doctor.ok, false);
    assert.equal(registryCheck.ok, false);
    assert.equal(registryCheck.liveIntegrationActive, true);
    assert.equal(registryCheck.requireAgentIdentityRegistryForAgentPrs, true);
    assert.equal(registryCheck.knownAgentIdCount, 0);
    assert.equal(
      registryCheck.error,
      "live_integration_requires_agent_identity_registry",
    );
  });

  it("sends bearer auth to checked endpoints", async () => {
    const seenAuth = [];
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      token: "secret-token",
      requireMetrics: false,
      smokeRepo: "elizaos/eliza",
      smokeAgent: "agent-one",
      fetchImpl: async (url, options = {}) => {
        seenAuth.push(options.headers?.authorization ?? null);
        if (url.pathname === "/health") return jsonResponse(200, { ok: true });
        if (url.pathname === "/ready") {
          return jsonResponse(200, {
            ok: true,
            configuration: {},
            checks: [
              { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
            ],
          });
        }
        if (url.pathname === "/.well-known/eliza-hub.json")
          return jsonResponse(200, discoveryManifest());
        if (url.pathname === "/openapi.json")
          return jsonResponse(200, openApiContract());
        if (url.pathname === "/api/workflows")
          return jsonResponse(200, workflowResponse());
        if (url.pathname === "/api/github-parity")
          return jsonResponse(200, githubParityResponse());
        if (url.pathname === "/api/production-readiness")
          return jsonResponse(200, productionReadinessResponse());
        if (url.pathname === "/api/production-cutover")
          return jsonResponse(200, productionCutoverResponse());
        if (url.pathname === "/api/production-evidence-template")
          return jsonResponse(200, productionEvidenceTemplateResponse());
        if (url.pathname === "/api/project-board")
          return jsonResponse(200, { board: { columns: [] } });
        if (url.pathname === "/api/work-items")
          return jsonResponse(200, { workItems: [] });
        if (url.pathname === "/api/work-cycles")
          return jsonResponse(200, { workCycles: [] });
        if (url.pathname === "/api/work-modules")
          return jsonResponse(200, { workModules: [] });
        if (url.pathname === "/api/work-progress")
          return jsonResponse(200, { workProgress: { summary: { total: 0 } } });
        if (url.pathname === "/api/work-views")
          return jsonResponse(200, { workViews: [] });
        if (url.pathname === "/api/work-views/evaluate")
          return jsonResponse(200, workViewEvaluationResponse());
        if (url.pathname === "/api/work-pages")
          return jsonResponse(200, { workPages: [] });
        if (url.pathname === "/api/fleet-coordination")
          return jsonResponse(200, fleetCoordinationResponse());
        if (url.pathname === "/api/work-context")
          return jsonResponse(200, workContextResponse());
        if (url.pathname === "/api/work-dashboard")
          return jsonResponse(200, {
            workDashboard: { views: { builtIn: [], saved: [] } },
          });
        if (url.pathname === "/api/work-intake")
          return jsonResponse(200, { workIntake: { actions: [] } });
        if (url.pathname === "/api/merge-queue")
          return jsonResponse(200, mergeQueueResponse());
        if (url.pathname === "/api/merge-train")
          return jsonResponse(200, mergeTrainResponse());
        if (url.pathname === "/api/search")
          return jsonResponse(200, searchResponse());
        if (url.pathname === "/api/queue/simulate")
          return jsonResponse(200, queueSimulationResponse());
        if (url.pathname === "/api/agent-identities")
          return jsonResponse(200, agentIdentitiesResponse());
        if (url.pathname === "/api/release-readiness")
          return jsonResponse(200, {
            releaseReadiness: { status: "idle", checks: [] },
          });
        if (url.pathname === "/api/repository-protection")
          return jsonResponse(200, {
            repositoryProtection: { status: "watch", checks: [] },
          });
        if (url.pathname === "/api/agent-insights")
          return jsonResponse(200, { insights: { recommendations: [] } });
        if (url.pathname === "/api/agents")
          return jsonResponse(200, { agents: { agents: [] } });
        if (url.pathname === "/api/agent-performance")
          return jsonResponse(200, { performance: { agents: [] } });
        if (url.pathname === "/api/agent-routing")
          return jsonResponse(200, { routing: { recommendations: [] } });
        if (url.pathname === "/api/agents/agent-one/bootstrap")
          return jsonResponse(200, agentBootstrapResponse("agent-one"));
        if (url.pathname === "/api/agents/agent-one/cockpit")
          return jsonResponse(200, agentCockpitResponse("agent-one"));
        if (url.pathname === "/api/agents/agent-one/action-plan")
          return jsonResponse(200, actionPlanResponse("agent-one"));
        if (url.pathname === "/api/agents/agent-one/submission-gate")
          return jsonResponse(200, {
            gate: {
              decision: { allowed: true },
              labels: ["submission:allowed"],
            },
          });
        if (url.pathname === "/api/agents/agent-one/work-preflight")
          return jsonResponse(200, workPreflightResponse());
        if (url.pathname === "/api/agents/agent-one/work-reservation")
          return jsonResponse(200, workReservationResponse());
        if (url.pathname === "/api/ci/failure-analysis")
          return jsonResponse(200, {
            analysis: { summary: { primaryCategory: "test_failure" } },
          });
        if (url.pathname === "/api/ci/validation-plan")
          return jsonResponse(200, validationPlanResponse());
        if (url.pathname === "/api/pr/brief")
          return jsonResponse(200, {
            brief: { labels: ["risk:low", "merge-ready"] },
          });
        if (url.pathname === "/api/review/assignment")
          return jsonResponse(200, reviewAssignmentResponse());
        if (url.pathname === "/api/patch/conflict-prediction")
          return jsonResponse(200, patchConflictPredictionResponse());
        if (url.pathname === "/api/releases/notes")
          return jsonResponse(200, releaseNotesResponse());
        if (url.pathname === "/api/agents/agent-one/inbox")
          return jsonResponse(200, { inbox: { cards: [] } });
        throw new Error(`unexpected url ${url.pathname}`);
      },
    });

    assert.equal(doctor.ok, true);
    assert.equal(seenAuth.length, 45);
    assert.ok(seenAuth.every((header) => header === "Bearer secret-token"));
  });

  it("fails when a required product API is not healthy", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      requireMetrics: false,
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(200, {
          ok: true,
          configuration: {},
          checks: [
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, discoveryManifest()),
        "/openapi.json": jsonResponse(200, openApiContract()),
        "/api/workflows?readiness=false": jsonResponse(200, workflowResponse()),
        "/api/github-parity": jsonResponse(200, githubParityResponse()),
        "/api/production-readiness": jsonResponse(
          200,
          productionReadinessResponse(),
        ),
        "/api/production-cutover": jsonResponse(
          200,
          productionCutoverResponse(),
        ),
        "/api/production-evidence-template": jsonResponse(
          200,
          productionEvidenceTemplateResponse(),
        ),
        "/api/project-board?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          500,
          { error: "board_failed" },
        ),
        "/api/work-items?repo=elizaos%2Feliza": jsonResponse(200, {
          workItems: [],
        }),
        "/api/work-cycles?repo=elizaos%2Feliza": jsonResponse(200, {
          workCycles: [],
        }),
        "/api/work-modules?repo=elizaos%2Feliza": jsonResponse(200, {
          workModules: [],
        }),
        "/api/work-progress?repo=elizaos%2Feliza": jsonResponse(200, {
          workProgress: { summary: { total: 0 } },
        }),
        "/api/work-views?repo=elizaos%2Feliza": jsonResponse(200, {
          workViews: [],
        }),
        "/api/work-views/evaluate": jsonResponse(
          200,
          workViewEvaluationResponse(),
        ),
        "/api/work-pages?repo=elizaos%2Feliza": jsonResponse(200, {
          workPages: [],
        }),
        "/api/fleet-coordination?repo=elizaos%2Feliza&ownerAgentId=eliza-smoke-agent":
          jsonResponse(200, fleetCoordinationResponse()),
        "/api/work-context?repo=elizaos%2Feliza&ownerAgentId=eliza-smoke-agent":
          jsonResponse(200, workContextResponse()),
        "/api/work-dashboard?repo=elizaos%2Feliza": jsonResponse(200, {
          workDashboard: { views: { builtIn: [], saved: [] } },
        }),
        "/api/work-intake?repo=elizaos%2Feliza": jsonResponse(200, {
          workIntake: { actions: [] },
        }),
        "/api/merge-queue?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          mergeQueueResponse(),
        ),
        "/api/merge-train?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          mergeTrainResponse(),
        ),
        "/api/search": jsonResponse(200, searchResponse()),
        "/api/queue/simulate": jsonResponse(200, queueSimulationResponse()),
        "/api/agent-identities": jsonResponse(200, agentIdentitiesResponse()),
        "/api/release-readiness?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, {
            releaseReadiness: { status: "idle", checks: [] },
          }),
        "/api/repository-protection?repo=elizaos%2Feliza&requireLive=false":
          jsonResponse(200, {
            repositoryProtection: { status: "watch", checks: [] },
          }),
        "/api/agent-insights?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { insights: { recommendations: [] } }),
        "/api/agents?repo=elizaos%2Feliza&readiness=false": jsonResponse(200, {
          agents: { agents: [] },
        }),
        "/api/agent-performance?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { performance: { agents: [] } }),
        "/api/agent-routing?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          { routing: { recommendations: [] } },
        ),
        "/api/agents/eliza-smoke-agent/bootstrap?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, agentBootstrapResponse()),
        "/api/agents/eliza-smoke-agent/cockpit?repo=elizaos%2Feliza&targetBranch=main&readiness=false":
          jsonResponse(200, agentCockpitResponse()),
        "/api/agents/eliza-smoke-agent/action-plan": jsonResponse(
          200,
          actionPlanResponse(),
        ),
        "/api/agents/eliza-smoke-agent/submission-gate": jsonResponse(200, {
          gate: { decision: { allowed: true }, labels: ["submission:allowed"] },
        }),
        "/api/agents/eliza-smoke-agent/work-preflight": jsonResponse(
          200,
          workPreflightResponse(),
        ),
        "/api/agents/eliza-smoke-agent/work-reservation": jsonResponse(
          200,
          workReservationResponse(),
        ),
        "/api/ci/failure-analysis": jsonResponse(200, {
          analysis: { summary: { primaryCategory: "test_failure" } },
        }),
        "/api/ci/validation-plan": jsonResponse(200, validationPlanResponse()),
        "/api/pr/brief": jsonResponse(200, {
          brief: { labels: ["risk:low", "merge-ready"] },
        }),
        "/api/review/assignment": jsonResponse(200, reviewAssignmentResponse()),
        "/api/patch/conflict-prediction": jsonResponse(
          200,
          patchConflictPredictionResponse(),
        ),
        "/api/releases/notes": jsonResponse(200, releaseNotesResponse()),
        "/api/agents/eliza-smoke-agent/inbox?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { inbox: { cards: [] } }),
      }),
    });

    assert.equal(doctor.ok, false);
    assert.equal(
      doctor.checks.find((check) => check.name === "workflow_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "github_parity_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "production_readiness_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "production_cutover_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find(
        (check) => check.name === "production_evidence_template_api",
      ).ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "project_board_api").ok,
      false,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_items_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_cycles_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_modules_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_progress_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_views_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_view_evaluation_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_pages_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "fleet_coordination_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_context_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_dashboard_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "work_intake_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "merge_queue_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "merge_train_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "search_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "queue_simulation_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_identities_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "release_readiness_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "repository_protection_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_insights_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_capacity_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_performance_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_routing_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_bootstrap_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_submission_gate_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_work_preflight_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_work_reservation_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "ci_failure_analysis_api")
        .ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "ci_validation_plan_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "pull_request_brief_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "review_assignment_api").ok,
      true,
    );
    assert.equal(
      doctor.checks.find(
        (check) => check.name === "patch_conflict_prediction_api",
      ).ok,
      true,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "agent_inbox_api").ok,
      true,
    );
  });

  it("fails when production evidence template usage commands are stale", async () => {
    const staleTemplate = productionEvidenceTemplateResponse();
    staleTemplate.productionEvidenceTemplate.usage.inventoryCommand =
      "node deployment/hetzner-staging/release/production-evidence-inventory.mjs --strict";

    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      requireMetrics: false,
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(200, {
          ok: true,
          configuration: {},
          checks: [
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, discoveryManifest()),
        "/openapi.json": jsonResponse(200, openApiContract()),
        "/api/workflows?readiness=false": jsonResponse(200, workflowResponse()),
        "/api/github-parity": jsonResponse(200, githubParityResponse()),
        "/api/production-readiness": jsonResponse(
          200,
          productionReadinessResponse(),
        ),
        "/api/production-cutover": jsonResponse(
          200,
          productionCutoverResponse(),
        ),
        "/api/production-evidence-template": jsonResponse(200, staleTemplate),
        "/api/project-board?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          { board: { columns: [] } },
        ),
        "/api/work-items?repo=elizaos%2Feliza": jsonResponse(200, {
          workItems: [],
        }),
        "/api/work-cycles?repo=elizaos%2Feliza": jsonResponse(200, {
          workCycles: [],
        }),
        "/api/work-modules?repo=elizaos%2Feliza": jsonResponse(200, {
          workModules: [],
        }),
        "/api/work-progress?repo=elizaos%2Feliza": jsonResponse(200, {
          workProgress: { summary: { total: 0 } },
        }),
        "/api/work-views?repo=elizaos%2Feliza": jsonResponse(200, {
          workViews: [],
        }),
        "/api/work-views/evaluate": jsonResponse(
          200,
          workViewEvaluationResponse(),
        ),
        "/api/work-pages?repo=elizaos%2Feliza": jsonResponse(200, {
          workPages: [],
        }),
        "/api/fleet-coordination?repo=elizaos%2Feliza&ownerAgentId=eliza-smoke-agent":
          jsonResponse(200, fleetCoordinationResponse()),
        "/api/work-context?repo=elizaos%2Feliza&ownerAgentId=eliza-smoke-agent":
          jsonResponse(200, workContextResponse()),
        "/api/work-dashboard?repo=elizaos%2Feliza": jsonResponse(200, {
          workDashboard: { views: { builtIn: [], saved: [] } },
        }),
        "/api/work-intake?repo=elizaos%2Feliza": jsonResponse(200, {
          workIntake: { actions: [] },
        }),
        "/api/merge-queue?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          mergeQueueResponse(),
        ),
        "/api/merge-train?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          mergeTrainResponse(),
        ),
        "/api/search": jsonResponse(200, searchResponse()),
        "/api/queue/simulate": jsonResponse(200, queueSimulationResponse()),
        "/api/agent-identities": jsonResponse(200, agentIdentitiesResponse()),
        "/api/release-readiness?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, {
            releaseReadiness: { status: "idle", checks: [] },
          }),
        "/api/repository-protection?repo=elizaos%2Feliza&requireLive=false":
          jsonResponse(200, {
            repositoryProtection: { status: "watch", checks: [] },
          }),
        "/api/agent-insights?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { insights: { recommendations: [] } }),
        "/api/agents?repo=elizaos%2Feliza&readiness=false": jsonResponse(200, {
          agents: { agents: [] },
        }),
        "/api/agent-performance?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { performance: { agents: [] } }),
        "/api/agent-routing?repo=elizaos%2Feliza&readiness=false": jsonResponse(
          200,
          { routing: { recommendations: [] } },
        ),
        "/api/agents/eliza-smoke-agent/bootstrap?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, agentBootstrapResponse()),
        "/api/agents/eliza-smoke-agent/cockpit?repo=elizaos%2Feliza&targetBranch=main&readiness=false":
          jsonResponse(200, agentCockpitResponse()),
        "/api/agents/eliza-smoke-agent/action-plan": jsonResponse(
          200,
          actionPlanResponse(),
        ),
        "/api/agents/eliza-smoke-agent/submission-gate": jsonResponse(200, {
          gate: { decision: { allowed: true }, labels: ["submission:allowed"] },
        }),
        "/api/agents/eliza-smoke-agent/work-preflight": jsonResponse(
          200,
          workPreflightResponse(),
        ),
        "/api/agents/eliza-smoke-agent/work-reservation": jsonResponse(
          200,
          workReservationResponse(),
        ),
        "/api/ci/failure-analysis": jsonResponse(200, {
          analysis: { summary: { primaryCategory: "test_failure" } },
        }),
        "/api/ci/validation-plan": jsonResponse(200, validationPlanResponse()),
        "/api/pr/brief": jsonResponse(200, {
          brief: { labels: ["risk:low", "merge-ready"] },
        }),
        "/api/review/assignment": jsonResponse(200, reviewAssignmentResponse()),
        "/api/patch/conflict-prediction": jsonResponse(
          200,
          patchConflictPredictionResponse(),
        ),
        "/api/releases/notes": jsonResponse(200, releaseNotesResponse()),
        "/api/agents/eliza-smoke-agent/inbox?repo=elizaos%2Feliza&readiness=false":
          jsonResponse(200, { inbox: { cards: [] } }),
      }),
    });

    assert.equal(doctor.ok, false);
    assert.equal(
      doctor.checks.find(
        (check) => check.name === "production_evidence_template_api",
      ).ok,
      false,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "project_board_api").ok,
      true,
    );
  });

  it("fails when discovery or OpenAPI contract checks are unhealthy", async () => {
    const doctor = await runDeploymentDoctor({
      baseUrl: "https://steward.example.invalid",
      requireMetrics: false,
      requireProductApis: false,
      fetchImpl: fakeFetch({
        "/health": jsonResponse(200, { ok: true }),
        "/ready": jsonResponse(200, {
          ok: true,
          configuration: {},
          checks: [
            { name: "runtime_preflight", ok: true, errors: [], warnings: [] },
          ],
        }),
        "/.well-known/eliza-hub.json": jsonResponse(200, {
          service: "eliza-merge-steward",
          links: {
            self: "/.well-known/eliza-hub.json",
            openapi: "/openapi.json",
          },
          capabilities: [],
        }),
        "/openapi.json": jsonResponse(200, {
          openapi: "3.1.0",
          info: { title: "Wrong API" },
          paths: {},
        }),
      }),
    });

    assert.equal(doctor.ok, false);
    assert.equal(
      doctor.checks.find((check) => check.name === "discovery_manifest").ok,
      false,
    );
    assert.equal(
      doctor.checks.find((check) => check.name === "openapi_contract").ok,
      false,
    );
  });
});

function fakeFetch(routes) {
  return async (url) => {
    const key = `${url.pathname}${url.search}`;
    const response = routes[key] ?? routes[url.pathname];
    if (!response) throw new Error(`missing fake route ${key}`);
    return response;
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}

function githubParityResponse() {
  return {
    parity: {
      status: "forgejo_plus_eliza_not_full_github_parity",
      summary: {
        githubDropInReplacement: false,
        productionReadyWithoutPrivateEvidence: false,
      },
      migrationGuardrails: [
        { id: "not_drop_in_github" },
        { id: "live_merges_evidence_gated" },
      ],
      surfaces: [
        { id: "merge_queue", status: "eliza_steward" },
        {
          id: "discussions",
          status: "not_supported",
          githubDropInReplacement: false,
        },
      ],
    },
  };
}

function productionReadinessResponse() {
  return {
    productionReadiness: {
      status: "blocked_until_private_evidence_passes",
      privateEvidenceRequired: true,
      authoritativeGate: {
        gateChecks: ["sso_registration", "merge_queue_rollout"],
      },
      domains: [
        { id: "sso_registration", evidenceBlock: "sso" },
        { id: "merge_queue_rollout", evidenceBlock: "mergeQueueRollout" },
      ],
    },
  };
}

function productionCutoverResponse() {
  return {
    productionCutover: {
      readOnly: true,
      status: "blocked",
      privateEvidenceRequired: true,
      guardrails: {
        liveAgentMergesAllowed: false,
      },
      phases: [{ id: "foundation", status: "blocked" }],
      executionPlan: {
        orderedSteps: [{ domainId: "domain_tls" }],
      },
    },
  };
}

function productionEvidenceTemplateResponse() {
  return {
    productionEvidenceTemplate: {
      readOnly: true,
      privateEvidenceRequired: true,
      storesPrivateEvidence: false,
      templatePassesProductionGate: false,
      requiredBlocks: ["domain", "sso"],
      summary: {
        shapeValid: true,
      },
      usage: {
        inventoryCommand:
          "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
        assembleCommand:
          "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
        gateCommand:
          'node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
      },
      template: {
        sso: {
          smokeEvidence: null,
          bootstrapEvidence: null,
        },
      },
    },
  };
}

function validationPlanResponse() {
  return {
    validationPlan: {
      decision: {
        allowed: true,
      },
      commands: [{ scope: "scoped" }],
    },
  };
}

function workPreflightResponse() {
  return {
    preflight: {
      decision: {
        allowed: true,
      },
      suggestedClaims: [
        {
          resourceKind: "path",
          resourceId: "README.md",
        },
      ],
      labels: ["work-preflight:allowed"],
    },
  };
}

function workReservationResponse() {
  return {
    reservation: {
      dryRun: true,
      reason: "dry_run",
      workItemAction: "planned",
      plannedWorkItem: {
        repo: "elizaos/eliza",
        state: "claimed",
        ownerAgentId: "eliza-smoke-agent",
        paths: ["README.md"],
        packages: ["docs"],
      },
      requestedClaims: [
        {
          resourceKind: "path",
          resourceId: "README.md",
        },
      ],
      labels: ["work-reservation:dry-run"],
    },
  };
}

function releaseNotesResponse() {
  return {
    notes: {
      summary: {
        totalMergedPullRequests: 1,
      },
      markdown: "- smoke release note",
    },
  };
}

function patchConflictPredictionResponse() {
  return {
    prediction: {
      prediction: {
        state: "clear",
        level: "low",
        safeToStart: true,
      },
      labels: ["patch-conflict:clear", "conflict:low"],
    },
  };
}

function reviewAssignmentResponse() {
  return {
    assignment: {
      decision: {
        state: "needs_reviewers",
        assignmentReady: false,
      },
      suggestedReviewers: [],
      labels: ["review-assignment:needs_reviewers", "reviewers:needed"],
    },
  };
}

function searchResponse() {
  return {
    search: {
      summary: {
        matchedDocuments: 1,
      },
      results: [
        {
          kind: "actions_log",
          id: "smoke-actions-log",
        },
      ],
    },
  };
}

function discoveryManifest() {
  return {
    service: "eliza-merge-steward",
    links: {
      self: "/.well-known/eliza-hub.json",
      openapi: "/openapi.json",
      githubParity: "/api/github-parity",
      productionReadiness: "/api/production-readiness",
      productionCutover: "/api/production-cutover",
      productionEvidenceTemplate: "/api/production-evidence-template",
      search: "/api/search",
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
      mergeTrain: "/api/merge-train",
      queueItemActionPlan: "/api/queue/item/action-plan",
      queueSimulation: "/api/queue/simulate",
      pullRequestBrief: "/api/pr/brief",
      reviewAssignment: "/api/review/assignment",
      patchConflictPrediction: "/api/patch/conflict-prediction",
      releaseNotes: "/api/releases/notes",
      agentBootstrapTemplate: "/api/agents/{agentId}/bootstrap",
      agentCockpitTemplate: "/api/agents/{agentId}/cockpit",
      agentActionPlanTemplate: "/api/agents/{agentId}/action-plan",
      agentSubmissionGateTemplate: "/api/agents/{agentId}/submission-gate",
      agentWorkPreflightTemplate: "/api/agents/{agentId}/work-preflight",
      agentWorkReservationTemplate: "/api/agents/{agentId}/work-reservation",
      releaseReadiness: "/api/release-readiness",
      repositoryProtection: "/api/repository-protection",
      ciValidationPlan: "/api/ci/validation-plan",
      agentIdentities: "/api/agent-identities",
      fleetCoordination: "/api/fleet-coordination",
    },
    capabilities: [
      "agent_routing",
      "repo_search",
      "work_items",
      "work_cycles",
      "work_modules",
      "work_progress",
      "work_views",
      "work_view_evaluation",
      "work_pages",
      "work_dashboard",
      "work_context_resume",
      "merge_train_plan",
      "queue_item_action_plan",
      "agent_bootstrap",
      "agent_cockpit",
      "agent_action_plan",
      "queue_simulation",
      "agent_submission_gate",
      "agent_work_preflight",
      "agent_work_reservation",
      "agent_identity_registry_policy",
      "release_readiness",
      "fleet_coordination_contract",
      "repository_protection",
      "ci_failure_analysis",
      "ci_validation_plan",
      "pull_request_brief",
      "review_assignment",
      "patch_conflict_prediction",
      "release_notes",
      "claim_next",
      "github_parity_matrix",
      "production_readiness_checklist",
      "production_cutover_plan",
      "production_evidence_inventory",
      "production_evidence_template",
    ],
    githubParity: {
      status: "forgejo_plus_eliza_not_full_github_parity",
      link: "/api/github-parity",
      githubDropInReplacement: false,
      productionReadyWithoutPrivateEvidence: false,
      migrationGuardrailIds: [
        "not_drop_in_github",
        "live_merges_evidence_gated",
      ],
      agentNativeAdditionIds: ["agent_cockpit", "queue_item_action_plans"],
    },
    productionReadiness: {
      status: "blocked_until_private_evidence_passes",
      link: "/api/production-readiness",
      privateEvidenceRequired: true,
    },
    clientHints: {
      mergeExecution: {
        integrationEnabled: true,
        integrationDryRun: false,
        liveIntegrationActive: true,
        executor: "local-git",
        batchingAllowed: true,
        maxBatchSize: 3,
        branchPrefix: "eliza-queue",
        branchPushEnabled: true,
        emptyRequiredChecksAllowed: false,
        workerEnabled: true,
        workerLiveExecutionConfirmed: true,
        workerLeaseEnabled: true,
        workerLeaseIdConfigured: true,
        liveAgentMergesEvidenceGated: true,
        liveAgentMergesAllowedWithoutProductionEvidence: false,
        productionCutoverRequired: true,
      },
      productionEvidence: {
        artifactRootEnv: "ELIZA_ARTIFACT_ROOT",
        templateFile: "eliza-hub-production-evidence.template.json",
        assembledEvidenceFile: "eliza-hub-production-evidence.json",
        templateEndpoint: "/api/production-evidence-template",
        commands: {
          template:
            'node services/merge-steward/src/cli.js production-evidence-template > "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.template.json"',
          inventory:
            "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
          assemble:
            "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
          gate: 'node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
        },
        strictGateRequired: true,
        inventoryMustPassBeforeAssemble: true,
        generatedEvidenceMustStayPrivate: true,
      },
    },
    surfaces: {
      projectBoard: {
        authority: "eliza_computed",
        forgejoProjectsSync: "not_enabled",
      },
      workItems: {
        authority: "eliza_steward",
      },
      workPlanning: {
        authority: "eliza_steward",
      },
      fleetCoordination: {
        authority: "eliza_steward",
      },
      discussions: {
        status: "not_supported_as_native_discussions",
      },
      mergeQueue: {
        authority: "eliza_steward",
      },
    },
  };
}

function openApiContract() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Eliza Merge Steward API",
    },
    paths: {
      "/.well-known/eliza-hub.json": {
        get: {},
      },
      "/api/github-parity": {
        get: {},
      },
      "/api/production-readiness": {
        get: {},
      },
      "/api/production-cutover": {
        get: {},
      },
      "/api/production-evidence-template": {
        get: {},
      },
      "/api/search": {
        get: {},
        post: {},
      },
      "/api/work-items": {
        get: {},
        post: {},
      },
      "/api/work-items/item": {
        get: {},
      },
      "/api/work-items/transition": {
        post: {},
      },
      "/api/work-cycles": {
        get: {},
        post: {},
      },
      "/api/work-cycles/item": {
        get: {},
      },
      "/api/work-cycles/transition": {
        post: {},
      },
      "/api/work-modules": {
        get: {},
        post: {},
      },
      "/api/work-modules/item": {
        get: {},
      },
      "/api/work-modules/transition": {
        post: {},
      },
      "/api/work-progress": {
        get: {},
      },
      "/api/work-views": {
        get: {},
        post: {},
      },
      "/api/work-views/item": {
        get: {},
      },
      "/api/work-views/evaluate": {
        get: {},
        post: {},
      },
      "/api/work-views/transition": {
        post: {},
      },
      "/api/work-pages": {
        get: {},
        post: {},
      },
      "/api/work-pages/item": {
        get: {},
      },
      "/api/work-pages/transition": {
        post: {},
      },
      "/api/work-dashboard": {
        get: {},
      },
      "/api/work-intake": {
        get: {},
      },
      "/api/work-intake/apply": {
        post: {},
      },
      "/api/merge-train": {
        get: {},
      },
      "/api/queue/item/action-plan": {
        get: {},
      },
      "/api/fleet-coordination": {
        get: {},
      },
      "/api/work-context": {
        get: {},
      },
      "/api/queue/simulate": {
        post: {},
      },
      "/api/agent-routing": {
        get: {},
      },
      "/api/agents/{agentId}/bootstrap": {
        get: {},
      },
      "/api/agents/{agentId}/cockpit": {
        get: {},
      },
      "/api/agents/{agentId}/action-plan": {
        post: {},
      },
      "/api/agents/{agentId}/submission-gate": {
        post: {},
      },
      "/api/agents/{agentId}/work-preflight": {
        post: {},
      },
      "/api/agents/{agentId}/work-reservation": {
        post: {},
      },
      "/api/release-readiness": {
        get: {},
      },
      "/api/repository-protection": {
        get: {},
      },
      "/api/agent-identities": {
        get: {},
        post: {},
      },
      "/api/ci/failure-analysis": {
        post: {},
      },
      "/api/ci/validation-plan": {
        post: {},
      },
      "/api/pr/brief": {
        post: {},
      },
      "/api/review/assignment": {
        post: {},
      },
      "/api/patch/conflict-prediction": {
        post: {},
      },
      "/api/releases/notes": {
        get: {},
        post: {},
      },
    },
  };
}

function mergeQueueResponse() {
  return {
    mergeQueue: {
      lanes: [],
      diagnostics: {
        health: "empty",
      },
    },
  };
}

function workflowResponse() {
  return {
    workflow: {
      cards: [],
      operations: {
        status: "idle",
        mergeQueue: {
          status: "empty",
        },
      },
    },
  };
}

function mergeTrainResponse() {
  return {
    mergeTrain: {
      readOnly: true,
      status: "empty",
      selectedTrain: {
        executionReady: false,
        itemIds: [],
      },
      preflight: {
        status: "empty",
        liveExecutionReady: false,
        dryRunReviewReady: false,
        checks: [],
        blockers: [],
        warnings: [],
        requiredActions: [],
      },
      lanes: [],
      labels: ["merge-train:empty"],
    },
  };
}

function queueSimulationResponse() {
  return {
    simulation: {
      readOnly: true,
      proposed: [
        {
          id: "elizaos/eliza#0-simulation",
          outcome: "blocked",
        },
      ],
      baseline: {
        counts: {
          items: 0,
        },
      },
      simulated: {
        counts: {
          items: 1,
        },
      },
    },
  };
}

function agentIdentitiesResponse() {
  return {
    agents: [],
    summary: {
      knownAgentIdCount: 0,
    },
  };
}

function fleetCoordinationResponse() {
  return {
    coordinationContract: {
      version: 1,
      sharedLevers: [],
      claimProtocol: {
        blockedAfterMinutes: 30,
      },
    },
  };
}

function workContextResponse() {
  return {
    workContext: {
      version: 1,
      readOnly: true,
      status: "ready",
      nextActions: [],
      resume: {
        readFirst: [],
        ownedCardIds: [],
        activeClaimIds: [],
        staleClaimIds: [],
        blockingLeverIds: [],
      },
    },
  };
}

function workViewEvaluationResponse() {
  return {
    workViewEvaluation: {
      computedAt: "2026-07-07T00:00:00.000Z",
      filters: {
        repo: "elizaos/eliza",
        ownerAgentId: null,
      },
      view: {
        title: "Smoke docs view",
        kind: "kanban",
      },
      summary: {
        totalItems: 0,
        returnedItems: 0,
        totalPages: 0,
        returnedPages: 0,
      },
      columns: [],
      rows: [],
      pages: [],
      nextActions: ["relax_view_filters_or_create_matching_work"],
    },
  };
}

function agentBootstrapResponse(agentId = "eliza-smoke-agent") {
  return {
    bootstrap: {
      agentId,
      links: {
        workPreflight: `/api/agents/${encodeURIComponent(agentId)}/work-preflight`,
      },
      nextActions: [
        {
          id: "preflight_before_branch",
        },
      ],
    },
  };
}

function agentCockpitResponse(agentId = "eliza-smoke-agent") {
  return {
    cockpit: {
      agentId,
      readOnly: true,
      summary: {},
      focusCards: [],
      nextActions: [],
    },
  };
}

function actionPlanResponse(agentId = "eliza-smoke-agent") {
  return {
    actionPlan: {
      readOnly: true,
      agentId,
      decision: {
        state: "watch",
      },
      checks: [],
      nextSteps: [],
      labels: ["agent-action-plan:watch"],
    },
  };
}
