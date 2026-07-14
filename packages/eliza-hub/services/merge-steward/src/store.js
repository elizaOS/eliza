import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TERMINAL_QUEUE_STATES = new Set([
  "closed",
  "merged",
  "failed",
  "cancelled",
]);
const ACTIVE_QUEUE_STATES = new Set(["running", "building_integration"]);
const REPO_POLICY_QUEUE_MODES = new Set(["disabled", "serialized", "batched"]);
const REGISTERED_AGENT_STATUSES = new Set(["active", "disabled", "revoked"]);
const WORK_ITEM_KINDS = new Set([
  "task",
  "issue",
  "pull_request",
  "branch",
  "path",
  "package",
  "release",
  "incident",
]);
const WORK_ITEM_STATES = new Set([
  "backlog",
  "ready",
  "claimed",
  "in_progress",
  "needs_human_review",
  "merge_queue",
  "blocked",
  "done",
  "cancelled",
]);
const TERMINAL_WORK_ITEM_STATES = new Set(["done", "cancelled"]);
const WORK_CYCLE_STATES = new Set([
  "planned",
  "active",
  "completed",
  "cancelled",
]);
const WORK_MODULE_STATES = new Set(["active", "archived"]);
const WORK_VIEW_KINDS = new Set([
  "list",
  "kanban",
  "dashboard",
  "calendar",
  "timeline",
  "spreadsheet",
  "search",
]);
const WORK_VIEW_STATES = new Set(["active", "archived"]);
const WORK_PAGE_KINDS = new Set([
  "agent_plan",
  "runbook",
  "release_note",
  "decision",
  "spec",
  "note",
]);
const WORK_PAGE_STATES = new Set(["active", "archived"]);

export class InMemoryQueueStore {
  #items = new Map();
  #approvals = new Map();
  #humanRequests = new Map();
  #workItems = new Map();
  #workCycles = new Map();
  #workModules = new Map();
  #workViews = new Map();
  #workPages = new Map();
  #runs = new Map();
  #runNodes = new Map();
  #attempts = new Map();
  #runEvents = [];
  #signals = [];
  #agentClaims = new Map();
  #workerLeases = new Map();
  #repoPolicies = new Map();
  #registeredAgents = new Map();
  #events = [];

  async getQueueItem(id) {
    return this.#items.get(String(id)) ?? null;
  }

  async listQueueItems() {
    return [...this.#items.values()].sort((left, right) => {
      return String(left.pullRequestId ?? left.id).localeCompare(
        String(right.pullRequestId ?? right.id),
        undefined,
        {
          numeric: true,
        },
      );
    });
  }

  async findQueueItemByHeadSha(headSha) {
    if (!headSha) return null;
    return (
      [...this.#items.values()].find((item) => item.headSha === headSha) ?? null
    );
  }

  async upsertQueueItem(item) {
    const id = queueItemId(item);
    const existing = this.#items.get(id);
    const now = new Date().toISOString();
    const next = {
      ...existing,
      ...item,
      id,
      createdAt: existing?.createdAt ?? item.createdAt ?? now,
      updatedAt: item.updatedAt ?? now,
    };
    this.#items.set(id, next);
    return next;
  }

  async claimNextQueueItem(
    candidates = [],
    { workerId = "merge-steward", now = new Date().toISOString() } = {},
  ) {
    let skippedBusy = false;
    let skippedTerminal = false;
    let skippedUnavailable = false;
    const runningScopes = new Set(
      [...this.#items.values()]
        .filter((item) => ACTIVE_QUEUE_STATES.has(item.queueState))
        .map(queueItemScopeKey),
    );

    for (const candidate of candidates) {
      const id = queueItemId(candidate);
      const existing = this.#items.get(id) ?? {};
      const effective = { ...existing, ...candidate, id };
      const scope = queueItemScopeKey(effective);

      if (TERMINAL_QUEUE_STATES.has(existing.queueState)) {
        skippedTerminal = true;
        continue;
      }

      if (isFutureAvailableAt(effective.availableAt, now)) {
        skippedUnavailable = true;
        continue;
      }

      if (
        ACTIVE_QUEUE_STATES.has(existing.queueState) ||
        runningScopes.has(scope)
      ) {
        skippedBusy = true;
        continue;
      }

      const attemptCount = Number.isFinite(existing.attemptCount)
        ? existing.attemptCount + 1
        : 1;
      const claimed = {
        ...effective,
        queueState: "running",
        claimedBy: workerId,
        claimedAt: now,
        attemptCount,
        lastError: null,
        createdAt: existing.createdAt ?? candidate.createdAt ?? now,
        updatedAt: now,
      };
      this.#items.set(id, claimed);
      return {
        claimed: true,
        item: claimed,
      };
    }

    return {
      claimed: false,
      reason: skippedBusy
        ? "repo_or_target_busy"
        : skippedUnavailable
          ? "no_available_items"
          : skippedTerminal
            ? "no_claimable_items"
            : "no_ready_items",
    };
  }

  async claimQueueItems(
    candidates = [],
    { workerId = "merge-steward", now = new Date().toISOString() } = {},
  ) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { claimed: false, reason: "no_ready_items" };
    }

    let skippedTerminal = false;
    let skippedUnavailable = false;
    const candidateIds = new Set(
      candidates.map((candidate) => queueItemId(candidate)),
    );
    const runningScopes = new Set(
      [...this.#items.values()]
        .filter(
          (item) =>
            ACTIVE_QUEUE_STATES.has(item.queueState) &&
            !candidateIds.has(item.id),
        )
        .map(queueItemScopeKey),
    );
    const effectiveItems = [];
    let scope = null;

    for (const candidate of candidates) {
      const id = queueItemId(candidate);
      const existing = this.#items.get(id) ?? {};
      const effective = { ...existing, ...candidate, id };
      const nextScope = queueItemScopeKey(effective);

      if (TERMINAL_QUEUE_STATES.has(existing.queueState)) {
        skippedTerminal = true;
        continue;
      }

      if (isFutureAvailableAt(effective.availableAt, now)) {
        skippedUnavailable = true;
        continue;
      }

      if (ACTIVE_QUEUE_STATES.has(existing.queueState)) {
        return { claimed: false, reason: "repo_or_target_busy" };
      }

      if (scope && nextScope !== scope) {
        return { claimed: false, reason: "different_queue_lane" };
      }
      scope = nextScope;
      effectiveItems.push({ existing, candidate, effective });
    }

    if (effectiveItems.length !== candidates.length) {
      return {
        claimed: false,
        reason: skippedUnavailable
          ? "no_available_items"
          : skippedTerminal
            ? "no_claimable_items"
            : "no_ready_items",
      };
    }

    if (runningScopes.has(scope)) {
      return { claimed: false, reason: "repo_or_target_busy" };
    }

    const items = effectiveItems.map(({ existing, candidate, effective }) => {
      const attemptCount = Number.isFinite(existing.attemptCount)
        ? existing.attemptCount + 1
        : 1;
      return {
        ...effective,
        queueState: "running",
        claimedBy: workerId,
        claimedAt: now,
        attemptCount,
        lastError: null,
        createdAt: existing.createdAt ?? candidate.createdAt ?? now,
        updatedAt: now,
      };
    });

    for (const item of items) {
      this.#items.set(item.id, item);
    }

    return {
      claimed: true,
      item: items[0],
      items,
    };
  }

  async finishQueueItem(
    id,
    {
      state = "merged",
      now = new Date().toISOString(),
      activeRunId,
      claimedBy,
      queueState,
    } = {},
  ) {
    const existing = this.#items.get(String(id));
    if (!existing) return null;
    if (
      !queueItemFenceMatches(existing, { activeRunId, claimedBy, queueState })
    )
      return null;

    const next = {
      ...existing,
      queueState: state,
      finishedAt: now,
      updatedAt: now,
      lastError: null,
    };
    this.#items.set(String(id), next);
    return next;
  }

  async failQueueItem(
    id,
    {
      error,
      now = new Date().toISOString(),
      activeRunId,
      claimedBy,
      queueState,
    } = {},
  ) {
    const existing = this.#items.get(String(id));
    if (!existing) return null;
    if (
      !queueItemFenceMatches(existing, { activeRunId, claimedBy, queueState })
    )
      return null;

    const next = {
      ...existing,
      queueState: "failed",
      finishedAt: now,
      updatedAt: now,
      lastError:
        error instanceof Error
          ? error.message
          : String(error ?? "queue_item_failed"),
    };
    this.#items.set(String(id), next);
    return next;
  }

  async upsertApproval(approval = {}) {
    const id = approvalId(approval);
    const existing = this.#approvals.get(id);
    const now = new Date().toISOString();
    const iteration = normalizedIteration(
      approval.iteration,
      existing?.iteration ?? 0,
    );
    const next = {
      ...existing,
      ...approval,
      id,
      status: approval.status ?? existing?.status ?? "requested",
      nodeId: approval.nodeId ?? existing?.nodeId ?? "human_approval",
      iteration,
      requestedAt: existing?.requestedAt ?? approval.requestedAt ?? now,
      createdAt: existing?.createdAt ?? approval.createdAt ?? now,
      updatedAt: approval.updatedAt ?? now,
    };
    this.#approvals.set(id, next);
    return next;
  }

  async getApproval(id) {
    return this.#approvals.get(String(id)) ?? null;
  }

  async listApprovals({ status } = {}) {
    return [...this.#approvals.values()]
      .filter((approval) => !status || approval.status === status)
      .sort((left, right) =>
        String(left.requestedAt ?? left.createdAt).localeCompare(
          String(right.requestedAt ?? right.createdAt),
        ),
      );
  }

  async decideApproval(
    id,
    {
      approved,
      decidedBy,
      note,
      decision,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = this.#approvals.get(String(id));
    if (!existing) return null;

    const next = {
      ...existing,
      status: approved === true ? "approved" : "denied",
      decision: {
        ...(existing.decision ?? {}),
        ...(decision ?? {}),
        approved: approved === true,
        note: note ?? decision?.note ?? null,
      },
      decidedBy: decidedBy ?? decision?.decidedBy ?? null,
      decidedAt: now,
      updatedAt: now,
    };
    this.#approvals.set(String(id), next);
    return next;
  }

  async upsertHumanRequest(request = {}) {
    const id = humanRequestId(request);
    const existing = this.#humanRequests.get(id);
    const now = new Date().toISOString();
    const iteration = normalizedIteration(
      request.iteration,
      existing?.iteration ?? 0,
    );
    const next = {
      ...existing,
      ...request,
      id,
      status: request.status ?? existing?.status ?? "requested",
      kind: request.kind ?? existing?.kind ?? "confirm",
      nodeId: request.nodeId ?? existing?.nodeId ?? "human_input",
      iteration,
      requestedAt: existing?.requestedAt ?? request.requestedAt ?? now,
      createdAt: existing?.createdAt ?? request.createdAt ?? now,
      updatedAt: request.updatedAt ?? now,
    };
    this.#humanRequests.set(id, next);
    return next;
  }

  async getHumanRequest(id) {
    return this.#humanRequests.get(String(id)) ?? null;
  }

  async listHumanRequests({ status, runId } = {}) {
    return [...this.#humanRequests.values()]
      .filter((request) => !status || request.status === status)
      .filter((request) => !runId || request.runId === runId)
      .sort((left, right) =>
        String(left.requestedAt ?? left.createdAt).localeCompare(
          String(right.requestedAt ?? right.createdAt),
        ),
      );
  }

  async respondHumanRequest(
    id,
    {
      response,
      respondedBy,
      status = "answered",
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = this.#humanRequests.get(String(id));
    if (!existing) return null;

    const next = {
      ...existing,
      status,
      response: response ?? null,
      respondedBy: respondedBy ?? null,
      respondedAt: now,
      updatedAt: now,
    };
    this.#humanRequests.set(String(id), next);
    return next;
  }

  async upsertWorkItem(
    item = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workItemId(item);
    const existing = this.#workItems.get(id);
    const next = normalizeWorkItem({ ...item, id }, existing, { actorId, now });
    this.#workItems.set(id, next);
    return next;
  }

  async getWorkItem(id) {
    return this.#workItems.get(String(id)) ?? null;
  }

  async listWorkItems({ repo, state, ownerAgentId, kind } = {}) {
    return [...this.#workItems.values()]
      .filter((item) => !repo || item.repo === repo)
      .filter((item) => !state || item.state === state)
      .filter((item) => !ownerAgentId || item.ownerAgentId === ownerAgentId)
      .filter((item) => !kind || item.kind === kind)
      .sort(compareWorkItems);
  }

  async transitionWorkItem(
    id,
    {
      state,
      transitionedBy,
      actorId,
      reason,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = this.#workItems.get(String(id));
    if (!existing) return null;
    if (!WORK_ITEM_STATES.has(state)) {
      throw new TypeError(
        `Work item transition state must be one of ${[...WORK_ITEM_STATES].join(", ")}`,
      );
    }

    const next = normalizeWorkItem(
      {
        ...existing,
        state,
        updatedBy: transitionedBy ?? actorId ?? existing.updatedBy,
        completedAt: TERMINAL_WORK_ITEM_STATES.has(state)
          ? (existing.completedAt ?? now)
          : null,
        metadata: {
          ...(existing.metadata ?? {}),
          transitions: [
            ...arrayValue(existing.metadata?.transitions),
            {
              from: existing.state,
              to: state,
              actorId: transitionedBy ?? actorId ?? null,
              reason: stringOrNull(reason),
              at: now,
            },
          ],
        },
        updatedAt: now,
      },
      existing,
      { actorId: transitionedBy ?? actorId, now },
    );
    this.#workItems.set(String(id), next);
    return next;
  }

  async upsertWorkCycle(
    cycle = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workCycleId(cycle);
    const existing = this.#workCycles.get(id);
    const next = normalizeWorkCycle({ ...cycle, id }, existing, {
      actorId,
      now,
    });
    this.#workCycles.set(id, next);
    return next;
  }

  async getWorkCycle(id) {
    return this.#workCycles.get(String(id)) ?? null;
  }

  async listWorkCycles({ repo, state, ownerAgentId } = {}) {
    return [...this.#workCycles.values()]
      .filter((cycle) => !repo || cycle.repo === repo)
      .filter((cycle) => !state || cycle.state === state)
      .filter((cycle) => !ownerAgentId || cycle.ownerAgentId === ownerAgentId)
      .sort(compareWorkScopes);
  }

  async upsertWorkModule(
    module = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workModuleId(module);
    const existing = this.#workModules.get(id);
    const next = normalizeWorkModule({ ...module, id }, existing, {
      actorId,
      now,
    });
    this.#workModules.set(id, next);
    return next;
  }

  async getWorkModule(id) {
    return this.#workModules.get(String(id)) ?? null;
  }

  async listWorkModules({ repo, state, ownerAgentId } = {}) {
    return [...this.#workModules.values()]
      .filter((module) => !repo || module.repo === repo)
      .filter((module) => !state || module.state === state)
      .filter((module) => !ownerAgentId || module.ownerAgentId === ownerAgentId)
      .sort(compareWorkScopes);
  }

  async upsertWorkView(
    view = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workViewId(view);
    const existing = this.#workViews.get(id);
    const next = normalizeWorkView({ ...view, id }, existing, { actorId, now });
    this.#workViews.set(id, next);
    return next;
  }

  async getWorkView(id) {
    return this.#workViews.get(String(id)) ?? null;
  }

  async listWorkViews({ repo, state, ownerAgentId, kind } = {}) {
    return [...this.#workViews.values()]
      .filter((view) => !repo || view.repo === repo)
      .filter((view) => !state || view.state === state)
      .filter((view) => !ownerAgentId || view.ownerAgentId === ownerAgentId)
      .filter((view) => !kind || view.kind === kind)
      .sort(compareWorkScopes);
  }

  async upsertWorkPage(
    page = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workPageId(page);
    const existing = this.#workPages.get(id);
    const next = normalizeWorkPage({ ...page, id }, existing, { actorId, now });
    this.#workPages.set(id, next);
    return next;
  }

  async getWorkPage(id) {
    return this.#workPages.get(String(id)) ?? null;
  }

  async listWorkPages({
    repo,
    state,
    ownerAgentId,
    kind,
    workItemId,
    cycleId,
    moduleId,
    taskId,
    issueId,
    pullRequestId,
  } = {}) {
    return [...this.#workPages.values()]
      .filter((page) => !repo || page.repo === repo)
      .filter((page) => !state || page.state === state)
      .filter((page) => !ownerAgentId || page.ownerAgentId === ownerAgentId)
      .filter((page) => !kind || page.kind === kind)
      .filter((page) => !workItemId || page.workItemId === workItemId)
      .filter((page) => !cycleId || page.cycleId === cycleId)
      .filter((page) => !moduleId || page.moduleId === moduleId)
      .filter((page) => !taskId || page.taskId === taskId)
      .filter((page) => !issueId || page.issueId === issueId)
      .filter(
        (page) =>
          pullRequestId == null ||
          page.pullRequestId === intOrNullValue(pullRequestId),
      )
      .sort(compareWorkScopes);
  }

  async transitionWorkPage(
    id,
    {
      state,
      transitionedBy,
      actorId,
      reason,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = this.#workPages.get(String(id));
    if (!existing) return null;
    if (!WORK_PAGE_STATES.has(state)) {
      throw new TypeError(
        `Work page transition state must be one of ${[...WORK_PAGE_STATES].join(", ")}`,
      );
    }

    const next = normalizeWorkPage(
      {
        ...existing,
        state,
        updatedBy: transitionedBy ?? actorId ?? existing.updatedBy,
        metadata: {
          ...(existing.metadata ?? {}),
          transitions: [
            ...arrayValue(existing.metadata?.transitions),
            {
              from: existing.state,
              to: state,
              actorId: transitionedBy ?? actorId ?? null,
              reason: stringOrNull(reason),
              at: now,
            },
          ],
        },
        updatedAt: now,
      },
      existing,
      { actorId: transitionedBy ?? actorId, now },
    );
    this.#workPages.set(String(id), next);
    return next;
  }

  async upsertRun(run = {}) {
    const id = runId(run);
    const existing = this.#runs.get(id);
    const now = new Date().toISOString();
    const next = {
      ...existing,
      ...run,
      id,
      status: run.status ?? existing?.status ?? "running",
      createdAt: existing?.createdAt ?? run.createdAt ?? now,
      updatedAt: run.updatedAt ?? now,
    };
    this.#runs.set(id, next);
    return next;
  }

  async getRun(id) {
    return this.#runs.get(String(id)) ?? null;
  }

  async listRuns({ status, queueItemId } = {}) {
    return [...this.#runs.values()]
      .filter((run) => !status || run.status === status)
      .filter((run) => !queueItemId || run.queueItemId === queueItemId)
      .sort((left, right) =>
        String(right.updatedAt ?? right.createdAt).localeCompare(
          String(left.updatedAt ?? left.createdAt),
        ),
      );
  }

  async upsertRunNode(node = {}) {
    const id = runNodeId(node);
    const existing = this.#runNodes.get(id);
    const now = new Date().toISOString();
    const iteration = normalizedIteration(
      node.iteration,
      existing?.iteration ?? 0,
    );
    const next = {
      ...existing,
      ...node,
      id,
      status: node.status ?? existing?.status ?? "pending",
      iteration,
      createdAt: existing?.createdAt ?? node.createdAt ?? now,
      updatedAt: node.updatedAt ?? now,
    };
    this.#runNodes.set(id, next);
    return next;
  }

  async listRunNodes(runId) {
    const runIdFilter = runId == null ? null : String(runId);
    return [...this.#runNodes.values()]
      .filter((node) => runIdFilter == null || node.runId === runIdFilter)
      .sort((left, right) => {
        return (
          String(left.nodeId).localeCompare(String(right.nodeId)) ||
          Number(left.iteration ?? 0) - Number(right.iteration ?? 0)
        );
      });
  }

  async startAttempt(attempt = {}) {
    const now = new Date().toISOString();
    const attemptNumber =
      attempt.attempt == null
        ? this.#nextAttemptNumber(attempt)
        : positiveAttemptNumber(attempt.attempt);
    const id = attemptId({ ...attempt, attempt: attemptNumber });
    const existing = this.#attempts.get(id);
    const next = {
      ...existing,
      ...attempt,
      id,
      attempt: attemptNumber,
      status: attempt.status ?? existing?.status ?? "running",
      ownerId: attempt.ownerId ?? existing?.ownerId ?? null,
      startedAt: existing?.startedAt ?? attempt.startedAt ?? now,
      heartbeatAt: attempt.heartbeatAt ?? existing?.heartbeatAt ?? now,
      createdAt: existing?.createdAt ?? attempt.createdAt ?? now,
      updatedAt: attempt.updatedAt ?? now,
    };
    this.#attempts.set(id, next);
    return next;
  }

  async getAttempt(id) {
    return this.#attempts.get(String(id)) ?? null;
  }

  async listAttempts({ runId, nodeId, status, ownerId } = {}) {
    return [...this.#attempts.values()]
      .filter((attempt) => !runId || attempt.runId === runId)
      .filter((attempt) => !nodeId || attempt.nodeId === nodeId)
      .filter((attempt) => !status || attempt.status === status)
      .filter((attempt) => !ownerId || attempt.ownerId === ownerId)
      .sort((left, right) => {
        return (
          String(left.runId).localeCompare(String(right.runId)) ||
          String(left.nodeId).localeCompare(String(right.nodeId)) ||
          Number(left.attempt ?? 0) - Number(right.attempt ?? 0)
        );
      });
  }

  async heartbeatAttempt(id, { ownerId, now = new Date().toISOString() } = {}) {
    const existing = this.#attempts.get(String(id));
    if (!existing || !attemptOwnerMatches(existing, ownerId)) return null;

    const next = {
      ...existing,
      status: existing.status === "recovering" ? "running" : existing.status,
      ownerId: ownerId ?? existing.ownerId ?? null,
      heartbeatAt: now,
      updatedAt: now,
    };
    this.#attempts.set(String(id), next);
    return next;
  }

  async finishAttempt(id, { output, now = new Date().toISOString() } = {}) {
    const existing = this.#attempts.get(String(id));
    if (!existing) return null;

    const next = {
      ...existing,
      status: "succeeded",
      output: output ?? existing.output ?? null,
      lastError: null,
      finishedAt: now,
      updatedAt: now,
    };
    this.#attempts.set(String(id), next);
    return next;
  }

  async failAttempt(
    id,
    { error, output, retryAfterMs, now = new Date().toISOString() } = {},
  ) {
    const existing = this.#attempts.get(String(id));
    if (!existing) return null;

    const next = {
      ...existing,
      status: "failed",
      output: output ?? existing.output ?? null,
      lastError: serializeAttemptError(error),
      availableAt: Number.isFinite(retryAfterMs)
        ? new Date(Date.parse(now) + retryAfterMs).toISOString()
        : (existing.availableAt ?? null),
      finishedAt: now,
      updatedAt: now,
    };
    this.#attempts.set(String(id), next);
    return next;
  }

  async cancelAttempt(
    id,
    { reason, cancelledBy, now = new Date().toISOString() } = {},
  ) {
    const existing = this.#attempts.get(String(id));
    if (!existing) return null;

    const next = {
      ...existing,
      status: "cancelled",
      cancelReason: reason ?? null,
      cancelledBy: cancelledBy ?? null,
      finishedAt: now,
      updatedAt: now,
    };
    this.#attempts.set(String(id), next);
    return next;
  }

  async claimStaleAttempt({
    workerId = "merge-steward",
    now = new Date().toISOString(),
    staleAfterMs = 30 * 1000,
  } = {}) {
    const stale = [...this.#attempts.values()]
      .filter(
        (attempt) =>
          attempt.status === "running" || attempt.status === "recovering",
      )
      .filter((attempt) => isAttemptStale(attempt, now, staleAfterMs))
      .sort((left, right) =>
        String(left.heartbeatAt ?? left.startedAt).localeCompare(
          String(right.heartbeatAt ?? right.startedAt),
        ),
      )[0];

    if (!stale) {
      return { claimed: false, reason: "no_stale_attempts" };
    }

    const next = {
      ...stale,
      status: "recovering",
      ownerId: workerId,
      recoveredFromOwnerId: stale.ownerId ?? null,
      recoveredAt: now,
      heartbeatAt: now,
      updatedAt: now,
    };
    this.#attempts.set(stale.id, next);
    return { claimed: true, attempt: next };
  }

  async appendRunEvent(event = {}) {
    if (!event.runId) {
      throw new TypeError("Run event requires runId");
    }
    const seq =
      event.seq == null
        ? this.#nextRunEventSeq(event.runId)
        : positiveSequenceNumber(event.seq);
    const stored = {
      ...event,
      id: event.id ?? `${event.runId}:event:${seq}`,
      seq,
      createdAt: event.createdAt ?? new Date().toISOString(),
    };
    this.#runEvents.push(stored);
    return stored;
  }

  async listRunEvents(runId, { afterSeq } = {}) {
    const runIdFilter = runId == null ? null : String(runId);
    const after = afterSeq == null ? null : Number(afterSeq);
    return this.#runEvents
      .filter((event) => runIdFilter == null || event.runId === runIdFilter)
      .filter((event) => after == null || Number(event.seq ?? 0) > after)
      .sort((left, right) => {
        return (
          String(left.runId).localeCompare(String(right.runId)) ||
          Number(left.seq ?? 0) - Number(right.seq ?? 0)
        );
      });
  }

  #nextAttemptNumber(attempt = {}) {
    if (!attempt.runId || !attempt.nodeId) {
      throw new TypeError("Attempt requires runId and nodeId");
    }
    return (
      Math.max(
        0,
        ...[...this.#attempts.values()]
          .filter(
            (candidate) =>
              candidate.runId === attempt.runId &&
              candidate.nodeId === attempt.nodeId,
          )
          .map((candidate) => Number(candidate.attempt ?? 0)),
      ) + 1
    );
  }

  #nextRunEventSeq(runId) {
    return (
      Math.max(
        0,
        ...this.#runEvents
          .filter((event) => event.runId === runId)
          .map((event) => Number(event.seq ?? 0)),
      ) + 1
    );
  }

  async appendSignal(signal = {}) {
    if (!signal.runId && !signal.correlationKey) {
      throw new TypeError("Signal requires runId or correlationKey");
    }
    const stored = {
      ...signal,
      id:
        signal.id ??
        `signal:${signal.runId ?? signal.correlationKey}:${this.#signals.length + 1}`,
      status: signal.status ?? "received",
      createdAt: signal.createdAt ?? new Date().toISOString(),
    };
    this.#signals.push(stored);
    return stored;
  }

  async listSignals({ runId, correlationKey, type, status } = {}) {
    return this.#signals.filter((signal) => {
      return (
        (!runId || signal.runId === runId) &&
        (!correlationKey || signal.correlationKey === correlationKey) &&
        (!type || signal.type === type) &&
        (!status || signal.status === status)
      );
    });
  }

  async consumeSignal(id, { consumerId, now = new Date().toISOString() } = {}) {
    const index = this.#signals.findIndex((signal) => signal.id === String(id));
    if (index === -1) return null;

    const next = {
      ...this.#signals[index],
      status: "consumed",
      consumedBy: consumerId ?? null,
      consumedAt: now,
      updatedAt: now,
    };
    this.#signals[index] = next;
    return next;
  }

  async claimAgentWork(
    claim = {},
    { now = new Date().toISOString(), ttlMs = 30 * 60 * 1000 } = {},
  ) {
    validateAgentClaim(claim);
    const requestedId = agentClaimId(claim);
    const existingById = this.#agentClaims.get(requestedId);
    const existingByResource = [...this.#agentClaims.values()].find(
      (candidate) => sameAgentClaimResource(candidate, claim),
    );
    if (existingById && !sameAgentClaimResource(existingById, claim)) {
      return {
        claimed: false,
        reason: "claim_id_conflict",
        claim: existingById,
      };
    }
    const existing = existingByResource ?? existingById;
    const id = existing?.id ?? requestedId;

    if (
      existing?.status === "active" &&
      !isExpired(existing.expiresAt, now) &&
      existing.ownerAgentId !== claim.ownerAgentId
    ) {
      return {
        claimed: false,
        reason: "already_claimed",
        claim: existing,
      };
    }

    const expiresAt =
      claim.expiresAt ?? new Date(Date.parse(now) + ttlMs).toISOString();
    const next = {
      ...existing,
      ...claim,
      id,
      status: "active",
      claimedAt:
        existing?.ownerAgentId === claim.ownerAgentId
          ? (existing.claimedAt ?? now)
          : now,
      renewedAt: now,
      expiresAt,
      releasedAt: null,
      releaseReason: null,
      createdAt: existing?.createdAt ?? claim.createdAt ?? now,
      updatedAt: claim.updatedAt ?? now,
    };
    this.#agentClaims.set(id, next);
    return {
      claimed: true,
      claim: next,
    };
  }

  async getAgentClaim(id) {
    return this.#agentClaims.get(String(id)) ?? null;
  }

  async listAgentClaims({ repo, ownerAgentId, resourceKind, status } = {}) {
    return [...this.#agentClaims.values()]
      .filter((claim) => !repo || claim.repo === repo)
      .filter((claim) => !ownerAgentId || claim.ownerAgentId === ownerAgentId)
      .filter((claim) => !resourceKind || claim.resourceKind === resourceKind)
      .filter((claim) => !status || claim.status === status)
      .sort((left, right) =>
        String(right.updatedAt ?? right.claimedAt).localeCompare(
          String(left.updatedAt ?? left.claimedAt),
        ),
      );
  }

  async renewAgentClaim(
    id,
    {
      ownerAgentId,
      expiresAt,
      ttlMs = 30 * 60 * 1000,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = this.#agentClaims.get(String(id));
    if (
      existing?.status !== "active" ||
      (ownerAgentId && existing.ownerAgentId !== ownerAgentId)
    ) {
      return null;
    }

    const next = {
      ...existing,
      renewedAt: now,
      expiresAt: expiresAt ?? new Date(Date.parse(now) + ttlMs).toISOString(),
      updatedAt: now,
    };
    this.#agentClaims.set(String(id), next);
    return next;
  }

  async releaseAgentClaim(
    id,
    { ownerAgentId, reason, now = new Date().toISOString() } = {},
  ) {
    const existing = this.#agentClaims.get(String(id));
    if (
      existing?.status !== "active" ||
      (ownerAgentId && existing.ownerAgentId !== ownerAgentId)
    ) {
      return null;
    }

    const next = {
      ...existing,
      status: "released",
      releaseReason: reason ?? null,
      releasedAt: now,
      updatedAt: now,
    };
    this.#agentClaims.set(String(id), next);
    return next;
  }

  async transferAgentClaim(
    id,
    {
      fromOwnerAgentId,
      toOwnerAgentId,
      reason,
      expiresAt,
      ttlMs = 30 * 60 * 1000,
      now = new Date().toISOString(),
    } = {},
  ) {
    if (!toOwnerAgentId) {
      throw new TypeError("Agent claim transfer requires toOwnerAgentId");
    }

    const existing = this.#agentClaims.get(String(id));
    if (
      existing?.status !== "active" ||
      (fromOwnerAgentId && existing.ownerAgentId !== fromOwnerAgentId)
    ) {
      return null;
    }

    const handoff = {
      fromAgentId: existing.ownerAgentId ?? null,
      toAgentId: String(toOwnerAgentId),
      reason: reason ?? null,
      transferredAt: now,
    };
    const metadata = objectValue(existing.metadata);
    const next = {
      ...existing,
      ownerAgentId: String(toOwnerAgentId),
      claimedAt: now,
      renewedAt: now,
      expiresAt: expiresAt ?? new Date(Date.parse(now) + ttlMs).toISOString(),
      releasedAt: null,
      releaseReason: null,
      metadata: {
        ...metadata,
        transferredFromAgentId: existing.ownerAgentId ?? null,
        transferredToAgentId: String(toOwnerAgentId),
        transferReason: reason ?? null,
        transferredAt: now,
        handoffs: [...arrayValue(metadata.handoffs), handoff],
      },
      updatedAt: now,
    };
    this.#agentClaims.set(String(id), next);
    return next;
  }

  async claimWorkerLease(
    lease = {},
    { now = new Date().toISOString(), ttlMs = 30 * 1000 } = {},
  ) {
    validateWorkerLease(lease);
    const id = workerLeaseId(lease);
    const existing = this.#workerLeases.get(id);
    const ownerId = String(lease.ownerId);

    if (
      existing?.status === "active" &&
      !isExpired(existing.expiresAt, now) &&
      existing.ownerId !== ownerId
    ) {
      return {
        claimed: false,
        reason: "lease_held",
        lease: existing,
      };
    }

    const expiresAt =
      lease.expiresAt ?? new Date(Date.parse(now) + ttlMs).toISOString();
    const next = {
      ...existing,
      ...lease,
      id,
      ownerId,
      status: "active",
      acquiredAt:
        existing?.ownerId === ownerId && existing.status === "active"
          ? (existing.acquiredAt ?? now)
          : now,
      renewedAt: now,
      expiresAt,
      releasedAt: null,
      releaseReason: null,
      createdAt: existing?.createdAt ?? lease.createdAt ?? now,
      updatedAt: lease.updatedAt ?? now,
    };
    this.#workerLeases.set(id, next);
    return {
      claimed: true,
      lease: next,
    };
  }

  async getWorkerLease(id) {
    return this.#workerLeases.get(String(id)) ?? null;
  }

  async listWorkerLeases({ ownerId, status } = {}) {
    return [...this.#workerLeases.values()]
      .filter((lease) => !ownerId || lease.ownerId === ownerId)
      .filter((lease) => !status || lease.status === status)
      .sort((left, right) =>
        String(right.updatedAt ?? right.renewedAt).localeCompare(
          String(left.updatedAt ?? left.renewedAt),
        ),
      );
  }

  async heartbeatWorkerLease(
    id,
    { ownerId, now = new Date().toISOString(), ttlMs = 30 * 1000 } = {},
  ) {
    const existing = this.#workerLeases.get(String(id));
    if (
      existing?.status !== "active" ||
      isExpired(existing.expiresAt, now) ||
      (ownerId && existing.ownerId !== ownerId)
    ) {
      return null;
    }

    const next = {
      ...existing,
      renewedAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
      updatedAt: now,
    };
    this.#workerLeases.set(String(id), next);
    return next;
  }

  async releaseWorkerLease(
    id,
    { ownerId, reason, now = new Date().toISOString() } = {},
  ) {
    const existing = this.#workerLeases.get(String(id));
    if (
      existing?.status !== "active" ||
      (ownerId && existing.ownerId !== ownerId)
    ) {
      return null;
    }

    const next = {
      ...existing,
      status: "released",
      releaseReason: reason ?? null,
      releasedAt: now,
      updatedAt: now,
    };
    this.#workerLeases.set(String(id), next);
    return next;
  }

  async upsertRepoPolicy(policy = {}) {
    const repo = repoPolicyId(policy);
    const existing = this.#repoPolicies.get(repo);
    const next = normalizeRepoPolicy(policy, existing);
    this.#repoPolicies.set(repo, next);
    return next;
  }

  async getRepoPolicy(repo) {
    if (!repo) return null;
    return this.#repoPolicies.get(String(repo)) ?? null;
  }

  async listRepoPolicies() {
    return [...this.#repoPolicies.values()].sort((left, right) =>
      String(left.repo).localeCompare(String(right.repo)),
    );
  }

  async upsertRegisteredAgent(
    agent = {},
    { registeredBy, now = new Date().toISOString() } = {},
  ) {
    const id = registeredAgentId(agent);
    const existing = this.#registeredAgents.get(id);
    const next = normalizeRegisteredAgent(agent, existing, {
      registeredBy,
      now,
    });
    this.#registeredAgents.set(id, next);
    return next;
  }

  async getRegisteredAgent(id) {
    if (!id) return null;
    return this.#registeredAgents.get(String(id)) ?? null;
  }

  async listRegisteredAgents({ status, tenantId, source } = {}) {
    return [...this.#registeredAgents.values()]
      .filter((agent) => !status || agent.status === status)
      .filter((agent) => !tenantId || agent.tenantId === tenantId)
      .filter((agent) => !source || agent.source === source)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  async disableRegisteredAgent(
    id,
    { disabledBy, reason, now = new Date().toISOString() } = {},
  ) {
    const existing = this.#registeredAgents.get(String(id));
    if (!existing) return null;
    const next = {
      ...existing,
      status: "disabled",
      disabledBy: disabledBy ?? existing.disabledBy ?? null,
      disabledAt: now,
      disableReason: reason ?? null,
      updatedAt: now,
    };
    this.#registeredAgents.set(String(id), next);
    return next;
  }

  async appendEvent(event) {
    const stored = {
      ...event,
      receivedAt: event.receivedAt ?? new Date().toISOString(),
    };
    this.#events.push(stored);
    return stored;
  }

  async findEventByDeliveryId(deliveryId) {
    if (!deliveryId) return null;
    return (
      this.#events.find((event) => event.deliveryId === deliveryId) ?? null
    );
  }

  async listEvents() {
    return [...this.#events];
  }
}

export class JsonFileQueueStore extends InMemoryQueueStore {
  #filePath;
  #loaded = false;

  constructor(filePath) {
    super();
    if (!filePath) {
      throw new TypeError("JsonFileQueueStore requires a file path");
    }
    this.#filePath = filePath;
  }

  async getQueueItem(id) {
    await this.#load();
    return super.getQueueItem(id);
  }

  async listQueueItems() {
    await this.#load();
    return super.listQueueItems();
  }

  async findQueueItemByHeadSha(headSha) {
    await this.#load();
    return super.findQueueItemByHeadSha(headSha);
  }

  async upsertQueueItem(item) {
    await this.#load();
    const next = await super.upsertQueueItem(item);
    await this.#save();
    return next;
  }

  async claimNextQueueItem(candidates, options) {
    await this.#load();
    const result = await super.claimNextQueueItem(candidates, options);
    if (result.claimed) {
      await this.#save();
    }
    return result;
  }

  async claimQueueItems(candidates, options) {
    await this.#load();
    const result = await super.claimQueueItems(candidates, options);
    if (result.claimed) {
      await this.#save();
    }
    return result;
  }

  async finishQueueItem(id, options) {
    await this.#load();
    const next = await super.finishQueueItem(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async failQueueItem(id, options) {
    await this.#load();
    const next = await super.failQueueItem(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async upsertApproval(approval) {
    await this.#load();
    const next = await super.upsertApproval(approval);
    await this.#save();
    return next;
  }

  async getApproval(id) {
    await this.#load();
    return super.getApproval(id);
  }

  async listApprovals(options) {
    await this.#load();
    return super.listApprovals(options);
  }

  async decideApproval(id, options) {
    await this.#load();
    const next = await super.decideApproval(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async upsertHumanRequest(request) {
    await this.#load();
    const next = await super.upsertHumanRequest(request);
    await this.#save();
    return next;
  }

  async getHumanRequest(id) {
    await this.#load();
    return super.getHumanRequest(id);
  }

  async listHumanRequests(options) {
    await this.#load();
    return super.listHumanRequests(options);
  }

  async respondHumanRequest(id, options) {
    await this.#load();
    const next = await super.respondHumanRequest(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async upsertWorkItem(item, options) {
    await this.#load();
    const next = await super.upsertWorkItem(item, options);
    await this.#save();
    return next;
  }

  async getWorkItem(id) {
    await this.#load();
    return super.getWorkItem(id);
  }

  async listWorkItems(options) {
    await this.#load();
    return super.listWorkItems(options);
  }

  async transitionWorkItem(id, options) {
    await this.#load();
    const next = await super.transitionWorkItem(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async upsertWorkCycle(cycle, options) {
    await this.#load();
    const next = await super.upsertWorkCycle(cycle, options);
    await this.#save();
    return next;
  }

  async getWorkCycle(id) {
    await this.#load();
    return super.getWorkCycle(id);
  }

  async listWorkCycles(options) {
    await this.#load();
    return super.listWorkCycles(options);
  }

  async upsertWorkModule(module, options) {
    await this.#load();
    const next = await super.upsertWorkModule(module, options);
    await this.#save();
    return next;
  }

  async getWorkModule(id) {
    await this.#load();
    return super.getWorkModule(id);
  }

  async listWorkModules(options) {
    await this.#load();
    return super.listWorkModules(options);
  }

  async upsertWorkView(view, options) {
    await this.#load();
    const next = await super.upsertWorkView(view, options);
    await this.#save();
    return next;
  }

  async getWorkView(id) {
    await this.#load();
    return super.getWorkView(id);
  }

  async listWorkViews(options) {
    await this.#load();
    return super.listWorkViews(options);
  }

  async upsertWorkPage(page, options) {
    await this.#load();
    const next = await super.upsertWorkPage(page, options);
    await this.#save();
    return next;
  }

  async getWorkPage(id) {
    await this.#load();
    return super.getWorkPage(id);
  }

  async listWorkPages(options) {
    await this.#load();
    return super.listWorkPages(options);
  }

  async transitionWorkPage(id, options) {
    await this.#load();
    const next = await super.transitionWorkPage(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async upsertRun(run) {
    await this.#load();
    const next = await super.upsertRun(run);
    await this.#save();
    return next;
  }

  async getRun(id) {
    await this.#load();
    return super.getRun(id);
  }

  async listRuns(options) {
    await this.#load();
    return super.listRuns(options);
  }

  async upsertRunNode(node) {
    await this.#load();
    const next = await super.upsertRunNode(node);
    await this.#save();
    return next;
  }

  async listRunNodes(runId) {
    await this.#load();
    return super.listRunNodes(runId);
  }

  async startAttempt(attempt) {
    await this.#load();
    const next = await super.startAttempt(attempt);
    await this.#save();
    return next;
  }

  async getAttempt(id) {
    await this.#load();
    return super.getAttempt(id);
  }

  async listAttempts(options) {
    await this.#load();
    return super.listAttempts(options);
  }

  async heartbeatAttempt(id, options) {
    await this.#load();
    const next = await super.heartbeatAttempt(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async finishAttempt(id, options) {
    await this.#load();
    const next = await super.finishAttempt(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async failAttempt(id, options) {
    await this.#load();
    const next = await super.failAttempt(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async cancelAttempt(id, options) {
    await this.#load();
    const next = await super.cancelAttempt(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async claimStaleAttempt(options) {
    await this.#load();
    const result = await super.claimStaleAttempt(options);
    if (result.claimed) {
      await this.#save();
    }
    return result;
  }

  async appendRunEvent(event) {
    await this.#load();
    const stored = await super.appendRunEvent(event);
    await this.#save();
    return stored;
  }

  async listRunEvents(runId, options) {
    await this.#load();
    return super.listRunEvents(runId, options);
  }

  async appendSignal(signal) {
    await this.#load();
    const stored = await super.appendSignal(signal);
    await this.#save();
    return stored;
  }

  async listSignals(options) {
    await this.#load();
    return super.listSignals(options);
  }

  async consumeSignal(id, options) {
    await this.#load();
    const next = await super.consumeSignal(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async claimAgentWork(claim, options) {
    await this.#load();
    const result = await super.claimAgentWork(claim, options);
    if (result.claimed) {
      await this.#save();
    }
    return result;
  }

  async getAgentClaim(id) {
    await this.#load();
    return super.getAgentClaim(id);
  }

  async listAgentClaims(options) {
    await this.#load();
    return super.listAgentClaims(options);
  }

  async renewAgentClaim(id, options) {
    await this.#load();
    const next = await super.renewAgentClaim(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async releaseAgentClaim(id, options) {
    await this.#load();
    const next = await super.releaseAgentClaim(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async transferAgentClaim(id, options) {
    await this.#load();
    const next = await super.transferAgentClaim(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async claimWorkerLease(lease, options) {
    await this.#load();
    const result = await super.claimWorkerLease(lease, options);
    if (result.claimed) {
      await this.#save();
    }
    return result;
  }

  async getWorkerLease(id) {
    await this.#load();
    return super.getWorkerLease(id);
  }

  async listWorkerLeases(options) {
    await this.#load();
    return super.listWorkerLeases(options);
  }

  async heartbeatWorkerLease(id, options) {
    await this.#load();
    const next = await super.heartbeatWorkerLease(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async releaseWorkerLease(id, options) {
    await this.#load();
    const next = await super.releaseWorkerLease(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async upsertRepoPolicy(policy) {
    await this.#load();
    const next = await super.upsertRepoPolicy(policy);
    await this.#save();
    return next;
  }

  async getRepoPolicy(repo) {
    await this.#load();
    return super.getRepoPolicy(repo);
  }

  async listRepoPolicies() {
    await this.#load();
    return super.listRepoPolicies();
  }

  async upsertRegisteredAgent(agent, options) {
    await this.#load();
    const next = await super.upsertRegisteredAgent(agent, options);
    await this.#save();
    return next;
  }

  async getRegisteredAgent(id) {
    await this.#load();
    return super.getRegisteredAgent(id);
  }

  async listRegisteredAgents(options) {
    await this.#load();
    return super.listRegisteredAgents(options);
  }

  async disableRegisteredAgent(id, options) {
    await this.#load();
    const next = await super.disableRegisteredAgent(id, options);
    if (next) {
      await this.#save();
    }
    return next;
  }

  async appendEvent(event) {
    await this.#load();
    const stored = await super.appendEvent(event);
    await this.#save();
    return stored;
  }

  async findEventByDeliveryId(deliveryId) {
    await this.#load();
    return super.findEventByDeliveryId(deliveryId);
  }

  async listEvents() {
    await this.#load();
    return super.listEvents();
  }

  async #load() {
    if (this.#loaded) return;
    this.#loaded = true;

    let raw;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      // error-policy:J4 a missing store file is legitimate first-boot empty
      // state; anything else rethrows
      if (error?.code === "ENOENT") return;
      throw error;
    }

    if (raw.trim() === "") return;
    const data = JSON.parse(raw);

    for (const item of data.items ?? []) {
      await super.upsertQueueItem(item);
    }

    for (const approval of data.approvals ?? []) {
      await super.upsertApproval(approval);
    }

    for (const request of data.humanRequests ?? []) {
      await super.upsertHumanRequest(request);
    }

    for (const item of data.workItems ?? []) {
      await super.upsertWorkItem(item, {
        actorId: item.updatedBy ?? item.createdBy,
        now: item.updatedAt ?? item.createdAt,
      });
    }

    for (const cycle of data.workCycles ?? []) {
      await super.upsertWorkCycle(cycle, {
        actorId: cycle.updatedBy ?? cycle.createdBy,
        now: cycle.updatedAt ?? cycle.createdAt,
      });
    }

    for (const module of data.workModules ?? []) {
      await super.upsertWorkModule(module, {
        actorId: module.updatedBy ?? module.createdBy,
        now: module.updatedAt ?? module.createdAt,
      });
    }

    for (const view of data.workViews ?? []) {
      await super.upsertWorkView(view, {
        actorId: view.updatedBy ?? view.createdBy,
        now: view.updatedAt ?? view.createdAt,
      });
    }

    for (const page of data.workPages ?? []) {
      await super.upsertWorkPage(page, {
        actorId: page.updatedBy ?? page.createdBy,
        now: page.updatedAt ?? page.createdAt,
      });
    }

    for (const run of data.runs ?? []) {
      await super.upsertRun(run);
    }

    for (const node of data.runNodes ?? []) {
      await super.upsertRunNode(node);
    }

    for (const attempt of data.attempts ?? []) {
      await super.startAttempt(attempt);
    }

    for (const event of data.runEvents ?? []) {
      await super.appendRunEvent(event);
    }

    for (const signal of data.signals ?? []) {
      await super.appendSignal(signal);
    }

    for (const claim of data.agentClaims ?? []) {
      await super.claimAgentWork(claim, {
        now: claim.renewedAt ?? claim.claimedAt ?? claim.createdAt,
      });
      if (claim.status === "released") {
        await super.releaseAgentClaim(claim.id, {
          ownerAgentId: claim.ownerAgentId,
          reason: claim.releaseReason,
          now: claim.releasedAt ?? claim.updatedAt,
        });
      }
    }

    for (const lease of data.workerLeases ?? []) {
      await super.claimWorkerLease(lease, {
        now: lease.renewedAt ?? lease.acquiredAt ?? lease.createdAt,
      });
      if (lease.status === "released") {
        await super.releaseWorkerLease(lease.id, {
          ownerId: lease.ownerId,
          reason: lease.releaseReason,
          now: lease.releasedAt ?? lease.updatedAt,
        });
      }
    }

    for (const policy of data.repoPolicies ?? []) {
      await super.upsertRepoPolicy(policy);
    }

    for (const agent of data.registeredAgents ?? []) {
      await super.upsertRegisteredAgent(agent, {
        registeredBy: agent.registeredBy,
        now: agent.updatedAt ?? agent.registeredAt ?? agent.createdAt,
      });
      if (agent.status === "disabled") {
        await super.disableRegisteredAgent(agent.id, {
          disabledBy: agent.disabledBy,
          reason: agent.disableReason,
          now: agent.disabledAt ?? agent.updatedAt,
        });
      }
    }

    for (const event of data.events ?? []) {
      await super.appendEvent(event);
    }
  }

  async #save() {
    const snapshot = {
      items: await super.listQueueItems(),
      approvals: await super.listApprovals(),
      humanRequests: await super.listHumanRequests(),
      workItems: await super.listWorkItems(),
      workCycles: await super.listWorkCycles(),
      workModules: await super.listWorkModules(),
      workViews: await super.listWorkViews(),
      workPages: await super.listWorkPages(),
      runs: await super.listRuns(),
      runNodes: await super.listRunNodes(),
      attempts: await super.listAttempts(),
      runEvents: await super.listRunEvents(),
      signals: await super.listSignals(),
      agentClaims: await super.listAgentClaims(),
      workerLeases: await super.listWorkerLeases(),
      repoPolicies: await super.listRepoPolicies(),
      registeredAgents: await super.listRegisteredAgents(),
      events: await super.listEvents(),
    };
    await mkdir(dirname(this.#filePath), { recursive: true });
    const tmpPath = `${this.#filePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(tmpPath, this.#filePath);
  }
}

export function queueItemId(item = {}) {
  const repoName = item.name ?? item.repoName;
  const repo =
    item.repo || (item.owner && repoName ? `${item.owner}/${repoName}` : "");
  const pullRequestId = item.pullRequestId ?? item.id;
  if (!repo || !pullRequestId) {
    throw new TypeError("Queue item requires repo and pullRequestId");
  }
  return `${repo}#${pullRequestId}`;
}

export function queueItemScopeKey(item = {}) {
  return `${item.repo ?? ""}:${item.targetBranch ?? ""}`;
}

function queueItemFenceMatches(
  item = {},
  { activeRunId, claimedBy, queueState } = {},
) {
  if (activeRunId != null && item.activeRunId !== activeRunId) return false;
  if (claimedBy != null && item.claimedBy !== claimedBy) return false;
  if (queueState != null && item.queueState !== queueState) return false;
  return true;
}

export function approvalId(approval = {}) {
  if (approval.id) return String(approval.id);
  const scope =
    approval.queueItemId ?? approval.queueItem?.id ?? approval.runId;
  if (!scope) {
    throw new TypeError("Approval requires id, queueItemId, or runId");
  }
  const nodeId = approval.nodeId ?? "human_approval";
  const iteration = normalizedIteration(approval.iteration, 0);
  return `${scope}:${nodeId}:${iteration}`;
}

export function humanRequestId(request = {}) {
  if (request.id) return String(request.id);
  if (!request.runId) {
    throw new TypeError("Human request requires id or runId");
  }
  const nodeId = request.nodeId ?? "human_input";
  const iteration = normalizedIteration(request.iteration, 0);
  return `human:${request.runId}:${nodeId}:${iteration}`;
}

export function workItemId(item = {}) {
  const explicit = stringOrNull(
    item.id ?? item.workItemId ?? item.work_item_id,
  );
  if (explicit) return explicit;

  const repo = stringOrNull(item.repo);
  if (!repo) {
    throw new TypeError("Work item requires id or repo");
  }

  const taskId = stringOrNull(item.taskId ?? item.task_id);
  if (taskId) return `work:${repo}:task:${taskId}`;

  const issueId = stringOrNull(item.issueId ?? item.issue_id);
  if (issueId) return `work:${repo}:issue:${issueId}`;

  const pullRequestId = stringOrNull(
    item.pullRequestId ?? item.pull_request_id,
  );
  if (pullRequestId) return `work:${repo}:pr:${pullRequestId}`;

  const sourceUrl = stringOrNull(item.sourceUrl ?? item.source_url);
  if (sourceUrl) return `work:${repo}:source:${slugValue(sourceUrl, 96)}`;

  const title = stringOrNull(item.title);
  if (title) return `work:${repo}:title:${slugValue(title, 96)}`;

  throw new TypeError(
    "Work item requires id or repo plus taskId, issueId, pullRequestId, sourceUrl, or title",
  );
}

export function workCycleId(cycle = {}) {
  const explicit = stringOrNull(cycle.id ?? cycle.cycleId ?? cycle.cycle_id);
  if (explicit) return explicit;

  const repo = stringOrNull(cycle.repo);
  if (!repo) {
    throw new TypeError("Work cycle requires id or repo");
  }

  const key = stringOrNull(cycle.key ?? cycle.name ?? cycle.title);
  if (!key) {
    throw new TypeError(
      "Work cycle requires id or repo plus key, name, or title",
    );
  }

  return `cycle:${repo}:${slugValue(key, 96)}`;
}

export function workModuleId(module = {}) {
  const explicit = stringOrNull(
    module.id ?? module.moduleId ?? module.module_id,
  );
  if (explicit) return explicit;

  const repo = stringOrNull(module.repo);
  if (!repo) {
    throw new TypeError("Work module requires id or repo");
  }

  const key = stringOrNull(module.key ?? module.name ?? module.title);
  if (!key) {
    throw new TypeError(
      "Work module requires id or repo plus key, name, or title",
    );
  }

  return `module:${repo}:${slugValue(key, 96)}`;
}

export function workViewId(view = {}) {
  const explicit = stringOrNull(view.id ?? view.viewId ?? view.view_id);
  if (explicit) return explicit;

  const key = stringOrNull(view.key ?? view.name ?? view.title);
  if (!key) {
    throw new TypeError("Work view requires id or key, name, or title");
  }

  return `view:${stringOrNull(view.repo) ?? "global"}:${slugValue(key, 96)}`;
}

export function workPageId(page = {}) {
  const explicit = stringOrNull(
    page.id ??
      page.pageId ??
      page.workPageId ??
      page.page_id ??
      page.work_page_id,
  );
  if (explicit) return explicit;

  const repo = stringOrNull(page.repo);
  if (!repo) {
    throw new TypeError("Work page requires id or repo");
  }

  const kind = stringOrNull(page.kind ?? page.type) ?? "note";
  const workItemIdValue = stringOrNull(page.workItemId ?? page.work_item_id);
  if (workItemIdValue)
    return `page:${repo}:work:${slugValue(workItemIdValue, 96)}:${slugValue(kind, 40)}`;

  const taskId = stringOrNull(page.taskId ?? page.task_id);
  if (taskId)
    return `page:${repo}:task:${slugValue(taskId, 96)}:${slugValue(kind, 40)}`;

  const issueId = stringOrNull(page.issueId ?? page.issue_id);
  if (issueId) return `page:${repo}:issue:${issueId}:${slugValue(kind, 40)}`;

  const pullRequestId = stringOrNull(
    page.pullRequestId ?? page.pull_request_id,
  );
  if (pullRequestId)
    return `page:${repo}:pr:${pullRequestId}:${slugValue(kind, 40)}`;

  const sourceUrl = stringOrNull(page.sourceUrl ?? page.source_url);
  if (sourceUrl) return `page:${repo}:source:${slugValue(sourceUrl, 96)}`;

  const key = stringOrNull(page.key ?? page.name ?? page.title);
  if (!key) {
    throw new TypeError(
      "Work page requires id or repo plus workItemId, taskId, issueId, pullRequestId, sourceUrl, key, name, or title",
    );
  }

  return `page:${repo}:title:${slugValue(key, 96)}`;
}

export function runId(run = {}) {
  if (run.id) return String(run.id);
  if (run.runId) return String(run.runId);
  if (run.queueItemId) return `run:${run.queueItemId}`;
  throw new TypeError("Run requires id, runId, or queueItemId");
}

export function runNodeId(node = {}) {
  if (node.id) return String(node.id);
  if (!node.runId || !node.nodeId) {
    throw new TypeError("Run node requires runId and nodeId");
  }
  const iteration = normalizedIteration(node.iteration, 0);
  return `${node.runId}:${node.nodeId}:${iteration}`;
}

export function attemptId(attempt = {}) {
  if (attempt.id) return String(attempt.id);
  if (!attempt.runId || !attempt.nodeId || attempt.attempt == null) {
    throw new TypeError("Attempt requires id or runId, nodeId, and attempt");
  }
  return `attempt:${attempt.runId}:${attempt.nodeId}:${positiveAttemptNumber(attempt.attempt)}`;
}

export function agentClaimId(claim = {}) {
  if (claim.id) return String(claim.id);
  if (
    !claim.repo ||
    !claim.resourceKind ||
    !claim.resourceId ||
    !claim.ownerAgentId
  ) {
    throw new TypeError(
      "Agent claim requires repo, resourceKind, resourceId, and ownerAgentId",
    );
  }
  return `claim:${claim.repo}:${claim.resourceKind}:${claim.resourceId}`;
}

export function workerLeaseId(lease = {}) {
  if (typeof lease === "string") return lease;
  if (lease.id) return String(lease.id);
  if (lease.leaseId) return String(lease.leaseId);
  throw new TypeError("Worker lease requires id or leaseId");
}

export function repoPolicyId(policy = {}) {
  const repo = typeof policy === "string" ? policy : policy.repo;
  if (!repo) {
    throw new TypeError("Repository policy requires repo");
  }
  return String(repo);
}

export function registeredAgentId(agent = {}) {
  const id =
    typeof agent === "string"
      ? agent
      : (agent.id ?? agent.agentId ?? agent.ownerAgentId ?? agent.elizaAgentId);
  if (!id || !String(id).trim()) {
    throw new TypeError("Registered agent requires id or agentId");
  }
  return String(id).trim();
}

export function normalizeRepoPolicy(
  policy = {},
  existing = null,
  now = new Date().toISOString(),
) {
  const repo = repoPolicyId(policy);
  const queueMode =
    policy.queueMode ??
    policy.queue_mode ??
    existing?.queueMode ??
    "serialized";
  if (!REPO_POLICY_QUEUE_MODES.has(queueMode)) {
    throw new TypeError(
      `Repository policy queueMode must be one of ${[...REPO_POLICY_QUEUE_MODES].join(", ")}`,
    );
  }

  return {
    repo,
    queueMode,
    protectedBranches: arrayValue(
      policy.protectedBranches ?? policy.protected_branches,
      existing?.protectedBranches ?? ["main", "develop"],
    ),
    requiredChecks: arrayValue(
      policy.requiredChecks ?? policy.required_checks,
      existing?.requiredChecks ?? [],
    ),
    trustedActors: arrayValue(
      policy.trustedActors ?? policy.trusted_actors,
      existing?.trustedActors ?? [],
    ),
    allowForks: booleanValue(
      policy.allowForks ?? policy.allow_forks,
      existing?.allowForks ?? false,
    ),
    policy: objectValue(
      policy.policy ?? policy.policyJson ?? policy.policy_json,
      existing?.policy ?? {},
    ),
    createdAt: existing?.createdAt ?? policy.createdAt ?? now,
    updatedAt: policy.updatedAt ?? now,
  };
}

export function normalizeRegisteredAgent(
  agent = {},
  existing = null,
  { registeredBy, now = new Date().toISOString() } = {},
) {
  const id = registeredAgentId(agent);
  const status = agent.status ?? existing?.status ?? "active";
  if (!REGISTERED_AGENT_STATUSES.has(status)) {
    throw new TypeError(
      `Registered agent status must be one of ${[...REGISTERED_AGENT_STATUSES].join(", ")}`,
    );
  }

  return {
    id,
    status,
    displayName: stringOrNull(
      agent.displayName ?? agent.display_name ?? existing?.displayName,
    ),
    forgejoUsername: stringOrNull(
      agent.forgejoUsername ??
        agent.forgejo_username ??
        existing?.forgejoUsername,
    ),
    elizaCloudSubject: stringOrNull(
      agent.elizaCloudSubject ??
        agent.eliza_cloud_subject ??
        existing?.elizaCloudSubject,
    ),
    tenantId: stringOrNull(
      agent.tenantId ?? agent.tenant_id ?? existing?.tenantId,
    ),
    source: stringOrNull(agent.source ?? existing?.source) ?? "steward",
    registeredBy: stringOrNull(
      agent.registeredBy ??
        agent.registered_by ??
        registeredBy ??
        existing?.registeredBy,
    ),
    registeredAt:
      existing?.registeredAt ??
      agent.registeredAt ??
      agent.registered_at ??
      now,
    disabledBy: stringOrNull(
      agent.disabledBy ?? agent.disabled_by ?? existing?.disabledBy,
    ),
    disabledAt:
      agent.disabledAt ?? agent.disabled_at ?? existing?.disabledAt ?? null,
    disableReason: stringOrNull(
      agent.disableReason ?? agent.disable_reason ?? existing?.disableReason,
    ),
    metadata: objectValue(
      agent.metadata ?? agent.metadataJson ?? agent.metadata_json,
      existing?.metadata ?? {},
    ),
    createdAt:
      existing?.createdAt ?? agent.createdAt ?? agent.created_at ?? now,
    updatedAt: agent.updatedAt ?? agent.updated_at ?? now,
  };
}

export function normalizeWorkItem(
  item = {},
  existing = null,
  { actorId, now = new Date().toISOString() } = {},
) {
  const id = workItemId(item);
  const repo = stringOrNull(item.repo ?? existing?.repo);
  if (!repo) {
    throw new TypeError("Work item requires repo");
  }

  const kind =
    item.kind ?? item.type ?? existing?.kind ?? inferWorkItemKind(item);
  if (!WORK_ITEM_KINDS.has(kind)) {
    throw new TypeError(
      `Work item kind must be one of ${[...WORK_ITEM_KINDS].join(", ")}`,
    );
  }

  const state = item.state ?? item.status ?? existing?.state ?? "ready";
  if (!WORK_ITEM_STATES.has(state)) {
    throw new TypeError(
      `Work item state must be one of ${[...WORK_ITEM_STATES].join(", ")}`,
    );
  }

  const title =
    stringOrNull(item.title ?? existing?.title) ??
    deriveWorkItemTitle({ ...existing, ...item, repo });
  if (!title) {
    throw new TypeError("Work item requires title");
  }

  const completedAt = TERMINAL_WORK_ITEM_STATES.has(state)
    ? (item.completedAt ?? item.completed_at ?? existing?.completedAt ?? now)
    : (item.completedAt ??
      item.completed_at ??
      (item.state || item.status ? null : (existing?.completedAt ?? null)));

  return {
    ...existing,
    ...item,
    id,
    repo,
    kind,
    state,
    title,
    summary: stringOrNull(
      item.summary ?? item.description ?? existing?.summary,
    ),
    priority: numberValue(item.priority, existing?.priority ?? 0),
    ownerAgentId: stringOrNull(
      item.ownerAgentId ?? item.owner_agent_id ?? existing?.ownerAgentId,
    ),
    taskId: stringOrNull(item.taskId ?? item.task_id ?? existing?.taskId),
    issueId: stringOrNull(item.issueId ?? item.issue_id ?? existing?.issueId),
    pullRequestId: intOrNullValue(
      item.pullRequestId ?? item.pull_request_id ?? existing?.pullRequestId,
    ),
    cycleId: stringOrNull(item.cycleId ?? item.cycle_id ?? existing?.cycleId),
    moduleId: stringOrNull(
      item.moduleId ?? item.module_id ?? existing?.moduleId,
    ),
    sourceUrl: stringOrNull(
      item.sourceUrl ?? item.source_url ?? item.url ?? existing?.sourceUrl,
    ),
    targetBranch: stringOrNull(
      item.targetBranch ?? item.target_branch ?? existing?.targetBranch,
    ),
    paths: arrayValue(item.paths ?? existing?.paths),
    packages: arrayValue(item.packages ?? existing?.packages),
    labels: arrayValue(item.labels ?? existing?.labels),
    metadata: objectValue(
      item.metadata ?? item.metadataJson ?? item.metadata_json,
      existing?.metadata ?? {},
    ),
    createdBy: stringOrNull(
      item.createdBy ?? item.created_by ?? existing?.createdBy ?? actorId,
    ),
    updatedBy: stringOrNull(
      item.updatedBy ?? item.updated_by ?? actorId ?? existing?.updatedBy,
    ),
    claimedAt: item.claimedAt ?? item.claimed_at ?? existing?.claimedAt ?? null,
    completedAt,
    createdAt: existing?.createdAt ?? item.createdAt ?? item.created_at ?? now,
    updatedAt: item.updatedAt ?? item.updated_at ?? now,
  };
}

export function normalizeWorkCycle(
  cycle = {},
  existing = null,
  { actorId, now = new Date().toISOString() } = {},
) {
  const id = workCycleId(cycle);
  const repo = stringOrNull(cycle.repo ?? existing?.repo);
  if (!repo) {
    throw new TypeError("Work cycle requires repo");
  }

  const state = cycle.state ?? cycle.status ?? existing?.state ?? "planned";
  if (!WORK_CYCLE_STATES.has(state)) {
    throw new TypeError(
      `Work cycle state must be one of ${[...WORK_CYCLE_STATES].join(", ")}`,
    );
  }

  const title = stringOrNull(cycle.title ?? cycle.name ?? existing?.title);
  if (!title) {
    throw new TypeError("Work cycle requires title");
  }

  return {
    ...existing,
    ...cycle,
    id,
    repo,
    state,
    title,
    summary: stringOrNull(
      cycle.summary ?? cycle.description ?? existing?.summary,
    ),
    ownerAgentId: stringOrNull(
      cycle.ownerAgentId ?? cycle.owner_agent_id ?? existing?.ownerAgentId,
    ),
    startAt: cycle.startAt ?? cycle.start_at ?? existing?.startAt ?? null,
    endAt: cycle.endAt ?? cycle.end_at ?? existing?.endAt ?? null,
    metadata: objectValue(
      cycle.metadata ?? cycle.metadataJson ?? cycle.metadata_json,
      existing?.metadata ?? {},
    ),
    createdBy: stringOrNull(
      cycle.createdBy ?? cycle.created_by ?? existing?.createdBy ?? actorId,
    ),
    updatedBy: stringOrNull(
      cycle.updatedBy ?? cycle.updated_by ?? actorId ?? existing?.updatedBy,
    ),
    createdAt:
      existing?.createdAt ?? cycle.createdAt ?? cycle.created_at ?? now,
    updatedAt: cycle.updatedAt ?? cycle.updated_at ?? now,
  };
}

export function normalizeWorkModule(
  module = {},
  existing = null,
  { actorId, now = new Date().toISOString() } = {},
) {
  const id = workModuleId(module);
  const repo = stringOrNull(module.repo ?? existing?.repo);
  if (!repo) {
    throw new TypeError("Work module requires repo");
  }

  const state = module.state ?? module.status ?? existing?.state ?? "active";
  if (!WORK_MODULE_STATES.has(state)) {
    throw new TypeError(
      `Work module state must be one of ${[...WORK_MODULE_STATES].join(", ")}`,
    );
  }

  const title = stringOrNull(module.title ?? module.name ?? existing?.title);
  if (!title) {
    throw new TypeError("Work module requires title");
  }

  return {
    ...existing,
    ...module,
    id,
    repo,
    state,
    title,
    summary: stringOrNull(
      module.summary ?? module.description ?? existing?.summary,
    ),
    ownerAgentId: stringOrNull(
      module.ownerAgentId ?? module.owner_agent_id ?? existing?.ownerAgentId,
    ),
    paths: arrayValue(module.paths ?? existing?.paths),
    packages: arrayValue(module.packages ?? existing?.packages),
    labels: arrayValue(module.labels ?? existing?.labels),
    metadata: objectValue(
      module.metadata ?? module.metadataJson ?? module.metadata_json,
      existing?.metadata ?? {},
    ),
    createdBy: stringOrNull(
      module.createdBy ?? module.created_by ?? existing?.createdBy ?? actorId,
    ),
    updatedBy: stringOrNull(
      module.updatedBy ?? module.updated_by ?? actorId ?? existing?.updatedBy,
    ),
    createdAt:
      existing?.createdAt ?? module.createdAt ?? module.created_at ?? now,
    updatedAt: module.updatedAt ?? module.updated_at ?? now,
  };
}

export function normalizeWorkView(
  view = {},
  existing = null,
  { actorId, now = new Date().toISOString() } = {},
) {
  const id = workViewId(view);
  const kind = view.kind ?? view.type ?? existing?.kind ?? "list";
  if (!WORK_VIEW_KINDS.has(kind)) {
    throw new TypeError(
      `Work view kind must be one of ${[...WORK_VIEW_KINDS].join(", ")}`,
    );
  }

  const state = view.state ?? view.status ?? existing?.state ?? "active";
  if (!WORK_VIEW_STATES.has(state)) {
    throw new TypeError(
      `Work view state must be one of ${[...WORK_VIEW_STATES].join(", ")}`,
    );
  }

  const title = stringOrNull(view.title ?? view.name ?? existing?.title);
  if (!title) {
    throw new TypeError("Work view requires title");
  }

  return {
    ...existing,
    ...view,
    id,
    repo: stringOrNull(view.repo ?? existing?.repo),
    kind,
    state,
    title,
    summary: stringOrNull(
      view.summary ?? view.description ?? existing?.summary,
    ),
    ownerAgentId: stringOrNull(
      view.ownerAgentId ?? view.owner_agent_id ?? existing?.ownerAgentId,
    ),
    query: stringOrNull(view.query ?? view.q ?? existing?.query),
    filters: objectValue(
      view.filters ?? view.filter ?? existing?.filters ?? {},
    ),
    layout: objectValue(view.layout ?? existing?.layout ?? {}),
    columns: arrayValue(view.columns ?? existing?.columns),
    visibility:
      stringOrNull(view.visibility ?? existing?.visibility) ?? "private",
    metadata: objectValue(
      view.metadata ?? view.metadataJson ?? view.metadata_json,
      existing?.metadata ?? {},
    ),
    createdBy: stringOrNull(
      view.createdBy ?? view.created_by ?? existing?.createdBy ?? actorId,
    ),
    updatedBy: stringOrNull(
      view.updatedBy ?? view.updated_by ?? actorId ?? existing?.updatedBy,
    ),
    createdAt: existing?.createdAt ?? view.createdAt ?? view.created_at ?? now,
    updatedAt: view.updatedAt ?? view.updated_at ?? now,
  };
}

export function normalizeWorkPage(
  page = {},
  existing = null,
  { actorId, now = new Date().toISOString() } = {},
) {
  const id = workPageId(page);
  const repo = stringOrNull(page.repo ?? existing?.repo);
  if (!repo) {
    throw new TypeError("Work page requires repo");
  }

  const kind = page.kind ?? page.type ?? existing?.kind ?? "note";
  if (!WORK_PAGE_KINDS.has(kind)) {
    throw new TypeError(
      `Work page kind must be one of ${[...WORK_PAGE_KINDS].join(", ")}`,
    );
  }

  const state = page.state ?? page.status ?? existing?.state ?? "active";
  if (!WORK_PAGE_STATES.has(state)) {
    throw new TypeError(
      `Work page state must be one of ${[...WORK_PAGE_STATES].join(", ")}`,
    );
  }

  const title = stringOrNull(page.title ?? page.name ?? existing?.title);
  if (!title) {
    throw new TypeError("Work page requires title");
  }

  const body = stringOrNull(
    page.body ?? page.content ?? page.markdown ?? existing?.body,
  );

  return {
    ...existing,
    ...page,
    id,
    repo,
    kind,
    state,
    title,
    summary: stringOrNull(
      page.summary ?? page.description ?? existing?.summary,
    ),
    body,
    format:
      stringOrNull(
        page.format ?? page.bodyFormat ?? page.body_format ?? existing?.format,
      ) ?? "markdown",
    ownerAgentId: stringOrNull(
      page.ownerAgentId ?? page.owner_agent_id ?? existing?.ownerAgentId,
    ),
    workItemId: stringOrNull(
      page.workItemId ?? page.work_item_id ?? existing?.workItemId,
    ),
    cycleId: stringOrNull(page.cycleId ?? page.cycle_id ?? existing?.cycleId),
    moduleId: stringOrNull(
      page.moduleId ?? page.module_id ?? existing?.moduleId,
    ),
    taskId: stringOrNull(page.taskId ?? page.task_id ?? existing?.taskId),
    issueId: stringOrNull(page.issueId ?? page.issue_id ?? existing?.issueId),
    pullRequestId: intOrNullValue(
      page.pullRequestId ?? page.pull_request_id ?? existing?.pullRequestId,
    ),
    sourceUrl: stringOrNull(
      page.sourceUrl ?? page.source_url ?? page.url ?? existing?.sourceUrl,
    ),
    tags: arrayValue(page.tags ?? page.labels ?? existing?.tags),
    visibility:
      stringOrNull(page.visibility ?? existing?.visibility) ?? "private",
    metadata: objectValue(
      page.metadata ?? page.metadataJson ?? page.metadata_json,
      existing?.metadata ?? {},
    ),
    createdBy: stringOrNull(
      page.createdBy ?? page.created_by ?? existing?.createdBy ?? actorId,
    ),
    updatedBy: stringOrNull(
      page.updatedBy ?? page.updated_by ?? actorId ?? existing?.updatedBy,
    ),
    createdAt: existing?.createdAt ?? page.createdAt ?? page.created_at ?? now,
    updatedAt: page.updatedAt ?? page.updated_at ?? now,
  };
}

function validateAgentClaim(claim = {}) {
  if (
    !claim.repo ||
    !claim.resourceKind ||
    !claim.resourceId ||
    !claim.ownerAgentId
  ) {
    throw new TypeError(
      "Agent claim requires repo, resourceKind, resourceId, and ownerAgentId",
    );
  }
}

function validateWorkerLease(lease = {}) {
  workerLeaseId(lease);
  if (!lease.ownerId) {
    throw new TypeError("Worker lease requires ownerId");
  }
}

function isFutureAvailableAt(availableAt, now) {
  if (!availableAt) return false;
  const availableAtMs = Date.parse(availableAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(availableAtMs) || !Number.isFinite(nowMs)) return false;
  return availableAtMs > nowMs;
}

function normalizedIteration(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function positiveAttemptNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError("Attempt number must be a positive integer");
  }
  return number;
}

function positiveSequenceNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError("Event sequence must be a positive integer");
  }
  return number;
}

function attemptOwnerMatches(attempt, ownerId) {
  return !ownerId || !attempt.ownerId || attempt.ownerId === ownerId;
}

function sameAgentClaimResource(left = {}, right = {}) {
  return (
    left.repo === right.repo &&
    left.resourceKind === right.resourceKind &&
    String(left.resourceId) === String(right.resourceId)
  );
}

function arrayValue(value, fallback = []) {
  if (value instanceof Set) return [...value];
  return Array.isArray(value) ? value : fallback;
}

function objectValue(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
}

function booleanValue(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function stringOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function intOrNullValue(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function inferWorkItemKind(item = {}) {
  if (item.kind) return item.kind;
  if (item.type) return item.type;
  if (item.pullRequestId != null || item.pull_request_id != null)
    return "pull_request";
  if (item.issueId != null || item.issue_id != null) return "issue";
  return "task";
}

function deriveWorkItemTitle(item = {}) {
  if (item.pullRequestId != null) return `${item.repo} #${item.pullRequestId}`;
  if (item.issueId != null) return `${item.repo} issue ${item.issueId}`;
  if (item.taskId) return `${item.repo} task ${item.taskId}`;
  return null;
}

function compareWorkItems(left, right) {
  return (
    Number(right.priority ?? 0) - Number(left.priority ?? 0) ||
    String(right.updatedAt ?? right.createdAt).localeCompare(
      String(left.updatedAt ?? left.createdAt),
    ) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareWorkScopes(left, right) {
  return (
    String(right.updatedAt ?? right.createdAt).localeCompare(
      String(left.updatedAt ?? left.createdAt),
    ) ||
    String(left.title ?? left.id).localeCompare(
      String(right.title ?? right.id),
    ) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function slugValue(value, maxLength = 96) {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "item";
}

function isAttemptStale(attempt, now, staleAfterMs) {
  const lastAliveMs = Date.parse(
    attempt.heartbeatAt ??
      attempt.updatedAt ??
      attempt.startedAt ??
      attempt.createdAt ??
      "",
  );
  const nowMs = Date.parse(now);
  return (
    Number.isFinite(lastAliveMs) &&
    Number.isFinite(nowMs) &&
    nowMs - lastAliveMs > staleAfterMs
  );
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false;
  return expiresAtMs <= nowMs;
}

function serializeAttemptError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }
  if (error && typeof error === "object") return error;
  return { message: String(error ?? "attempt_failed") };
}
