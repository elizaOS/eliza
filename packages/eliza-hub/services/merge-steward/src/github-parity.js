import {
  PRODUCTION_GATE_CHECKS,
  runProductionGate,
} from "./production-gate.js";

export const GITHUB_PARITY_PATH = "/api/github-parity";

export const GITHUB_PARITY_STATUS = Object.freeze({
  NATIVE: "native",
  COMPUTED: "eliza_computed",
  STEWARD: "eliza_steward",
  PARTIAL: "partial",
  DELEGATED: "delegated",
  NOT_SUPPORTED: "not_supported",
  PLANNED: "planned",
});

const GITHUB_PARITY_SURFACES = Object.freeze([
  {
    id: "git_repositories",
    githubSurface: "Repositories, refs, commits, diffs",
    status: GITHUB_PARITY_STATUS.NATIVE,
    authority: "forgejo",
    exposedBy: ["forgejo_ui", "forgejo_api"],
    maturity: "ready_for_private_use",
    githubDropInReplacement: false,
    agentFit: "standard_git",
    notes:
      "Forgejo is the Git source of truth for repositories, branches, tags, commits, file browsing, and diffs.",
  },
  {
    id: "issues",
    githubSurface: "Issues, labels, milestones",
    status: GITHUB_PARITY_STATUS.NATIVE,
    authority: "forgejo",
    exposedBy: ["forgejo_ui", "forgejo_api", "merge_steward_webhooks"],
    maturity: "ready_for_private_use",
    githubDropInReplacement: false,
    agentFit: "standard_collaboration",
    notes:
      "Forgejo owns issue records while Merge Steward can mirror agent ownership and claim labels.",
  },
  {
    id: "pull_requests",
    githubSurface: "Pull requests, reviews, comments",
    status: GITHUB_PARITY_STATUS.NATIVE,
    authority: "forgejo",
    exposedBy: ["forgejo_ui", "forgejo_api", "merge_steward_webhooks"],
    maturity: "ready_for_private_use",
    githubDropInReplacement: false,
    agentFit: "strong_with_steward_policy",
    notes:
      "Forgejo owns PR review mechanics; Merge Steward adds policy, brief, queue, and run-state views.",
  },
  {
    id: "actions",
    githubSurface: "GitHub Actions",
    status: GITHUB_PARITY_STATUS.PARTIAL,
    authority: "forgejo_actions",
    exposedBy: [
      "forgejo_actions",
      "isolated_runner_scaffold",
      "runner_isolation_evidence",
    ],
    gaps: [
      "marketplace_compatibility_not_guaranteed",
      "trusted_runner_rollout_required",
    ],
    maturity: "staging_ready_until_runner_evidence_passes",
    githubDropInReplacement: false,
    agentFit: "trusted_workflows_only_before_runner_cutover",
    notes:
      "Forgejo Actions can run trusted workflows, but Marketplace parity and untrusted runner safety require separate validation.",
  },
  {
    id: "packages_releases_wiki",
    githubSurface: "Packages, releases, wiki",
    status: GITHUB_PARITY_STATUS.NATIVE,
    authority: "forgejo",
    exposedBy: ["forgejo_ui", "forgejo_api"],
    maturity: "ready_for_private_use",
    githubDropInReplacement: false,
    agentFit: "standard_repository_support",
    notes: "Forgejo provides these repository collaboration surfaces.",
  },
  {
    id: "projects_v2",
    githubSurface: "GitHub Projects v2 tables, custom fields, saved views",
    status: GITHUB_PARITY_STATUS.COMPUTED,
    authority: "eliza_hub",
    exposedBy: ["/api/project-board", "/api/workflows", "/api/coordination"],
    replacementSurfaces: [
      "agent_kanban",
      "workflow_cards",
      "coordination_summary",
    ],
    gaps: ["forgejo_projects_sync_not_enabled", "custom_fields_not_native"],
    maturity: "agent_native_replacement",
    githubDropInReplacement: false,
    agentFit: "strong_agent_kanban",
    notes:
      "Eliza Hub computes agent workflow boards from queue, run, claim, and PR state instead of claiming GitHub Projects v2 parity.",
  },
  {
    id: "merge_queue",
    githubSurface: "GitHub merge queue",
    status: GITHUB_PARITY_STATUS.STEWARD,
    authority: "merge_steward",
    exposedBy: [
      "/api/merge-queue",
      "/api/queue/run-once",
      "/api/release-readiness",
    ],
    replacementSurfaces: [
      "policy_queue",
      "durable_worker",
      "integration_branch_guard",
    ],
    gaps: ["production_live_rollout_evidence_required"],
    maturity: "production_evidence_gated",
    githubDropInReplacement: false,
    agentFit: "strong_agent_queue_after_cutover",
    notes:
      "Merge Steward owns agent-scale queueing, guarded integration execution, and final merge policy; production live merging remains evidence-gated.",
  },
  {
    id: "branch_protection",
    githubSurface: "Protected branches, required checks, review gates",
    status: GITHUB_PARITY_STATUS.PARTIAL,
    authority: "forgejo_plus_merge_steward",
    exposedBy: [
      "forgejo_branch_protection",
      "/api/repository-protection",
      "/api/release-readiness",
    ],
    gaps: ["github_rulesets_not_claimed"],
    maturity: "production_evidence_gated",
    githubDropInReplacement: false,
    agentFit: "strong_after_live_audit",
    notes:
      "Forgejo provides branch protection and Merge Steward audits the live policy before agent merge windows.",
  },
  {
    id: "discussions",
    githubSurface: "GitHub Discussions",
    status: GITHUB_PARITY_STATUS.NOT_SUPPORTED,
    authority: "not_native",
    exposedBy: [],
    replacementSurfaces: [
      "pull_request_comments",
      "human_requests",
      "approvals",
      "signals",
    ],
    maturity: "not_available",
    githubDropInReplacement: false,
    agentFit: "use_steward_human_request_flow",
    notes:
      "Use PR comments and Eliza Steward human-request/approval flows until a first-class discussion sync exists.",
  },
  {
    id: "advanced_security",
    githubSurface: "GitHub Advanced Security, Dependabot, code scanning",
    status: GITHUB_PARITY_STATUS.DELEGATED,
    authority: "external_security_tooling",
    exposedBy: [
      "required_checks",
      "repository_protection_audit",
      "security_review_evidence",
    ],
    gaps: ["native_advanced_security_not_included"],
    maturity: "external_tooling_required",
    githubDropInReplacement: false,
    agentFit: "delegated_to_required_checks",
    notes:
      "Security scanning should run as required checks and launch evidence; this repo does not claim native GitHub Advanced Security parity.",
  },
  {
    id: "codespaces",
    githubSurface: "Codespaces and hosted dev environments",
    status: GITHUB_PARITY_STATUS.NOT_SUPPORTED,
    authority: "not_native",
    exposedBy: [],
    replacementSurfaces: ["external_dev_environments", "agent_sandboxes"],
    maturity: "not_available",
    githubDropInReplacement: false,
    agentFit: "requires_dedicated_sandbox_layer",
    notes:
      "Hosted dev environments are outside the Forgejo core surface and should be provided by a dedicated sandbox layer.",
  },
  {
    id: "organization_governance",
    githubSurface: "GitHub org rulesets, audit, teams, marketplace apps",
    status: GITHUB_PARITY_STATUS.PLANNED,
    authority: "eliza_cloud_policy",
    exposedBy: ["oidc_groups", "steward_policy", "production_evidence"],
    gaps: ["org_ruleset_parity_not_claimed", "app_marketplace_not_claimed"],
    maturity: "planned",
    githubDropInReplacement: false,
    agentFit: "requires_eliza_cloud_policy_sync",
    notes:
      "Production governance belongs in Eliza Cloud identity and steward policy before this is sold as org-scale GitHub replacement.",
  },
]);

const SURFACE_CUTOVER_METADATA = Object.freeze({
  git_repositories: {
    productionDisposition: "production_gate_required",
    cutoverBlocker: true,
    requiredEvidence: [
      "domain.probeEvidence",
      "repository.liveProtectionEvidence",
      "backups.backupEvidence",
      "database.databaseEvidence",
      "deployment.postDeployEvidence",
    ],
    requiredGateChecks: [
      "domain_tls",
      "repository_protection",
      "backup_restore",
      "database_migration",
      "deployment_verification",
    ],
    migrationTarget: "forgejo",
    targetApis: ["forgejo_api"],
    nextAction:
      "prove_domain_repo_backup_database_and_deploy_before_migrating_git_source_of_truth",
  },
  issues: {
    productionDisposition: "production_gate_required",
    cutoverBlocker: true,
    requiredEvidence: [
      "domain.probeEvidence",
      "repository.liveProtectionEvidence",
      "backups.backupEvidence",
      "database.databaseEvidence",
      "deployment.postDeployEvidence",
    ],
    requiredGateChecks: [
      "domain_tls",
      "repository_protection",
      "backup_restore",
      "database_migration",
      "deployment_verification",
    ],
    migrationTarget: "forgejo",
    targetApis: ["forgejo_api", "merge_steward_webhooks"],
    nextAction:
      "prove_repo_policy_backup_database_and_post_deploy_checks_before_migrating_issue_workflows",
  },
  pull_requests: {
    productionDisposition: "production_gate_required",
    cutoverBlocker: true,
    requiredEvidence: [
      "repository.liveProtectionEvidence",
      "runner.smokeEvidence",
      "runner.auditEvidence",
      "steward.doctorEvidence",
      "deployment.postDeployEvidence",
    ],
    requiredGateChecks: [
      "repository_protection",
      "runner_isolation",
      "steward_runtime",
      "deployment_verification",
    ],
    migrationTarget: "forgejo_plus_merge_steward",
    targetApis: ["forgejo_api", "/api/queue/schedule", "/api/pr/brief"],
    nextAction:
      "prove_runner_repository_policy_and_steward_runtime_before_migrating_pr_workflows",
  },
  actions: {
    productionDisposition: "production_gate_required",
    cutoverBlocker: true,
    requiredEvidence: [
      "runner.smokeEvidence",
      "runner.auditEvidence",
      "repository.actionsPolicyReviewed",
      "storage.storageEvidence",
      "deployment.postDeployEvidence",
    ],
    requiredGateChecks: [
      "runner_isolation",
      "repository_protection",
      "storage_retention",
      "deployment_verification",
    ],
    migrationTarget: "forgejo_actions_isolated_runner_pool",
    targetApis: ["forgejo_actions", "/api/workflows"],
    nextAction:
      "prove_isolated_runner_smoke_audit_and_actions_policy_before_running_untrusted_agent_ci",
  },
  packages_releases_wiki: {
    productionDisposition: "production_gate_required",
    cutoverBlocker: true,
    requiredEvidence: [
      "storage.storageEvidence",
      "backups.backupEvidence",
      "database.databaseEvidence",
      "deployment.postDeployEvidence",
    ],
    requiredGateChecks: [
      "storage_retention",
      "backup_restore",
      "database_migration",
      "deployment_verification",
    ],
    migrationTarget: "forgejo",
    targetApis: ["forgejo_api"],
    nextAction:
      "prove_storage_retention_backup_and_database_restore_before_migrating_package_release_or_wiki_data",
  },
  projects_v2: {
    productionDisposition: "agent_native_replacement",
    cutoverBlocker: false,
    requiredEvidence: [
      "steward.doctorEvidence",
      "deployment.postDeployEvidence",
    ],
    requiredGateChecks: ["steward_runtime", "deployment_verification"],
    migrationTarget: "eliza_work",
    targetApis: [
      "/api/project-board",
      "/api/work-dashboard",
      "/api/work-views",
      "/api/work-intake",
    ],
    nextAction:
      "map_project_fields_to_eliza_work_views_and_keep_projects_v2_as_an_intentional_non_goal",
  },
  merge_queue: {
    productionDisposition: "production_gate_required",
    cutoverBlocker: true,
    requiredEvidence: [
      "mergeQueueRollout.liveDrillEvidence",
      "mergeQueueRollout.stackDependencyOrderEnforced",
      "steward.strictWorkReservationsEnforced",
      "steward.strictWorkItemsEnforced",
      "steward.verifiedAgentRunReceiptsEnforced",
      "repository.liveProtectionEvidence",
    ],
    requiredGateChecks: [
      "merge_queue_rollout",
      "steward_runtime",
      "repository_protection",
    ],
    migrationTarget: "merge_steward",
    targetApis: [
      "/api/merge-queue",
      "/api/merge-train",
      "/api/queue/run-once",
      "/api/release-readiness",
    ],
    nextAction:
      "complete_merge_queue_live_drill_and_repository_protection_before_enabling_live_agent_merges",
  },
  branch_protection: {
    productionDisposition: "production_gate_required",
    cutoverBlocker: true,
    requiredEvidence: [
      "repository.liveProtectionEvidence",
      "repository.requiredChecks",
      "repository.adminBypassDisabled",
      "securityReview.securityEvidence",
    ],
    requiredGateChecks: ["repository_protection", "security_review"],
    migrationTarget: "forgejo_plus_merge_steward",
    targetApis: ["forgejo_branch_protection", "/api/repository-protection"],
    nextAction:
      "prove_live_branch_protection_and_required_checks_before_accepting_agent_merge_windows",
  },
  discussions: {
    productionDisposition: "accepted_gap",
    cutoverBlocker: false,
    requiredEvidence: [],
    requiredGateChecks: [],
    migrationTarget: "human_requests_and_pr_comments",
    targetApis: ["/api/human-requests", "/api/approvals", "/api/signals"],
    nextAction:
      "route_discussion_workflows_to_human_requests_pr_comments_or_future_discussion_sync",
  },
  advanced_security: {
    productionDisposition: "external_dependency_required",
    cutoverBlocker: true,
    requiredEvidence: [
      "securityReview.securityEvidence",
      "repository.requiredChecks",
      "repository.forkPolicyReviewed",
      "repository.actionsPolicyReviewed",
    ],
    requiredGateChecks: ["security_review", "repository_protection"],
    migrationTarget: "external_security_required_checks",
    targetApis: ["/api/repository-protection", "/api/release-readiness"],
    nextAction:
      "wire_security_scanners_as_required_checks_and_capture_security_review_evidence",
  },
  codespaces: {
    productionDisposition: "accepted_gap",
    cutoverBlocker: false,
    requiredEvidence: [],
    requiredGateChecks: [],
    migrationTarget: "external_dev_environment_or_agent_sandbox",
    targetApis: [],
    nextAction:
      "keep_hosted_dev_environments_out_of_eliza_hub_cutover_until_a_sandbox_layer_exists",
  },
  organization_governance: {
    productionDisposition: "production_gate_required_for_org_scale",
    cutoverBlocker: true,
    requiredEvidence: [
      "sso.bootstrapEvidence",
      "sso.humanIdentitySmokePassed",
      "steward.agentIdentityRegistryEnforced",
      "repository.liveProtectionEvidence",
      "securityReview.securityEvidence",
    ],
    requiredGateChecks: [
      "sso_registration",
      "steward_runtime",
      "repository_protection",
      "security_review",
    ],
    migrationTarget: "eliza_cloud_identity_and_steward_policy",
    targetApis: [
      "/api/agent-identities",
      "/api/production-readiness",
      "/api/repository-protection",
    ],
    nextAction:
      "finish_eliza_cloud_identity_agent_registry_and_repository_policy_sync_before_org_scale_rollout",
  },
});

const MIGRATION_GUARDRAILS = Object.freeze([
  {
    id: "not_drop_in_github",
    severity: "must_read",
    guidance:
      "Do not present Eliza Hub as a GitHub API drop-in replacement; use the parity matrix to route each workflow to Forgejo, Merge Steward, or external tooling.",
  },
  {
    id: "actions_runner_evidence_required",
    severity: "blocker_for_untrusted_ci",
    guidance:
      "Do not run untrusted PR code on live runners until runner isolation, egress, secret exposure, and trusted smoke evidence pass.",
  },
  {
    id: "projects_v2_replaced_by_agent_work",
    severity: "migration_note",
    guidance:
      "Map GitHub Projects v2 workflows to Eliza Work boards, saved views, workflow cards, and merge lanes instead of expecting native custom-field parity.",
  },
  {
    id: "discussions_not_available",
    severity: "migration_gap",
    guidance:
      "Route discussion-style collaboration to PR comments, human requests, approvals, signals, or a future first-class discussion sync.",
  },
  {
    id: "live_merges_evidence_gated",
    severity: "production_blocker",
    guidance:
      "Keep live merge execution disabled until production evidence, repository protection, SSO, runner isolation, and merge-queue rollout gates pass.",
  },
]);

const AGENT_NATIVE_ADDITIONS = Object.freeze([
  {
    id: "agent_claims",
    surface: "Durable agent work claims and leases",
    links: [
      "/api/claims",
      "/api/agents/{agentId}/work-preflight",
      "/api/agents/{agentId}/work-reservation",
      "/api/agents/{agentId}/claim-next",
      "/api/agents/{agentId}/claim-assignment",
    ],
  },
  {
    id: "agent_routing",
    surface: "Performance-aware routing, inbox, and submission gates",
    links: [
      "/api/agent-routing",
      "/api/agents/{agentId}/inbox",
      "/api/agents/{agentId}/submission-gate",
    ],
  },
  {
    id: "agent_merge_steward",
    surface:
      "Agent-scale merge queue, merge train plans, run state, approvals, and recovery",
    links: [
      "/api/merge-queue",
      "/api/merge-train",
      "/api/runs",
      "/api/approvals",
      "/api/human-requests",
    ],
  },
  {
    id: "agent_cockpit",
    surface:
      "One-call read-only cockpit joining workflow cards, work context, focus cards, merge-train status, and ranked next actions",
    links: [
      "/api/agents/{agentId}/cockpit",
      "/api/work-context",
      "/api/workflows",
    ],
  },
  {
    id: "queue_item_action_plans",
    surface:
      "PR-scoped next-action plans linked from workflow, inbox, and cockpit cards",
    links: [
      "/api/queue/item/action-plan",
      "/api/agents/{agentId}/cockpit",
      "/api/workflows",
    ],
  },
  {
    id: "agent_branch_namespaces",
    surface: "Per-agent branch ownership policy for source branches",
    links: [
      "/api/agents/{agentId}/work-preflight",
      "/api/agents/{agentId}/submission-gate",
      "/api/queue/schedule",
    ],
  },
  {
    id: "verified_agent_run_receipts",
    surface: "Signed Eliza agent run receipts before live merge eligibility",
    links: [
      "/api/queue/schedule",
      "/api/pr/brief",
      "/api/production-readiness",
    ],
  },
  {
    id: "agent_identity_registry",
    surface: "Allowed Eliza agent identity registry for live merge eligibility",
    links: [
      "/api/queue/schedule",
      "/api/agents/{agentId}/submission-gate",
      "/api/production-readiness",
    ],
  },
  {
    id: "agent_failure_triage",
    surface: "CI failure analysis and PR review briefs for agent handoff",
    links: ["/api/ci/failure-analysis", "/api/pr/brief"],
  },
  {
    id: "agent_review_assignment",
    surface: "Path and package aware reviewer and owner assignment for agents",
    links: ["/api/review/assignment", "/api/pr/brief", "/api/agents"],
  },
  {
    id: "agent_repo_search",
    surface:
      "Natural-query search over steward state plus supplied issue, diff, and Actions-log documents",
    links: ["/api/search", "/api/agent-insights", "/api/ci/failure-analysis"],
  },
  {
    id: "agent_work_items",
    surface:
      "Durable agent work intake records and queue-to-work automation linking repo scope, owners, cycles, modules, issues, PRs, paths, packages, and state",
    links: [
      "/api/work-items",
      "/api/work-items/transition",
      "/api/work-intake",
      "/api/work-intake/apply",
      "/api/project-board",
      "/api/work-progress",
    ],
  },
  {
    id: "agent_work_planning",
    surface:
      "Eliza Work cycles, modules, saved views, evaluated view payloads, dashboards, and progress snapshots for agent-scale Kanban planning",
    links: [
      "/api/work-cycles",
      "/api/work-modules",
      "/api/work-views",
      "/api/work-views/evaluate",
      "/api/work-dashboard",
      "/api/work-progress",
      "/api/search",
    ],
  },
  {
    id: "agent_action_plan",
    surface:
      "Read-only next-action plans that compose routing, search, validation, conflict, submission, and review evidence",
    links: [
      "/api/agents/{agentId}/action-plan",
      "/api/search",
      "/api/ci/validation-plan",
      "/api/patch/conflict-prediction",
    ],
  },
  {
    id: "agent_patch_conflict_prediction",
    surface:
      "Read-only patch conflict prediction before agents reserve work or open PRs",
    links: [
      "/api/patch/conflict-prediction",
      "/api/agents/{agentId}/work-preflight",
      "/api/queue/simulate",
    ],
  },
  {
    id: "agent_release_notes",
    surface:
      "Release notes generated from steward merge and agent contribution evidence",
    links: [
      "/api/releases/notes",
      "/api/merge-queue",
      "/api/production-readiness",
    ],
  },
]);

export function buildGithubParityMatrix({
  generatedAt = new Date().toISOString(),
  evidence = null,
  productionGate = null,
} = {}) {
  const evaluatedGate =
    productionGate ??
    (hasEvidence(evidence) ? runProductionGate({ evidence }) : null);
  const gateByName = new Map(
    (evaluatedGate?.checks ?? []).map((check) => [check.name, check]),
  );
  const privateEvidenceEvaluated = evaluatedGate !== null;
  const surfaces = GITHUB_PARITY_SURFACES.map(enrichParitySurface).map(
    (surface) => ({
      ...surface,
      cutoverReadiness: buildCutoverReadiness(
        surface,
        gateByName,
        privateEvidenceEvaluated,
      ),
    }),
  );
  const agentNativeAdditions = AGENT_NATIVE_ADDITIONS.map(cloneObject);

  return {
    schema: "https://eliza.hub/schemas/github-parity.v1",
    matrixVersion: 1,
    generatedAt,
    status: "forgejo_plus_eliza_not_full_github_parity",
    summary: summarizeSurfaces(surfaces, {
      privateEvidenceEvaluated,
      productionGate: evaluatedGate,
    }),
    productionGateSummary: evaluatedGate
      ? {
          ok: evaluatedGate.ok === true,
          checkedAt: evaluatedGate.checkedAt ?? null,
          total: evaluatedGate.summary?.total ?? 0,
          passed: evaluatedGate.summary?.passed ?? 0,
          failed: evaluatedGate.summary?.failed ?? 0,
          shapeErrors: evaluatedGate.summary?.shapeErrors ?? 0,
        }
      : null,
    productionGateChecks: [...PRODUCTION_GATE_CHECKS],
    statuses: { ...GITHUB_PARITY_STATUS },
    migrationGuardrails: MIGRATION_GUARDRAILS.map(cloneObject),
    surfaces,
    agentNativeAdditions,
  };
}

export function buildGithubParitySummary() {
  const matrix = buildGithubParityMatrix({ generatedAt: null });
  const unsupportedNativeSurfaces = matrix.surfaces
    .filter((surface) => surface.status === GITHUB_PARITY_STATUS.NOT_SUPPORTED)
    .map((surface) => surface.id);
  const partialOrDelegatedSurfaces = matrix.surfaces
    .filter((surface) =>
      [
        GITHUB_PARITY_STATUS.PARTIAL,
        GITHUB_PARITY_STATUS.DELEGATED,
        GITHUB_PARITY_STATUS.PLANNED,
      ].includes(surface.status),
    )
    .map((surface) => surface.id);

  return {
    status: matrix.status,
    matrixVersion: matrix.matrixVersion,
    link: GITHUB_PARITY_PATH,
    summary: matrix.summary,
    githubDropInReplacement: matrix.summary.githubDropInReplacement,
    productionReadyWithoutPrivateEvidence:
      matrix.summary.productionReadyWithoutPrivateEvidence,
    migrationGuardrailIds: matrix.migrationGuardrails.map(
      (guardrail) => guardrail.id,
    ),
    agentNativeAdditionIds: matrix.agentNativeAdditions.map(
      (surface) => surface.id,
    ),
    unsupportedNativeSurfaces,
    partialOrDelegatedSurfaces,
    cutoverBlockerSurfaces: matrix.summary.cutoverBlockerSurfaceIds,
    acceptedGapSurfaces: matrix.summary.acceptedGapSurfaceIds,
    evidenceRequiredSurfaces: matrix.summary.evidenceRequiredSurfaceIds,
    blockedCutoverSurfaces: matrix.summary.blockedCutoverSurfaceIds,
    readySurfaceCount: matrix.summary.readySurfaceCount,
    cutoverReady: matrix.summary.cutoverReady,
  };
}

function summarizeSurfaces(
  surfaces,
  { privateEvidenceEvaluated = false, productionGate = null } = {},
) {
  const countsByStatus = {};
  for (const surface of surfaces) {
    countsByStatus[surface.status] = (countsByStatus[surface.status] ?? 0) + 1;
  }
  const cutoverBlockerSurfaceIds = surfaces
    .filter((surface) => surface.cutoverBlocker === true)
    .map((surface) => surface.id);
  const acceptedGapSurfaceIds = surfaces
    .filter((surface) => surface.productionDisposition === "accepted_gap")
    .map((surface) => surface.id);
  const evidenceRequiredSurfaceIds = surfaces
    .filter(
      (surface) =>
        Array.isArray(surface.requiredEvidence) &&
        surface.requiredEvidence.length > 0,
    )
    .map((surface) => surface.id);
  const readySurfaceIds = surfaces
    .filter((surface) => surface.cutoverReadiness?.ready === true)
    .map((surface) => surface.id);
  const blockedCutoverSurfaceIds = surfaces
    .filter((surface) => surface.cutoverReadiness?.blocksCutover === true)
    .map((surface) => surface.id);

  return {
    totalSurfaces: surfaces.length,
    countsByStatus,
    cutoverBlockerCount: cutoverBlockerSurfaceIds.length,
    acceptedGapCount: acceptedGapSurfaceIds.length,
    evidenceRequiredSurfaceCount: evidenceRequiredSurfaceIds.length,
    readySurfaceCount: readySurfaceIds.length,
    blockedCutoverSurfaceCount: blockedCutoverSurfaceIds.length,
    cutoverBlockerSurfaceIds,
    acceptedGapSurfaceIds,
    evidenceRequiredSurfaceIds,
    readySurfaceIds,
    blockedCutoverSurfaceIds,
    githubParityClaim: "explicit_partial_parity",
    githubDropInReplacement: false,
    productionReadyWithoutPrivateEvidence: false,
    productionUseRequiresPrivateEvidence: true,
    privateEvidenceEvaluated,
    productionGatePassed: productionGate?.ok === true,
    cutoverReady:
      privateEvidenceEvaluated && blockedCutoverSurfaceIds.length === 0,
    githubMigrationMode: "surface_by_surface_with_agent_native_replacements",
    productPosition:
      "Core Git collaboration stays Forgejo-native; agent workflow, merge queue, and readiness are Eliza-computed stewardship layers.",
  };
}

function enrichParitySurface(surface) {
  const metadata = SURFACE_CUTOVER_METADATA[surface.id] ?? {
    productionDisposition: "unclassified",
    cutoverBlocker: true,
    requiredEvidence: ["production_readiness.review_required"],
    requiredGateChecks: ["production_readiness_review_required"],
    migrationTarget: surface.authority,
    targetApis: [],
    nextAction: "classify_surface_before_cutover",
  };
  return cloneObject({ ...surface, ...metadata });
}

function buildCutoverReadiness(surface, gateByName, privateEvidenceEvaluated) {
  const requiredGateChecks = Array.isArray(surface.requiredGateChecks)
    ? surface.requiredGateChecks
    : [];

  if (surface.productionDisposition === "accepted_gap") {
    return {
      status: "accepted_gap",
      ready: true,
      blocksCutover: false,
      privateEvidenceEvaluated,
      requiredGateChecks,
      passedGateChecks: [],
      failingGateChecks: [],
      missingGateChecks: [],
    };
  }

  if (!privateEvidenceEvaluated) {
    return {
      status:
        requiredGateChecks.length > 0
          ? "private_evidence_required"
          : "unevaluated",
      ready: false,
      blocksCutover: surface.cutoverBlocker === true,
      privateEvidenceEvaluated: false,
      requiredGateChecks,
      passedGateChecks: [],
      failingGateChecks: requiredGateChecks,
      missingGateChecks: [],
    };
  }

  const passedGateChecks = [];
  const failingGateChecks = [];
  const missingGateChecks = [];

  for (const gateCheck of requiredGateChecks) {
    const check = gateByName.get(gateCheck);
    if (!check) {
      missingGateChecks.push(gateCheck);
    } else if (check.ok === true) {
      passedGateChecks.push(gateCheck);
    } else {
      failingGateChecks.push(gateCheck);
    }
  }

  const ready =
    failingGateChecks.length === 0 && missingGateChecks.length === 0;
  return {
    status: ready ? "ready" : "blocked_by_production_gate",
    ready,
    blocksCutover: surface.cutoverBlocker === true && !ready,
    privateEvidenceEvaluated: true,
    requiredGateChecks,
    passedGateChecks,
    failingGateChecks,
    missingGateChecks,
  };
}

function hasEvidence(evidence) {
  return (
    evidence &&
    typeof evidence === "object" &&
    !Array.isArray(evidence) &&
    Object.keys(evidence).length > 0
  );
}

function cloneObject(value) {
  return JSON.parse(JSON.stringify(value));
}
