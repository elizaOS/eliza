import { DEFAULT_SUBMISSION_GATE_LIMITS } from "./agent-submission-gate.js";
import { buildWorkflowOperations } from "./workflow-view.js";

export function buildAgentBootstrap({
  agentId,
  repo,
  targetBranch,
  now = new Date().toISOString(),
  config = {},
  knownAgentIds = [],
  registeredAgent = null,
  identityRegistry = {},
  inbox = {},
  routing = {},
  claims = [],
  mergeTrain = {},
  readiness = null,
} = {}) {
  const normalizedAgentId = stringOrNull(agentId);
  if (!normalizedAgentId) {
    throw new TypeError("Agent bootstrap requires agentId");
  }

  const filters = {
    repo: stringOrNull(repo),
    targetBranch: stringOrNull(targetBranch),
    ownerAgentId: normalizedAgentId,
  };
  const links = buildAgentLinks(normalizedAgentId, filters);
  const identity = buildIdentityState({
    agentId: normalizedAgentId,
    knownAgentIds,
    registeredAgent,
    identityRegistry,
    config,
  });
  const workflowOperations = buildWorkflowOperations({
    readiness,
    mergeTrain,
    filters,
    counts: {
      cards: numberOrZero(inbox.counts?.cards),
    },
  });
  const snapshots = buildSnapshots({
    agentId: normalizedAgentId,
    inbox,
    routing,
    claims,
    mergeTrain,
    workflowOperations,
    now,
  });
  const policyHints = buildPolicyHints({
    agentId: normalizedAgentId,
    config,
    identity,
    mergeTrain: snapshots.mergeTrain,
    workflowOperations: snapshots.workflowOperations,
  });

  return {
    agentId: normalizedAgentId,
    computedAt: now,
    filters,
    identity,
    policyHints,
    links,
    snapshots,
    nextActions: buildNextActions({ identity, snapshots, links }),
  };
}

function buildIdentityState({
  agentId,
  knownAgentIds = [],
  registeredAgent,
  identityRegistry = {},
  config = {},
}) {
  const knownIds = uniqueStrings(knownAgentIds);
  const configured = uniqueStrings(config.policy?.knownAgentIds).includes(
    agentId,
  );
  const record = registeredAgent
    ? compactRegisteredAgent(registeredAgent)
    : null;
  const disabled = record?.status === "disabled";
  const persistedActive = record?.status === "active";
  const known = !disabled && knownIds.includes(agentId);
  const required =
    identityRegistry.required === true ||
    config.policy?.requireAgentIdentityRegistryForAgentPrs === true;

  return {
    required,
    known,
    configured,
    persistedActive,
    disabled,
    status: record?.status ?? null,
    state: disabled
      ? "disabled"
      : known
        ? "known"
        : required
          ? "unregistered_blocked"
          : "unregistered_allowed",
    registrySummary: {
      required,
      configuredAgentIdCount: numberOrZero(
        identityRegistry.configuredAgentIdCount,
      ),
      persistedActiveAgentIdCount: numberOrZero(
        identityRegistry.persistedActiveAgentIdCount,
      ),
      persistedDisabledAgentIdCount: numberOrZero(
        identityRegistry.persistedDisabledAgentIdCount,
      ),
      knownAgentIdCount: numberOrZero(identityRegistry.knownAgentIdCount),
    },
    record,
  };
}

function buildPolicyHints({
  agentId,
  config = {},
  identity,
  mergeTrain = {},
  workflowOperations = {},
}) {
  const branchPrefix = config.policy?.agentBranchNamespacePrefix ?? "agent";
  return {
    workReservation: {
      required: config.policy?.requireWorkReservationForAgentPrs === true,
      reserveBeforePullRequest: true,
    },
    workItem: {
      required: config.policy?.requireWorkItemForAgentPrs === true,
      linkBeforePullRequest: true,
      matchKeys: ["pullRequestId", "taskId", "issueId"],
    },
    agentBranchNamespace: {
      required: config.policy?.requireAgentBranchNamespaceForAgentPrs === true,
      prefix: branchPrefix,
      expectedPrefix: `${branchPrefix}/${agentId}/`,
    },
    agentRunReceipt: {
      required:
        config.policy?.requireAgentRunReceiptForAgentPrs === true ||
        config.policy?.requireVerifiedAgentRunReceiptForAgentPrs === true,
      verified:
        config.policy?.requireVerifiedAgentRunReceiptForAgentPrs === true,
      signatureAlgorithm: "hmac-sha256",
    },
    agentIdentityRegistry: {
      required: identity.required,
      accepted: identity.known,
      state: identity.state,
      knownAgentIdCount: identity.registrySummary.knownAgentIdCount,
    },
    validationBudget: {
      planBeforeRunning: true,
      broadValidationBlockedByDefault: true,
    },
    submissionGate: {
      checkBeforePullRequest: true,
      maxQueuedWork: DEFAULT_SUBMISSION_GATE_LIMITS.maxQueuedWork,
      warnQueuedWork: DEFAULT_SUBMISSION_GATE_LIMITS.warnQueuedWork,
      maxRecentSubmissions: DEFAULT_SUBMISSION_GATE_LIMITS.maxRecentSubmissions,
      warnRecentSubmissions:
        DEFAULT_SUBMISSION_GATE_LIMITS.warnRecentSubmissions,
      recentSubmissionWindowMinutes:
        DEFAULT_SUBMISSION_GATE_LIMITS.recentSubmissionWindowMinutes,
    },
    mergeQueue: {
      integrationEnabled: config.integration?.enabled === true,
      integrationDryRun: config.integration?.dryRun !== false,
      workerEnabled: config.worker?.enabled === true,
      trainStatus: mergeTrain.status ?? null,
      trainPreflightStatus: mergeTrain.preflight?.status ?? null,
      liveExecutionReady: mergeTrain.preflight?.liveExecutionReady === true,
      dryRunReviewReady: mergeTrain.preflight?.dryRunReviewReady === true,
    },
    workflowOperations: {
      status: workflowOperations.status ?? null,
      actionsStatus: workflowOperations.actions?.status ?? null,
      runnerStatus: workflowOperations.runner?.status ?? null,
      mergeQueueStatus: workflowOperations.mergeQueue?.status ?? null,
      nextActions: arrayValue(workflowOperations.nextActions).slice(0, 10),
    },
  };
}

function buildSnapshots({
  agentId,
  inbox = {},
  routing = {},
  claims = [],
  mergeTrain = {},
  workflowOperations = {},
  now,
}) {
  const normalizedClaims = claims.map((claim) => compactClaim(claim, now));
  const activeClaims = normalizedClaims.filter(
    (claim) => claim.status === "active",
  );
  const staleClaims = normalizedClaims.filter(
    (claim) => claim.status === "stale",
  );
  const ownRecommendations = arrayValue(routing.recommendations)
    .filter((recommendation) => recommendation.agentId === agentId)
    .slice(0, 10);
  const routable =
    arrayValue(routing.routableAgents).find(
      (agent) => agent.agentId === agentId,
    ) ?? null;
  const blocked =
    arrayValue(routing.blockedAgents).find(
      (agent) => agent.agentId === agentId,
    ) ?? null;

  return {
    inbox: {
      computedAt: inbox.computedAt ?? null,
      counts: inbox.counts ?? {},
      nextActions: arrayValue(inbox.nextActions).slice(0, 10),
      cardIds: arrayValue(inbox.cards)
        .slice(0, 20)
        .map((card) => card.id)
        .filter(Boolean),
    },
    routing: {
      computedAt: routing.computedAt ?? null,
      counts: routing.counts ?? {},
      routable,
      blocked,
      recommendations: ownRecommendations,
    },
    claims: {
      counts: {
        active: activeClaims.length,
        stale: staleClaims.length,
        total: normalizedClaims.length,
      },
      active: activeClaims,
      stale: staleClaims,
    },
    mergeTrain: compactMergeTrain(mergeTrain),
    workflowOperations: compactWorkflowOperations(workflowOperations),
  };
}

function buildNextActions({ identity, snapshots, links }) {
  const actions = [];

  if (identity.disabled) {
    actions.push(
      action({
        id: "restore_agent_identity",
        priority: 100,
        blocking: true,
        method: "POST",
        href: links.agentIdentities,
        reason: "Agent identity is disabled in the steward registry.",
      }),
    );
  } else if (identity.required && !identity.known) {
    actions.push(
      action({
        id: "register_agent_identity",
        priority: 95,
        blocking: true,
        method: "POST",
        href: links.agentIdentities,
        reason:
          "Strict agent identity registry policy is enabled and this agent is not known.",
      }),
    );
  }

  if (snapshots.claims.counts.stale > 0) {
    actions.push(
      action({
        id: "renew_or_release_stale_claims",
        priority: 80,
        method: "GET",
        href: links.claims,
        reason: "This agent has stale claims that can block other agents.",
      }),
    );
  }

  if (snapshots.inbox.nextActions.length > 0) {
    actions.push(
      action({
        id: "inspect_agent_inbox",
        priority: 60,
        method: "GET",
        href: links.inbox,
        reason: "Inbox has pending agent actions.",
      }),
    );
  }

  if (snapshots.routing.recommendations.length > 0) {
    actions.push(
      action({
        id: "claim_suggested_assignment",
        priority: 50,
        method: "POST",
        href: links.claimAssignment,
        reason: "Routing has work assigned to this agent.",
      }),
    );
  }

  if (snapshots.workflowOperations.status === "control_plane_blocked") {
    actions.push(
      action({
        id: "inspect_steward_readiness",
        priority: 70,
        method: "GET",
        href: links.workflows,
        reason: "Workflow operations report a blocked steward control plane.",
      }),
    );
  }

  if (snapshots.mergeTrain.preflight.status === "blocked") {
    actions.push(
      action({
        id: "resolve_merge_train_preflight",
        priority: 55,
        method: "GET",
        href: links.mergeTrain,
        reason: "Merge train preflight has blockers before live execution.",
      }),
    );
  } else if (snapshots.mergeTrain.preflight.dryRunReviewReady) {
    actions.push(
      action({
        id: "review_merge_train_dry_run",
        priority: 45,
        method: "GET",
        href: links.mergeTrain,
        reason:
          "A dry-run merge train is ready for review before live execution.",
      }),
    );
  }

  if (
    snapshots.workflowOperations.runner.status === "private_evidence_required"
  ) {
    actions.push(
      action({
        id: "review_runner_evidence_before_live",
        priority: 40,
        method: "GET",
        href: links.productionReadiness,
        reason:
          "Live merge readiness still requires retained isolated-runner evidence.",
      }),
    );
  }

  actions.push(
    action({
      id: "preflight_before_branch",
      priority: 20,
      method: "POST",
      href: links.workPreflight,
      reason: "Run work preflight before opening or updating an agent branch.",
    }),
  );

  actions.push(
    action({
      id: "preview_next_claim",
      priority: 10,
      method: "POST",
      href: links.claimNext,
      body: { dryRun: true },
      reason: "Preview the next safe claim before mutating steward state.",
    }),
  );

  return actions.sort(
    (left, right) =>
      right.priority - left.priority || left.id.localeCompare(right.id),
  );
}

function buildAgentLinks(agentId, filters) {
  const encodedAgentId = encodeURIComponent(agentId);
  const query = {
    repo: filters.repo,
    targetBranch: filters.targetBranch,
  };
  const ownerQuery = {
    ...query,
    ownerAgentId: agentId,
  };

  return {
    self: pathWithQuery(`/api/agents/${encodedAgentId}/bootstrap`, query),
    discovery: "/.well-known/eliza-hub.json",
    openapi: "/openapi.json",
    inbox: pathWithQuery(`/api/agents/${encodedAgentId}/inbox`, {
      ...query,
      readiness: false,
    }),
    cockpit: pathWithQuery(`/api/agents/${encodedAgentId}/cockpit`, query),
    workContext: pathWithQuery("/api/work-context", ownerQuery),
    routing: pathWithQuery("/api/agent-routing", ownerQuery),
    fleetCoordination: pathWithQuery("/api/fleet-coordination", ownerQuery),
    projectBoard: pathWithQuery("/api/project-board", {
      ...ownerQuery,
      readiness: false,
    }),
    workflows: pathWithQuery("/api/workflows", ownerQuery),
    mergeQueue: pathWithQuery("/api/merge-queue", query),
    mergeTrain: pathWithQuery("/api/merge-train", query),
    releaseReadiness: pathWithQuery("/api/release-readiness", {
      ...query,
      readiness: false,
    }),
    productionReadiness: "/api/production-readiness",
    claims: pathWithQuery("/api/claims", { ...ownerQuery, status: "active" }),
    agentIdentity: pathWithQuery("/api/agent-identities/item", { id: agentId }),
    agentIdentities: "/api/agent-identities",
    submissionGate: `/api/agents/${encodedAgentId}/submission-gate`,
    workPreflight: `/api/agents/${encodedAgentId}/work-preflight`,
    workReservation: `/api/agents/${encodedAgentId}/work-reservation`,
    claimAssignment: `/api/agents/${encodedAgentId}/claim-assignment`,
    claimNext: `/api/agents/${encodedAgentId}/claim-next`,
    validationPlan: "/api/ci/validation-plan",
    pullRequestBrief: "/api/pr/brief",
    patchConflictPrediction: "/api/patch/conflict-prediction",
  };
}

function compactRegisteredAgent(agent) {
  return {
    id: agent.id,
    status: agent.status ?? "active",
    tenantId: agent.tenantId ?? null,
    source: agent.source ?? null,
    registeredBy: agent.registeredBy ?? null,
    registeredAt: agent.registeredAt ?? null,
    updatedAt: agent.updatedAt ?? null,
    disabledBy: agent.disabledBy ?? null,
    disabledAt: agent.disabledAt ?? null,
    disableReason: agent.disableReason ?? null,
  };
}

function compactClaim(claim, now) {
  return {
    id: claim.id,
    repo: claim.repo ?? null,
    resourceKind: claim.resourceKind ?? null,
    resourceId: claim.resourceId ?? null,
    ownerAgentId: claim.ownerAgentId ?? null,
    status:
      claim.status === "active" && isExpired(claim.expiresAt, now)
        ? "stale"
        : (claim.status ?? "unknown"),
    paths: arrayValue(claim.paths),
    taskId: claim.taskId ?? null,
    expiresAt: claim.expiresAt ?? null,
    updatedAt: claim.updatedAt ?? claim.createdAt ?? null,
  };
}

function compactMergeTrain(mergeTrain = {}) {
  const selectedTrain = mergeTrain.selectedTrain ?? {};
  const preflight = mergeTrain.preflight ?? {};
  return {
    computedAt: mergeTrain.computedAt ?? null,
    status: mergeTrain.status ?? "unknown",
    readOnly: mergeTrain.readOnly === true,
    selectedTrain: {
      id: selectedTrain.id ?? null,
      repo: selectedTrain.repo ?? null,
      targetBranch: selectedTrain.targetBranch ?? null,
      mode: selectedTrain.mode ?? null,
      executionReady: selectedTrain.executionReady === true,
      planCount: numberOrZero(selectedTrain.planCount),
      itemIds: arrayValue(selectedTrain.itemIds).slice(0, 20),
      blockers: arrayValue(selectedTrain.blockers),
      nextAction: selectedTrain.nextAction ?? null,
    },
    preflight: {
      status: preflight.status ?? null,
      liveExecutionReady: preflight.liveExecutionReady === true,
      dryRunReviewReady: preflight.dryRunReviewReady === true,
      blockers: arrayValue(preflight.blockers),
      warnings: arrayValue(preflight.warnings),
      requiredActions: arrayValue(preflight.requiredActions),
    },
  };
}

function compactWorkflowOperations(operations = {}) {
  return {
    status: operations.status ?? "unknown",
    controlPlane: {
      status: operations.controlPlane?.status ?? "unknown",
      ok: operations.controlPlane?.ok ?? null,
      deploymentMode: operations.controlPlane?.deploymentMode ?? null,
    },
    actions: {
      status: operations.actions?.status ?? "unknown",
      provider: operations.actions?.provider ?? null,
      ciAuthority: operations.actions?.ciAuthority ?? null,
      trustedWorkflow: operations.actions?.trustedWorkflow ?? null,
    },
    runner: {
      status: operations.runner?.status ?? "unknown",
      trustedSmokeWorkflowRequired:
        operations.runner?.trustedSmokeWorkflowRequired === true,
      isolatedRunnerRequired:
        operations.runner?.isolatedRunnerRequired === true,
      privateEvidenceRequired:
        operations.runner?.privateEvidenceRequired === true,
    },
    mergeQueue: {
      status: operations.mergeQueue?.status ?? "unknown",
      liveExecutionReady: operations.mergeQueue?.liveExecutionReady === true,
      dryRunReviewReady: operations.mergeQueue?.dryRunReviewReady === true,
      selectedItemIds: arrayValue(operations.mergeQueue?.selectedItemIds).slice(
        0,
        20,
      ),
      blockers: arrayValue(operations.mergeQueue?.blockers),
      warnings: arrayValue(operations.mergeQueue?.warnings),
      nextAction: operations.mergeQueue?.nextAction ?? null,
    },
    nextActions: arrayValue(operations.nextActions).slice(0, 10),
    links: {
      workflows: operations.links?.workflows ?? "/api/workflows",
      mergeTrain: operations.links?.mergeTrain ?? "/api/merge-train",
      productionReadiness:
        operations.links?.productionReadiness ?? "/api/production-readiness",
    },
  };
}

function action({
  id,
  priority,
  method,
  href,
  reason,
  blocking = false,
  body,
} = {}) {
  return {
    id,
    priority,
    blocking,
    method,
    href,
    reason,
    ...(body ? { body } : {}),
  };
}

function pathWithQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }

  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return (
    Number.isFinite(expiresAtMs) &&
    Number.isFinite(nowMs) &&
    expiresAtMs <= nowMs
  );
}

function stringOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [
    ...new Set(
      arrayValue(values)
        .map((value) => String(value))
        .filter(Boolean),
    ),
  ];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
