import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const SERVICE_ROOT = new URL("../", import.meta.url);
const REPO_ROOT = new URL("../../", SERVICE_ROOT);
const OPENAPI_URL = new URL("openapi.json", SERVICE_ROOT);
const PACKAGE_URL = new URL("package.json", SERVICE_ROOT);
const PRODUCTION_EVIDENCE_SCHEMA_URL = new URL(
  "production-evidence.schema.json",
  SERVICE_ROOT,
);
const SERVER_URL = new URL("src/server.js", SERVICE_ROOT);
const DOCTOR_URL = new URL("src/deployment-doctor.js", SERVICE_ROOT);
const SERVICE_README_URL = new URL("README.md", SERVICE_ROOT);
const RUNTIME_MODEL_URL = new URL("docs/steward-runtime-model.md", REPO_ROOT);
const ROOT_README_URL = new URL("README.md", REPO_ROOT);

const PRODUCT_API_PATHS = [
  "/api/workflows",
  "/api/github-parity",
  "/api/production-readiness",
  "/api/production-cutover",
  "/api/production-evidence-template",
  "/api/project-board",
  "/api/work-items",
  "/api/work-cycles",
  "/api/work-modules",
  "/api/work-progress",
  "/api/work-views",
  "/api/work-views/evaluate",
  "/api/work-pages",
  "/api/work-context",
  "/api/work-dashboard",
  "/api/work-intake",
  "/api/merge-queue",
  "/api/merge-train",
  "/api/search",
  "/api/queue/simulate",
  "/api/release-readiness",
  "/api/repository-protection",
  "/api/agent-insights",
  "/api/agents",
  "/api/agent-performance",
  "/api/agent-routing",
  "/api/agents/{agentId}/bootstrap",
  "/api/agents/{agentId}/cockpit",
  "/api/agents/{agentId}/action-plan",
  "/api/agents/{agentId}/submission-gate",
  "/api/agents/{agentId}/work-preflight",
  "/api/agents/{agentId}/work-reservation",
  "/api/ci/failure-analysis",
  "/api/ci/validation-plan",
  "/api/pr/brief",
  "/api/review/assignment",
  "/api/patch/conflict-prediction",
  "/api/releases/notes",
  "/api/agents/{agentId}/inbox",
  "/api/agents/{agentId}/claim-assignment",
  "/api/agents/{agentId}/claim-next",
  "/api/coordination",
  "/api/fleet-coordination",
  "/api/claims/transfer",
];

const FORBIDDEN_PRIVATE_REFERENCES = [
  patternFrom("smi", "thers"),
  patternFrom("jj", "hub"),
  patternFrom("pla", "ne\\.so"),
  patternFrom("omo", "ika"),
  patternFrom("ja", "red"),
  patternFrom("jer", "lend"),
  patternFrom("ivan", "hercaz"),
  patternFrom("terminal", "-theme"),
  patternFrom("forgejo", "-terminal"),
  patternFrom("inspired", " by"),
  patternFrom("reference", " project"),
  patternFrom("source", " project"),
  patternFrom("jj", "-style"),
];

describe("OpenAPI contract", () => {
  it("is valid JSON with the package version and private control auth defaults", async () => {
    const [openapi, packageJson] = await Promise.all([
      readOpenApi(),
      readJson(PACKAGE_URL),
    ]);

    assert.equal(openapi.openapi, "3.1.0");
    assert.equal(openapi.info.title, "Eliza Merge Steward API");
    assert.equal(openapi.info.version, packageJson.version);
    assert.deepEqual(openapi.security, [{ bearerAuth: [] }]);
    assert.equal(openapi.components.securitySchemes.bearerAuth.type, "http");
    assert.equal(
      openapi.components.securitySchemes.bearerAuth.scheme,
      "bearer",
    );
    assert.equal(
      openapi.components.securitySchemes.forgejoSignature.name,
      "X-Forgejo-Signature",
    );
    assert.deepEqual(openapi.paths["/health"].get.security, []);
    assert.deepEqual(openapi.paths["/ready"].get.security, []);
    assert.deepEqual(
      openapi.paths["/.well-known/eliza-hub.json"].get.security,
      [],
    );
    assert.deepEqual(openapi.paths["/openapi.json"].get.security, []);
    assert.deepEqual(openapi.paths["/api/webhooks/forgejo"].post.security, [
      { forgejoSignature: [] },
    ]);
  });

  it("does not include private source or partnership references", async () => {
    const text = await readFile(OPENAPI_URL, "utf8");

    for (const pattern of FORBIDDEN_PRIVATE_REFERENCES) {
      assert.doesNotMatch(
        text,
        pattern,
        `OpenAPI contract contains forbidden reference ${pattern}`,
      );
    }
  });

  it("documents every implemented server path", async () => {
    const [openapi, serverSource] = await Promise.all([
      readOpenApi(),
      readFile(SERVER_URL, "utf8"),
    ]);

    const documentedPaths = new Set(Object.keys(openapi.paths));
    const implementedPaths = implementedServerPaths(serverSource);

    for (const path of implementedPaths) {
      assert.ok(
        documentedPaths.has(path),
        `OpenAPI contract is missing implemented path ${path}`,
      );
    }
  });

  it("resolves every local reference", async () => {
    const openapi = await readOpenApi();
    const refs = collectRefs(openapi);

    assert.ok(
      refs.size > 0,
      "OpenAPI contract should use shared local references",
    );
    for (const ref of refs) {
      assert.ok(
        resolveJsonPointer(openapi, ref),
        `OpenAPI contract has unresolved reference ${ref}`,
      );
    }
  });

  it("documents agent work split plans as part of preflight", async () => {
    const openapi = await readOpenApi();
    const submissionGate = openapi.components.schemas.AgentSubmissionGate;
    const submissionDecision =
      openapi.components.schemas.AgentSubmissionGateDecision;
    const preflight = openapi.components.schemas.AgentWorkPreflight;
    const proposed = openapi.components.schemas.AgentWorkPreflightProposed;
    const decision = openapi.components.schemas.AgentWorkPreflightDecision;
    const branchNamespace =
      openapi.components.schemas.AgentWorkPreflightBranchNamespace;
    const hotspots = openapi.components.schemas.AgentWorkPreflightHotspots;
    const hotPath = openapi.components.schemas.AgentWorkPreflightHotPath;
    const hotPackage = openapi.components.schemas.AgentWorkPreflightHotPackage;
    const suggestedClaim = openapi.components.schemas.AgentWorkClaimRequest;
    const overlaps = openapi.components.schemas.AgentWorkPreflightOverlaps;
    const workItemOverlap = openapi.components.schemas.AgentWorkItemOverlap;
    const splitPlan = openapi.components.schemas.AgentWorkSplitPlan;

    assert.equal(
      submissionGate.properties.decision.$ref,
      "#/components/schemas/AgentSubmissionGateDecision",
    );
    assert.ok(
      submissionDecision.properties.state.enum.includes("needs_verification"),
    );
    assert.equal(submissionDecision.properties.allowed.type, "boolean");
    assert.equal(submissionDecision.properties.score.maximum, 100);
    assert.equal(
      preflight.properties.proposed.$ref,
      "#/components/schemas/AgentWorkPreflightProposed",
    );
    assert.equal(proposed.properties.changedFiles.items.type, "string");
    assert.equal(proposed.properties.fileCount.minimum, 0);
    assert.equal(
      preflight.properties.decision.$ref,
      "#/components/schemas/AgentWorkPreflightDecision",
    );
    assert.ok(decision.properties.state.enum.includes("blocked"));
    assert.equal(
      decision.properties.branchNamespace.$ref,
      "#/components/schemas/AgentWorkPreflightBranchNamespace",
    );
    assert.equal(
      branchNamespace.properties.expectedNamespace.type[0],
      "string",
    );
    assert.equal(
      preflight.properties.hotspots.$ref,
      "#/components/schemas/AgentWorkPreflightHotspots",
    );
    assert.equal(
      hotspots.properties.paths.items.$ref,
      "#/components/schemas/AgentWorkPreflightHotPath",
    );
    assert.equal(
      hotspots.properties.packages.items.$ref,
      "#/components/schemas/AgentWorkPreflightHotPackage",
    );
    assert.equal(hotPath.properties.path.type, "string");
    assert.equal(hotPackage.properties.package.type, "string");
    assert.equal(
      preflight.properties.suggestedClaims.items.$ref,
      "#/components/schemas/AgentWorkClaimRequest",
    );
    assert.ok(suggestedClaim.properties.resourceKind.enum.includes("path"));
    assert.equal(
      preflight.properties.overlaps.$ref,
      "#/components/schemas/AgentWorkPreflightOverlaps",
    );
    assert.equal(
      overlaps.properties.workItems.items.$ref,
      "#/components/schemas/AgentWorkItemOverlap",
    );
    assert.equal(workItemOverlap.properties.blocking.type, "boolean");
    assert.equal(workItemOverlap.properties.suggestedAction.type, "string");
    assert.equal(
      preflight.properties.splitPlan.$ref,
      "#/components/schemas/AgentWorkSplitPlan",
    );
    assert.equal(splitPlan.properties.recommended.type, "boolean");
    assert.equal(splitPlan.properties.strategy.type, "string");
    assert.equal(splitPlan.properties.units.type, "array");
    assert.equal(splitPlan.properties.nextActions.type, "array");
  });

  it("documents typed request bodies for bootstrap-driven agent gates", async () => {
    const openapi = await readOpenApi();
    const submissionGatePath =
      openapi.paths["/api/agents/{agentId}/submission-gate"];
    const workPreflightPath =
      openapi.paths["/api/agents/{agentId}/work-preflight"];
    const workReservationPath =
      openapi.paths["/api/agents/{agentId}/work-reservation"];
    const submissionGateBody =
      openapi.components.requestBodies.AgentSubmissionGate;
    const workPreflightBody =
      openapi.components.requestBodies.AgentWorkPreflight;
    const workReservationBody =
      openapi.components.requestBodies.AgentWorkReservation;
    const submissionGate =
      openapi.components.schemas.AgentSubmissionGateRequest;
    const workPreflight = openapi.components.schemas.AgentWorkPreflightRequest;
    const workReservation =
      openapi.components.schemas.AgentWorkReservationRequest;

    assert.equal(
      submissionGatePath.post.requestBody.$ref,
      "#/components/requestBodies/AgentSubmissionGate",
    );
    assert.equal(
      workPreflightPath.post.requestBody.$ref,
      "#/components/requestBodies/AgentWorkPreflight",
    );
    assert.equal(
      workReservationPath.post.requestBody.$ref,
      "#/components/requestBodies/AgentWorkReservation",
    );
    assert.equal(
      submissionGateBody.content["application/json"].schema.$ref,
      "#/components/schemas/AgentSubmissionGateRequest",
    );
    assert.equal(
      workPreflightBody.content["application/json"].schema.$ref,
      "#/components/schemas/AgentWorkPreflightRequest",
    );
    assert.equal(
      workReservationBody.content["application/json"].schema.$ref,
      "#/components/schemas/AgentWorkReservationRequest",
    );
    assert.equal(
      submissionGate.properties.validationCommands.items.type,
      "string",
    );
    assert.equal(submissionGate.properties.commands.items.type, "string");
    assert.equal(
      submissionGate.properties.requestedCommands.items.type,
      "string",
    );
    assert.equal(submissionGate.properties.requireWorkItem.type, "boolean");
    assert.equal(submissionGate.properties.requireWorkLink.type, "boolean");
    assert.equal(
      submissionGate.properties.requireAgentIdentityRegistry.type,
      "boolean",
    );
    assert.equal(submissionGate.properties.since.format, "date-time");
    assert.equal(workPreflight.properties.changedFiles.items.type, "string");
    assert.equal(workPreflight.properties.paths.items.type, "string");
    assert.equal(
      workPreflight.properties.affectedPackages.items.type,
      "string",
    );
    assert.equal(workPreflight.properties.packages.items.type, "string");
    assert.equal(
      workPreflight.properties.requireBranchNamespace.type,
      "boolean",
    );
    assert.equal(workReservation.properties.ttlMs.minimum, 0);
    assert.equal(workReservation.properties.dryRun.type, "boolean");
    assert.equal(workReservation.properties.allowWatch.type, "boolean");
    assert.equal(workReservation.properties.maxClaims.minimum, 0);
    assert.equal(workReservation.properties.createWorkItem.type, "boolean");
  });

  it("documents typed request bodies for analysis and search APIs", async () => {
    const openapi = await readOpenApi();
    const ciFailurePath = openapi.paths["/api/ci/failure-analysis"];
    const validationPath = openapi.paths["/api/ci/validation-plan"];
    const briefPath = openapi.paths["/api/pr/brief"];
    const reviewPath = openapi.paths["/api/review/assignment"];
    const conflictPath = openapi.paths["/api/patch/conflict-prediction"];
    const searchPath = openapi.paths["/api/search"];
    const ciFailure = openapi.components.schemas.CiFailureAnalysisRequest;
    const ciCheck = openapi.components.schemas.CiFailureCheckInput;
    const ciLog = openapi.components.schemas.CiFailureLogInput;
    const validation = openapi.components.schemas.CiValidationPlanRequest;
    const brief = openapi.components.schemas.PullRequestBriefRequest;
    const review = openapi.components.schemas.ReviewAssignmentRequest;
    const conflict = openapi.components.schemas.PatchConflictPredictionRequest;
    const search = openapi.components.schemas.RepoSearchRequest;
    const searchDocument = openapi.components.schemas.RepoSearchDocumentInput;
    const queueItem = openapi.components.schemas.AnalysisQueueItemInput;
    const limits = openapi.components.schemas.ValidationPlanLimits;
    const searchLimits = openapi.components.schemas.RepoSearchLimits;

    assert.equal(
      ciFailurePath.post.requestBody.$ref,
      "#/components/requestBodies/CiFailureAnalysis",
    );
    assert.equal(
      validationPath.post.requestBody.$ref,
      "#/components/requestBodies/CiValidationPlan",
    );
    assert.equal(
      briefPath.post.requestBody.$ref,
      "#/components/requestBodies/PullRequestBrief",
    );
    assert.equal(
      reviewPath.post.requestBody.$ref,
      "#/components/requestBodies/ReviewAssignment",
    );
    assert.equal(
      conflictPath.post.requestBody.$ref,
      "#/components/requestBodies/PatchConflictPrediction",
    );
    assert.equal(
      searchPath.post.requestBody.$ref,
      "#/components/requestBodies/RepoSearch",
    );
    assert.equal(
      openapi.components.requestBodies.CiFailureAnalysis.content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/CiFailureAnalysisRequest",
    );
    assert.equal(
      openapi.components.requestBodies.CiValidationPlan.content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/CiValidationPlanRequest",
    );
    assert.equal(
      openapi.components.requestBodies.PullRequestBrief.content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/PullRequestBriefRequest",
    );
    assert.equal(
      openapi.components.requestBodies.ReviewAssignment.content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/ReviewAssignmentRequest",
    );
    assert.equal(
      openapi.components.requestBodies.PatchConflictPrediction.content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/PatchConflictPredictionRequest",
    );
    assert.equal(
      openapi.components.requestBodies.RepoSearch.content["application/json"]
        .schema.$ref,
      "#/components/schemas/RepoSearchRequest",
    );
    assert.equal(
      ciFailure.properties.item.oneOf[0].$ref,
      "#/components/schemas/AnalysisQueueItemInput",
    );
    assert.equal(
      ciFailure.properties.checks.items.$ref,
      "#/components/schemas/CiFailureCheckInput",
    );
    assert.equal(
      ciFailure.properties.logs.items.$ref,
      "#/components/schemas/CiFailureLogInput",
    );
    assert.equal(ciFailure.properties.now.format, "date-time");
    assert.equal(
      ciCheck.properties.annotations.items.$ref,
      "#/components/schemas/AnyObject",
    );
    assert.equal(ciLog.properties.text.type, "string");
    assert.equal(validation.properties.commands.items.type, "string");
    assert.equal(validation.properties.requestedCommands.items.type, "string");
    assert.equal(
      validation.properties.limits.$ref,
      "#/components/schemas/ValidationPlanLimits",
    );
    assert.equal(validation.properties.allowBroadCommands.type, "boolean");
    assert.equal(limits.properties.maxBroadCommands.minimum, 0);
    assert.equal(limits.properties.maxRecommendations.minimum, 0);
    assert.equal(brief.properties.validationCommands.items.type, "string");
    assert.equal(brief.properties.commands.items.type, "string");
    assert.equal(
      brief.properties.requestedValidationCommands.items.type,
      "string",
    );
    assert.equal(
      brief.properties.validationLimits.$ref,
      "#/components/schemas/ValidationPlanLimits",
    );
    assert.equal(
      brief.properties.submissionGate.$ref,
      "#/components/schemas/AnyObject",
    );
    assert.equal(brief.properties.requireWorkReservation.type, "boolean");
    assert.equal(
      review.properties.proposedItem.oneOf[0].$ref,
      "#/components/schemas/AnalysisQueueItemInput",
    );
    assert.equal(review.properties.changedFiles.items.type, "string");
    assert.equal(review.properties.paths.items.type, "string");
    assert.equal(review.properties.maxSuggestions.minimum, 0);
    assert.equal(
      conflict.properties.proposedItem.oneOf[0].$ref,
      "#/components/schemas/AnalysisQueueItemInput",
    );
    assert.equal(conflict.properties.changedFiles.items.type, "string");
    assert.equal(conflict.properties.paths.items.type, "string");
    assert.equal(conflict.properties.targetCommitsBehind.minimum, 0);
    assert.equal(
      search.properties.documents.items.$ref,
      "#/components/schemas/RepoSearchDocumentInput",
    );
    assert.equal(
      search.properties.limits.$ref,
      "#/components/schemas/RepoSearchLimits",
    );
    assert.equal(search.properties.kinds.items.type, "string");
    assert.equal(search.properties.kind.items.type, "string");
    assert.equal(searchLimits.properties.maxResults.minimum, 1);
    assert.equal(searchLimits.properties.maxFieldLength.minimum, 1);
    assert.equal(searchDocument.properties.body.type[0], "string");
    assert.equal(searchDocument.properties.text.type[0], "string");
    assert.equal(searchDocument.properties.paths.items.type, "string");
    assert.equal(
      searchDocument.properties.metadata.$ref,
      "#/components/schemas/AnyObject",
    );
    assert.equal(queueItem.properties.changedFiles.items.type, "string");
    assert.equal(queueItem.properties.requiredChecks.items.type, "string");
    assert.equal(
      queueItem.properties.checkResults.$ref,
      "#/components/schemas/AnyObject",
    );
  });

  it("documents typed response bodies for CI analysis APIs", async () => {
    const openapi = await readOpenApi();
    const ciFailureResponse =
      openapi.components.schemas.CiFailureAnalysisResponse;
    const validationResponse =
      openapi.components.schemas.CiValidationPlanResponse;
    const analysis = openapi.components.schemas.CiFailureAnalysis;
    const analysisSummary = openapi.components.schemas.CiFailureAnalysisSummary;
    const analysisEntry = openapi.components.schemas.CiFailureAnalysisEntry;
    const evidence = openapi.components.schemas.CiFailureEvidence;
    const impact = openapi.components.schemas.CiFailureImpact;
    const recommendation = openapi.components.schemas.CiFailureRecommendation;
    const validationPlan = openapi.components.schemas.CiValidationPlan;
    const validationSummary =
      openapi.components.schemas.CiValidationPlanSummary;
    const decision = openapi.components.schemas.CiValidationDecision;
    const command = openapi.components.schemas.CiValidationCommand;
    const recommendedCommand =
      openapi.components.schemas.ValidationCommandRecommendation;

    assert.equal(
      ciFailureResponse.properties.analysis.$ref,
      "#/components/schemas/CiFailureAnalysis",
    );
    assert.equal(
      validationResponse.properties.validationPlan.$ref,
      "#/components/schemas/CiValidationPlan",
    );
    assert.equal(analysis.properties.computedAt.format, "date-time");
    assert.equal(
      analysis.properties.queueItem.$ref,
      "#/components/schemas/CiFailureAnalysisQueueItem",
    );
    assert.equal(
      analysis.properties.summary.$ref,
      "#/components/schemas/CiFailureAnalysisSummary",
    );
    assert.equal(
      analysis.properties.analyses.items.$ref,
      "#/components/schemas/CiFailureAnalysisEntry",
    );
    assert.equal(
      analysis.properties.recommendations.items.$ref,
      "#/components/schemas/CiFailureRecommendation",
    );
    assert.equal(analysisSummary.properties.totalLogs.minimum, 0);
    assert.equal(analysisSummary.properties.failedLogs.minimum, 0);
    assert.ok(analysisSummary.properties.maxSeverity.enum.includes("high"));
    assert.equal(analysisSummary.properties.retryable.type, "boolean");
    assert.equal(analysisEntry.properties.confidence.maximum, 1);
    assert.equal(
      analysisEntry.properties.evidence.items.$ref,
      "#/components/schemas/CiFailureEvidence",
    );
    assert.equal(
      analysisEntry.properties.impact.$ref,
      "#/components/schemas/CiFailureImpact",
    );
    assert.equal(
      analysisEntry.properties.suggestedActions.items.type,
      "string",
    );
    assert.ok(
      evidence.properties.line.oneOf.some(
        (option) => option.type === "integer",
      ),
    );
    assert.ok(evidence.properties.path.type.includes("null"));
    assert.equal(evidence.properties.text.type, "string");
    assert.equal(impact.properties.paths.items.type, "string");
    assert.equal(impact.properties.packages.items.type, "string");
    assert.equal(recommendation.properties.evidence.items.type, "string");
    assert.ok(recommendation.properties.ownerAgentId.type.includes("null"));
    assert.equal(validationPlan.properties.computedAt.format, "date-time");
    assert.equal(validationPlan.properties.changedFiles.items.type, "string");
    assert.equal(
      validationPlan.properties.affectedPackages.items.type,
      "string",
    );
    assert.equal(
      validationPlan.properties.summary.$ref,
      "#/components/schemas/CiValidationPlanSummary",
    );
    assert.equal(
      validationPlan.properties.decision.$ref,
      "#/components/schemas/CiValidationDecision",
    );
    assert.equal(
      validationPlan.properties.commands.items.$ref,
      "#/components/schemas/CiValidationCommand",
    );
    assert.equal(
      validationPlan.properties.recommendedCommands.items.$ref,
      "#/components/schemas/ValidationCommandRecommendation",
    );
    assert.equal(validationPlan.properties.labels.items.type, "string");
    assert.equal(validationSummary.properties.commandCount.minimum, 0);
    assert.equal(validationSummary.properties.maxEstimatedCost.minimum, 0);
    assert.equal(decision.properties.allowed.type, "boolean");
    assert.ok(decision.properties.state.enum.includes("needs_validation_plan"));
    assert.equal(
      decision.properties.recommendedCommands.items.$ref,
      "#/components/schemas/ValidationCommandRecommendation",
    );
    assert.equal(decision.properties.allowBroadCommands.type, "boolean");
    assert.ok(command.properties.intent.enum.includes("typecheck"));
    assert.ok(command.properties.scope.enum.includes("scoped"));
    assert.ok(command.properties.status.enum.includes("blocked"));
    assert.equal(command.properties.estimatedCost.minimum, 0);
    assert.equal(command.properties.requiredActions.items.type, "string");
    assert.ok(recommendedCommand.properties.package.type.includes("null"));
  });

  it("documents reservation-created Work items", async () => {
    const openapi = await readOpenApi();
    const reservation = openapi.components.schemas.AgentWorkReservation;
    const attempt = openapi.components.schemas.AgentWorkReservationAttempt;
    const claim = openapi.components.schemas.AgentWorkClaimRecord;

    assert.equal(
      reservation.properties.requestedClaims.items.$ref,
      "#/components/schemas/AgentWorkClaimRequest",
    );
    assert.equal(
      reservation.properties.attempted.items.$ref,
      "#/components/schemas/AgentWorkReservationAttempt",
    );
    assert.equal(
      reservation.properties.claims.items.$ref,
      "#/components/schemas/AgentWorkClaimRecord",
    );
    assert.equal(
      reservation.properties.rolledBackClaims.items.$ref,
      "#/components/schemas/AgentWorkClaimRecord",
    );
    assert.equal(
      attempt.properties.claim.oneOf[0].$ref,
      "#/components/schemas/AgentWorkClaimRecord",
    );
    assert.equal(attempt.properties.claimed.type, "boolean");
    assert.equal(claim.properties.paths.items.type, "string");
    assert.equal(claim.properties.expiresAt.format, "date-time");
    assert.equal(
      reservation.properties.workItem.oneOf[0].$ref,
      "#/components/schemas/WorkItem",
    );
    assert.equal(
      reservation.properties.plannedWorkItem.oneOf[0].$ref,
      "#/components/schemas/WorkItem",
    );
    assert.ok(reservation.properties.workItemAction.enum.includes("upserted"));
    assert.ok(reservation.properties.workItemAction.enum.includes("planned"));
  });

  it("documents PR brief commit hygiene", async () => {
    const openapi = await readOpenApi();
    const brief = openapi.components.schemas.PullRequestBrief;
    const commitHygiene = openapi.components.schemas.PullRequestCommitHygiene;

    assert.equal(
      brief.properties.commitHygiene.oneOf[0].$ref,
      "#/components/schemas/PullRequestCommitHygiene",
    );
    assert.ok(commitHygiene.properties.state.enum.includes("needs_summary"));
    assert.ok(commitHygiene.properties.state.enum.includes("summary_provided"));
    assert.equal(commitHygiene.properties.lowSignalMessages.type, "array");
    assert.equal(commitHygiene.properties.requiredActions.type, "array");
  });

  it("documents release notes", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/releases/notes"];
    const notes = openapi.components.schemas.ReleaseNotes;

    assert.equal(path.get.operationId, "getReleaseNotes");
    assert.equal(path.post.operationId, "buildReleaseNotes");
    assert.equal(
      path.post.responses["200"].$ref,
      "#/components/responses/ReleaseNotes",
    );
    assert.equal(
      notes.properties.sections.items.$ref,
      "#/components/schemas/ReleaseNotesSection",
    );
    assert.equal(notes.properties.markdown.type, "string");
  });

  it("documents patch conflict prediction", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/patch/conflict-prediction"];
    const prediction = openapi.components.schemas.PatchConflictPrediction;
    const decision = openapi.components.schemas.PatchConflictDecision;

    assert.equal(path.post.operationId, "predictPatchConflicts");
    assert.equal(
      path.post.responses["200"].$ref,
      "#/components/responses/PatchConflictPrediction",
    );
    assert.equal(
      prediction.properties.prediction.$ref,
      "#/components/schemas/PatchConflictDecision",
    );
    assert.equal(prediction.properties.labels.type, "array");
    assert.ok(decision.properties.state.enum.includes("blocked"));
    assert.ok(decision.properties.state.enum.includes("watch"));
    assert.equal(decision.properties.safeToStart.type, "boolean");
  });

  it("documents repo search", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/search"];
    const search = openapi.components.schemas.RepoSearch;
    const result = openapi.components.schemas.RepoSearchResult;

    assert.equal(path.get.operationId, "searchRepoContext");
    assert.equal(path.post.operationId, "searchRepoContextWithDocuments");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/RepoSearch",
    );
    assert.equal(
      path.post.responses["200"].$ref,
      "#/components/responses/RepoSearch",
    );
    assert.equal(
      search.properties.results.items.$ref,
      "#/components/schemas/RepoSearchResult",
    );
    assert.equal(
      search.properties.summary.$ref,
      "#/components/schemas/RepoSearchSummary",
    );
    assert.equal(result.properties.snippets.type, "array");
    assert.equal(result.properties.matches.type, "array");
  });

  it("documents Eliza Work saved-view evaluation", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/work-views/evaluate"];
    const response = openapi.components.schemas.WorkViewEvaluationResponse;
    const evaluation = openapi.components.schemas.WorkViewEvaluation;

    assert.equal(path.get.operationId, "evaluateWorkView");
    assert.equal(path.post.operationId, "previewWorkView");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/WorkViewEvaluation",
    );
    assert.equal(
      path.post.responses["200"].$ref,
      "#/components/responses/WorkViewEvaluation",
    );
    assert.equal(
      response.properties.workViewEvaluation.$ref,
      "#/components/schemas/WorkViewEvaluation",
    );
    assert.equal(
      evaluation.properties.columns.items.$ref,
      "#/components/schemas/WorkViewEvaluationColumn",
    );
    assert.equal(
      evaluation.properties.rows.items.$ref,
      "#/components/schemas/WorkViewEvaluationRow",
    );
    assert.equal(
      evaluation.properties.pages.items.$ref,
      "#/components/schemas/WorkViewEvaluationPage",
    );
    assert.equal(
      evaluation.properties.summary.properties.totalItems.type,
      "integer",
    );
    assert.equal(evaluation.properties.nextActions.items.type, "string");
  });

  it("documents Eliza Work pages", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/work-pages"];
    const itemPath = openapi.paths["/api/work-pages/item"];
    const transitionPath = openapi.paths["/api/work-pages/transition"];
    const page = openapi.components.schemas.WorkPage;

    assert.equal(path.get.operationId, "listWorkPages");
    assert.equal(path.post.operationId, "upsertWorkPage");
    assert.equal(itemPath.get.operationId, "getWorkPage");
    assert.equal(transitionPath.post.operationId, "transitionWorkPage");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/WorkPages",
    );
    assert.equal(
      path.post.responses["200"].$ref,
      "#/components/responses/WorkPage",
    );
    assert.equal(
      transitionPath.post.requestBody.content["application/json"].schema.$ref,
      "#/components/schemas/WorkPageTransitionRequest",
    );
    assert.ok(page.properties.kind.enum.includes("agent_plan"));
    assert.ok(page.properties.kind.enum.includes("runbook"));
    assert.equal(page.properties.body.type, "string");
    assert.equal(page.properties.workItemId.type, "string");
    assert.equal(
      openapi.components.schemas.WorkPagesResponse.properties.workPages.items
        .$ref,
      "#/components/schemas/WorkPage",
    );
  });

  it("documents merge train plans", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/merge-train"];
    const response = openapi.components.schemas.MergeTrainResponse;
    const plan = openapi.components.schemas.MergeTrainPlan;
    const selection = openapi.components.schemas.MergeTrainSelection;
    const preflight = openapi.components.schemas.MergeTrainPreflight;

    assert.equal(path.get.operationId, "getMergeTrain");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/MergeTrain",
    );
    assert.equal(
      response.properties.mergeTrain.$ref,
      "#/components/schemas/MergeTrainPlan",
    );
    assert.equal(plan.properties.readOnly.const, true);
    assert.equal(
      plan.properties.selectedTrain.$ref,
      "#/components/schemas/MergeTrainSelection",
    );
    assert.equal(
      plan.properties.preflight.$ref,
      "#/components/schemas/MergeTrainPreflight",
    );
    assert.equal(
      plan.properties.lanes.items.$ref,
      "#/components/schemas/MergeTrainLane",
    );
    assert.equal(
      plan.properties.queue.$ref,
      "#/components/schemas/MergeTrainQueue",
    );
    assert.equal(selection.properties.executionReady.type, "boolean");
    assert.equal(selection.properties.blockers.items.type, "string");
    assert.ok(preflight.properties.status.enum.includes("live_ready"));
    assert.ok(preflight.properties.status.enum.includes("dry_run_ready"));
    assert.equal(preflight.properties.liveExecutionReady.type, "boolean");
    assert.equal(
      preflight.properties.checks.items.$ref,
      "#/components/schemas/MergeTrainPreflightCheck",
    );
  });

  it("documents workflow operations as a typed workflow view surface", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/workflows"];
    const response = openapi.components.schemas.WorkflowViewResponse;
    const workflow = openapi.components.schemas.WorkflowView;
    const operations = openapi.components.schemas.WorkflowOperations;

    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/WorkflowView",
    );
    assert.ok(
      path.get.parameters.some(
        (parameter) => parameter.$ref === "#/components/parameters/Repo",
      ),
    );
    assert.ok(
      path.get.parameters.some(
        (parameter) =>
          parameter.$ref === "#/components/parameters/TargetBranch",
      ),
    );
    assert.ok(
      path.get.parameters.some(
        (parameter) =>
          parameter.$ref === "#/components/parameters/OwnerAgentId",
      ),
    );
    assert.equal(
      response.properties.workflow.$ref,
      "#/components/schemas/WorkflowView",
    );
    assert.equal(
      workflow.properties.operations.$ref,
      "#/components/schemas/WorkflowOperations",
    );
    assert.equal(
      workflow.properties.filters.$ref,
      "#/components/schemas/WorkflowFilters",
    );
    assert.equal(
      operations.properties.controlPlane.$ref,
      "#/components/schemas/WorkflowControlPlane",
    );
    assert.equal(
      operations.properties.actions.$ref,
      "#/components/schemas/WorkflowActions",
    );
    assert.equal(
      operations.properties.runner.$ref,
      "#/components/schemas/WorkflowRunner",
    );
    assert.equal(
      operations.properties.mergeQueue.$ref,
      "#/components/schemas/WorkflowMergeQueueOperations",
    );
  });

  it("documents PR-scoped queue item action plans", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/queue/item/action-plan"];
    const response = openapi.components.schemas.QueueItemActionPlanResponse;
    const actionPlan = openapi.components.schemas.QueueItemActionPlan;
    const item = openapi.components.schemas.QueueItemActionPlanItem;
    const queue = openapi.components.schemas.QueueItemActionPlanQueue;
    const step = openapi.components.schemas.QueueItemActionPlanStep;

    assert.equal(path.get.operationId, "getQueueItemActionPlan");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/QueueItemActionPlan",
    );
    assert.ok(
      path.get.parameters.some(
        (parameter) => parameter.name === "id" && parameter.required === true,
      ),
    );
    assert.ok(
      path.get.parameters.some(
        (parameter) => parameter.name === "ownerAgentId",
      ),
    );
    assert.equal(
      response.properties.queueItemActionPlan.$ref,
      "#/components/schemas/QueueItemActionPlan",
    );
    assert.equal(actionPlan.properties.version.const, 1);
    assert.equal(
      actionPlan.properties.schema.const,
      "https://eliza.hub/schemas/queue-item-action-plan.v1",
    );
    assert.equal(actionPlan.properties.readOnly.const, true);
    assert.ok(actionPlan.properties.status.enum.includes("needs_attention"));
    assert.equal(
      actionPlan.properties.item.$ref,
      "#/components/schemas/QueueItemActionPlanItem",
    );
    assert.equal(
      actionPlan.properties.queue.$ref,
      "#/components/schemas/QueueItemActionPlanQueue",
    );
    assert.equal(
      actionPlan.properties.nextSteps.items.$ref,
      "#/components/schemas/QueueItemActionPlanStep",
    );
    assert.deepEqual(item.properties.ownerAgentId.type, ["string", "null"]);
    assert.equal(queue.properties.scheduled.type, "boolean");
    assert.equal(step.properties.blocking.type, "boolean");
  });

  it("documents the one-call agent cockpit surface", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/agents/{agentId}/cockpit"];
    const response = openapi.components.schemas.AgentCockpitResponse;
    const cockpit = openapi.components.schemas.AgentCockpit;
    const summary = openapi.components.schemas.AgentCockpitSummary;
    const focusCard = openapi.components.schemas.AgentCockpitFocusCard;
    const snapshots = openapi.components.schemas.AgentCockpitSnapshots;

    assert.equal(path.get.operationId, "getAgentCockpit");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/AgentCockpit",
    );
    assert.ok(
      path.get.parameters.some(
        (parameter) => parameter.$ref === "#/components/parameters/AgentId",
      ),
    );
    assert.ok(
      path.get.parameters.some(
        (parameter) => parameter.$ref === "#/components/parameters/Repo",
      ),
    );
    assert.ok(
      path.get.parameters.some(
        (parameter) =>
          parameter.$ref === "#/components/parameters/TargetBranch",
      ),
    );
    assert.equal(
      response.properties.cockpit.$ref,
      "#/components/schemas/AgentCockpit",
    );
    assert.equal(cockpit.properties.version.const, 1);
    assert.equal(
      cockpit.properties.schema.const,
      "https://eliza.hub/schemas/agent-cockpit.v1",
    );
    assert.equal(cockpit.properties.readOnly.const, true);
    assert.ok(cockpit.properties.status.enum.includes("needs_attention"));
    assert.equal(
      cockpit.properties.summary.$ref,
      "#/components/schemas/AgentCockpitSummary",
    );
    assert.equal(
      cockpit.properties.focusCards.items.$ref,
      "#/components/schemas/AgentCockpitFocusCard",
    );
    assert.equal(
      cockpit.properties.nextActions.items.$ref,
      "#/components/schemas/AgentCockpitAction",
    );
    assert.equal(
      focusCard.properties.links.$ref,
      "#/components/schemas/AnyObject",
    );
    assert.equal(summary.properties.submissionAllowed.type[0], "boolean");
    assert.equal(summary.properties.submissionAllowed.type[1], "null");
    assert.equal(
      snapshots.properties.workflow.$ref,
      "#/components/schemas/WorkflowView",
    );
    assert.equal(
      snapshots.properties.workContext.$ref,
      "#/components/schemas/WorkContext",
    );
  });

  it("documents agent bootstrap links and policy hints for generated clients", async () => {
    const openapi = await readOpenApi();
    const bootstrap = openapi.components.schemas.AgentBootstrap;
    const links = openapi.components.schemas.AgentBootstrapLinks;
    const policyHints = openapi.components.schemas.AgentBootstrapPolicyHints;
    const workItem = openapi.components.schemas.AgentBootstrapWorkItemPolicy;
    const branchNamespace =
      openapi.components.schemas.AgentBootstrapBranchNamespacePolicy;
    const runReceipt =
      openapi.components.schemas.AgentBootstrapRunReceiptPolicy;
    const identityRegistry =
      openapi.components.schemas.AgentBootstrapIdentityRegistryPolicy;
    const validationBudget =
      openapi.components.schemas.AgentBootstrapValidationBudgetPolicy;
    const submissionGate =
      openapi.components.schemas.AgentBootstrapSubmissionGatePolicy;
    const mergeQueue =
      openapi.components.schemas.AgentBootstrapMergeQueuePolicy;
    const workflowOperations =
      openapi.components.schemas.AgentBootstrapWorkflowOperationsPolicy;

    assert.equal(
      bootstrap.properties.policyHints.$ref,
      "#/components/schemas/AgentBootstrapPolicyHints",
    );
    assert.equal(
      bootstrap.properties.links.$ref,
      "#/components/schemas/AgentBootstrapLinks",
    );
    assert.equal(
      bootstrap.properties.nextActions.items.$ref,
      "#/components/schemas/AgentNextAction",
    );
    assert.ok(links.required.includes("discovery"));
    assert.ok(links.required.includes("workPreflight"));
    assert.ok(links.required.includes("claimNext"));
    assert.equal(
      links.properties.discovery.const,
      "/.well-known/eliza-hub.json",
    );
    assert.equal(links.properties.openapi.const, "/openapi.json");
    assert.deepEqual(policyHints.required, [
      "workReservation",
      "workItem",
      "agentBranchNamespace",
      "agentRunReceipt",
      "agentIdentityRegistry",
      "validationBudget",
      "submissionGate",
      "mergeQueue",
      "workflowOperations",
    ]);
    assert.equal(
      policyHints.properties.workItem.$ref,
      "#/components/schemas/AgentBootstrapWorkItemPolicy",
    );
    assert.equal(workItem.properties.linkBeforePullRequest.const, true);
    assert.ok(
      workItem.properties.matchKeys.items.enum.includes("pullRequestId"),
    );
    assert.deepEqual(branchNamespace.required, [
      "required",
      "prefix",
      "expectedPrefix",
    ]);
    assert.equal(runReceipt.properties.signatureAlgorithm.const, "hmac-sha256");
    assert.ok(
      identityRegistry.properties.state.enum.includes("unregistered_blocked"),
    );
    assert.equal(validationBudget.properties.planBeforeRunning.const, true);
    assert.equal(
      validationBudget.properties.broadValidationBlockedByDefault.const,
      true,
    );
    assert.equal(submissionGate.properties.checkBeforePullRequest.const, true);
    assert.equal(
      submissionGate.properties.recentSubmissionWindowMinutes.minimum,
      1,
    );
    assert.ok(mergeQueue.required.includes("liveExecutionReady"));
    assert.ok(mergeQueue.required.includes("dryRunReviewReady"));
    assert.equal(
      workflowOperations.properties.nextActions.items.type,
      "string",
    );
  });

  it("documents production readiness current-use states", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/production-readiness"];
    const response = openapi.components.schemas.ProductionReadinessResponse;
    const readiness = openapi.components.schemas.ProductionReadinessChecklist;
    const readinessDomain =
      openapi.components.schemas.ProductionReadinessDomain;
    const helperStep = openapi.components.schemas.ProductionHelperStep;
    const cutoverDomain = openapi.components.schemas.ProductionCutoverDomain;
    const cutoverStep = openapi.components.schemas.ProductionCutoverStep;
    const manifest = openapi.components.schemas.DiscoveryManifest;
    const discoveryReadiness =
      openapi.components.schemas.ProductionReadinessDiscoverySummary;
    const discoverySummary =
      openapi.components.schemas.ProductionReadinessDiscoveryStatusSummary;

    assert.equal(path.get.operationId, "getProductionReadiness");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/ProductionReadiness",
    );
    assert.equal(
      response.properties.productionReadiness.$ref,
      "#/components/schemas/ProductionReadinessChecklist",
    );
    assert.ok(
      readiness.properties.status.enum.includes(
        "blocked_until_private_evidence_passes",
      ),
    );
    assert.ok(readiness.properties.status.enum.includes("production_ready"));
    assert.ok(readiness.properties.currentUse.enum.includes("demo_ready"));
    assert.ok(
      readiness.properties.currentUse.enum.includes("production_ready"),
    );
    assert.equal(readiness.properties.privateEvidenceRequired.const, true);
    assert.equal(
      readinessDomain.properties.helperSteps.items.$ref,
      "#/components/schemas/ProductionHelperStep",
    );
    assert.equal(
      cutoverDomain.properties.helperSteps.items.$ref,
      "#/components/schemas/ProductionHelperStep",
    );
    assert.equal(
      cutoverStep.properties.helperSteps.items.$ref,
      "#/components/schemas/ProductionHelperStep",
    );
    assert.deepEqual(helperStep.required, ["id", "command", "description"]);
    assert.equal(helperStep.properties.requires.items.type, "string");
    assert.equal(helperStep.properties.produces.type, "string");
    assert.equal(
      manifest.properties.productionReadiness.$ref,
      "#/components/schemas/ProductionReadinessDiscoverySummary",
    );
    assert.equal(
      discoveryReadiness.properties.status.const,
      "blocked_until_private_evidence_passes",
    );
    assert.equal(discoveryReadiness.properties.currentUse.const, "demo_ready");
    assert.equal(discoveryReadiness.properties.productionReady.const, false);
    assert.equal(
      discoveryReadiness.properties.privateEvidenceRequired.const,
      true,
    );
    assert.equal(
      discoveryReadiness.properties.summary.$ref,
      "#/components/schemas/ProductionReadinessDiscoveryStatusSummary",
    );
    assert.equal(
      discoverySummary.properties.privateEvidenceEvaluated.const,
      false,
    );
    assert.equal(discoverySummary.properties.gatePassed.const, false);
  });

  it("documents discovery auth hints without secret-bearing fields", async () => {
    const openapi = await readOpenApi();
    const manifest = openapi.components.schemas.DiscoveryManifest;
    const auth = openapi.components.schemas.DiscoveryAuth;
    const oidc = openapi.components.schemas.DiscoveryOidcAuth;

    assert.equal(
      manifest.properties.auth.$ref,
      "#/components/schemas/DiscoveryAuth",
    );
    assert.deepEqual(auth.required, [
      "requiredForApiRoutes",
      "modes",
      "oidc",
      "bearerHeader",
      "webhookSignatureHeaders",
    ]);
    assert.equal(auth.properties.requiredForApiRoutes.type, "boolean");
    assert.deepEqual(auth.properties.modes.items.enum, [
      "local_optional",
      "oidc_bearer",
      "static_bearer",
    ]);
    assert.equal(
      auth.properties.oidc.oneOf[0].$ref,
      "#/components/schemas/DiscoveryOidcAuth",
    );
    assert.equal(auth.properties.oidc.oneOf[1].type, "null");
    assert.equal(
      auth.properties.bearerHeader.const,
      "Authorization: Bearer <token>",
    );
    assert.deepEqual(auth.properties.webhookSignatureHeaders.items.enum, [
      "X-Forgejo-Signature",
      "X-Gitea-Signature",
      "X-Hub-Signature-256",
    ]);
    assert.deepEqual(oidc.required, ["issuer", "audience"]);
    assert.deepEqual(oidc.properties.issuer.type, ["string", "null"]);
    assert.deepEqual(oidc.properties.audience.type, ["string", "null"]);
    assert.equal(oidc.additionalProperties, false);
  });

  it("documents discovery links as typed route bindings", async () => {
    const openapi = await readOpenApi();
    const manifest = openapi.components.schemas.DiscoveryManifest;
    const links = openapi.components.schemas.DiscoveryLinks;

    assert.equal(
      manifest.properties.links.$ref,
      "#/components/schemas/DiscoveryLinks",
    );
    assert.equal(links.required.length, 71);
    assert.ok(links.required.includes("self"));
    assert.ok(links.required.includes("openapi"));
    assert.ok(links.required.includes("agentCockpitTemplate"));
    assert.ok(links.required.includes("claimNextTemplate"));
    assert.ok(links.required.includes("forgejoWebhook"));
    assert.equal(links.properties.self.const, "/.well-known/eliza-hub.json");
    assert.equal(links.properties.openapi.const, "/openapi.json");
    assert.equal(links.additionalProperties.type, "string");
  });

  it("documents discovery surfaces as owned product surfaces", async () => {
    const openapi = await readOpenApi();
    const manifest = openapi.components.schemas.DiscoveryManifest;
    const surfaces = openapi.components.schemas.DiscoverySurfaces;
    const descriptor = openapi.components.schemas.DiscoverySurfaceDescriptor;

    assert.equal(
      manifest.properties.surfaces.$ref,
      "#/components/schemas/DiscoverySurfaces",
    );
    assert.deepEqual(surfaces.required, [
      "git",
      "projectBoard",
      "fleetCoordination",
      "workItems",
      "workPlanning",
      "mergeQueue",
      "discussions",
      "actions",
    ]);
    assert.equal(
      surfaces.properties.git.$ref,
      "#/components/schemas/DiscoverySurfaceDescriptor",
    );
    assert.equal(
      surfaces.properties.workPlanning.$ref,
      "#/components/schemas/DiscoverySurfaceDescriptor",
    );
    assert.equal(
      surfaces.additionalProperties.$ref,
      "#/components/schemas/DiscoverySurfaceDescriptor",
    );
    assert.deepEqual(descriptor.required, ["authority", "notes"]);
    assert.ok(descriptor.properties.authority.enum.includes("forgejo_native"));
    assert.ok(descriptor.properties.authority.enum.includes("eliza_steward"));
    assert.ok(
      descriptor.properties.authority.enum.includes("not_forgejo_native"),
    );
    assert.equal(
      descriptor.properties.links.additionalProperties.type,
      "string",
    );
    assert.equal(descriptor.properties.related.items.type, "string");
    assert.equal(
      descriptor.properties.replacementSurfaces.items.type,
      "string",
    );
    assert.ok(
      descriptor.properties.forgejoNativeEquivalent.enum.includes(
        "not_available",
      ),
    );
  });

  it("keeps required discovery bootstrap fields typed", async () => {
    const openapi = await readOpenApi();
    const manifest = openapi.components.schemas.DiscoveryManifest;

    for (const property of manifest.required) {
      assert.notEqual(
        manifest.properties[property]?.$ref,
        "#/components/schemas/AnyObject",
        `DiscoveryManifest.${property} must not regress to AnyObject`,
      );
    }
  });

  it("documents production cutover as a typed read-only plan", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/production-cutover"];
    const response = openapi.components.schemas.ProductionCutoverResponse;
    const plan = openapi.components.schemas.ProductionCutoverPlan;
    const phase = openapi.components.schemas.ProductionCutoverPhase;
    const executionPlan =
      openapi.components.schemas.ProductionCutoverExecutionPlan;
    const guardrails = openapi.components.schemas.ProductionCutoverGuardrails;
    const githubMigration =
      openapi.components.schemas.ProductionCutoverGithubMigration;

    assert.equal(path.get.operationId, "getProductionCutover");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/ProductionCutover",
    );
    assert.equal(
      response.properties.productionCutover.$ref,
      "#/components/schemas/ProductionCutoverPlan",
    );
    assert.equal(plan.properties.readOnly.const, true);
    assert.ok(plan.properties.status.enum.includes("blocked"));
    assert.ok(plan.properties.status.enum.includes("ready_for_cutover"));
    assert.equal(
      plan.properties.guardrails.$ref,
      "#/components/schemas/ProductionCutoverGuardrails",
    );
    assert.equal(
      plan.properties.githubMigration.$ref,
      "#/components/schemas/ProductionCutoverGithubMigration",
    );
    assert.ok(plan.required.includes("githubMigration"));
    assert.equal(guardrails.properties.githubMigrationReady.type, "boolean");
    assert.ok(guardrails.required.includes("githubMigrationReady"));
    assert.equal(githubMigration.properties.status.type, "string");
    assert.equal(githubMigration.properties.link.const, "/api/github-parity");
    assert.equal(githubMigration.properties.cutoverReady.type, "boolean");
    assert.equal(
      githubMigration.properties.blockedSurfaces.items.type,
      "string",
    );
    assert.ok(githubMigration.required.includes("privateEvidenceEvaluated"));
    assert.ok(githubMigration.required.includes("blockedSurfaces"));
    assert.equal(
      plan.properties.phases.items.$ref,
      "#/components/schemas/ProductionCutoverPhase",
    );
    assert.equal(
      phase.properties.domains.items.$ref,
      "#/components/schemas/ProductionCutoverDomain",
    );
    assert.equal(
      executionPlan.properties.orderedSteps.items.$ref,
      "#/components/schemas/ProductionCutoverStep",
    );
  });

  it("documents production evidence template as a typed read-only private assembly aid", async () => {
    const openapi = await readOpenApi();
    const productionEvidenceSchema = JSON.parse(
      await readFile(PRODUCTION_EVIDENCE_SCHEMA_URL, "utf8"),
    );
    const path = openapi.paths["/api/production-evidence-template"];
    const response =
      openapi.components.schemas.ProductionEvidenceTemplateResponse;
    const manifest = openapi.components.schemas.ProductionEvidenceTemplate;
    const productionEvidence = openapi.components.schemas.ProductionEvidence;
    const gatePreview =
      openapi.components.schemas.ProductionEvidenceTemplateGatePreview;
    const usage = openapi.components.schemas.ProductionEvidenceTemplateUsage;

    assert.equal(path.get.operationId, "getProductionEvidenceTemplate");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/ProductionEvidenceTemplate",
    );
    assert.equal(
      response.properties.productionEvidenceTemplate.$ref,
      "#/components/schemas/ProductionEvidenceTemplate",
    );
    assert.equal(manifest.properties.readOnly.const, true);
    assert.equal(manifest.properties.privateEvidenceRequired.const, true);
    assert.equal(manifest.properties.storesPrivateEvidence.const, false);
    assert.equal(manifest.properties.templatePassesProductionGate.const, false);
    assert.equal(
      manifest.properties.summary.$ref,
      "#/components/schemas/ProductionEvidenceTemplateSummary",
    );
    assert.equal(
      manifest.properties.gatePreview.$ref,
      "#/components/schemas/ProductionEvidenceTemplateGatePreview",
    );
    assert.equal(
      gatePreview.properties.checks.items.$ref,
      "#/components/schemas/ProductionEvidenceTemplateCheck",
    );
    assert.equal(
      usage.properties.inventoryCommand.const,
      "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
    );
    assert.equal(
      usage.properties.assembleCommand.const,
      "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
    );
    assert.equal(
      usage.properties.gateCommand.const,
      'node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
    );
    assert.equal(
      manifest.properties.template.$ref,
      "#/components/schemas/ProductionEvidence",
    );
    assert.deepEqual(productionEvidence, productionEvidenceSchema);
    assert.deepEqual(productionEvidence.required, [
      "domain",
      "sso",
      "backups",
      "database",
      "imageProvenance",
      "runner",
      "repository",
      "githubMigration",
      "secrets",
      "mail",
      "storage",
      "observability",
      "steward",
      "mergeQueueRollout",
      "securityReview",
      "deployment",
    ]);
    assert.equal(
      productionEvidence.properties.sso.properties.smokeEvidence.type[0],
      "object",
    );
    assert.equal(
      productionEvidence.properties.sso.properties.bootstrapEvidence.type[0],
      "object",
    );
    assert.ok(
      productionEvidence.properties.sso.required.includes("bootstrapEvidence"),
    );
    assert.equal(
      productionEvidence.properties.runner.properties.auditEvidence.type[1],
      "null",
    );
    assert.equal(
      productionEvidence.properties.repository.properties.liveProtectionEvidence
        .type[1],
      "null",
    );
    assert.equal(
      productionEvidence.properties.githubMigration.properties
        .pilotBootstrapEvidence.type[1],
      "null",
    );
    assert.equal(
      productionEvidence.properties.steward.properties.preflight.properties.mode
        .type,
      "string",
    );
    assert.ok(
      productionEvidence.properties.steward.properties.preflight.required.includes(
        "mode",
      ),
    );
    assert.equal(
      productionEvidence.properties.mergeQueueRollout.properties
        .liveDrillEvidence.type[1],
      "null",
    );
    assert.equal(
      productionEvidence.properties.deployment.properties.deployEvidence
        .type[1],
      "null",
    );
    assert.equal(
      productionEvidence.properties.deployment.properties.postDeployEvidence
        .type[1],
      "null",
    );
    assert.ok(
      productionEvidence.properties.deployment.required.includes("applied"),
    );
    assert.ok(
      productionEvidence.properties.deployment.required.includes(
        "postDeployVerified",
      ),
    );
  });

  it("documents the fleet coordination contract", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/fleet-coordination"];
    const contract = openapi.components.schemas.FleetCoordination;
    const lever = openapi.components.schemas.FleetSharedLever;

    assert.equal(path.get.operationId, "getFleetCoordination");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/FleetCoordination",
    );
    assert.equal(
      openapi.components.schemas.FleetCoordinationResponse.properties
        .coordinationContract.$ref,
      "#/components/schemas/FleetCoordination",
    );
    assert.equal(
      contract.properties.claimProtocol.$ref,
      "#/components/schemas/FleetClaimProtocol",
    );
    assert.equal(
      contract.properties.sharedLevers.items.$ref,
      "#/components/schemas/FleetSharedLever",
    );
    assert.ok(lever.properties.state.enum.includes("claimed_by_other"));
    assert.equal(lever.properties.resourceKind.type, "string");
  });

  it("documents agent work context resume packets", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/work-context"];
    const context = openapi.components.schemas.WorkContext;
    const summary = openapi.components.schemas.WorkContextSummary;
    const resume = openapi.components.schemas.WorkContextResume;

    assert.equal(path.get.operationId, "getWorkContext");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/WorkContext",
    );
    assert.equal(
      openapi.components.schemas.WorkContextResponse.properties.workContext
        .$ref,
      "#/components/schemas/WorkContext",
    );
    assert.equal(context.properties.readOnly.type, "boolean");
    assert.equal(
      context.properties.resume.$ref,
      "#/components/schemas/WorkContextResume",
    );
    assert.equal(
      context.properties.nextActions.items.$ref,
      "#/components/schemas/AgentNextAction",
    );
    assert.equal(summary.properties.mergeTrainStatus.type, "string");
    assert.deepEqual(summary.properties.mergeTrainPreflightStatus.type, [
      "string",
      "null",
    ]);
    assert.equal(summary.properties.workflowOperationsStatus.type, "string");
    assert.equal(summary.properties.workflowActionsStatus.type, "string");
    assert.equal(summary.properties.runnerStatus.type, "string");
    assert.equal(
      resume.properties.readFirst.items.$ref,
      "#/components/schemas/WorkContextReadFirstItem",
    );
    assert.equal(resume.properties.ownedCardIds.items.type, "string");
    assert.equal(resume.properties.mergeTrainItemIds.items.type, "string");
  });

  it("documents agent action plans", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/agents/{agentId}/action-plan"];
    const actionPlan = openapi.components.schemas.AgentActionPlan;
    const decision = openapi.components.schemas.AgentActionPlanDecision;
    const step = openapi.components.schemas.AgentActionPlanStep;

    assert.equal(path.post.operationId, "buildAgentActionPlan");
    assert.equal(
      path.post.responses["200"].$ref,
      "#/components/responses/AgentActionPlan",
    );
    assert.equal(actionPlan.properties.readOnly.type, "boolean");
    assert.equal(
      actionPlan.properties.decision.$ref,
      "#/components/schemas/AgentActionPlanDecision",
    );
    assert.equal(
      actionPlan.properties.checks.items.$ref,
      "#/components/schemas/AgentActionPlanCheck",
    );
    assert.equal(
      actionPlan.properties.nextSteps.items.$ref,
      "#/components/schemas/AgentActionPlanStep",
    );
    assert.equal(
      openapi.components.schemas.AgentActionPlanRequest.properties
        .requireWorkItem.type,
      "boolean",
    );
    assert.ok(decision.properties.state.enum.includes("ready_to_submit"));
    assert.ok(decision.properties.state.enum.includes("blocked"));
    assert.equal(decision.properties.canSubmit.type, "boolean");
    assert.equal(step.properties.priority.enum.includes("blocking"), true);
  });

  it("documents review assignment", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/review/assignment"];
    const assignment = openapi.components.schemas.ReviewAssignment;
    const decision = openapi.components.schemas.ReviewAssignmentDecision;

    assert.equal(path.post.operationId, "assignReviewers");
    assert.equal(
      path.post.responses["200"].$ref,
      "#/components/responses/ReviewAssignment",
    );
    assert.equal(
      assignment.properties.decision.$ref,
      "#/components/schemas/ReviewAssignmentDecision",
    );
    assert.equal(
      assignment.properties.suggestedReviewers.items.$ref,
      "#/components/schemas/ReviewAssignmentReviewer",
    );
    assert.ok(decision.properties.state.enum.includes("needs_reviewers"));
    assert.ok(decision.properties.state.enum.includes("needs_human_review"));
    assert.equal(decision.properties.assignmentReady.type, "boolean");
  });

  it("documents GitHub parity migration guardrails", async () => {
    const openapi = await readOpenApi();
    const path = openapi.paths["/api/github-parity"];
    const manifest = openapi.components.schemas.DiscoveryManifest;
    const discoverySummary =
      openapi.components.schemas.GithubParityDiscoverySummary;
    const matrix = openapi.components.schemas.GithubParityMatrix;
    const summary = openapi.components.schemas.GithubParitySummary;
    const guardrail = openapi.components.schemas.GithubParityMigrationGuardrail;
    const surface = openapi.components.schemas.GithubParitySurface;
    const cutoverReadiness =
      openapi.components.schemas.GithubParitySurfaceCutoverReadiness;

    assert.equal(path.get.operationId, "getGithubParity");
    assert.equal(
      path.get.responses["200"].$ref,
      "#/components/responses/GithubParity",
    );
    assert.equal(
      manifest.properties.githubParity.$ref,
      "#/components/schemas/GithubParityDiscoverySummary",
    );
    assert.equal(
      discoverySummary.properties.summary.$ref,
      "#/components/schemas/GithubParitySummary",
    );
    assert.equal(
      discoverySummary.properties.githubDropInReplacement.const,
      false,
    );
    assert.equal(
      discoverySummary.properties.productionReadyWithoutPrivateEvidence.const,
      false,
    );
    assert.ok(discoverySummary.required.includes("cutoverBlockerSurfaces"));
    assert.ok(discoverySummary.required.includes("acceptedGapSurfaces"));
    assert.ok(discoverySummary.required.includes("evidenceRequiredSurfaces"));
    assert.equal(
      matrix.properties.summary.$ref,
      "#/components/schemas/GithubParitySummary",
    );
    assert.ok(matrix.required.includes("productionGateSummary"));
    assert.ok(matrix.required.includes("productionGateChecks"));
    assert.equal(matrix.properties.productionGateChecks.items.type, "string");
    assert.equal(
      matrix.properties.migrationGuardrails.items.$ref,
      "#/components/schemas/GithubParityMigrationGuardrail",
    );
    assert.ok(matrix.required.includes("migrationGuardrails"));
    assert.equal(
      summary.properties.githubParityClaim.const,
      "explicit_partial_parity",
    );
    assert.equal(summary.properties.githubDropInReplacement.const, false);
    assert.equal(
      summary.properties.productionReadyWithoutPrivateEvidence.const,
      false,
    );
    assert.equal(
      summary.properties.productionUseRequiresPrivateEvidence.const,
      true,
    );
    assert.equal(
      summary.properties.githubMigrationMode.const,
      "surface_by_surface_with_agent_native_replacements",
    );
    assert.ok(summary.required.includes("cutoverBlockerCount"));
    assert.ok(summary.required.includes("acceptedGapCount"));
    assert.ok(summary.required.includes("evidenceRequiredSurfaceCount"));
    assert.ok(summary.required.includes("readySurfaceCount"));
    assert.ok(summary.required.includes("blockedCutoverSurfaceCount"));
    assert.ok(summary.required.includes("cutoverBlockerSurfaceIds"));
    assert.ok(summary.required.includes("acceptedGapSurfaceIds"));
    assert.ok(summary.required.includes("evidenceRequiredSurfaceIds"));
    assert.ok(summary.required.includes("readySurfaceIds"));
    assert.ok(summary.required.includes("blockedCutoverSurfaceIds"));
    assert.ok(summary.required.includes("privateEvidenceEvaluated"));
    assert.ok(summary.required.includes("productionGatePassed"));
    assert.ok(summary.required.includes("cutoverReady"));
    assert.equal(guardrail.properties.id.type, "string");
    assert.equal(guardrail.properties.severity.type, "string");
    assert.equal(guardrail.properties.guidance.type, "string");
    assert.equal(surface.properties.githubDropInReplacement.type, "boolean");
    assert.equal(surface.properties.maturity.type, "string");
    assert.equal(surface.properties.agentFit.type, "string");
    assert.equal(surface.properties.productionDisposition.type, "string");
    assert.equal(surface.properties.cutoverBlocker.type, "boolean");
    assert.equal(surface.properties.requiredEvidence.items.type, "string");
    assert.equal(surface.properties.requiredGateChecks.items.type, "string");
    assert.equal(
      surface.properties.cutoverReadiness.$ref,
      "#/components/schemas/GithubParitySurfaceCutoverReadiness",
    );
    assert.equal(surface.properties.migrationTarget.type, "string");
    assert.equal(surface.properties.targetApis.items.type, "string");
    assert.equal(surface.properties.nextAction.type, "string");
    assert.equal(cutoverReadiness.properties.status.type, "string");
    assert.equal(cutoverReadiness.properties.ready.type, "boolean");
    assert.equal(cutoverReadiness.properties.blocksCutover.type, "boolean");
    assert.equal(
      cutoverReadiness.properties.privateEvidenceEvaluated.type,
      "boolean",
    );
    assert.equal(
      cutoverReadiness.properties.requiredGateChecks.items.type,
      "string",
    );
    assert.ok(cutoverReadiness.required.includes("failingGateChecks"));
    assert.ok(cutoverReadiness.required.includes("missingGateChecks"));
    assert.ok(surface.required.includes("githubDropInReplacement"));
    assert.ok(surface.required.includes("maturity"));
    assert.ok(surface.required.includes("agentFit"));
    assert.ok(surface.required.includes("productionDisposition"));
    assert.ok(surface.required.includes("cutoverBlocker"));
    assert.ok(surface.required.includes("requiredEvidence"));
    assert.ok(surface.required.includes("requiredGateChecks"));
    assert.ok(surface.required.includes("cutoverReadiness"));
    assert.ok(surface.required.includes("migrationTarget"));
    assert.ok(surface.required.includes("targetApis"));
    assert.ok(surface.required.includes("nextAction"));
  });

  it("documents discovery merge execution guardrails", async () => {
    const openapi = await readOpenApi();
    const manifest = openapi.components.schemas.DiscoveryManifest;
    const clientHints = openapi.components.schemas.DiscoveryClientHints;
    const branchNamespace =
      openapi.components.schemas.DiscoveryAgentBranchNamespaceHints;
    const runReceipts =
      openapi.components.schemas.DiscoveryAgentRunReceiptHints;
    const workItems = openapi.components.schemas.DiscoveryWorkItemPolicyHints;
    const identityRegistry =
      openapi.components.schemas.DiscoveryAgentIdentityRegistryHints;
    const mergeExecution =
      openapi.components.schemas.DiscoveryMergeExecutionHints;
    const productionEvidence =
      openapi.components.schemas.DiscoveryProductionEvidenceHints;
    const productionEvidenceCommands =
      openapi.components.schemas.DiscoveryProductionEvidenceCommands;

    assert.equal(
      manifest.properties.clientHints.$ref,
      "#/components/schemas/DiscoveryClientHints",
    );
    assert.deepEqual(clientHints.required, [
      "pathParametersMustBeUrlEncoded",
      "apiRoutesUseBearerAuth",
      "webhookRouteUsesHmacSignature",
      "idempotentWebhookDeliveryIds",
      "productionMode",
      "agentBranchNamespace",
      "agentRunReceipts",
      "workItems",
      "agentIdentityRegistry",
      "mergeExecution",
      "productionEvidence",
    ]);
    assert.equal(
      clientHints.properties.pathParametersMustBeUrlEncoded.const,
      true,
    );
    assert.equal(
      clientHints.properties.webhookRouteUsesHmacSignature.const,
      true,
    );
    assert.equal(clientHints.properties.apiRoutesUseBearerAuth.type, "boolean");
    assert.equal(
      clientHints.properties.idempotentWebhookDeliveryIds.type,
      "boolean",
    );
    assert.equal(clientHints.properties.productionMode.type, "boolean");
    assert.equal(
      clientHints.properties.agentBranchNamespace.$ref,
      "#/components/schemas/DiscoveryAgentBranchNamespaceHints",
    );
    assert.equal(
      clientHints.properties.agentRunReceipts.$ref,
      "#/components/schemas/DiscoveryAgentRunReceiptHints",
    );
    assert.equal(
      clientHints.properties.workItems.$ref,
      "#/components/schemas/DiscoveryWorkItemPolicyHints",
    );
    assert.equal(
      clientHints.properties.agentIdentityRegistry.$ref,
      "#/components/schemas/DiscoveryAgentIdentityRegistryHints",
    );
    assert.equal(
      clientHints.properties.mergeExecution.$ref,
      "#/components/schemas/DiscoveryMergeExecutionHints",
    );
    assert.equal(
      clientHints.properties.productionEvidence.$ref,
      "#/components/schemas/DiscoveryProductionEvidenceHints",
    );
    assert.deepEqual(branchNamespace.required, [
      "required",
      "prefix",
      "pattern",
    ]);
    assert.equal(
      runReceipts.properties.signatureAlgorithm.const,
      "hmac-sha256",
    );
    assert.equal(workItems.properties.linkRequiredBeforeMerge.const, true);
    assert.ok(
      workItems.properties.matchKeys.items.enum.includes("pullRequestId"),
    );
    assert.ok(
      workItems.properties.activeStates.items.enum.includes("in_progress"),
    );
    assert.ok(workItems.properties.terminalStates.items.enum.includes("done"));
    assert.deepEqual(identityRegistry.required, [
      "required",
      "knownAgentIdCount",
      "configuredAgentIdCount",
      "persistedActiveAgentIdCount",
      "identifier",
    ]);
    assert.equal(identityRegistry.properties.identifier.const, "ownerAgentId");
    assert.ok(mergeExecution.required.includes("liveIntegrationActive"));
    assert.ok(mergeExecution.required.includes("liveAgentMergesEvidenceGated"));
    assert.equal(mergeExecution.properties.integrationEnabled.type, "boolean");
    assert.equal(mergeExecution.properties.integrationDryRun.type, "boolean");
    assert.equal(mergeExecution.properties.workerEnabled.type, "boolean");
    assert.equal(
      mergeExecution.properties.liveAgentMergesEvidenceGated.const,
      true,
    );
    assert.equal(
      mergeExecution.properties.liveAgentMergesAllowedWithoutProductionEvidence
        .const,
      false,
    );
    assert.equal(
      mergeExecution.properties.productionCutoverRequired.const,
      true,
    );
    assert.deepEqual(productionEvidence.required, [
      "artifactRootEnv",
      "templateFile",
      "assembledEvidenceFile",
      "templateEndpoint",
      "commands",
      "strictGateRequired",
      "inventoryMustPassBeforeAssemble",
      "generatedEvidenceMustStayPrivate",
    ]);
    assert.equal(
      productionEvidence.properties.artifactRootEnv.const,
      "ELIZA_ARTIFACT_ROOT",
    );
    assert.equal(
      productionEvidence.properties.templateFile.const,
      "eliza-hub-production-evidence.template.json",
    );
    assert.equal(
      productionEvidence.properties.assembledEvidenceFile.const,
      "eliza-hub-production-evidence.json",
    );
    assert.equal(
      productionEvidence.properties.templateEndpoint.const,
      "/api/production-evidence-template",
    );
    assert.equal(
      productionEvidence.properties.commands.$ref,
      "#/components/schemas/DiscoveryProductionEvidenceCommands",
    );
    assert.equal(productionEvidence.properties.strictGateRequired.const, true);
    assert.equal(
      productionEvidence.properties.inventoryMustPassBeforeAssemble.const,
      true,
    );
    assert.equal(
      productionEvidence.properties.generatedEvidenceMustStayPrivate.const,
      true,
    );
    assert.deepEqual(productionEvidenceCommands.required, [
      "template",
      "inventory",
      "assemble",
      "gate",
    ]);
    assert.match(
      productionEvidenceCommands.properties.template.const,
      /production-evidence-template/,
    );
    assert.equal(
      productionEvidenceCommands.properties.inventory.const,
      "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
    );
    assert.equal(
      productionEvidenceCommands.properties.assemble.const,
      "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
    );
    assert.match(
      productionEvidenceCommands.properties.gate.const,
      /production-gate --strict/,
    );
  });

  it("keeps smoke-tested product APIs and docs aligned", async () => {
    const [openapi, doctorSource, serviceReadme, rootReadme, runtimeModel] =
      await Promise.all([
        readOpenApi(),
        readFile(DOCTOR_URL, "utf8"),
        readFile(SERVICE_README_URL, "utf8"),
        readFile(ROOT_README_URL, "utf8"),
        readFile(RUNTIME_MODEL_URL, "utf8"),
      ]);

    for (const path of PRODUCT_API_PATHS) {
      assert.ok(
        openapi.paths[path],
        `OpenAPI contract is missing product API ${path}`,
      );
      assert.ok(
        serviceReadme.includes(path.replace("{agentId}", "agent-one")),
        `service README is missing ${path}`,
      );
      assert.ok(
        runtimeModel.includes(path.replace("{agentId}", ":agentId")),
        `runtime model is missing ${path}`,
      );
    }

    assert.match(doctorSource, /stewardUrl\(target, "\/api\/workflows"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/github-parity"/);
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/production-readiness"/,
    );
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/production-cutover"/,
    );
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/production-evidence-template"/,
    );
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/project-board"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/work-items"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/work-cycles"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/work-modules"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/work-progress"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/work-views"/);
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/work-views\/evaluate"/,
    );
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/work-pages"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/work-context"/);
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/fleet-coordination"/,
    );
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/work-dashboard"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/work-intake"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/merge-queue"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/merge-train"/);
    assert.match(doctorSource, /\/api\/queue\/item\/action-plan/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/search"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/queue\/simulate"/);
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/release-readiness"/,
    );
    assert.match(
      doctorSource,
      /stewardUrl\(\s*target,\s*"\/api\/repository-protection"/,
    );
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/agent-insights"/);
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/agents"/);
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/agent-performance"/,
    );
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/agent-routing"/);
    assert.match(
      doctorSource,
      /\/api\/agents\/\$\{encodeStewardSegment\(smokeAgent\)\}\/cockpit/,
    );
    assert.match(
      doctorSource,
      /\/api\/agents\/\$\{encodeStewardSegment\(smokeAgent\)\}\/action-plan/,
    );
    assert.match(
      doctorSource,
      /\/api\/agents\/\$\{encodeStewardSegment\(smokeAgent\)\}\/submission-gate/,
    );
    assert.match(
      doctorSource,
      /\/api\/agents\/\$\{encodeStewardSegment\(smokeAgent\)\}\/work-preflight/,
    );
    assert.match(
      doctorSource,
      /\/api\/agents\/\$\{encodeStewardSegment\(smokeAgent\)\}\/work-reservation/,
    );
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/ci\/failure-analysis"/,
    );
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/ci\/validation-plan"/,
    );
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/pr\/brief"/);
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/review\/assignment"/,
    );
    assert.match(
      doctorSource,
      /stewardUrl\(target, "\/api\/patch\/conflict-prediction"/,
    );
    assert.match(doctorSource, /stewardUrl\(target, "\/api\/releases\/notes"/);
    assert.match(
      doctorSource,
      /\/api\/agents\/\$\{encodeStewardSegment\(smokeAgent\)\}\/inbox/,
    );
    assert.match(doctorSource, /discovery_manifest/);
    assert.match(doctorSource, /openapi_contract/);
    assert.ok(rootReadme.includes("GET /.well-known/eliza-hub.json"));
    assert.ok(rootReadme.includes("services/merge-steward/openapi.json"));
    assert.ok(serviceReadme.includes("GET /.well-known/eliza-hub.json"));
    assert.ok(serviceReadme.includes("openapi.json"));
  });

  it("does not document stale planned routes as active control APIs", async () => {
    const [openapi, runtimeModel] = await Promise.all([
      readOpenApi(),
      readFile(RUNTIME_MODEL_URL, "utf8"),
    ]);

    const staleRoutes = [
      "/api/approvals/{id}/approve",
      "/api/approvals/{id}/deny",
      "/api/human-requests/{id}/answer",
    ];

    for (const route of staleRoutes) {
      assert.equal(
        openapi.paths[route],
        undefined,
        `OpenAPI should not expose stale route ${route}`,
      );
    }

    assert.doesNotMatch(runtimeModel, /POST \/api\/approvals\/:id\/approve/);
    assert.doesNotMatch(runtimeModel, /POST \/api\/approvals\/:id\/deny/);
    assert.doesNotMatch(
      runtimeModel,
      /POST \/api\/human-requests\/:id\/answer/,
    );
    assert.match(runtimeModel, /POST \/api\/approvals\/decide/);
    assert.match(runtimeModel, /POST \/api\/human-requests\/respond/);
  });
});

async function readOpenApi() {
  return readJson(OPENAPI_URL);
}

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function implementedServerPaths(serverSource) {
  const paths = new Set(
    Array.from(
      serverSource.matchAll(/url\.pathname === "([^"]+)"/g),
      (match) => match[1],
    ),
  );

  if (serverSource.includes("parseRunRoute(url.pathname)")) {
    paths.add("/api/runs/{runId}");
    paths.add("/api/runs/{runId}/run-state");
    paths.add("/api/runs/{runId}/nodes");
    paths.add("/api/runs/{runId}/attempts");
    paths.add("/api/runs/{runId}/events");
  }

  if (serverSource.includes("parseAgentInboxRoute(url.pathname)")) {
    paths.add("/api/agents/{agentId}/inbox");
  }

  if (serverSource.includes("parseAgentBootstrapRoute(url.pathname)")) {
    paths.add("/api/agents/{agentId}/bootstrap");
  }

  if (serverSource.includes("parseAgentActionPlanRoute(url.pathname)")) {
    paths.add("/api/agents/{agentId}/action-plan");
  }

  if (serverSource.includes("parseAgentSubmissionGateRoute(url.pathname)")) {
    paths.add("/api/agents/{agentId}/submission-gate");
  }

  if (serverSource.includes("parseAgentWorkPreflightRoute(url.pathname)")) {
    paths.add("/api/agents/{agentId}/work-preflight");
  }

  if (serverSource.includes("parseAgentWorkReservationRoute(url.pathname)")) {
    paths.add("/api/agents/{agentId}/work-reservation");
  }

  if (serverSource.includes("parseAgentClaimNextRoute(url.pathname)")) {
    paths.add("/api/agents/{agentId}/claim-next");
  }

  if (serverSource.includes("parseAgentClaimAssignmentRoute(url.pathname)")) {
    paths.add("/api/agents/{agentId}/claim-assignment");
  }

  if (serverSource.includes("GITHUB_PARITY_PATH")) {
    paths.add("/api/github-parity");
  }

  if (serverSource.includes("PRODUCTION_READINESS_PATH")) {
    paths.add("/api/production-readiness");
  }

  if (serverSource.includes("PRODUCTION_CUTOVER_PATH")) {
    paths.add("/api/production-cutover");
  }

  if (serverSource.includes("PRODUCTION_EVIDENCE_TEMPLATE_PATH")) {
    paths.add("/api/production-evidence-template");
  }

  return [...paths].sort();
}

function patternFrom(...parts) {
  return new RegExp(parts.join(""), "i");
}

function collectRefs(value, refs = new Set()) {
  if (!value || typeof value !== "object") {
    return refs;
  }

  if (typeof value.$ref === "string") {
    refs.add(value.$ref);
  }

  for (const nested of Object.values(value)) {
    collectRefs(nested, refs);
  }

  return refs;
}

function resolveJsonPointer(root, ref) {
  assert.match(
    ref,
    /^#\//,
    `Only local JSON pointer references are supported: ${ref}`,
  );

  return ref
    .slice(2)
    .split("/")
    .reduce((current, segment) => {
      if (!current || typeof current !== "object") {
        return undefined;
      }
      return current[decodePointerSegment(segment)];
    }, root);
}

function decodePointerSegment(segment) {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
