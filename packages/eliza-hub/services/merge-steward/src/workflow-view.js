import { deriveQueueItemRunState, deriveStewardRunState } from "./run-state.js";
import { buildStackDependencyGraph } from "./stack-dependencies.js";

const TERMINAL_QUEUE_STATES = new Set([
  "closed",
  "merged",
  "failed",
  "cancelled",
  "integration_failed",
]);
const OPEN_APPROVAL_STATUSES = new Set([
  "requested",
  "pending",
  "waiting",
  "waiting_approval",
]);
const OPEN_HUMAN_REQUEST_STATUSES = new Set([
  "requested",
  "pending",
  "waiting",
  "waiting_input",
  "open",
]);

export function buildWorkflowView({
  queueItems = [],
  workItems = [],
  workCycles = [],
  workModules = [],
  workProgress = null,
  claims = [],
  runs = [],
  approvals = [],
  humanRequests = [],
  readiness = null,
  mergeTrain = null,
  now = new Date().toISOString(),
  repo,
  targetBranch,
  ownerAgentId,
} = {}) {
  const nowMs = Date.parse(now);
  const filters = normalizeWorkflowFilters({
    repo,
    targetBranch,
    ownerAgentId,
  });
  const scopedQueueItems = queueItems.filter((item) =>
    matchesWorkflowScope(item, filters),
  );
  const scopedWorkItems = workItems.filter((item) =>
    matchesWorkflowScope(item, filters),
  );
  const scopedWorkCycles = workCycles.filter((cycle) =>
    matchesWorkflowScope(cycle, filters),
  );
  const scopedWorkModules = workModules.filter((module) =>
    matchesWorkflowScope(module, filters),
  );
  const scopedQueueIds = new Set(
    scopedQueueItems.map(queueItemIdentity).filter(Boolean),
  );
  const scopedRuns = runs.filter((run) =>
    matchesRunScope(run, filters, scopedQueueIds),
  );
  const scopedRunIds = new Set(
    scopedRuns.map((run) => String(run.id)).filter(Boolean),
  );
  const scopedApprovals = approvals.filter((approval) =>
    matchesLinkedScope(approval, { scopedQueueIds, scopedRunIds, filters }),
  );
  const scopedHumanRequests = humanRequests.filter((request) =>
    matchesLinkedScope(request, { scopedQueueIds, scopedRunIds, filters }),
  );
  const scopedClaims = claims.filter((claim) =>
    matchesClaimScope(claim, filters),
  );
  const queueById = new Map(
    scopedQueueItems.map((item) => [String(item.id), item]),
  );
  const runsByQueueItem = groupBy(scopedRuns, (run) => run.queueItemId ?? null);
  const approvalsByQueueItem = groupBy(
    scopedApprovals,
    (approval) => approval.queueItemId ?? null,
  );
  const approvalsByRun = groupBy(
    scopedApprovals,
    (approval) => approval.runId ?? null,
  );
  const humanRequestsByRun = groupBy(
    scopedHumanRequests,
    (request) => request.runId ?? null,
  );
  const activeClaims = scopedClaims.filter(
    (claim) => claim.status === "active" && !isExpired(claim.expiresAt, nowMs),
  );
  const staleClaims = scopedClaims.filter(
    (claim) => claim.status === "active" && isExpired(claim.expiresAt, nowMs),
  );
  const stackGraph = buildStackDependencyGraph({
    queueItems: scopedQueueItems,
  });
  const stackByQueueItem = new Map(
    stackGraph.items.map((item) => [item.id, item]),
  );

  const cards = [];
  for (const item of scopedQueueItems.filter(
    (candidate) => !TERMINAL_QUEUE_STATES.has(candidate.queueState),
  )) {
    const itemRuns = runsByQueueItem.get(String(item.id)) ?? [];
    const itemApprovals = uniqueById([
      ...(approvalsByQueueItem.get(String(item.id)) ?? []),
      ...itemRuns.flatMap((run) => approvalsByRun.get(String(run.id)) ?? []),
    ]);
    const itemHumanRequests = itemRuns.flatMap(
      (run) => humanRequestsByRun.get(String(run.id)) ?? [],
    );
    const itemClaims = claimsForQueueItem(
      item,
      activeClaims,
      staleClaims,
      nowMs,
    );
    const runStates = itemRuns
      .map((run) => deriveStewardRunState(run))
      .filter(Boolean);
    const runState =
      runStates[0] ??
      deriveQueueItemRunState(item, {
        now: Number.isFinite(nowMs) ? nowMs : Date.now(),
      });
    const stack = stackByQueueItem.get(queueItemIdentity(item)) ?? null;
    cards.push(
      queueCard({
        item,
        claims: itemClaims,
        approvals: itemApprovals,
        humanRequests: itemHumanRequests,
        runs: itemRuns,
        runState,
        stack,
        now,
      }),
    );
  }

  for (const run of scopedRuns.filter(
    (candidate) =>
      candidate.queueItemId && !queueById.has(String(candidate.queueItemId)),
  )) {
    const runApprovals = approvalsByRun.get(String(run.id)) ?? [];
    const runHumanRequests = humanRequestsByRun.get(String(run.id)) ?? [];
    cards.push(
      runCard({
        run,
        approvals: runApprovals,
        humanRequests: runHumanRequests,
        runState: deriveStewardRunState(run),
        now,
      }),
    );
  }

  for (const item of scopedWorkItems) {
    cards.push(
      workItemCard({
        item,
        claims: claimsForWorkItem(item, activeClaims, staleClaims, nowMs),
        now,
      }),
    );
  }

  const readinessView = readinessSummary(readiness);
  const counts = {
    cards: cards.length,
    queueItems: scopedQueueItems.length,
    workItems: scopedWorkItems.length,
    workCycles: scopedWorkCycles.length,
    workModules: scopedWorkModules.length,
    openApprovals: scopedApprovals.filter(isOpenApproval).length,
    openHumanRequests: scopedHumanRequests.filter(isOpenHumanRequest).length,
    activeClaims: activeClaims.length,
    staleClaims: staleClaims.length,
    runningRuns: scopedRuns.filter(
      (run) => normalizeStatus(run.status) === "running",
    ).length,
    failedRuns: scopedRuns.filter(
      (run) => normalizeStatus(run.status) === "failed",
    ).length,
  };

  return {
    computedAt: now,
    filters,
    readiness: readinessView,
    operations: buildWorkflowOperations({
      readiness: readinessView,
      mergeTrain,
      counts,
      filters,
    }),
    counts,
    inbox: {
      approvals: scopedApprovals.filter(isOpenApproval).map(approvalInboxItem),
      humanRequests: scopedHumanRequests
        .filter(isOpenHumanRequest)
        .map(humanRequestInboxItem),
      staleClaims: staleClaims.map(claimInboxItem),
      failedRuns: scopedRuns
        .filter((run) => normalizeStatus(run.status) === "failed")
        .map(runInboxItem),
    },
    work: {
      cycles: scopedWorkCycles.map(workScopeChip),
      modules: scopedWorkModules.map(workScopeChip),
      progress: workProgress,
    },
    cards: cards.sort(compareCards),
  };
}

function queueCard({
  item,
  claims,
  approvals,
  humanRequests,
  runs,
  runState,
  stack,
  now,
}) {
  const openApprovals = approvals.filter(isOpenApproval);
  const openHumanRequests = humanRequests.filter(isOpenHumanRequest);
  const staleClaims = claims.filter((claim) => claim.stale === true);
  const cardStack = stackCardSummary(stack);
  const status = cardStatus({
    item,
    runState,
    openApprovals,
    openHumanRequests,
    staleClaims,
    stack: cardStack,
  });
  return {
    id: `queue:${item.id}`,
    kind: "queue-item",
    status,
    title: `${item.repo ?? "unknown"}#${item.pullRequestId ?? "unknown"}`,
    repo: item.repo ?? null,
    pullRequestId: item.pullRequestId ?? null,
    targetBranch: item.targetBranch ?? null,
    laneKey: `${item.repo ?? "unknown"}:${item.targetBranch ?? ""}`,
    ownerAgentId: item.ownerAgentId ?? null,
    priority: numberOrZero(item.priority),
    queueState: item.queueState ?? null,
    runState,
    stack: cardStack,
    claims: claims.map(claimChip),
    approvals: openApprovals.map(approvalInboxItem),
    humanRequests: openHumanRequests.map(humanRequestInboxItem),
    runs: runs.map(runChip),
    links: queueCardLinks(item),
    nextActions: nextActions({
      item,
      runState,
      openApprovals,
      openHumanRequests,
      staleClaims,
      stack: cardStack,
    }),
    updatedAt: item.updatedAt ?? item.createdAt ?? now,
  };
}

function runCard({ run, approvals, humanRequests, runState, now }) {
  const openApprovals = approvals.filter(isOpenApproval);
  const openHumanRequests = humanRequests.filter(isOpenHumanRequest);
  return {
    id: `run:${run.id}`,
    kind: "run",
    status: runState?.state ?? normalizeStatus(run.status),
    title: run.id,
    repo: run.repo ?? null,
    pullRequestId: run.pullRequestId ?? null,
    targetBranch: run.targetBranch ?? null,
    ownerAgentId: run.ownerKind === "agent" ? (run.ownerId ?? null) : null,
    priority: 0,
    queueState: null,
    runState,
    claims: [],
    approvals: openApprovals.map(approvalInboxItem),
    humanRequests: openHumanRequests.map(humanRequestInboxItem),
    runs: [runChip(run)],
    nextActions: nextActions({
      runState,
      openApprovals,
      openHumanRequests,
      staleClaims: [],
    }),
    updatedAt: run.updatedAt ?? run.createdAt ?? now,
  };
}

function workItemCard({ item, claims, now }) {
  const staleClaims = claims.filter((claim) => claim.stale === true);
  const status = workItemStatus(item, staleClaims);
  return {
    id: `work-item:${item.id}`,
    kind: "work-item",
    status,
    title: item.title ?? item.id,
    repo: item.repo ?? null,
    pullRequestId: item.pullRequestId ?? null,
    targetBranch: item.targetBranch ?? null,
    laneKey: `${item.repo ?? "unknown"}:${item.targetBranch ?? ""}`,
    ownerAgentId: item.ownerAgentId ?? null,
    priority: numberOrZero(item.priority),
    queueState: null,
    runState: null,
    workItem: {
      id: item.id,
      kind: item.kind ?? null,
      state: item.state ?? null,
      taskId: item.taskId ?? null,
      issueId: item.issueId ?? null,
      pullRequestId: item.pullRequestId ?? null,
      cycleId: item.cycleId ?? null,
      moduleId: item.moduleId ?? null,
      sourceUrl: item.sourceUrl ?? null,
      labels: arrayValue(item.labels),
      paths: arrayValue(item.paths),
      packages: arrayValue(item.packages),
    },
    claims: claims.map(claimChip),
    approvals: [],
    humanRequests: [],
    runs: [],
    nextActions: nextActionsForWorkItem(item, staleClaims),
    updatedAt: item.updatedAt ?? item.createdAt ?? now,
  };
}

function workScopeChip(scope = {}) {
  return {
    id: scope.id,
    repo: scope.repo ?? null,
    state: scope.state ?? null,
    title: scope.title ?? scope.id ?? null,
    ownerAgentId: scope.ownerAgentId ?? null,
    updatedAt: scope.updatedAt ?? scope.createdAt ?? null,
  };
}

function cardStatus({
  item,
  runState,
  openApprovals,
  openHumanRequests,
  staleClaims,
  stack,
}) {
  if (openApprovals.length > 0 || openHumanRequests.length > 0)
    return "needs-human";
  if (
    staleClaims.length > 0 ||
    runState?.state === "stale" ||
    runState?.unhealthy
  )
    return "needs-triage";
  if (runState?.state === "failed" || item?.queueState === "integration_failed")
    return "failed";
  if (
    runState?.state === "running" ||
    item?.queueState === "running" ||
    item?.queueState === "building_integration"
  )
    return "running";
  if (
    stack?.state === "missing_dependency" ||
    stack?.state === "broken_dependency" ||
    stack?.state === "cycle"
  )
    return "blocked";
  if (stack?.stackBlocked === true) return "waiting";
  if (item?.queueState === "ready" || item?.queueState === "queued")
    return "ready";
  if (
    String(item?.queueState ?? "").startsWith("blocked") ||
    item?.queueState === "quarantined"
  )
    return "blocked";
  return runState?.state ?? item?.queueState ?? "unknown";
}

function workItemStatus(item, staleClaims) {
  if (staleClaims.length > 0) return "needs-triage";
  const state = normalizeStatus(item?.state);
  if (state === "needs_human_review") return "needs-human";
  if (state === "blocked") return "blocked";
  if (state === "claimed" || state === "in_progress") return "running";
  if (state === "ready") return "ready";
  if (state === "done") return "done";
  if (state === "cancelled") return "cancelled";
  return "waiting";
}

function nextActions({
  item,
  runState,
  openApprovals,
  openHumanRequests,
  staleClaims,
  stack,
}) {
  const actions = [];
  if (openApprovals.length > 0) actions.push("decide_approval");
  if (openHumanRequests.length > 0) actions.push("answer_human_request");
  if (
    staleClaims.length > 0 ||
    runState?.state === "stale" ||
    runState?.unhealthy
  )
    actions.push("recover_or_release_stale_work");
  if (item && item.hasExecutionPlan === false) actions.push("add_agent_plan");
  if (stack?.nextActions)
    actions.push(...stack.nextActions.filter((action) => action !== "none"));
  if (
    (item?.queueState === "ready" || item?.queueState === "queued") &&
    stack?.stackBlocked !== true
  )
    actions.push("claim_or_merge_queue_lane");
  if (
    String(item?.queueState ?? "").startsWith("blocked") ||
    item?.queueState === "quarantined"
  )
    actions.push("resolve_policy_blocker");
  if (runState?.state === "running") actions.push("watch_run");
  if (actions.length === 0) actions.push("inspect");
  return [...new Set(actions)];
}

function nextActionsForWorkItem(item, staleClaims) {
  if (staleClaims.length > 0) return ["recover_or_release_stale_work"];
  const state = normalizeStatus(item?.state);
  if (state === "needs_human_review") return ["answer_human_request"];
  if (state === "blocked") return ["resolve_policy_blocker"];
  if (state === "ready") return ["claim_work_item"];
  if (state === "claimed" || state === "in_progress")
    return ["continue_work_item"];
  if (state === "merge_queue") return ["claim_or_merge_queue_lane"];
  return ["inspect_work_item"];
}

function stackCardSummary(stack) {
  if (!stack || stack.state === "independent") return null;
  return {
    state: stack.state,
    stackBlocked: stack.stackBlocked,
    dependencies: stack.dependencies,
    dependents: stack.dependents,
    blockingDependencies: stack.blockingDependencies,
    requiredActions: stack.requiredActions,
    nextActions: stack.nextActions,
  };
}

function claimsForQueueItem(item, activeClaims, staleClaims, nowMs) {
  return [...activeClaims, ...staleClaims]
    .filter((claim) => claim.repo === item.repo)
    .filter((claim) => {
      const itemPaths = new Set([
        ...arrayValue(item.affectedPaths),
        ...arrayValue(item.changedFiles),
      ]);
      const itemPackages = new Set(arrayValue(item.affectedPackages));
      if (
        itemPaths.size === 0 &&
        itemPackages.size === 0 &&
        claim.ownerAgentId &&
        item.ownerAgentId &&
        claim.ownerAgentId === item.ownerAgentId
      ) {
        return true;
      }
      if (claim.resourceKind === "path") {
        const claimPaths = new Set(
          [claim.resourceId, ...arrayValue(claim.paths)].filter(Boolean),
        );
        return intersects(itemPaths, claimPaths);
      }
      if (claim.resourceKind === "package") {
        return itemPackages.has(claim.resourceId);
      }
      return false;
    })
    .map((claim) => ({
      ...claim,
      stale: isExpired(claim.expiresAt, nowMs),
    }));
}

function claimsForWorkItem(item, activeClaims, staleClaims, nowMs) {
  return [...activeClaims, ...staleClaims]
    .filter((claim) => claim.repo === item.repo)
    .filter((claim) => {
      if (claim.taskId && item.taskId && claim.taskId === item.taskId)
        return true;
      const itemPaths = new Set(arrayValue(item.paths));
      const itemPackages = new Set(arrayValue(item.packages));
      if (claim.resourceKind === "path") {
        const claimPaths = new Set(
          [claim.resourceId, ...arrayValue(claim.paths)].filter(Boolean),
        );
        return intersects(itemPaths, claimPaths);
      }
      if (claim.resourceKind === "package") {
        return itemPackages.has(claim.resourceId);
      }
      return false;
    })
    .map((claim) => ({
      ...claim,
      stale: isExpired(claim.expiresAt, nowMs),
    }));
}

function readinessSummary(readiness) {
  if (!readiness) return null;
  const runtime =
    readiness.checks?.find((check) => check.name === "runtime_preflight") ??
    null;
  const workerLease =
    readiness.checks?.find((check) => check.name === "worker_lease") ?? null;
  return {
    ok: readiness.ok === true,
    checkedAt: readiness.checkedAt ?? null,
    deploymentMode:
      readiness.configuration?.deploymentMode ?? runtime?.mode ?? null,
    worker: readiness.configuration?.worker ?? null,
    workerLease: workerLease
      ? {
          ok: workerLease.ok === true,
          ownerId: workerLease.ownerId ?? null,
          status: workerLease.status ?? null,
          expiresAt: workerLease.expiresAt ?? null,
        }
      : null,
  };
}

export function buildWorkflowOperations({
  readiness = null,
  mergeTrain = null,
  counts = {},
  filters = {},
} = {}) {
  const readinessView = isRawReadiness(readiness)
    ? readinessSummary(readiness)
    : readiness;
  const mergeQueue = mergeQueueOperations(mergeTrain);
  const controlPlane = controlPlaneOperations(readinessView);
  const runner = runnerOperations(mergeQueue);
  const actions = actionsOperations({ mergeQueue, runner });
  const status = operationsStatus({ controlPlane, mergeQueue, counts });
  const nextActions = operationNextActions({
    controlPlane,
    mergeQueue,
    runner,
  });

  return {
    status,
    filters,
    controlPlane,
    actions,
    runner,
    mergeQueue,
    nextActions,
    links: {
      workflows: "/api/workflows",
      mergeTrain: "/api/merge-train",
      mergeQueue: "/api/merge-queue",
      queueRunOnce: "/api/queue/run-once",
      releaseReadiness: "/api/release-readiness",
      productionReadiness: "/api/production-readiness",
      repositoryProtection: "/api/repository-protection",
    },
  };
}

function controlPlaneOperations(readiness) {
  if (!readiness) {
    return {
      status: "not_included",
      ok: null,
      deploymentMode: null,
      worker: null,
      workerLease: null,
    };
  }
  return {
    status: readiness.ok === true ? "ready" : "blocked",
    ok: readiness.ok === true,
    deploymentMode: readiness.deploymentMode ?? null,
    worker: readiness.worker ?? null,
    workerLease: readiness.workerLease ?? null,
  };
}

function isRawReadiness(readiness) {
  return Boolean(
    readiness && (Array.isArray(readiness.checks) || readiness.configuration),
  );
}

function mergeQueueOperations(mergeTrain) {
  if (!mergeTrain) {
    return {
      status: "not_included",
      selectedTrainId: null,
      laneKey: null,
      repo: null,
      targetBranch: null,
      mode: null,
      selectedItemIds: [],
      selectedPullRequests: [],
      liveExecutionReady: false,
      dryRunReviewReady: false,
      executionReady: false,
      blockers: [],
      warnings: [],
      requiredActions: ["include_merge_train_plan"],
      nextAction: "inspect_merge_train",
    };
  }

  const selectedTrain = mergeTrain.selectedTrain ?? {};
  const preflight = mergeTrain.preflight ?? {};
  const blockers = unique([
    ...arrayValue(selectedTrain.blockers),
    ...arrayValue(preflight.blockers),
  ]);
  const requiredActions = unique(
    [...arrayValue(preflight.requiredActions), selectedTrain.nextAction].filter(
      Boolean,
    ),
  );

  return {
    status: preflight.status ?? mergeTrain.status ?? "unknown",
    selectedTrainId: selectedTrain.id ?? null,
    laneKey: selectedTrain.laneKey ?? null,
    repo: selectedTrain.repo ?? mergeTrain.filters?.repo ?? null,
    targetBranch:
      selectedTrain.targetBranch ?? mergeTrain.filters?.targetBranch ?? null,
    mode: selectedTrain.mode ?? null,
    selectedItemIds: arrayValue(selectedTrain.itemIds),
    selectedPullRequests: arrayValue(selectedTrain.pullRequests)
      .slice(0, 10)
      .map((pullRequest) => ({
        repo: pullRequest.repo ?? null,
        pullRequestId: pullRequest.pullRequestId ?? null,
        ownerAgentId: pullRequest.ownerAgentId ?? null,
        integrationBranch: pullRequest.integrationBranch ?? null,
        requiredChecks: arrayValue(pullRequest.requiredChecks),
      })),
    liveExecutionReady: preflight.liveExecutionReady === true,
    dryRunReviewReady: preflight.dryRunReviewReady === true,
    executionReady: selectedTrain.executionReady === true,
    blockers,
    warnings: arrayValue(preflight.warnings),
    requiredActions: requiredActions.length
      ? requiredActions
      : ["inspect_merge_train"],
    nextAction:
      selectedTrain.nextAction ??
      mergeTrain.queue?.nextAction ??
      "inspect_merge_train",
  };
}

function actionsOperations({ mergeQueue, runner }) {
  return {
    status: actionsStatus({ mergeQueue, runner }),
    provider: "forgejo_actions",
    ciAuthority: "required_checks",
    trustedWorkflow: "runner-smoke.yml",
    liveExecutionRequires: [
      "protected_target_branch",
      "fresh_required_checks",
      "matching_pr_head_sha",
      "isolated_trusted_runner_pool",
    ],
  };
}

function runnerOperations(mergeQueue) {
  if (mergeQueue.status === "not_included" || mergeQueue.status === "empty") {
    return {
      status: "not_evaluated",
      trustedSmokeWorkflowRequired: true,
      isolatedRunnerRequired: true,
      privateEvidenceRequired: true,
    };
  }
  if (mergeQueue.liveExecutionReady === true) {
    return {
      status: "private_evidence_required",
      trustedSmokeWorkflowRequired: true,
      isolatedRunnerRequired: true,
      privateEvidenceRequired: true,
      requiredActions: ["attach_runner_isolation_evidence"],
    };
  }
  if (mergeQueue.dryRunReviewReady === true) {
    return {
      status: "dry_run_only",
      trustedSmokeWorkflowRequired: true,
      isolatedRunnerRequired: true,
      privateEvidenceRequired: true,
      requiredActions: ["review_runner_smoke_before_live_cutover"],
    };
  }
  return {
    status: "blocked",
    trustedSmokeWorkflowRequired: true,
    isolatedRunnerRequired: true,
    privateEvidenceRequired: true,
  };
}

function actionsStatus({ mergeQueue, runner }) {
  if (
    mergeQueue.liveExecutionReady === true &&
    runner.status === "private_evidence_required"
  ) {
    return "runner_evidence_required";
  }
  if (mergeQueue.dryRunReviewReady === true) return "dry_run_ready";
  if (mergeQueue.status === "empty") return "idle";
  if (mergeQueue.status === "not_included") return "not_evaluated";
  return "blocked";
}

function operationsStatus({ controlPlane, mergeQueue, counts }) {
  if (controlPlane.status === "blocked") return "control_plane_blocked";
  if (mergeQueue.liveExecutionReady === true) return "live_merge_ready";
  if (mergeQueue.dryRunReviewReady === true) return "dry_run_ready";
  if (mergeQueue.status === "empty" || counts.cards === 0) return "idle";
  if (mergeQueue.status === "not_included") return "needs_merge_train_context";
  if (mergeQueue.blockers.length > 0) return "blocked";
  return mergeQueue.status ?? "unknown";
}

function operationNextActions({ controlPlane, mergeQueue, runner }) {
  const actions = [];
  if (controlPlane.status === "blocked") actions.push("fix_steward_readiness");
  actions.push(...arrayValue(mergeQueue.requiredActions));
  if (mergeQueue.nextAction) actions.push(mergeQueue.nextAction);
  actions.push(...arrayValue(runner.requiredActions));
  const uniqueActions = unique(actions.filter(Boolean));
  return uniqueActions.length ? uniqueActions : ["inspect_workflow"];
}

function approvalInboxItem(approval) {
  return {
    id: approval.id,
    runId: approval.runId ?? null,
    queueItemId: approval.queueItemId ?? null,
    nodeId: approval.nodeId ?? null,
    status: approval.status ?? null,
    requestedBy: approval.requestedBy ?? null,
    requestedAt: approval.requestedAt ?? approval.createdAt ?? null,
  };
}

function humanRequestInboxItem(request) {
  return {
    id: request.id,
    runId: request.runId ?? null,
    queueItemId: request.queueItemId ?? null,
    status: request.status ?? null,
    requestedBy: request.requestedBy ?? null,
    requestedAt: request.requestedAt ?? request.createdAt ?? null,
    prompt: request.prompt ?? request.title ?? null,
  };
}

function claimInboxItem(claim) {
  return {
    id: claim.id,
    repo: claim.repo,
    resourceKind: claim.resourceKind,
    resourceId: claim.resourceId,
    ownerAgentId: claim.ownerAgentId,
    expiresAt: claim.expiresAt ?? null,
  };
}

function runInboxItem(run) {
  return {
    id: run.id,
    queueItemId: run.queueItemId ?? null,
    repo: run.repo ?? null,
    pullRequestId: run.pullRequestId ?? null,
    ownerId: run.ownerId ?? null,
    ownerKind: run.ownerKind ?? null,
    lastError: run.lastError ?? null,
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
  };
}

function claimChip(claim) {
  return {
    id: claim.id,
    ownerAgentId: claim.ownerAgentId,
    resourceKind: claim.resourceKind,
    resourceId: claim.resourceId,
    status: claim.stale ? "stale" : (claim.status ?? "unknown"),
    expiresAt: claim.expiresAt ?? null,
  };
}

function runChip(run) {
  return {
    id: run.id,
    status: run.status ?? null,
    ownerKind: run.ownerKind ?? null,
    ownerId: run.ownerId ?? null,
  };
}

function queueCardLinks(item = {}) {
  const itemId = queueItemIdentity(item);
  const ownerAgentId = stringOrNull(item.ownerAgentId);
  const scopedQuery = {
    repo: item.repo,
    targetBranch: item.targetBranch,
  };
  return {
    queueItem: pathWithQuery("/api/queue/item", { id: itemId }),
    queueItemActionPlan: pathWithQuery("/api/queue/item/action-plan", {
      id: itemId,
      ownerAgentId,
    }),
    runState: pathWithQuery("/api/queue/item/run-state", { id: itemId }),
    mergeQueue: pathWithQuery("/api/merge-queue", { repo: item.repo }),
    mergeTrain: pathWithQuery("/api/merge-train", scopedQuery),
    ...(ownerAgentId
      ? {
          agentCockpit: pathWithQuery(
            `/api/agents/${encodeURIComponent(ownerAgentId)}/cockpit`,
            scopedQuery,
          ),
          agentInbox: pathWithQuery(
            `/api/agents/${encodeURIComponent(ownerAgentId)}/inbox`,
            scopedQuery,
          ),
        }
      : {}),
  };
}

function compareCards(left, right) {
  return (
    statusRank(left.status) - statusRank(right.status) ||
    right.priority - left.priority ||
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function statusRank(status) {
  return (
    {
      "needs-human": 0,
      "needs-triage": 1,
      failed: 2,
      blocked: 3,
      running: 4,
      ready: 5,
    }[status] ?? 9
  );
}

function isOpenApproval(approval) {
  return OPEN_APPROVAL_STATUSES.has(normalizeStatus(approval.status));
}

function isOpenHumanRequest(request) {
  return OPEN_HUMAN_REQUEST_STATUSES.has(normalizeStatus(request.status));
}

function isExpired(expiresAt, nowMs) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= effectiveNowMs;
}

function groupBy(items, keyForItem) {
  const groups = new Map();
  for (const item of items) {
    const key = keyForItem(item);
    if (!key) continue;
    const stringKey = String(key);
    groups.set(stringKey, [...(groups.get(stringKey) ?? []), item]);
  }
  return groups;
}

function queueItemIdentity(item) {
  if (item.id) return String(item.id);
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  return "";
}

function normalizeWorkflowFilters({ repo, targetBranch, ownerAgentId } = {}) {
  return {
    repo: stringOrNull(repo),
    targetBranch: stringOrNull(targetBranch),
    ownerAgentId: stringOrNull(ownerAgentId),
  };
}

function hasWorkflowFilters(filters = {}) {
  return Boolean(filters.repo || filters.targetBranch || filters.ownerAgentId);
}

function matchesWorkflowScope(item = {}, filters = {}) {
  if (!hasWorkflowFilters(filters)) return true;
  if (filters.repo && item.repo !== filters.repo) return false;
  if (filters.targetBranch && item.targetBranch !== filters.targetBranch)
    return false;
  if (filters.ownerAgentId && item.ownerAgentId !== filters.ownerAgentId)
    return false;
  return true;
}

function matchesRunScope(run = {}, filters = {}, scopedQueueIds = new Set()) {
  if (!hasWorkflowFilters(filters)) return true;
  if (run.queueItemId && scopedQueueIds.has(String(run.queueItemId)))
    return true;
  if (filters.repo && run.repo !== filters.repo) return false;
  if (filters.targetBranch && run.targetBranch !== filters.targetBranch)
    return false;
  if (
    filters.ownerAgentId &&
    !(run.ownerKind === "agent" && run.ownerId === filters.ownerAgentId)
  )
    return false;
  return true;
}

function matchesLinkedScope(
  item = {},
  { scopedQueueIds = new Set(), scopedRunIds = new Set(), filters = {} } = {},
) {
  if (!hasWorkflowFilters(filters)) return true;
  if (item.queueItemId && scopedQueueIds.has(String(item.queueItemId)))
    return true;
  if (item.runId && scopedRunIds.has(String(item.runId))) return true;
  return false;
}

function matchesClaimScope(claim = {}, filters = {}) {
  if (!hasWorkflowFilters(filters)) return true;
  if (filters.repo && claim.repo !== filters.repo) return false;
  if (filters.ownerAgentId && claim.ownerAgentId !== filters.ownerAgentId)
    return false;
  return true;
}

function uniqueById(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = item?.id ?? JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function unique(items) {
  return [...new Set(items.filter((item) => item != null && item !== ""))];
}

function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function pathWithQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function stringOrNull(value) {
  if (value == null) return null;
  const string = String(value).trim();
  return string || null;
}
