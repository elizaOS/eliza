export const WORK_CONTEXT_VERSION = 1;

const DEFAULT_READ_FIRST = Object.freeze([
  {
    id: "bootstrap",
    title: "Agent bootstrap",
    hrefKey: "bootstrap",
    reason: "Identity, policy hints, and safe startup actions.",
  },
  {
    id: "workflow_operations",
    title: "Workflow operations",
    hrefKey: "workflows",
    reason:
      "Scoped Actions, runner evidence, and merge-train execution posture.",
  },
  {
    id: "inbox",
    title: "Agent inbox",
    hrefKey: "inbox",
    reason: "Owned cards, pending approvals, human requests, and work claims.",
  },
  {
    id: "fleet_coordination",
    title: "Fleet coordination",
    hrefKey: "fleetCoordination",
    reason: "Shared-lever claims, evidence expectations, and lane protocol.",
  },
  {
    id: "work_dashboard",
    title: "Work dashboard",
    hrefKey: "workDashboard",
    reason: "Current Work item views, active scopes, and progress.",
  },
  {
    id: "merge_queue",
    title: "Merge queue",
    hrefKey: "mergeQueue",
    reason: "Queue health, blocked lanes, and integration state.",
  },
  {
    id: "merge_train",
    title: "Merge train",
    hrefKey: "mergeTrain",
    reason: "Selected train, live preflight, and dry-run review state.",
  },
]);

const INBOX_ACTION_PRIORITY = Object.freeze({
  decide_approval: 95,
  answer_human_request: 90,
  recover_or_release_stale_work: 85,
  resolve_policy_blocker: 80,
  add_agent_plan: 70,
  claim_work_item: 65,
  continue_work_item: 60,
  claim_or_merge_queue_lane: 55,
  watch_run: 45,
  inspect_work_item: 35,
  inspect: 20,
});

export function buildWorkContext({
  repo,
  ownerAgentId,
  targetBranch,
  query,
  now = new Date().toISOString(),
  bootstrap = {},
  inbox = {},
  workDashboard = {},
  workProgress = null,
  fleetCoordination = {},
  mergeQueue = {},
  mergeTrain = {},
  workflowOperations = {},
  routing = {},
  search = {},
  workPages = [],
} = {}) {
  const agentId = stringOrNull(ownerAgentId);
  if (!agentId) {
    throw new TypeError("Work context requires ownerAgentId");
  }

  const filters = {
    repo: stringOrNull(repo),
    ownerAgentId: agentId,
    targetBranch: stringOrNull(targetBranch),
    query: stringOrNull(query),
  };
  const links = buildLinks(filters);
  const compactInbox = compactInboxSnapshot(inbox);
  const compactFleet = compactFleetSnapshot(fleetCoordination);
  const compactWork = compactWorkSnapshot({ workDashboard, workProgress });
  const compactQueue = compactMergeQueueSnapshot(mergeQueue);
  const mergeTrainSource =
    mergeTrain &&
    typeof mergeTrain === "object" &&
    Object.keys(mergeTrain).length > 0
      ? mergeTrain
      : bootstrap.snapshots?.mergeTrain;
  const compactTrain = compactMergeTrainSnapshot(mergeTrainSource);
  const workflowOperationsSource =
    workflowOperations &&
    typeof workflowOperations === "object" &&
    Object.keys(workflowOperations).length > 0
      ? workflowOperations
      : bootstrap.snapshots?.workflowOperations;
  const compactOperations = compactWorkflowOperationsSnapshot(
    workflowOperationsSource,
  );
  const compactRouting = compactRoutingSnapshot(routing, agentId);
  const compactSearch = compactSearchSnapshot(search);
  const compactPages = arrayValue(workPages)
    .map(compactPage)
    .filter(Boolean)
    .slice(0, 10);
  const nextActions = mergeNextActions({
    links,
    bootstrap,
    inbox: compactInbox,
    fleetCoordination: compactFleet,
    mergeTrain: compactTrain,
    workflowOperations: compactOperations,
    routing: compactRouting,
  });
  const status = contextStatus({
    bootstrap,
    inbox: compactInbox,
    fleetCoordination: compactFleet,
    mergeQueue: compactQueue,
    mergeTrain: compactTrain,
    workflowOperations: compactOperations,
    nextActions,
  });

  return {
    version: WORK_CONTEXT_VERSION,
    computedAt: now,
    readOnly: true,
    status,
    filters,
    identity: compactIdentity(bootstrap.identity),
    summary: {
      cards: compactInbox.counts.cards,
      ready: compactInbox.counts.ready,
      running: compactInbox.counts.running,
      blocked: compactInbox.counts.blocked,
      needsHuman: compactInbox.counts.needsHuman,
      activeClaims: compactInbox.counts.activeClaims,
      staleClaims: compactInbox.counts.staleClaims,
      openApprovals: compactInbox.counts.openApprovals,
      openHumanRequests: compactInbox.counts.openHumanRequests,
      workItems: compactWork.summary.workItems,
      activeWork: compactWork.summary.active,
      blockedWork: compactWork.summary.blocked,
      readyWork: compactWork.summary.ready,
      mergeQueueHealth: compactQueue.health,
      mergeTrainStatus: compactTrain.status,
      mergeTrainPreflightStatus: compactTrain.preflight.status,
      workflowOperationsStatus: compactOperations.status,
      workflowActionsStatus: compactOperations.actions.status,
      runnerStatus: compactOperations.runner.status,
      blockingSharedLevers: compactFleet.blockingLeverIds.length,
      searchResults: compactSearch.summary.returnedResults,
    },
    resume: {
      readFirst: readFirstItems({ links, pages: compactPages }),
      ownedCardIds: compactInbox.cards.map((card) => card.id).filter(Boolean),
      activeClaimIds: compactInbox.claims.active
        .map((claim) => claim.id)
        .filter(Boolean),
      staleClaimIds: compactInbox.claims.stale
        .map((claim) => claim.id)
        .filter(Boolean),
      blockingLeverIds: compactFleet.blockingLeverIds,
      mergeTrainItemIds: compactTrain.selectedTrain.itemIds,
      suggestedWorkIds: compactRouting.recommendations
        .map(
          (recommendation) =>
            recommendation.workItemId ??
            recommendation.itemId ??
            recommendation.id,
        )
        .filter(Boolean),
      searchResultIds: compactSearch.results
        .map((result) => result.id)
        .filter(Boolean),
      pageIds: compactPages.map((page) => page.id).filter(Boolean),
    },
    links,
    snapshots: {
      bootstrap: compactBootstrapSnapshot(bootstrap),
      inbox: compactInbox,
      work: compactWork,
      fleetCoordination: compactFleet,
      mergeQueue: compactQueue,
      mergeTrain: compactTrain,
      workflowOperations: compactOperations,
      routing: compactRouting,
      search: compactSearch,
      pages: compactPages,
    },
    nextActions,
  };
}

function buildLinks(filters) {
  const encodedAgentId = encodeURIComponent(filters.ownerAgentId);
  const query = {
    repo: filters.repo,
    targetBranch: filters.targetBranch,
  };
  const ownerQuery = {
    ...query,
    ownerAgentId: filters.ownerAgentId,
  };

  return {
    self: pathWithQuery("/api/work-context", {
      ...ownerQuery,
      query: filters.query,
    }),
    bootstrap: pathWithQuery(`/api/agents/${encodedAgentId}/bootstrap`, query),
    cockpit: pathWithQuery(`/api/agents/${encodedAgentId}/cockpit`, query),
    inbox: pathWithQuery(`/api/agents/${encodedAgentId}/inbox`, {
      ...query,
      readiness: false,
    }),
    actionPlan: `/api/agents/${encodedAgentId}/action-plan`,
    submissionGate: `/api/agents/${encodedAgentId}/submission-gate`,
    workPreflight: `/api/agents/${encodedAgentId}/work-preflight`,
    workReservation: `/api/agents/${encodedAgentId}/work-reservation`,
    claimNext: `/api/agents/${encodedAgentId}/claim-next`,
    claimAssignment: `/api/agents/${encodedAgentId}/claim-assignment`,
    workDashboard: pathWithQuery("/api/work-dashboard", ownerQuery),
    workProgress: pathWithQuery("/api/work-progress", ownerQuery),
    workItems: pathWithQuery("/api/work-items", ownerQuery),
    workPages: pathWithQuery("/api/work-pages", ownerQuery),
    fleetCoordination: pathWithQuery("/api/fleet-coordination", ownerQuery),
    workflows: pathWithQuery("/api/workflows", ownerQuery),
    mergeQueue: pathWithQuery("/api/merge-queue", query),
    mergeTrain: pathWithQuery("/api/merge-train", query),
    search: pathWithQuery("/api/search", {
      ...ownerQuery,
      q: filters.query,
    }),
    coordination: pathWithQuery("/api/coordination", { now: null }),
  };
}

function compactIdentity(identity = {}) {
  return {
    required: identity.required === true,
    known: identity.known === true,
    configured: identity.configured === true,
    persistedActive: identity.persistedActive === true,
    disabled: identity.disabled === true,
    state: identity.state ?? "unknown",
    status: identity.status ?? null,
    registrySummary: identity.registrySummary ?? {},
  };
}

function compactBootstrapSnapshot(bootstrap = {}) {
  return {
    agentId: bootstrap.agentId ?? null,
    computedAt: bootstrap.computedAt ?? null,
    identity: compactIdentity(bootstrap.identity),
    policyHints: bootstrap.policyHints ?? {},
    workflowOperations: compactWorkflowOperationsSnapshot(
      bootstrap.snapshots?.workflowOperations,
    ),
    nextActions: compactActions(bootstrap.nextActions).slice(0, 10),
  };
}

function compactInboxSnapshot(inbox = {}) {
  const counts = inbox.counts ?? {};
  return {
    computedAt: inbox.computedAt ?? null,
    counts: {
      cards: numberOrZero(counts.cards),
      needsHuman: numberOrZero(counts.needsHuman),
      triage: numberOrZero(counts.triage),
      blocked: numberOrZero(counts.blocked),
      failed: numberOrZero(counts.failed),
      running: numberOrZero(counts.running),
      ready: numberOrZero(counts.ready),
      waiting: numberOrZero(counts.waiting),
      activeClaims: numberOrZero(counts.activeClaims),
      staleClaims: numberOrZero(counts.staleClaims),
      openApprovals: numberOrZero(counts.openApprovals),
      openHumanRequests: numberOrZero(counts.openHumanRequests),
    },
    nextActions: arrayValue(inbox.nextActions)
      .slice(0, 10)
      .map((action) => ({
        action: action.action ?? action.id ?? "inspect",
        count: numberOrZero(action.count),
        cardIds: arrayValue(action.cardIds).slice(0, 20),
      })),
    claims: {
      active: arrayValue(inbox.claims?.active)
        .map(compactClaim)
        .filter(Boolean)
        .slice(0, 20),
      stale: arrayValue(inbox.claims?.stale)
        .map(compactClaim)
        .filter(Boolean)
        .slice(0, 20),
    },
    cards: arrayValue(inbox.cards)
      .map(compactCard)
      .filter(Boolean)
      .slice(0, 20),
    lanes: arrayValue(inbox.lanes)
      .map(compactLane)
      .filter(Boolean)
      .slice(0, 10),
  };
}

function compactWorkSnapshot({ workDashboard = {}, workProgress = null } = {}) {
  const summary = workDashboard.summary ?? {};
  const progressSummary =
    workProgress?.summary ?? workDashboard.progress?.summary ?? {};
  return {
    computedAt: workDashboard.computedAt ?? workProgress?.computedAt ?? null,
    summary: {
      workItems: numberOrZero(summary.workItems ?? progressSummary.total),
      cycles: numberOrZero(summary.cycles ?? progressSummary.cycles),
      modules: numberOrZero(summary.modules ?? progressSummary.modules),
      pages: numberOrZero(summary.pages),
      savedViews: numberOrZero(summary.savedViews),
      needsHuman: numberOrZero(summary.needsHuman),
      blocked: numberOrZero(summary.blocked ?? progressSummary.blocked),
      ready: numberOrZero(summary.ready ?? progressSummary.ready),
      active: numberOrZero(summary.active ?? progressSummary.active),
      done: numberOrZero(summary.done ?? progressSummary.done),
      percentComplete: numberOrZero(progressSummary.percentComplete),
      latestUpdatedAt: progressSummary.latestUpdatedAt ?? null,
    },
    builtInViews: arrayValue(workDashboard.views?.builtIn)
      .map(compactWorkView)
      .filter(Boolean),
    savedViews: arrayValue(workDashboard.views?.saved)
      .map(compactWorkView)
      .filter(Boolean)
      .slice(0, 10),
    progress: {
      summary: progressSummary,
      activeCycles: arrayValue(
        workProgress?.cycles ?? workDashboard.progress?.cycles,
      )
        .filter((cycle) => cycle.state === "active")
        .slice(0, 10),
      activeModules: arrayValue(
        workProgress?.modules ?? workDashboard.progress?.modules,
      )
        .filter((module) => module.state === "active")
        .slice(0, 10),
    },
  };
}

function compactFleetSnapshot(contract = {}) {
  const sharedLevers = arrayValue(contract.sharedLevers).map((lever) => ({
    id: lever.id ?? null,
    title: lever.title ?? lever.id ?? null,
    resourceKind: lever.resourceKind ?? null,
    resourceId: lever.resourceId ?? null,
    state: lever.state ?? "unknown",
    requiredAction: lever.requiredAction ?? null,
    activeClaim: lever.activeClaim ? compactClaim(lever.activeClaim) : null,
    activeClaimCount: numberOrZero(lever.activeClaimCount),
    staleClaimCount: numberOrZero(lever.staleClaimCount),
  }));
  return {
    computedAt: contract.computedAt ?? null,
    claimProtocol: {
      blockedAfterMinutes: contract.claimProtocol?.blockedAfterMinutes ?? null,
      staleClaimAfterMinutes:
        contract.claimProtocol?.staleClaimAfterMinutes ?? null,
      evidenceRows: arrayValue(contract.claimProtocol?.evidenceRows),
    },
    sharedLevers,
    blockingLeverIds: sharedLevers
      .filter((lever) => lever.state === "claimed_by_other")
      .map((lever) => lever.id)
      .filter(Boolean),
    staleOwnLeverIds: sharedLevers
      .filter((lever) => lever.state === "own_claim_stale")
      .map((lever) => lever.id)
      .filter(Boolean),
    nextActions: compactActions(contract.nextActions).slice(0, 10),
  };
}

function compactMergeQueueSnapshot(mergeQueue = {}) {
  const diagnostics = mergeQueue.diagnostics ?? {};
  const counts = mergeQueue.counts ?? {};
  return {
    computedAt: mergeQueue.computedAt ?? null,
    health: diagnostics.health ?? mergeQueue.status ?? "unknown",
    diagnostics: {
      health: diagnostics.health ?? null,
      reasons: arrayValue(diagnostics.reasons),
      blockedCount: numberOrZero(diagnostics.blockedCount),
      readyCount: numberOrZero(diagnostics.readyCount),
    },
    counts,
    lanes: arrayValue(mergeQueue.lanes)
      .map(compactLane)
      .filter(Boolean)
      .slice(0, 20),
  };
}

function compactMergeTrainSnapshot(mergeTrain = {}) {
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

function compactWorkflowOperationsSnapshot(operations = {}) {
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
  };
}

function compactRoutingSnapshot(routing = {}, agentId) {
  return {
    computedAt: routing.computedAt ?? null,
    counts: routing.counts ?? {},
    recommendations: arrayValue(routing.recommendations)
      .filter(
        (recommendation) =>
          !agentId ||
          !recommendation.agentId ||
          recommendation.agentId === agentId,
      )
      .slice(0, 10)
      .map((recommendation) => ({
        id:
          recommendation.id ??
          recommendation.workItemId ??
          recommendation.itemId ??
          recommendation.queueItemId ??
          null,
        agentId: recommendation.agentId ?? null,
        title: recommendation.title ?? recommendation.reason ?? null,
        reason: recommendation.reason ?? null,
        priority: recommendation.priority ?? null,
        workItemId: recommendation.workItemId ?? null,
        queueItemId: recommendation.queueItemId ?? null,
      })),
    blocked:
      arrayValue(routing.blockedAgents).find(
        (agent) => agent.agentId === agentId,
      ) ?? null,
    routable:
      arrayValue(routing.routableAgents).find(
        (agent) => agent.agentId === agentId,
      ) ?? null,
  };
}

function compactSearchSnapshot(search = {}) {
  const summary = search.summary ?? {};
  return {
    computedAt: search.computedAt ?? null,
    query: search.query ?? null,
    summary: {
      searchedDocuments: numberOrZero(summary.searchedDocuments),
      matchedDocuments: numberOrZero(summary.matchedDocuments),
      returnedResults: numberOrZero(summary.returnedResults),
    },
    results: arrayValue(search.results)
      .map((result) => ({
        rank: result.rank ?? null,
        kind: result.kind ?? null,
        id: result.id ?? null,
        title: result.title ?? null,
        summary: result.summary ?? null,
        score: result.score ?? null,
        url: result.url ?? null,
      }))
      .slice(0, 10),
  };
}

function mergeNextActions({
  links,
  bootstrap = {},
  inbox = {},
  fleetCoordination = {},
  mergeTrain = {},
  workflowOperations = {},
  routing = {},
} = {}) {
  const actions = [];

  for (const action of compactActions(bootstrap.nextActions)) {
    actions.push({ ...action, source: "bootstrap" });
  }

  for (const action of arrayValue(inbox.nextActions)) {
    actions.push({
      id: action.action,
      priority: INBOX_ACTION_PRIORITY[action.action] ?? 30,
      blocking: [
        "decide_approval",
        "answer_human_request",
        "resolve_policy_blocker",
      ].includes(action.action),
      method: "GET",
      href: links.inbox,
      reason: `${action.count} inbox card(s) need ${action.action}.`,
      cardIds: action.cardIds,
      source: "inbox",
    });
  }

  for (const action of compactActions(fleetCoordination.nextActions)) {
    actions.push({ ...action, source: "fleet_coordination" });
  }

  if (mergeTrain.preflight.status === "blocked") {
    actions.push({
      id: "resolve_merge_train_preflight",
      priority: 65,
      blocking: false,
      method: "GET",
      href: links.mergeTrain,
      reason: "Merge train preflight has blockers before live execution.",
      source: "merge_train",
    });
  } else if (mergeTrain.preflight.dryRunReviewReady) {
    actions.push({
      id: "review_merge_train_dry_run",
      priority: 45,
      blocking: false,
      method: "GET",
      href: links.mergeTrain,
      reason: "A dry-run merge train is ready for review.",
      source: "merge_train",
    });
  }

  if (workflowOperations.status === "control_plane_blocked") {
    actions.push({
      id: "inspect_steward_readiness",
      priority: 70,
      blocking: false,
      method: "GET",
      href: links.workflows,
      reason: "Workflow operations report a blocked steward control plane.",
      source: "workflow_operations",
    });
  }

  if (workflowOperations.runner.status === "private_evidence_required") {
    actions.push({
      id: "review_runner_evidence_before_live",
      priority: 40,
      blocking: false,
      method: "GET",
      href: links.workflows,
      reason:
        "Live merge readiness still requires retained isolated-runner evidence.",
      source: "workflow_operations",
    });
  }

  if (routing.recommendations.length > 0) {
    actions.push({
      id: "claim_routed_work",
      priority: 50,
      blocking: false,
      method: "POST",
      href: links.claimAssignment,
      reason: "Routing has recommended work for this agent.",
      source: "routing",
    });
  }

  actions.push({
    id: "run_action_plan_before_pr",
    priority: 25,
    blocking: false,
    method: "POST",
    href: links.actionPlan,
    reason: "Build a fresh action plan before opening or updating a PR.",
    source: "work_context",
  });

  const byId = new Map();
  for (const action of actions) {
    const key = `${action.id}:${action.href ?? ""}`;
    const existing = byId.get(key);
    if (
      !existing ||
      numberOrZero(action.priority) > numberOrZero(existing.priority)
    ) {
      byId.set(key, action);
    }
  }

  return [...byId.values()]
    .sort(
      (left, right) =>
        Boolean(right.blocking) - Boolean(left.blocking) ||
        numberOrZero(right.priority) - numberOrZero(left.priority) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(0, 20);
}

function contextStatus({
  bootstrap = {},
  inbox = {},
  fleetCoordination = {},
  mergeQueue = {},
  mergeTrain = {},
  workflowOperations = {},
  nextActions = [],
} = {}) {
  const identityState = bootstrap.identity?.state;
  if (
    bootstrap.identity?.disabled === true ||
    identityState === "unregistered_blocked"
  )
    return "blocked";
  if (workflowOperations.status === "control_plane_blocked")
    return "needs_attention";
  if (nextActions.some((action) => action.blocking === true))
    return "needs_attention";
  if (fleetCoordination.blockingLeverIds.length > 0) return "needs_attention";
  if (mergeTrain.preflight?.status === "blocked") return "needs_attention";
  if (
    inbox.counts.staleClaims > 0 ||
    inbox.counts.blocked > 0 ||
    inbox.counts.needsHuman > 0
  )
    return "needs_attention";
  if (
    mergeQueue.health &&
    !["healthy", "idle", "empty", "unknown"].includes(mergeQueue.health)
  )
    return "needs_attention";
  if (
    inbox.counts.cards > 0 ||
    inbox.counts.ready > 0 ||
    inbox.counts.running > 0
  )
    return "active";
  return "ready";
}

function readFirstItems({ links, pages = [] } = {}) {
  const builtIn = DEFAULT_READ_FIRST.map((item) => ({
    id: item.id,
    title: item.title,
    href: links[item.hrefKey],
    reason: item.reason,
  }));
  const pageItems = pages.slice(0, 5).map((page) => ({
    id: `page:${page.id}`,
    title: page.title,
    href: page.id
      ? pathWithQuery("/api/work-pages/item", { id: page.id })
      : links.workPages,
    reason:
      page.kind === "agent_plan"
        ? "Agent plan context attached to current work."
        : "Runbook or saved context attached to current work.",
  }));
  return [...pageItems, ...builtIn];
}

function compactActions(actions) {
  return arrayValue(actions).map((action) => ({
    id: action.id ?? action.action ?? "inspect",
    priority: numberOrZero(action.priority),
    blocking: action.blocking === true,
    method: action.method ?? null,
    href: action.href ?? null,
    reason: action.reason ?? null,
    ...(action.body ? { body: action.body } : {}),
    ...(action.leverIds ? { leverIds: arrayValue(action.leverIds) } : {}),
  }));
}

function compactCard(card = {}) {
  if (!card.id) return null;
  return {
    id: card.id,
    kind: card.kind ?? null,
    title:
      card.title ?? card.workItem?.title ?? card.queueItem?.title ?? card.id,
    state:
      card.state ??
      card.columnId ??
      card.queueItem?.queueState ??
      card.workItem?.state ??
      null,
    priority:
      card.priority ??
      card.queueItem?.priority ??
      card.workItem?.priority ??
      null,
    repo: card.repo ?? card.queueItem?.repo ?? card.workItem?.repo ?? null,
    ownerAgentId:
      card.ownerAgentId ??
      card.queueItem?.ownerAgentId ??
      card.workItem?.ownerAgentId ??
      null,
    queueItemId: card.queueItem?.id ?? card.queueItemId ?? null,
    workItemId: card.workItem?.id ?? card.workItemId ?? null,
    pullRequestId:
      card.queueItem?.pullRequestId ?? card.workItem?.pullRequestId ?? null,
    links: objectValue(card.links),
    nextActions: arrayValue(card.nextActions),
  };
}

function compactClaim(claim = {}) {
  if (!claim.id) return null;
  return {
    id: claim.id,
    repo: claim.repo ?? null,
    resourceKind: claim.resourceKind ?? null,
    resourceId: claim.resourceId ?? null,
    ownerAgentId: claim.ownerAgentId ?? null,
    status: claim.status ?? "unknown",
    taskId: claim.taskId ?? null,
    paths: arrayValue(claim.paths),
    expiresAt: claim.expiresAt ?? null,
    updatedAt: claim.updatedAt ?? claim.createdAt ?? null,
  };
}

function compactLane(lane = {}) {
  const id = lane.id ?? lane.key;
  if (!id) return null;
  return {
    id,
    key: lane.key ?? id,
    state: lane.state ?? lane.health ?? null,
    repo: lane.repo ?? null,
    targetBranch: lane.targetBranch ?? null,
    ready: numberOrZero(lane.ready),
    running: numberOrZero(lane.running),
    blocked: numberOrZero(lane.blocked),
    waiting: numberOrZero(lane.waiting),
    cardIds: arrayValue(lane.cardIds).slice(0, 20),
    needsHumanCardIds: arrayValue(lane.needsHumanCardIds).slice(0, 20),
    batchCandidateCardIds: arrayValue(lane.batchCandidateCardIds).slice(0, 20),
  };
}

function compactWorkView(view = {}) {
  if (!view.id) return null;
  return {
    id: view.id,
    title: view.title ?? view.id,
    kind: view.kind ?? null,
    builtIn: view.builtIn === true,
    count: numberOrZero(view.count),
    itemIds: arrayValue(view.itemIds).slice(0, 20),
    pageIds: arrayValue(view.pageIds).slice(0, 20),
    truncated: view.truncated === true,
  };
}

function compactPage(page = {}) {
  if (!page.id) return null;
  return {
    id: page.id,
    title: page.title ?? page.id,
    kind: page.kind ?? null,
    state: page.state ?? null,
    workItemId: page.workItemId ?? null,
    cycleId: page.cycleId ?? null,
    moduleId: page.moduleId ?? null,
    taskId: page.taskId ?? null,
    issueId: page.issueId ?? null,
    pullRequestId: page.pullRequestId ?? null,
    updatedAt: page.updatedAt ?? page.createdAt ?? null,
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

function stringOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
