import { buildAgentActionPlan } from "./agent-action-plan.js";
import { buildAgentBootstrap } from "./agent-bootstrap.js";
import {
  buildAgentCapacity,
  buildClaimFromAssignmentSuggestion,
} from "./agent-capacity.js";
import {
  buildAgentClaimCandidates,
  buildClaimFromCandidate,
} from "./agent-claim-router.js";
import { buildAgentCockpit } from "./agent-cockpit.js";
import { buildAgentInbox } from "./agent-inbox.js";
import { buildAgentInsights } from "./agent-insights.js";
import { buildAgentPerformance } from "./agent-performance.js";
import { detectAgentPlanSignals } from "./agent-plan.js";
import { buildAgentRouting } from "./agent-routing.js";
import { buildAgentSubmissionGate } from "./agent-submission-gate.js";
import { buildAgentWorkPreflight } from "./agent-work-preflight.js";
import { buildCiFailureAnalysis } from "./ci-failure-analysis.js";
import { renderQueueComment } from "./comments.js";
import { buildCoordinationSummary } from "./coordination-summary.js";
import { enrichQueueItem } from "./enrichment.js";
import { gateForgejoEvent } from "./event-gate.js";
import { applyForgejoFeedback, buildForgejoFeedback } from "./feedback.js";
import { buildFleetCoordination } from "./fleet-coordination.js";
import { executeIntegrationPlan } from "./integration-executor.js";
import { buildIntegrationPlan } from "./integration-plan.js";
import { buildMergeQueueSummary } from "./merge-queue-summary.js";
import { buildMergeTrainPlan } from "./merge-train-plan.js";
import { buildPatchConflictPrediction } from "./patch-conflict-prediction.js";
import { evaluateMergePolicy, QUEUE_STATES, scheduleQueue } from "./policy.js";
import { buildProjectBoard } from "./project-board.js";
import { buildPullRequestBrief as buildPullRequestBriefModel } from "./pull-request-brief.js";
import { buildQueueItemActionPlan } from "./queue-item-action-plan.js";
import { buildQueueSimulation } from "./queue-simulation.js";
import { buildReleaseNotes as buildReleaseNotesModel } from "./release-notes.js";
import { buildReleaseReadiness } from "./release-readiness.js";
import { buildRepoSearch } from "./repo-search.js";
import { buildRepositoryProtectionAudit } from "./repository-protection.js";
import { buildReviewAssignment } from "./review-assignment.js";
import { deriveQueueItemRunState, deriveStewardRunState } from "./run-state.js";
import { applyStackDependencyEvidence } from "./stack-dependencies.js";
import { InMemoryQueueStore } from "./store.js";
import { buildValidationPlan as buildValidationPlanModel } from "./validation-plan.js";
import { parseForgejoWebhook, WebhookPayloadError } from "./webhook.js";
import { buildWorkContext } from "./work-context.js";
import {
  buildWorkDashboard,
  buildWorkViewEvaluation,
} from "./work-dashboard.js";
import { buildWorkIntakePlan } from "./work-intake.js";
import { buildWorkProgress } from "./work-progress.js";
import { buildWorkflowView } from "./workflow-view.js";

export class MergeSteward {
  constructor({
    config,
    store = new InMemoryQueueStore(),
    enrichmentClient,
    feedbackClient,
    integrationClient,
    forgejoClient,
    logger = console,
  } = {}) {
    this.config = config;
    this.store = store;
    this.enrichmentClient = enrichmentClient;
    this.feedbackClient = feedbackClient;
    this.integrationClient = integrationClient;
    this.forgejoClient = forgejoClient;
    this.logger = logger;
  }

  async listQueue() {
    const items = await this.applyQueuePolicyEvidence(
      await this.store.listQueueItems(),
    );
    const policy = await this.effectivePolicy();
    return {
      items,
      running: items.filter((item) => item.queueState === "running"),
      scheduled: scheduleQueue(items, policy),
    };
  }

  async getQueueItem(id) {
    return this.store.getQueueItem(id);
  }

  async getQueueItemRunState(id) {
    return deriveQueueItemRunState(await this.store.getQueueItem(id));
  }

  async getQueueItemActionPlan(id, options = {}) {
    const queueItem = await this.store.getQueueItem(id);
    if (!queueItem) return null;

    const now = options.now ?? new Date().toISOString();
    const [queueSummary, mergeTrain] = await Promise.all([
      this.getMergeQueueSummary({
        repo: queueItem.repo,
        targetBranch: queueItem.targetBranch,
        now,
      }),
      this.getMergeTrainPlan({
        repo: queueItem.repo,
        targetBranch: queueItem.targetBranch,
        now,
      }),
    ]);
    const ownerAgentId = options.ownerAgentId ?? queueItem.ownerAgentId;
    const workflow = await this.getWorkflowView({
      repo: queueItem.repo,
      targetBranch: queueItem.targetBranch,
      ownerAgentId,
      mergeTrain,
      readiness: options.readiness ?? null,
      now,
    });

    const nowMs = Date.parse(now);
    return buildQueueItemActionPlan({
      queueItem,
      queueSummary,
      mergeTrain,
      workflow,
      runState: deriveQueueItemRunState(queueItem, {
        now: Number.isFinite(nowMs) ? nowMs : Date.now(),
      }),
      ownerAgentId,
      now,
    });
  }

  async claimNextQueueItem({ workerId, now } = {}) {
    const items = await this.applyQueuePolicyEvidence(
      await this.store.listQueueItems(),
      { now },
    );
    return this.store.claimNextQueueItem(
      scheduleQueue(items, await this.effectivePolicy()),
      { workerId, now },
    );
  }

  async claimNextQueueItems({ workerId, now } = {}) {
    const items = await this.applyQueuePolicyEvidence(
      await this.store.listQueueItems(),
      { now },
    );
    const policy = await this.effectivePolicy();
    const scheduled = scheduleQueue(items, policy);
    const plan = buildIntegrationPlan({
      items,
      policy,
      config: this.config.integration,
    });
    const candidates = plan.plans
      .map((itemPlan) =>
        scheduled.find((item) => queueItemMatchesPlan(item, itemPlan)),
      )
      .filter(Boolean);

    if (candidates.length > 1) {
      if (typeof this.store.claimQueueItems !== "function") {
        return { claimed: false, reason: "batch_claim_unavailable" };
      }
      return this.store.claimQueueItems(candidates, { workerId, now });
    }

    return this.store.claimNextQueueItem(scheduled, { workerId, now });
  }

  async finishQueueItem(id, options) {
    return this.store.finishQueueItem(id, options);
  }

  async failQueueItem(id, options) {
    return this.store.failQueueItem(id, options);
  }

  async overrideQueueItem(
    id,
    {
      approvedBy,
      reason,
      blockers,
      expiresAt,
      now = new Date().toISOString(),
    } = {},
  ) {
    if (!approvedBy || !reason) {
      throw new TypeError("Queue override requires approvedBy and reason");
    }

    const existing = await this.store.getQueueItem(id);
    if (!existing) return null;

    const override = {
      active: true,
      approvedBy,
      reason,
      blockers: Array.isArray(blockers) ? blockers : [],
      createdAt: now,
      expiresAt: expiresAt ?? null,
    };
    const item = await this.store.upsertQueueItem({
      ...existing,
      policyOverride: override,
      updatedAt: now,
    });
    const effectiveItem = await this.effectiveEvaluationItem(item);
    const decision = evaluateMergePolicy(
      effectiveItem,
      await this.effectivePolicy(),
    );
    const event = await this.appendQueueAuditEvent({
      item: effectiveItem,
      type: "PolicyOverrideApplied",
      actorId: approvedBy,
      payload: {
        override,
        decision: decisionSummary(decision),
      },
      now,
    });

    return { item: effectiveItem, decision, event };
  }

  async clearQueueItemOverride(
    id,
    { clearedBy, reason, now = new Date().toISOString() } = {},
  ) {
    if (!clearedBy || !reason) {
      throw new TypeError("Queue override clear requires clearedBy and reason");
    }

    const existing = await this.store.getQueueItem(id);
    if (!existing) return null;

    const previousOverride = existing.policyOverride ?? null;
    const item = await this.store.upsertQueueItem({
      ...existing,
      policyOverride: {
        ...(previousOverride ?? {}),
        active: false,
        clearedBy,
        clearReason: reason,
        clearedAt: now,
      },
      updatedAt: now,
    });
    const effectiveItem = await this.effectiveEvaluationItem(item);
    const decision = evaluateMergePolicy(
      effectiveItem,
      await this.effectivePolicy(),
    );
    const event = await this.appendQueueAuditEvent({
      item: effectiveItem,
      type: "PolicyOverrideCleared",
      actorId: clearedBy,
      payload: {
        previousOverride,
        reason,
        decision: decisionSummary(decision),
      },
      now,
    });

    return { item: effectiveItem, decision, event };
  }

  async requestApproval(approval) {
    if (approval?.runId && !(await this.store.getRun(approval.runId)))
      return null;
    const requested = await this.store.upsertApproval(approval);
    await this.applyApprovalRequest(requested);
    return requested;
  }

  async getApproval(id) {
    return this.store.getApproval(id);
  }

  async listApprovals(options) {
    return this.store.listApprovals(options);
  }

  async decideApproval(id, options) {
    const approval = await this.store.decideApproval(id, options);
    await this.applyApprovalDecision(approval);
    return approval;
  }

  async applyApprovalRequest(approval) {
    if (!approval?.runId) return;
    const run = await this.store.getRun(approval.runId);
    if (!run) return;

    await this.store.upsertRunNode({
      runId: approval.runId,
      nodeId: approval.nodeId ?? "human_approval",
      iteration: approval.iteration ?? 0,
      status: "waiting_approval",
      approvalId: approval.id,
      requestedAt: approval.requestedAt,
    });
    await this.store.upsertRun({
      ...run,
      status: "waiting_approval",
    });
    await this.store.appendRunEvent({
      runId: approval.runId,
      type: "ApprovalRequested",
      payload: {
        approvalId: approval.id,
        nodeId: approval.nodeId ?? "human_approval",
        requestedBy: approval.requestedBy ?? null,
      },
    });
  }

  async applyApprovalDecision(approval) {
    if (!approval?.runId) return;
    const run = await this.store.getRun(approval.runId);
    if (!run) return;

    const approved =
      approval.status === "approved" || approval.decision?.approved === true;
    const nodeId = approval.nodeId ?? "human_approval";
    const nodes = await this.store.listRunNodes(approval.runId);
    const node = nodes.find((candidate) => {
      return (
        candidate.nodeId === nodeId &&
        Number(candidate.iteration ?? 0) === Number(approval.iteration ?? 0)
      );
    });

    if (node) {
      await this.store.upsertRunNode({
        ...node,
        status: approved ? "succeeded" : "failed",
        completedAt: approval.decidedAt ?? new Date().toISOString(),
        completedByApprovalId: approval.id,
        output: {
          ...(node.output ?? {}),
          approval: {
            id: approval.id,
            status: approval.status,
            decidedBy: approval.decidedBy ?? null,
          },
        },
      });
    }

    await this.store.upsertRun({
      ...run,
      status: approved ? "running" : "failed",
      resumedByApprovalId: approved ? approval.id : run.resumedByApprovalId,
      resumedAt: approved
        ? (approval.decidedAt ?? new Date().toISOString())
        : run.resumedAt,
      lastError: approved ? (run.lastError ?? null) : "approval_denied",
    });
    await this.store.appendRunEvent({
      runId: approval.runId,
      type: "ApprovalDecided",
      payload: {
        approvalId: approval.id,
        approved,
        nodeId,
        decidedBy: approval.decidedBy ?? null,
      },
    });
  }

  async requestHumanInput(request) {
    if (request?.runId && !(await this.store.getRun(request.runId)))
      return null;
    return this.store.upsertHumanRequest(request);
  }

  async getHumanRequest(id) {
    return this.store.getHumanRequest(id);
  }

  async listHumanRequests(options) {
    return this.store.listHumanRequests(options);
  }

  async respondHumanRequest(id, options) {
    return this.store.respondHumanRequest(id, options);
  }

  async upsertWorkItem(item, options) {
    if (typeof this.store.upsertWorkItem !== "function") {
      throw new TypeError("Work item store is not available");
    }
    return this.store.upsertWorkItem(item, options);
  }

  async getWorkItem(id) {
    if (typeof this.store.getWorkItem !== "function") return null;
    return this.store.getWorkItem(id);
  }

  async listWorkItems(options) {
    if (typeof this.store.listWorkItems !== "function") return [];
    return this.store.listWorkItems(options);
  }

  async transitionWorkItem(id, options) {
    if (typeof this.store.transitionWorkItem !== "function") return null;
    return this.store.transitionWorkItem(id, options);
  }

  async upsertWorkCycle(cycle, options) {
    if (typeof this.store.upsertWorkCycle !== "function") {
      throw new TypeError("Work cycle store is not available");
    }
    return this.store.upsertWorkCycle(cycle, options);
  }

  async getWorkCycle(id) {
    if (typeof this.store.getWorkCycle !== "function") return null;
    return this.store.getWorkCycle(id);
  }

  async listWorkCycles(options) {
    if (typeof this.store.listWorkCycles !== "function") return [];
    return this.store.listWorkCycles(options);
  }

  async transitionWorkCycle(
    id,
    {
      state,
      transitionedBy,
      actorId,
      reason,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = await this.getWorkCycle(id);
    if (!existing) return null;
    return this.upsertWorkCycle(
      {
        ...existing,
        state,
        metadata: {
          ...(existing.metadata ?? {}),
          transitions: [
            ...arrayValue(existing.metadata?.transitions),
            {
              from: existing.state,
              to: state,
              actorId: transitionedBy ?? actorId ?? null,
              reason: reason == null ? null : String(reason),
              at: now,
            },
          ],
        },
        updatedBy: transitionedBy ?? actorId ?? existing.updatedBy,
        updatedAt: now,
      },
      { actorId: transitionedBy ?? actorId, now },
    );
  }

  async upsertWorkModule(module, options) {
    if (typeof this.store.upsertWorkModule !== "function") {
      throw new TypeError("Work module store is not available");
    }
    return this.store.upsertWorkModule(module, options);
  }

  async getWorkModule(id) {
    if (typeof this.store.getWorkModule !== "function") return null;
    return this.store.getWorkModule(id);
  }

  async listWorkModules(options) {
    if (typeof this.store.listWorkModules !== "function") return [];
    return this.store.listWorkModules(options);
  }

  async transitionWorkModule(
    id,
    {
      state,
      transitionedBy,
      actorId,
      reason,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = await this.getWorkModule(id);
    if (!existing) return null;
    return this.upsertWorkModule(
      {
        ...existing,
        state,
        metadata: {
          ...(existing.metadata ?? {}),
          transitions: [
            ...arrayValue(existing.metadata?.transitions),
            {
              from: existing.state,
              to: state,
              actorId: transitionedBy ?? actorId ?? null,
              reason: reason == null ? null : String(reason),
              at: now,
            },
          ],
        },
        updatedBy: transitionedBy ?? actorId ?? existing.updatedBy,
        updatedAt: now,
      },
      { actorId: transitionedBy ?? actorId, now },
    );
  }

  async upsertWorkView(view, options) {
    if (typeof this.store.upsertWorkView !== "function") {
      throw new TypeError("Work view store is not available");
    }
    return this.store.upsertWorkView(view, options);
  }

  async getWorkView(id) {
    if (typeof this.store.getWorkView !== "function") return null;
    return this.store.getWorkView(id);
  }

  async listWorkViews(options) {
    if (typeof this.store.listWorkViews !== "function") return [];
    return this.store.listWorkViews(options);
  }

  async transitionWorkView(
    id,
    {
      state,
      transitionedBy,
      actorId,
      reason,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = await this.getWorkView(id);
    if (!existing) return null;
    return this.upsertWorkView(
      {
        ...existing,
        state,
        metadata: {
          ...(existing.metadata ?? {}),
          transitions: [
            ...arrayValue(existing.metadata?.transitions),
            {
              from: existing.state,
              to: state,
              actorId: transitionedBy ?? actorId ?? null,
              reason: reason == null ? null : String(reason),
              at: now,
            },
          ],
        },
        updatedBy: transitionedBy ?? actorId ?? existing.updatedBy,
        updatedAt: now,
      },
      { actorId: transitionedBy ?? actorId, now },
    );
  }

  async evaluateWorkView(options = {}) {
    const id = options.id ?? options.viewId ?? options.workViewId;
    const inlineView = options.view ?? options.workView;
    const view = id ? await this.getWorkView(id) : inlineView;
    if (!view) {
      if (id) return null;
      throw new TypeError("Work view evaluation requires id or view");
    }

    const repo = options.repo ?? view.repo;
    const ownerAgentId = options.ownerAgentId ?? view.ownerAgentId;
    const [workItems, cycles, modules, pages] = await Promise.all([
      this.listWorkItems({
        repo,
        ownerAgentId,
      }),
      this.listWorkCycles({
        repo,
        ownerAgentId,
      }),
      this.listWorkModules({
        repo,
        ownerAgentId,
      }),
      this.listWorkPages({
        repo,
        ownerAgentId,
        state: "active",
      }),
    ]);

    return buildWorkViewEvaluation({
      view,
      workItems,
      cycles,
      modules,
      pages,
      repo,
      ownerAgentId,
      now: options.now,
      maxItems: options.maxItems,
      maxPages: options.maxPages,
    });
  }

  async upsertWorkPage(page, options) {
    if (typeof this.store.upsertWorkPage !== "function") {
      throw new TypeError("Work page store is not available");
    }
    return this.store.upsertWorkPage(page, options);
  }

  async getWorkPage(id) {
    if (typeof this.store.getWorkPage !== "function") return null;
    return this.store.getWorkPage(id);
  }

  async listWorkPages(options) {
    if (typeof this.store.listWorkPages !== "function") return [];
    return this.store.listWorkPages(options);
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
    const existing = await this.getWorkPage(id);
    if (!existing) return null;
    return this.upsertWorkPage(
      {
        ...existing,
        state,
        metadata: {
          ...(existing.metadata ?? {}),
          transitions: [
            ...arrayValue(existing.metadata?.transitions),
            {
              from: existing.state,
              to: state,
              actorId: transitionedBy ?? actorId ?? null,
              reason: reason == null ? null : String(reason),
              at: now,
            },
          ],
        },
        updatedBy: transitionedBy ?? actorId ?? existing.updatedBy,
        updatedAt: now,
      },
      { actorId: transitionedBy ?? actorId, now },
    );
  }

  async getWorkProgress(options = {}) {
    const [workItems, cycles, modules] = await Promise.all([
      this.listWorkItems({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
      this.listWorkCycles({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
      this.listWorkModules({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
    ]);
    return buildWorkProgress({
      workItems,
      cycles,
      modules,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      now: options.now,
    });
  }

  async getWorkDashboard(options = {}) {
    const [workItems, cycles, modules, views, pages] = await Promise.all([
      this.listWorkItems({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
      this.listWorkCycles({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
      this.listWorkModules({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
      this.listWorkViews({
        state: "active",
      }),
      this.listWorkPages({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
        state: "active",
      }),
    ]);
    const progress = buildWorkProgress({
      workItems,
      cycles,
      modules,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      now: options.now,
    });
    return buildWorkDashboard({
      workItems,
      cycles,
      modules,
      views,
      pages,
      progress,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      now: options.now,
      maxItemIds: options.maxItemIds,
    });
  }

  async getWorkIntakePlan(options = {}) {
    const [rawQueueItems, workItems] = await Promise.all([
      this.store.listQueueItems(),
      this.listWorkItems({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
    ]);
    const queueItems = await this.applyQueuePolicyEvidence(rawQueueItems, {
      now: options.now,
    });
    return buildWorkIntakePlan({
      queueItems,
      workItems,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      now: options.now,
      maxActions: options.maxActions,
    });
  }

  async applyWorkIntakePlan({
    confirm,
    repo,
    ownerAgentId,
    actionIds,
    actorId = "work-intake",
    now = new Date().toISOString(),
    maxActions,
  } = {}) {
    if (confirm !== true) {
      throw new TypeError("Work intake apply requires confirm=true");
    }

    const plan = await this.getWorkIntakePlan({
      repo,
      ownerAgentId,
      now,
      maxActions,
    });
    const selectedIds = new Set(arrayValue(actionIds).map(String));
    const selectedActions = plan.actions.filter(
      (action) =>
        action.type !== "noop" &&
        (selectedIds.size === 0 || selectedIds.has(action.id)),
    );
    const applied = [];

    for (const action of selectedActions) {
      const workItem = await this.upsertWorkItem(action.targetWorkItem, {
        actorId,
        now,
      });
      applied.push({
        actionId: action.id,
        type: action.type,
        workItemId: workItem.id,
        state: workItem.state,
      });
    }

    return {
      plan,
      applied: {
        count: applied.length,
        actions: applied,
      },
    };
  }

  async upsertRun(run) {
    return this.store.upsertRun(run);
  }

  async getRun(id) {
    return this.store.getRun(id);
  }

  async listRuns(options) {
    return this.store.listRuns(options);
  }

  async upsertRunNode(runId, node) {
    if (!(await this.store.getRun(runId))) return null;
    return this.store.upsertRunNode({ ...node, runId });
  }

  async listRunNodes(runId) {
    return this.store.listRunNodes(runId);
  }

  async startAttempt(runId, attempt) {
    if (!(await this.store.getRun(runId))) return null;
    return this.store.startAttempt({ ...attempt, runId });
  }

  async getAttempt(id) {
    return this.store.getAttempt(id);
  }

  async listAttempts(options) {
    return this.store.listAttempts(options);
  }

  async heartbeatAttempt(id, options) {
    return this.store.heartbeatAttempt(id, options);
  }

  async finishAttempt(id, options) {
    return this.store.finishAttempt(id, options);
  }

  async failAttempt(id, options) {
    return this.store.failAttempt(id, options);
  }

  async cancelAttempt(id, options) {
    return this.store.cancelAttempt(id, options);
  }

  async claimStaleAttempt(options) {
    return this.store.claimStaleAttempt(options);
  }

  async appendRunEvent(runId, event) {
    if (!(await this.store.getRun(runId))) return null;
    return this.store.appendRunEvent({ ...event, runId });
  }

  async listRunEvents(runId, options) {
    return this.store.listRunEvents(runId, options);
  }

  async getRunState(id) {
    const run = await this.store.getRun(id);
    if (!run) return null;
    return deriveStewardRunState(run, {
      nodes: await this.store.listRunNodes(id),
    });
  }

  async appendSignal(signal) {
    const stored = await this.store.appendSignal(signal);
    const resumedRuns = await this.resumeRunsForSignal(stored);
    const consumed =
      resumedRuns.length > 0
        ? await this.store.consumeSignal(stored.id, {
            consumerId: "merge-steward:signal-resume",
          })
        : null;

    return {
      signal: consumed ?? stored,
      resumedRuns,
    };
  }

  async listSignals(options) {
    return this.store.listSignals(options);
  }

  async consumeSignal(id, options) {
    return this.store.consumeSignal(id, options);
  }

  async claimAgentWork(claim, options) {
    return this.store.claimAgentWork(claim, options);
  }

  async claimNextAgentWork({
    ownerAgentId,
    repo,
    targetBranch,
    action,
    resourceKind,
    includeOtherOwners = false,
    dryRun = false,
    ttlMs,
    now = new Date().toISOString(),
  } = {}) {
    if (!ownerAgentId) {
      throw new TypeError("claimNextAgentWork requires ownerAgentId");
    }

    const insights = await this.getAgentInsights({
      repo,
      targetBranch,
      now,
      limit: 50,
    });
    const candidates = buildAgentClaimCandidates({
      insights,
      ownerAgentId,
      action,
      resourceKind,
      includeOtherOwners,
    });
    const attempted = [];

    for (const candidate of candidates) {
      const claim = buildClaimFromCandidate(candidate, { ownerAgentId, now });
      if (dryRun) {
        return {
          claimed: false,
          dryRun: true,
          candidate,
          claim,
          candidates,
        };
      }

      const result = await this.store.claimAgentWork(claim, { ttlMs, now });
      attempted.push({
        candidateId: candidate.id,
        itemId: candidate.itemId,
        resource: candidate.resource,
        claimed: result.claimed === true,
        reason: result.reason ?? null,
        claim: result.claim ?? null,
      });
      if (result.claimed === true) {
        return {
          claimed: true,
          candidate,
          claim: result.claim,
          attempted,
        };
      }
    }

    return {
      claimed: false,
      reason: attempted.length > 0 ? "claim_conflicts" : "no_claimable_work",
      candidates,
      attempted,
    };
  }

  async claimSuggestedAgentAssignment({
    ownerAgentId,
    repo,
    targetBranch,
    dryRun = false,
    ttlMs,
    now = new Date().toISOString(),
  } = {}) {
    if (!ownerAgentId) {
      throw new TypeError(
        "claimSuggestedAgentAssignment requires ownerAgentId",
      );
    }

    const capacity = await this.getAgentCapacity({
      repo,
      targetBranch,
      now,
      maxSuggestions: 50,
    });
    const suggestions = (capacity.assignmentSuggestions ?? []).filter(
      (suggestion) => suggestion.agentId === String(ownerAgentId),
    );
    const attempted = [];

    for (const suggestion of suggestions) {
      const claim = buildClaimFromAssignmentSuggestion(suggestion, {
        ownerAgentId,
        now,
      });
      if (dryRun) {
        return {
          claimed: false,
          dryRun: true,
          suggestion,
          claim,
          suggestions,
        };
      }

      const result = await this.store.claimAgentWork(claim, { ttlMs, now });
      attempted.push({
        suggestionId: suggestion.id,
        itemId: suggestion.itemId,
        resource: suggestion.resource,
        claimed: result.claimed === true,
        reason: result.reason ?? null,
        claim: result.claim ?? null,
      });
      if (result.claimed === true) {
        return {
          claimed: true,
          suggestion,
          claim: result.claim,
          attempted,
        };
      }
    }

    return {
      claimed: false,
      reason:
        attempted.length > 0 ? "claim_conflicts" : "no_suggested_assignment",
      suggestions,
      attempted,
    };
  }

  async getAgentClaim(id) {
    return this.store.getAgentClaim(id);
  }

  async listAgentClaims(options) {
    return this.store.listAgentClaims(options);
  }

  async renewAgentClaim(id, options) {
    return this.store.renewAgentClaim(id, options);
  }

  async releaseAgentClaim(id, options) {
    return this.store.releaseAgentClaim(id, options);
  }

  async transferAgentClaim(id, options) {
    return this.store.transferAgentClaim(id, options);
  }

  async upsertRepoPolicy(policy) {
    return this.store.upsertRepoPolicy(policy);
  }

  async getRepoPolicy(repo) {
    return this.store.getRepoPolicy(repo);
  }

  async listRepoPolicies() {
    return this.store.listRepoPolicies();
  }

  async upsertRegisteredAgent(agent, options) {
    if (typeof this.store.upsertRegisteredAgent !== "function") {
      throw new TypeError("Registered agent store is not available");
    }
    return this.store.upsertRegisteredAgent(agent, options);
  }

  async getRegisteredAgent(id) {
    if (typeof this.store.getRegisteredAgent !== "function") return null;
    return this.store.getRegisteredAgent(id);
  }

  async listRegisteredAgents(options) {
    if (typeof this.store.listRegisteredAgents !== "function") return [];
    return this.store.listRegisteredAgents(options);
  }

  async disableRegisteredAgent(id, options) {
    if (typeof this.store.disableRegisteredAgent !== "function") return null;
    return this.store.disableRegisteredAgent(id, options);
  }

  async listKnownAgentIds() {
    const configured = uniqueStrings(this.config.policy?.knownAgentIds);
    const registered = await this.listRegisteredAgents({ status: "active" });
    return uniqueStrings([
      ...configured,
      ...registered.map((agent) => agent.id),
    ]);
  }

  async isRegisteredAgentId(agentId) {
    if (!agentId) return false;
    return (await this.listKnownAgentIds()).includes(String(agentId).trim());
  }

  async getAgentIdentityRegistrySummary() {
    const configured = uniqueStrings(this.config.policy?.knownAgentIds);
    const activeRegisteredAgents = await this.listRegisteredAgents({
      status: "active",
    });
    const disabledRegisteredAgents = await this.listRegisteredAgents({
      status: "disabled",
    });
    const knownAgentIds = uniqueStrings([
      ...configured,
      ...activeRegisteredAgents.map((agent) => agent.id),
    ]);
    return {
      required:
        this.config.policy?.requireAgentIdentityRegistryForAgentPrs === true,
      configuredAgentIdCount: configured.length,
      persistedActiveAgentIdCount: activeRegisteredAgents.length,
      persistedDisabledAgentIdCount: disabledRegisteredAgents.length,
      knownAgentIdCount: knownAgentIds.length,
    };
  }

  async effectivePolicy() {
    return {
      ...this.config.policy,
      knownAgentIds: await this.listKnownAgentIds(),
    };
  }

  async getCoordinationSummary(options = {}) {
    const [rawQueueItems, claims, runs] = await Promise.all([
      this.store.listQueueItems(),
      this.store.listAgentClaims(),
      this.store.listRuns(),
    ]);
    const queueItems = await this.applyRepoPolicies(rawQueueItems);
    return buildCoordinationSummary({
      queueItems,
      claims,
      runs,
      now: options.now,
    });
  }

  async getFleetCoordination(options = {}) {
    return buildFleetCoordination({
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      claims: await this.store.listAgentClaims(),
      now: options.now,
      config: this.config,
    });
  }

  async getWorkContext(options = {}) {
    if (!options.ownerAgentId) {
      throw new TypeError("Work context requires ownerAgentId");
    }

    const now = options.now ?? new Date().toISOString();
    const searchQuery = options.query ?? options.q ?? options.ownerAgentId;
    const [
      bootstrap,
      inbox,
      workDashboard,
      workProgress,
      fleetCoordination,
      mergeQueue,
      routing,
      search,
      workPages,
    ] = await Promise.all([
      this.getAgentBootstrap({
        ownerAgentId: options.ownerAgentId,
        repo: options.repo,
        targetBranch: options.targetBranch,
        readiness: options.readiness ?? null,
        now,
      }),
      this.getAgentInbox({
        ownerAgentId: options.ownerAgentId,
        repo: options.repo,
        readiness: options.readiness ?? null,
        now,
      }),
      this.getWorkDashboard({
        ownerAgentId: options.ownerAgentId,
        repo: options.repo,
        now,
      }),
      this.getWorkProgress({
        ownerAgentId: options.ownerAgentId,
        repo: options.repo,
        now,
      }),
      this.getFleetCoordination({
        ownerAgentId: options.ownerAgentId,
        repo: options.repo,
        now,
      }),
      this.getMergeQueueSummary({
        repo: options.repo,
        targetBranch: options.targetBranch,
        readiness: options.readiness ?? null,
        now,
      }),
      this.getAgentRouting({
        ownerAgentId: options.ownerAgentId,
        repo: options.repo,
        targetBranch: options.targetBranch,
        since: options.since,
        maxRecommendations: options.maxRecommendations,
        now,
      }),
      this.search({
        query: searchQuery,
        repo: options.repo,
        targetBranch: options.targetBranch,
        ownerAgentId: options.ownerAgentId,
        kinds: options.kinds ?? [
          "work_item",
          "work_page",
          "pull_request",
          "claim",
          "run",
          "approval",
          "human_request",
        ],
        limits: {
          maxResults: options.maxSearchResults ?? 10,
          ...(options.searchLimits ?? {}),
        },
        now,
      }),
      this.listWorkPages({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
        state: "active",
      }),
    ]);

    return buildWorkContext({
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      targetBranch: options.targetBranch,
      query: searchQuery,
      now,
      bootstrap,
      inbox,
      workDashboard,
      workProgress,
      fleetCoordination,
      mergeQueue,
      routing,
      search,
      workPages,
    });
  }

  async getWorkflowView(options = {}) {
    const [
      rawQueueItems,
      workItems,
      workCycles,
      workModules,
      claims,
      runs,
      approvals,
      humanRequests,
    ] = await Promise.all([
      this.store.listQueueItems(),
      this.listWorkItems(),
      this.listWorkCycles({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
      this.listWorkModules({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
      this.store.listAgentClaims(),
      this.store.listRuns(),
      this.store.listApprovals(),
      this.store.listHumanRequests(),
    ]);
    const queueItems = await this.applyRepoPolicies(rawQueueItems);
    const workProgress = buildWorkProgress({
      workItems,
      cycles: workCycles,
      modules: workModules,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      now: options.now,
    });
    return buildWorkflowView({
      queueItems,
      workItems,
      workCycles,
      workModules,
      workProgress,
      claims,
      runs,
      approvals,
      humanRequests,
      readiness: options.readiness ?? null,
      mergeTrain: options.mergeTrain ?? null,
      now: options.now,
      repo: options.repo,
      targetBranch: options.targetBranch,
      ownerAgentId: options.ownerAgentId,
    });
  }

  async getProjectBoard(options = {}) {
    const policy = await this.effectivePolicy();
    const [
      rawQueueItems,
      workItems,
      workCycles,
      workModules,
      claims,
      runs,
      approvals,
      humanRequests,
    ] = await Promise.all([
      this.store.listQueueItems(),
      this.listWorkItems(),
      this.listWorkCycles({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
      this.listWorkModules({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
      }),
      this.store.listAgentClaims(),
      this.store.listRuns(),
      this.store.listApprovals(),
      this.store.listHumanRequests(),
    ]);
    const queueItems = await this.applyRepoPolicies(rawQueueItems);
    const workProgress = buildWorkProgress({
      workItems,
      cycles: workCycles,
      modules: workModules,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      now: options.now,
    });
    return buildProjectBoard({
      queueItems,
      workItems,
      workCycles,
      workModules,
      workProgress,
      claims,
      runs,
      approvals,
      humanRequests,
      readiness: options.readiness ?? null,
      now: options.now,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      includeEmptyColumns: options.includeEmptyColumns,
      policy,
      integrationConfig: this.config.integration,
    });
  }

  async getAgentInbox(options = {}) {
    const policy = await this.effectivePolicy();
    const [
      rawQueueItems,
      workItems,
      workCycles,
      workModules,
      claims,
      runs,
      approvals,
      humanRequests,
    ] = await Promise.all([
      this.store.listQueueItems(),
      this.listWorkItems(),
      this.listWorkCycles(),
      this.listWorkModules(),
      this.store.listAgentClaims(),
      this.store.listRuns(),
      this.store.listApprovals(),
      this.store.listHumanRequests(),
    ]);
    const queueItems = await this.applyRepoPolicies(rawQueueItems);
    const workProgress = buildWorkProgress({
      workItems,
      cycles: workCycles,
      modules: workModules,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      now: options.now,
    });
    return buildAgentInbox({
      queueItems,
      workItems,
      workCycles,
      workModules,
      workProgress,
      claims,
      runs,
      approvals,
      humanRequests,
      readiness: options.readiness ?? null,
      now: options.now,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      policy,
      integrationConfig: this.config.integration,
    });
  }

  async getAgentInsights(options = {}) {
    const policy = await this.effectivePolicy();
    const [rawQueueItems, claims, runs, approvals, humanRequests] =
      await Promise.all([
        this.store.listQueueItems(),
        this.store.listAgentClaims(),
        this.store.listRuns(),
        this.store.listApprovals(),
        this.store.listHumanRequests(),
      ]);
    const queueItems = await this.applyRepoPolicies(rawQueueItems);
    return buildAgentInsights({
      queueItems,
      claims,
      runs,
      approvals,
      humanRequests,
      policy,
      now: options.now,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      targetBranch: options.targetBranch,
      limit: options.limit,
    });
  }

  async getAgentCapacity(options = {}) {
    const policy = await this.effectivePolicy();
    const [rawQueueItems, claims, runs, approvals, humanRequests] =
      await Promise.all([
        this.store.listQueueItems(),
        this.store.listAgentClaims(),
        this.store.listRuns(),
        this.store.listApprovals(),
        this.store.listHumanRequests(),
      ]);
    const queueItems = await this.applyRepoPolicies(rawQueueItems);
    const insights = buildAgentInsights({
      queueItems,
      claims,
      runs,
      approvals,
      humanRequests,
      policy,
      now: options.now,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      targetBranch: options.targetBranch,
      limit: options.limit,
    });
    const performance = buildAgentPerformance({
      queueItems,
      claims,
      runs,
      now: options.now,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      targetBranch: options.targetBranch,
      since: options.since,
    });
    return buildAgentCapacity({
      insights,
      claims,
      runs,
      now: options.now,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      targetBranch: options.targetBranch,
      maxSuggestions: options.maxSuggestions,
      performance,
    });
  }

  async getAgentPerformance(options = {}) {
    const [rawQueueItems, claims, runs] = await Promise.all([
      this.store.listQueueItems(),
      this.store.listAgentClaims(),
      this.store.listRuns(),
    ]);
    const queueItems = await this.applyRepoPolicies(rawQueueItems);
    return buildAgentPerformance({
      queueItems,
      claims,
      runs,
      now: options.now,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      targetBranch: options.targetBranch,
      since: options.since,
    });
  }

  async getAgentRouting(options = {}) {
    const capacity = await this.getAgentCapacity({
      now: options.now,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      targetBranch: options.targetBranch,
      since: options.since,
      maxSuggestions: options.maxRecommendations,
    });
    return buildAgentRouting({
      capacity,
      now: options.now,
      maxRecommendations: options.maxRecommendations,
    });
  }

  async search(options = {}) {
    const [
      rawQueueItems,
      workItems,
      workCycles,
      workModules,
      workViews,
      workPages,
      claims,
      runs,
      approvals,
      humanRequests,
      signals,
    ] = await Promise.all([
      this.store.listQueueItems(),
      this.listWorkItems(),
      this.listWorkCycles(),
      this.listWorkModules(),
      this.listWorkViews(),
      this.listWorkPages(),
      this.store.listAgentClaims(),
      this.store.listRuns(),
      this.store.listApprovals(),
      this.store.listHumanRequests(),
      this.store.listSignals(),
    ]);
    const queueItems = await this.applyRepoPolicies(rawQueueItems);

    return buildRepoSearch({
      query: options.query ?? options.q,
      repo: options.repo,
      targetBranch: options.targetBranch,
      ownerAgentId: options.ownerAgentId,
      kinds: options.kinds,
      queueItems,
      workItems,
      workCycles,
      workModules,
      workViews,
      workPages,
      claims,
      runs,
      approvals,
      humanRequests,
      signals,
      documents: options.documents,
      limits: options.limits,
      now: options.now,
    });
  }

  async getAgentBootstrap(options = {}) {
    if (!options.ownerAgentId) {
      throw new TypeError("Agent bootstrap requires ownerAgentId");
    }

    const now = options.now ?? new Date().toISOString();
    const [
      inbox,
      routing,
      claims,
      registeredAgent,
      identityRegistry,
      knownAgentIds,
      mergeTrain,
    ] = await Promise.all([
      this.getAgentInbox({
        now,
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
        readiness: options.readiness ?? null,
      }),
      this.getAgentRouting({
        now,
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
        targetBranch: options.targetBranch,
        since: options.since,
        maxRecommendations: options.maxRecommendations,
      }),
      this.store.listAgentClaims({
        repo: options.repo,
        ownerAgentId: options.ownerAgentId,
        status: "active",
      }),
      this.getRegisteredAgent(options.ownerAgentId),
      this.getAgentIdentityRegistrySummary(),
      this.listKnownAgentIds(),
      this.getMergeTrainPlan({
        now,
        repo: options.repo,
        targetBranch: options.targetBranch,
      }),
    ]);

    return buildAgentBootstrap({
      agentId: options.ownerAgentId,
      repo: options.repo,
      targetBranch: options.targetBranch,
      now,
      config: this.config,
      knownAgentIds,
      registeredAgent,
      identityRegistry,
      inbox,
      routing,
      claims,
      mergeTrain,
      readiness: options.readiness ?? null,
    });
  }

  async getAgentCockpit(options = {}) {
    if (!options.ownerAgentId) {
      throw new TypeError("Agent cockpit requires ownerAgentId");
    }

    const now = options.now ?? new Date().toISOString();
    const mergeTrain = await this.getMergeTrainPlan({
      now,
      repo: options.repo,
      targetBranch: options.targetBranch,
      maxLanes: options.maxLanes,
      maxLaneItems: options.maxLaneItems,
    });
    const hasProposedWork =
      Boolean(options.proposedItem) ||
      arrayValue(options.changedFiles).length > 0 ||
      arrayValue(options.affectedPackages).length > 0;
    const [workflow, workContext, preflight, submissionGate] =
      await Promise.all([
        this.getWorkflowView({
          ownerAgentId: options.ownerAgentId,
          repo: options.repo,
          targetBranch: options.targetBranch,
          readiness: options.readiness ?? null,
          mergeTrain,
          now,
        }),
        this.getWorkContext({
          ownerAgentId: options.ownerAgentId,
          repo: options.repo,
          targetBranch: options.targetBranch,
          query: options.query,
          kinds: options.kinds,
          maxSearchResults: options.maxSearchResults,
          maxRecommendations: options.maxRecommendations,
          readiness: options.readiness ?? null,
          now,
        }),
        hasProposedWork
          ? this.getAgentWorkPreflight({
              ownerAgentId: options.ownerAgentId,
              repo: options.repo,
              targetBranch: options.targetBranch,
              proposedItem: options.proposedItem,
              changedFiles: options.changedFiles,
              affectedPackages: options.affectedPackages,
              requireAgentBranchNamespace: options.requireAgentBranchNamespace,
              agentBranchNamespacePrefix: options.agentBranchNamespacePrefix,
              limits: options.limits,
              now,
            })
          : null,
        hasProposedWork
          ? this.getAgentSubmissionGate({
              ownerAgentId: options.ownerAgentId,
              repo: options.repo,
              targetBranch: options.targetBranch,
              proposedItem: options.proposedItem,
              validationCommands: options.validationCommands,
              requestedValidationCommands: options.requestedValidationCommands,
              allowBroadValidationCommands:
                options.allowBroadValidationCommands,
              validationLimits: options.validationLimits,
              requireWorkItem: options.requireWorkItem,
              requireWorkReservation: options.requireWorkReservation,
              requireAgentBranchNamespace: options.requireAgentBranchNamespace,
              requireAgentIdentityRegistry:
                options.requireAgentIdentityRegistry,
              agentBranchNamespacePrefix: options.agentBranchNamespacePrefix,
              limits: options.limits,
              now,
            })
          : null,
      ]);

    return buildAgentCockpit({
      agentId: options.ownerAgentId,
      repo: options.repo,
      targetBranch: options.targetBranch,
      now,
      workflow,
      workContext,
      preflight,
      submissionGate,
    });
  }

  async getAgentActionPlan(options = {}) {
    if (!options.ownerAgentId) {
      throw new TypeError("Agent action plan requires ownerAgentId");
    }

    const now = options.now ?? new Date().toISOString();
    const proposedItem = proposedWorkItemFor({
      proposedItem: options.proposedItem ?? options.item,
      ownerAgentId: options.ownerAgentId,
      repo: options.repo,
      targetBranch: options.targetBranch,
      changedFiles: options.changedFiles,
      affectedPackages: options.affectedPackages,
    });
    const [bootstrap, inbox, routing, search] = await Promise.all([
      this.getAgentBootstrap({
        ownerAgentId: options.ownerAgentId,
        repo: options.repo,
        targetBranch: options.targetBranch,
        since: options.since,
        maxRecommendations: options.maxRecommendations,
        readiness: options.readiness ?? null,
        now,
      }),
      this.getAgentInbox({
        ownerAgentId: options.ownerAgentId,
        repo: options.repo,
        readiness: options.readiness ?? null,
        now,
      }),
      this.getAgentRouting({
        ownerAgentId: options.ownerAgentId,
        repo: options.repo,
        targetBranch: options.targetBranch,
        since: options.since,
        maxRecommendations: options.maxRecommendations,
        now,
      }),
      this.search({
        query: options.searchQuery ?? options.query ?? options.q,
        repo: options.repo,
        targetBranch: options.targetBranch,
        ownerAgentId: options.ownerAgentId,
        kinds: options.searchKinds ?? options.kinds,
        documents: options.documents,
        limits: options.searchLimits,
        now,
      }),
    ]);

    const proposedChecks = proposedItem
      ? await this.getProposedAgentActionPlanChecks({
          ownerAgentId: options.ownerAgentId,
          repo: options.repo,
          targetBranch: options.targetBranch,
          proposedItem,
          changedFiles: options.changedFiles,
          affectedPackages: options.affectedPackages,
          validationCommands: options.validationCommands ?? options.commands,
          requestedValidationCommands:
            options.requestedValidationCommands ?? options.requestedCommands,
          allowBroadValidationCommands:
            options.allowBroadValidationCommands === true ||
            options.allowBroadCommands === true,
          validationLimits: options.validationLimits,
          targetCommitsBehind: options.targetCommitsBehind,
          requireWorkItem:
            options.requireWorkItem === true || options.requireWorkLink === true
              ? true
              : undefined,
          requireWorkReservation:
            options.requireWorkReservation === true ||
            options.requireReservation === true
              ? true
              : undefined,
          requireAgentBranchNamespace:
            options.requireAgentBranchNamespace === true ||
            options.requireBranchNamespace === true
              ? true
              : undefined,
          requireAgentIdentityRegistry:
            options.requireAgentIdentityRegistry === true ||
            options.requireIdentityRegistry === true
              ? true
              : undefined,
          agentBranchNamespacePrefix:
            options.agentBranchNamespacePrefix ?? options.branchNamespacePrefix,
          limits: options.limits,
          now,
        })
      : {};

    return buildAgentActionPlan({
      agentId: options.ownerAgentId,
      repo: options.repo,
      targetBranch: options.targetBranch,
      proposedItem,
      changedFiles: options.changedFiles,
      affectedPackages: options.affectedPackages,
      bootstrap,
      inbox,
      routing,
      search,
      ...proposedChecks,
      limits: options.planLimits ?? options.limits,
      now,
    });
  }

  async getProposedAgentActionPlanChecks(options = {}) {
    const validationPlan = await this.buildValidationPlan({
      item: options.proposedItem,
      changedFiles: options.changedFiles,
      affectedPackages: options.affectedPackages,
      commands: options.validationCommands,
      requestedCommands: options.requestedValidationCommands,
      limits: options.validationLimits,
      allowBroadCommands: options.allowBroadValidationCommands,
      now: options.now,
    });
    const [preflight, conflictPrediction, submissionGate, reviewAssignment] =
      await Promise.all([
        this.getAgentWorkPreflight({
          ownerAgentId: options.ownerAgentId,
          repo: options.repo,
          targetBranch: options.targetBranch,
          proposedItem: options.proposedItem,
          changedFiles: options.changedFiles,
          affectedPackages: options.affectedPackages,
          requireAgentBranchNamespace: options.requireAgentBranchNamespace,
          agentBranchNamespacePrefix: options.agentBranchNamespacePrefix,
          limits: options.limits,
          now: options.now,
        }),
        this.predictPatchConflicts({
          ownerAgentId: options.ownerAgentId,
          repo: options.repo,
          targetBranch: options.targetBranch,
          proposedItem: options.proposedItem,
          changedFiles: options.changedFiles,
          affectedPackages: options.affectedPackages,
          targetCommitsBehind: options.targetCommitsBehind,
          limits: options.limits,
          now: options.now,
        }),
        this.getAgentSubmissionGate({
          ownerAgentId: options.ownerAgentId,
          repo: options.repo,
          targetBranch: options.targetBranch,
          proposedItem: options.proposedItem,
          validationPlan,
          validationCommands: options.validationCommands,
          requestedValidationCommands: options.requestedValidationCommands,
          allowBroadValidationCommands: options.allowBroadValidationCommands,
          validationLimits: options.validationLimits,
          requireWorkItem: options.requireWorkItem,
          requireWorkReservation: options.requireWorkReservation,
          requireAgentBranchNamespace: options.requireAgentBranchNamespace,
          requireAgentIdentityRegistry: options.requireAgentIdentityRegistry,
          agentBranchNamespacePrefix: options.agentBranchNamespacePrefix,
          limits: options.limits,
          now: options.now,
        }),
        this.assignReviewers({
          proposedItem: options.proposedItem,
          repo: options.repo,
          targetBranch: options.targetBranch,
          ownerAgentId: options.ownerAgentId,
          changedFiles: options.changedFiles,
          affectedPackages: options.affectedPackages,
          limits: options.limits,
          now: options.now,
        }),
      ]);

    return {
      preflight,
      validationPlan,
      submissionGate,
      conflictPrediction,
      reviewAssignment,
    };
  }

  async getReleaseReadiness(options = {}) {
    const [mergeQueue, routing, performance, workflow] = await Promise.all([
      this.getMergeQueueSummary(options),
      this.getAgentRouting(options),
      this.getAgentPerformance(options),
      this.getWorkflowView({
        ...options,
        readiness: null,
      }),
    ]);
    const repositoryProtection =
      options.requireRepositoryProtection === true ||
      options.includeRepositoryProtection === true
        ? await this.getRepositoryProtection({
            repo: options.repo,
            targetBranch: options.targetBranch,
            requireLive: options.requireLiveProtection === true,
            now: options.now,
          })
        : null;
    return buildReleaseReadiness({
      mergeQueue,
      routing,
      performance,
      workflow,
      readiness: options.readiness ?? null,
      repositoryProtection,
      now: options.now,
      repo: options.repo,
      targetBranch: options.targetBranch,
      requireLiveMerge: options.requireLiveMerge,
      requireRoutableAgent: options.requireRoutableAgent,
      requireRepositoryProtection: options.requireRepositoryProtection,
      limits: options.limits,
    });
  }

  async getRepositoryProtection(options = {}) {
    if (!options.repo) {
      throw new TypeError("Repository protection audit requires repo");
    }

    const [policy, live] = await Promise.all([
      this.getRepoPolicy(options.repo),
      this.fetchRepositoryProtectionLive({ repo: options.repo }),
    ]);

    return buildRepositoryProtectionAudit({
      repo: options.repo,
      targetBranch: options.targetBranch,
      policy,
      live,
      config: this.config?.enrichment,
      requireLive: options.requireLive === true,
      now: options.now,
    });
  }

  async fetchRepositoryProtectionLive({ repo } = {}) {
    if (
      !this.forgejoClient ||
      typeof this.forgejoClient.listBranchProtections !== "function"
    ) {
      return {
        available: false,
        checked: false,
        source: "forgejo",
        reason: "forgejo_client_unavailable",
        protections: [],
      };
    }

    const forgejoRepo = repoSlugToObject(repo);
    if (!forgejoRepo) {
      return {
        available: false,
        checked: false,
        source: "forgejo",
        reason: "invalid_repo_slug",
        protections: [],
      };
    }

    try {
      return {
        available: true,
        checked: true,
        source: "forgejo",
        protections:
          await this.forgejoClient.listBranchProtections(forgejoRepo),
      };
    } catch (error) {
      // error-policy:J1 Forgejo branch-protection probe: failure becomes an
      // explicit unavailable result the gate reports
      return {
        available: false,
        checked: true,
        source: "forgejo",
        error:
          error instanceof Error
            ? error.message
            : "forgejo_branch_protection_unavailable",
        protections: [],
      };
    }
  }

  async getAgentSubmissionGate(options = {}) {
    if (!options.ownerAgentId) {
      throw new TypeError("Agent submission gate requires ownerAgentId");
    }

    const capacity = await this.getAgentCapacity({
      now: options.now,
      repo: options.repo,
      ownerAgentId: options.ownerAgentId,
      targetBranch: options.targetBranch,
      since: options.since,
      maxSuggestions: options.maxSuggestions,
    });
    const claims =
      typeof this.store.listAgentClaims === "function"
        ? await this.store.listAgentClaims({
            repo: options.repo ?? options.proposedItem?.repo,
            ownerAgentId: options.ownerAgentId,
            status: "active",
          })
        : [];
    const policy = await this.effectivePolicy();
    const requireWorkItem =
      options.requireWorkItem ?? policy.requireWorkItemForAgentPrs;
    const requireWorkReservation =
      options.requireWorkReservation ??
      policy.requireWorkReservationForAgentPrs;
    const workItemLink =
      requireWorkItem === true
        ? await this.workItemLinkForQueueItem({
            ...(options.proposedItem ?? {}),
            repo: options.repo ?? options.proposedItem?.repo,
            targetBranch:
              options.targetBranch ?? options.proposedItem?.targetBranch,
            ownerAgentId:
              options.ownerAgentId ?? options.proposedItem?.ownerAgentId,
            authorKind: options.proposedItem?.authorKind ?? "agent",
          })
        : null;
    return buildAgentSubmissionGate({
      capacity,
      ownerAgentId: options.ownerAgentId,
      repo: options.repo,
      targetBranch: options.targetBranch,
      proposedItem: options.proposedItem,
      validationPlan: options.validationPlan,
      validationCommands: options.validationCommands,
      requestedValidationCommands: options.requestedValidationCommands,
      allowBroadValidationCommands: options.allowBroadValidationCommands,
      validationLimits: options.validationLimits,
      claims,
      workItemLink,
      requireWorkItem,
      requireWorkReservation,
      requireAgentBranchNamespace:
        options.requireAgentBranchNamespace ??
        policy.requireAgentBranchNamespaceForAgentPrs,
      requireAgentIdentityRegistry:
        options.requireAgentIdentityRegistry ??
        policy.requireAgentIdentityRegistryForAgentPrs,
      knownAgentIds: policy.knownAgentIds,
      agentBranchNamespacePrefix:
        options.agentBranchNamespacePrefix ?? policy.agentBranchNamespacePrefix,
      limits: options.limits,
      now: options.now,
    });
  }

  async getAgentWorkPreflight(options = {}) {
    if (!options.ownerAgentId) {
      throw new TypeError("Agent work preflight requires ownerAgentId");
    }

    const [queueItems, claims, workItems] = await Promise.all([
      this.applyRepoPolicies(await this.store.listQueueItems()),
      this.store.listAgentClaims(),
      this.listWorkItems({ repo: options.repo }),
    ]);

    return buildAgentWorkPreflight({
      queueItems,
      claims,
      workItems,
      ownerAgentId: options.ownerAgentId,
      repo: options.repo,
      targetBranch: options.targetBranch,
      proposedItem: options.proposedItem,
      changedFiles: options.changedFiles,
      affectedPackages: options.affectedPackages,
      requireAgentBranchNamespace:
        options.requireAgentBranchNamespace ??
        this.config.policy?.requireAgentBranchNamespaceForAgentPrs,
      agentBranchNamespacePrefix:
        options.agentBranchNamespacePrefix ??
        this.config.policy?.agentBranchNamespacePrefix,
      limits: options.limits,
      now: options.now,
    });
  }

  async reserveAgentWork({
    ownerAgentId,
    repo,
    targetBranch,
    proposedItem,
    changedFiles,
    affectedPackages,
    limits,
    ttlMs,
    dryRun = false,
    allowWatch = true,
    maxClaims,
    createWorkItem = true,
    workItem,
    now = new Date().toISOString(),
  } = {}) {
    if (!ownerAgentId) {
      throw new TypeError("reserveAgentWork requires ownerAgentId");
    }

    const preflight = await this.getAgentWorkPreflight({
      ownerAgentId,
      repo,
      targetBranch,
      proposedItem,
      changedFiles,
      affectedPackages,
      requireAgentBranchNamespace:
        this.config.policy?.requireAgentBranchNamespaceForAgentPrs,
      agentBranchNamespacePrefix:
        this.config.policy?.agentBranchNamespacePrefix,
      limits,
      now,
    });
    const requestedClaims = claimsFromWorkPreflight(preflight, { maxClaims });
    const plannedWorkItem =
      createWorkItem === false
        ? null
        : workItemFromReservationPreflight({
            preflight,
            workItem,
            now,
          });

    if (!preflight.decision.allowed) {
      return workReservationResult({
        reserved: false,
        reason: "preflight_blocked",
        preflight,
        requestedClaims,
        plannedWorkItem,
        workItemAction: plannedWorkItem ? "blocked" : "disabled",
      });
    }

    if (preflight.decision.state === "watch" && allowWatch !== true) {
      return workReservationResult({
        reserved: false,
        reason: "preflight_watch_requires_ack",
        preflight,
        requestedClaims,
        plannedWorkItem,
        workItemAction: plannedWorkItem ? "watch_requires_ack" : "disabled",
      });
    }

    if (requestedClaims.length === 0) {
      return workReservationResult({
        reserved: false,
        reason: "no_claims_suggested",
        preflight,
        requestedClaims,
        plannedWorkItem,
        workItemAction: plannedWorkItem ? "not_created" : "disabled",
      });
    }

    if (dryRun) {
      return workReservationResult({
        reserved: false,
        dryRun: true,
        reason: "dry_run",
        preflight,
        requestedClaims,
        plannedWorkItem,
        workItemAction: plannedWorkItem ? "planned" : "disabled",
      });
    }

    const attempted = [];
    const claims = [];

    for (const claim of requestedClaims) {
      const result = await this.store.claimAgentWork(claim, { ttlMs, now });
      attempted.push({
        resourceKind: claim.resourceKind,
        resourceId: claim.resourceId,
        claimed: result.claimed === true,
        reason: result.reason ?? null,
        claim: result.claim ?? null,
      });

      if (result.claimed !== true) {
        const rolledBackClaims = [];
        for (const reservedClaim of claims.toReversed()) {
          const released = await this.store.releaseAgentClaim(
            reservedClaim.id,
            {
              ownerAgentId,
              reason: "reservation_rollback_after_conflict",
              now,
            },
          );
          if (released) rolledBackClaims.push(released);
        }

        return workReservationResult({
          reserved: false,
          reason: "claim_conflict",
          preflight,
          requestedClaims,
          attempted,
          claims,
          rolledBackClaims,
        });
      }

      claims.push(result.claim);
    }

    let reservedWorkItem = null;
    if (plannedWorkItem) {
      try {
        reservedWorkItem = await this.upsertWorkItem(plannedWorkItem, {
          actorId: ownerAgentId,
          now,
        });
      } catch (error) {
        // error-policy:J1 reservation boundary: roll back the claims reserved
        // so far and return a structured failed reservation
        const rolledBackClaims = [];
        for (const reservedClaim of claims.toReversed()) {
          const released = await this.store.releaseAgentClaim(
            reservedClaim.id,
            {
              ownerAgentId,
              reason: "reservation_rollback_after_work_item_error",
              now,
            },
          );
          if (released) rolledBackClaims.push(released);
        }

        return workReservationResult({
          reserved: false,
          reason: "work_item_create_failed",
          preflight,
          requestedClaims,
          attempted,
          claims,
          rolledBackClaims,
          plannedWorkItem,
          workItemAction: "failed",
          workItemError:
            error instanceof Error ? error.message : "Unknown Work item error",
        });
      }
    }

    return workReservationResult({
      reserved: true,
      reason: "reserved",
      preflight,
      requestedClaims,
      attempted,
      claims,
      workItem: reservedWorkItem,
      plannedWorkItem,
      workItemAction: reservedWorkItem ? "upserted" : "disabled",
    });
  }

  async analyzeCiFailures({ queueItemId, item, checks, logs, now } = {}) {
    const queueItem =
      item ?? (queueItemId ? await this.store.getQueueItem(queueItemId) : null);

    return buildCiFailureAnalysis({
      queueItem,
      queueItemId,
      checks,
      logs,
      now,
    });
  }

  async buildValidationPlan({
    queueItemId,
    item,
    changedFiles,
    affectedPackages,
    commands,
    requestedCommands,
    limits,
    allowBroadCommands,
    now,
  } = {}) {
    const queueItem =
      item ?? (queueItemId ? await this.store.getQueueItem(queueItemId) : null);

    return buildValidationPlanModel({
      queueItem,
      repo: item?.repo,
      ownerAgentId: item?.ownerAgentId,
      changedFiles: changedFiles ?? item?.changedFiles,
      affectedPackages: affectedPackages ?? item?.affectedPackages,
      commands,
      requestedCommands,
      limits,
      allowBroadCommands,
      now,
    });
  }

  async buildPullRequestBrief({
    queueItemId,
    item,
    ciAnalysis,
    validationPlan,
    validationCommands,
    requestedValidationCommands,
    allowBroadValidationCommands,
    validationLimits,
    submissionGate,
    reviewAssignment,
    requireWorkReservation = false,
    now,
  } = {}) {
    const queueItem =
      item ?? (queueItemId ? await this.store.getQueueItem(queueItemId) : null);
    const computedSubmissionGate =
      submissionGate ??
      (await this.submissionGateForBrief(queueItem, {
        requireWorkReservation,
        now,
      }));
    const computedReviewAssignment =
      reviewAssignment ??
      (await this.assignReviewers({
        item: queueItem,
        now,
      }));
    const policy = await this.effectivePolicy();

    return buildPullRequestBriefModel({
      queueItem: queueItem ?? {},
      policy,
      ciAnalysis,
      validationPlan,
      validationCommands,
      requestedValidationCommands,
      allowBroadValidationCommands,
      validationLimits,
      submissionGate: computedSubmissionGate,
      reviewAssignment: computedReviewAssignment,
      now,
    });
  }

  async buildReleaseNotes({
    items,
    repo,
    targetBranch,
    from,
    to,
    version,
    title,
    now,
  } = {}) {
    const sourceItems = Array.isArray(items)
      ? items
      : await this.store.listQueueItems();

    return buildReleaseNotesModel({
      items: sourceItems,
      repo,
      targetBranch,
      from,
      to,
      version,
      title,
      now,
    });
  }

  async predictPatchConflicts(options = {}) {
    const [queueItems, claims] = await Promise.all([
      this.applyRepoPolicies(await this.store.listQueueItems()),
      this.store.listAgentClaims(),
    ]);

    return buildPatchConflictPrediction({
      queueItems,
      claims,
      proposedItem: options.proposedItem ?? options.item,
      repo: options.repo,
      targetBranch: options.targetBranch,
      ownerAgentId: options.ownerAgentId,
      changedFiles: options.changedFiles,
      affectedPackages: options.affectedPackages,
      targetCommitsBehind: options.targetCommitsBehind,
      limits: options.limits,
      now: options.now,
    });
  }

  async assignReviewers(options = {}) {
    const queueItem =
      options.item ??
      options.queueItem ??
      (options.queueItemId
        ? await this.store.getQueueItem(options.queueItemId)
        : null);
    const proposedItem = options.proposedItem ?? queueItem;
    const now = options.now ?? new Date().toISOString();
    const repo = options.repo ?? proposedItem?.repo;
    const targetBranch = options.targetBranch ?? proposedItem?.targetBranch;
    const ownerAgentId = options.ownerAgentId ?? proposedItem?.ownerAgentId;
    const [registeredAgents, claims, capacity] = await Promise.all([
      this.listRegisteredAgents({ status: "active" }),
      this.store.listAgentClaims(),
      this.getAgentCapacity({
        now,
        repo,
        targetBranch,
        maxSuggestions: options.maxSuggestions,
      }),
    ]);

    return buildReviewAssignment({
      registeredAgents,
      claims,
      capacity,
      queueItem,
      proposedItem,
      repo,
      targetBranch,
      ownerAgentId,
      changedFiles: options.changedFiles,
      affectedPackages: options.affectedPackages,
      limits: options.limits,
      now,
    });
  }

  async submissionGateForBrief(
    item,
    { requireWorkReservation = false, now } = {},
  ) {
    if (item?.authorKind !== "agent" || !item.ownerAgentId) return null;

    return this.getAgentSubmissionGate({
      ownerAgentId: item.ownerAgentId,
      repo: item.repo,
      targetBranch: item.targetBranch,
      proposedItem: {
        repo: item.repo,
        pullRequestId: item.pullRequestId,
        sourceBranch: item.sourceBranch,
        targetBranch: item.targetBranch,
        ownerAgentId: item.ownerAgentId,
        authorKind: item.authorKind,
        agentKnown: item.agentKnown,
        hasIssueLink: item.hasIssueLink,
        hasExecutionPlan: item.hasExecutionPlan,
        hasValidationPlan: item.hasValidationPlan,
        changedLines: item.changedLines,
        changedFiles: item.changedFiles,
        affectedPackages: item.affectedPackages,
      },
      requireWorkReservation,
      now,
    });
  }

  async getMergeQueueSummary(options = {}) {
    const queueItems = await this.applyQueuePolicyEvidence(
      await this.store.listQueueItems(),
      { now: options.now },
    );
    const policy = await this.effectivePolicy();
    return buildMergeQueueSummary({
      queueItems,
      policy,
      config: this.config.integration,
      now: options.now,
      repo: options.repo,
      targetBranch: options.targetBranch,
    });
  }

  async getMergeTrainPlan(options = {}) {
    const queueItems = await this.applyQueuePolicyEvidence(
      await this.store.listQueueItems(),
      { now: options.now },
    );
    const policy = await this.effectivePolicy();
    return buildMergeTrainPlan({
      queueItems,
      policy,
      config: this.config.integration,
      now: options.now,
      repo: options.repo,
      targetBranch: options.targetBranch,
      maxLanes: options.maxLanes,
      maxLaneItems: options.maxLaneItems,
    });
  }

  async simulateQueue(options = {}) {
    const includeStoredQueue = options.includeStoredQueue !== false;
    const rawCurrentItems = Array.isArray(options.currentItems)
      ? options.currentItems
      : includeStoredQueue
        ? await this.store.listQueueItems()
        : [];
    const currentItems = await this.applyQueuePolicyEvidence(rawCurrentItems, {
      now: options.now,
    });
    const rawProposedItems = normalizeSimulationProposedItems(options);
    const proposedItems = await this.applyQueuePolicyEvidence(
      rawProposedItems,
      { now: options.now },
    );
    const policy = await this.effectivePolicy();

    return buildQueueSimulation({
      currentItems,
      proposedItems,
      policy,
      config: this.config.integration,
      now: options.now,
      repo: options.repo,
      targetBranch: options.targetBranch,
    });
  }

  async resumeRunsForSignal(signal) {
    if (!signal?.correlationKey && !signal?.runId) return [];

    const candidateRuns = signal.runId
      ? [await this.store.getRun(signal.runId)]
      : await this.store.listRuns({ status: "waiting_event" });
    const resumedRuns = [];

    for (const run of candidateRuns.filter(Boolean)) {
      const nodes = await this.store.listRunNodes(run.id);
      const matchingNode = nodes.find((node) =>
        nodeWaitsForSignal(node, signal, run),
      );
      if (!matchingNode && !runWaitsForSignal(run, signal)) continue;

      if (matchingNode) {
        await this.store.upsertRunNode({
          ...matchingNode,
          status: "succeeded",
          completedAt: signal.createdAt ?? new Date().toISOString(),
          completedBySignalId: signal.id,
          output: {
            ...(matchingNode.output ?? {}),
            signal: {
              id: signal.id,
              type: signal.type ?? null,
              correlationKey: signal.correlationKey ?? null,
            },
          },
        });
      }

      const nextRun = await this.store.upsertRun({
        ...run,
        status: "running",
        resumedBySignalId: signal.id,
        resumedAt: signal.createdAt ?? new Date().toISOString(),
      });
      await this.store.appendRunEvent({
        runId: run.id,
        type: "SignalReceived",
        payload: {
          signalId: signal.id,
          signalType: signal.type ?? null,
          correlationKey: signal.correlationKey ?? null,
          nodeId: matchingNode?.nodeId ?? null,
        },
      });
      resumedRuns.push(nextRun);
    }

    return resumedRuns;
  }

  async evaluateItem(input) {
    const item = await this.effectiveEvaluationItem(input);
    return evaluateMergePolicy(item, await this.effectivePolicy());
  }

  async effectiveEvaluationItem(input) {
    const contextItems = mergeEvaluationInput(
      await this.store.listQueueItems(),
      input,
    );
    const effectiveItems = await this.applyQueuePolicyEvidence(contextItems);
    return (
      findEvaluationItem(effectiveItems, input) ??
      effectiveItems.at(-1) ??
      input
    );
  }

  async scheduleItems(items = []) {
    return scheduleQueue(
      await this.applyQueuePolicyEvidence(items),
      await this.effectivePolicy(),
    );
  }

  async planIntegration(items) {
    const queueItems = items ?? (await this.store.listQueueItems());
    const effectiveItems = await this.applyQueuePolicyEvidence(queueItems);
    const policy = await this.effectivePolicy();
    return buildIntegrationPlan({
      items: effectiveItems,
      policy,
      config: this.config.integration,
    });
  }

  async executeIntegration(
    items,
    { confirmed = false, beforeIntegrationAction } = {},
  ) {
    const planItems = this.isLiveIntegrationExecution()
      ? await this.loadLiveIntegrationItems()
      : items;
    const plan = await this.planIntegration(planItems);
    const execution = await executeIntegrationPlan({
      plan,
      client: this.integrationClient,
      config: this.config.integration,
      confirmed,
      beforeAction: beforeIntegrationAction,
    });

    return {
      plan,
      execution,
    };
  }

  async recoverStaleQueueItems({
    workerId = "merge-steward",
    now = new Date().toISOString(),
    staleAfterMs = this.config.worker?.staleQueueItemMs ?? 120000,
  } = {}) {
    const thresholdMs = Math.max(0, Number(staleAfterMs) || 0);
    const recovered = [];
    const items = await this.store.listQueueItems();

    for (const item of items) {
      if (!RECOVERABLE_QUEUE_STATES.has(item.queueState)) continue;

      const run = await this.findActiveRunForQueueItem(item);
      const activeAttempts =
        run && typeof this.store.listAttempts === "function"
          ? (await this.store.listAttempts({ runId: run.id })).filter(
              (attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status),
            )
          : [];
      const latestActiveAt = latestIso([
        item.updatedAt,
        item.claimedAt,
        run?.heartbeatAt,
        run?.updatedAt,
        run?.startedAt,
        ...activeAttempts.flatMap((attempt) => [
          attempt.heartbeatAt,
          attempt.updatedAt,
          attempt.startedAt,
        ]),
      ]);
      if (!isTimestampStale(latestActiveAt, now, thresholdMs)) continue;

      const reason = "stale_queue_item_recovered";
      const runSummary = run
        ? await this.failRecoveredQueueRun({
            item,
            run,
            activeAttempts,
            workerId,
            reason,
            now,
          })
        : { run: null, failedAttempts: [], failedNodes: [] };
      const recoveredItem = await this.store.upsertQueueItem({
        ...item,
        queueState: QUEUE_STATES.QUEUED,
        claimedBy: null,
        claimedAt: null,
        activeRunId: null,
        finishedAt: null,
        lastError: reason,
        updatedAt: now,
      });

      recovered.push({
        item: recoveredItem,
        run: runSummary.run,
        failedAttempts: runSummary.failedAttempts,
        failedNodes: runSummary.failedNodes,
        lastActiveAt: latestActiveAt,
      });
    }

    return {
      count: recovered.length,
      recovered,
    };
  }

  async findActiveRunForQueueItem(item) {
    if (item.activeRunId) {
      const run = await this.store.getRun(item.activeRunId);
      if (ACTIVE_RUN_STATUSES.has(run?.status)) return run;
    }

    const runs =
      typeof this.store.listRuns === "function"
        ? await this.store.listRuns({ queueItemId: item.id })
        : [];
    return runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
  }

  async failRecoveredQueueRun({
    item,
    run,
    activeAttempts,
    workerId,
    reason,
    now,
  }) {
    const attempts =
      activeAttempts ??
      (typeof this.store.listAttempts === "function"
        ? await this.store.listAttempts({ runId: run.id })
        : []);
    const failedAttempts = [];
    for (const attempt of attempts.filter((entry) =>
      ACTIVE_ATTEMPT_STATUSES.has(entry.status),
    )) {
      const failed = await this.store.failAttempt(attempt.id, {
        error: reason,
        output: {
          recoveredQueueItemId: item.id,
          recoveredBy: workerId,
        },
        now,
      });
      if (failed) failedAttempts.push(failed);
    }

    const nodes =
      typeof this.store.listRunNodes === "function"
        ? await this.store.listRunNodes(run.id)
        : [];
    const failedNodes = [];
    for (const node of nodes.filter((entry) =>
      ACTIVE_RUN_NODE_STATUSES.has(entry.status),
    )) {
      const failed = await this.store.upsertRunNode({
        ...node,
        status: "failed",
        completedAt: now,
        error: {
          message: reason,
          queueItemId: item.id,
          recoveredBy: workerId,
        },
        updatedAt: now,
      });
      if (failed) failedNodes.push(failed);
    }

    const failedRun = await this.store.upsertRun({
      ...run,
      status: "failed",
      finishedAt: now,
      lastError: reason,
      updatedAt: now,
    });
    await this.store.appendRunEvent({
      runId: run.id,
      queueItemId: item.id,
      type: "QueueItemRecovered",
      actorKind: "steward",
      actorId: workerId,
      payload: {
        reason,
        queueState: item.queueState,
        recoveredQueueState: QUEUE_STATES.QUEUED,
      },
      createdAt: now,
    });

    return { run: failedRun, failedAttempts, failedNodes };
  }

  async markQueueItemFenceLost({
    record,
    workerId,
    plan,
    execution,
    itemExecution,
    finishedAt,
  }) {
    const reason = "queue_item_fence_lost";
    await this.store.failAttempt(record.attempt.id, {
      error: reason,
      output: { plan, execution, itemExecution },
      now: finishedAt,
    });
    await this.store.upsertRunNode({
      ...record.integrationNode,
      status: "failed",
      completedAt: finishedAt,
      output: { plan, execution, itemExecution },
      lastError: reason,
    });
    const finalRun = await this.store.upsertRun({
      ...record.run,
      status: "failed",
      finishedAt,
      lastError: reason,
    });
    const currentItem = await this.store.getQueueItem(record.item.id);
    await this.store.appendRunEvent({
      runId: record.run.id,
      queueItemId: record.item.id,
      type: "QueueItemFinalizationSkipped",
      actorKind: "steward",
      actorId: workerId,
      payload: {
        ok: false,
        reason,
        currentQueueState: currentItem?.queueState ?? null,
        activeRunId: currentItem?.activeRunId ?? null,
      },
      createdAt: finishedAt,
    });

    return {
      item: currentItem ?? record.item,
      run: finalRun,
      attempt: await this.store.getAttempt(record.attempt.id),
    };
  }

  async runQueueOnce({
    workerId = "merge-steward",
    confirmed = false,
    now = new Date().toISOString(),
    beforeIntegrationAction,
  } = {}) {
    if (!this.isLiveIntegrationExecution()) {
      return {
        claimed: false,
        reason: "live_integration_disabled",
      };
    }
    if (confirmed !== true) {
      return {
        claimed: false,
        reason: "integration_execution_not_confirmed",
      };
    }

    const claim = await this.claimNextQueueItems({ workerId, now });
    if (!claim.claimed) return claim;

    const claimedItems = claim.items ?? [claim.item];
    const records = [];
    for (const item of claimedItems) {
      const run = await this.createQueueRun({ item, workerId, now });
      await this.markQueueRunStarted({ run, item, workerId, now });

      const buildingItem = await this.store.upsertQueueItem({
        ...item,
        queueState: QUEUE_STATES.BUILDING_INTEGRATION,
        activeRunId: run.id,
        updatedAt: now,
      });
      await this.store.appendRunEvent({
        runId: run.id,
        queueItemId: item.id,
        type: "QueueItemBuildingIntegration",
        actorKind: "steward",
        actorId: workerId,
        payload: {
          queueState: QUEUE_STATES.BUILDING_INTEGRATION,
          trainSize: claimedItems.length,
        },
        createdAt: now,
      });

      const integrationNode = await this.store.upsertRunNode({
        runId: run.id,
        nodeId: "integration",
        status: "running",
        queueItemId: item.id,
        startedAt: now,
      });
      const attempt = await this.store.startAttempt({
        runId: run.id,
        nodeId: "integration",
        ownerId: workerId,
        status: "running",
        input: {
          queueItemId: item.id,
          repo: item.repo,
          pullRequestId: item.pullRequestId,
          trainSize: claimedItems.length,
        },
        startedAt: now,
        heartbeatAt: now,
      });
      const planItem =
        await this.prepareClaimedItemForIntegration(buildingItem);
      records.push({
        item,
        buildingItem,
        run,
        integrationNode,
        attempt,
        planItem,
      });
    }

    const plan = await this.planIntegration(
      records.map((record) => ({
        ...record.planItem,
        queueState: QUEUE_STATES.QUEUED,
      })),
    );
    const execution = await executeIntegrationPlan({
      plan,
      client: this.integrationClient,
      config: this.config.integration,
      confirmed: true,
      beforeAction: beforeIntegrationAction,
      onActionStart: (context) =>
        this.recordIntegrationActionCheckpoint({
          ...context,
          records,
          workerId,
          eventType: "IntegrationActionStarted",
        }),
      onActionComplete: (context) =>
        this.recordIntegrationActionCheckpoint({
          ...context,
          records,
          workerId,
          eventType: "IntegrationActionFinished",
        }),
    });
    const finishedAt = new Date().toISOString();
    const finalItems = [];
    const finalRuns = [];
    const finalAttempts = [];

    for (const record of records) {
      const itemExecution = executionForQueueItem(execution, record.item);
      const result = integrationExecutionResultForItem(
        execution,
        itemExecution,
      );
      const releaseForPredecessor =
        itemExecution?.status === "blocked" &&
        itemExecution.reason === "merge_train_predecessor_failed";
      const queueFence = {
        activeRunId: record.run.id,
        claimedBy: workerId,
        queueState: QUEUE_STATES.BUILDING_INTEGRATION,
      };

      if (result.ok) {
        const finalItem = await this.finishQueueItem(record.item.id, {
          state: QUEUE_STATES.MERGED,
          now: finishedAt,
          ...queueFence,
        });
        if (!finalItem) {
          const finalization = await this.markQueueItemFenceLost({
            record,
            workerId,
            plan,
            execution,
            itemExecution,
            finishedAt,
          });
          finalRuns.push(finalization.run);
          finalItems.push(finalization.item);
          finalAttempts.push(finalization.attempt);
          continue;
        }

        await this.store.finishAttempt(record.attempt.id, {
          output: { plan, execution, itemExecution },
          now: finishedAt,
        });
        await this.store.upsertRunNode({
          ...record.integrationNode,
          status: "succeeded",
          completedAt: finishedAt,
          output: { plan, execution, itemExecution },
        });
        const finalRun = await this.store.upsertRun({
          ...record.run,
          status: "succeeded",
          finishedAt,
          lastError: null,
        });
        await this.store.appendRunEvent({
          runId: record.run.id,
          queueItemId: record.item.id,
          type: "QueueItemMerged",
          actorKind: "steward",
          actorId: workerId,
          payload: result,
          createdAt: finishedAt,
        });
        finalRuns.push(finalRun);
        finalItems.push(finalItem);
        finalAttempts.push(await this.store.getAttempt(record.attempt.id));
        continue;
      }

      await this.store.failAttempt(record.attempt.id, {
        error: result.reason,
        output: { plan, execution, itemExecution },
        now: finishedAt,
      });
      await this.store.upsertRunNode({
        ...record.integrationNode,
        status: "failed",
        completedAt: finishedAt,
        output: { plan, execution, itemExecution },
        lastError: result.reason,
      });
      const finalRun = await this.store.upsertRun({
        ...record.run,
        status: "failed",
        finishedAt,
        lastError: result.reason,
      });
      let finalItem = null;
      if (releaseForPredecessor) {
        const currentItem = await this.store.getQueueItem(record.item.id);
        if (!queueItemFenceMatches(currentItem, queueFence)) {
          const finalization = await this.markQueueItemFenceLost({
            record,
            workerId,
            plan,
            execution,
            itemExecution,
            finishedAt,
          });
          finalRuns.push(finalization.run);
          finalItems.push(finalization.item);
          finalAttempts.push(finalization.attempt);
          continue;
        }
        finalItem = await this.store.upsertQueueItem({
          ...record.item,
          queueState: QUEUE_STATES.QUEUED,
          claimedBy: null,
          claimedAt: null,
          activeRunId: null,
          finishedAt: null,
          lastError: result.reason,
          updatedAt: finishedAt,
        });
      } else {
        finalItem = await this.failQueueItem(record.item.id, {
          error: result.reason,
          now: finishedAt,
          ...queueFence,
        });
        if (!finalItem) {
          const finalization = await this.markQueueItemFenceLost({
            record,
            workerId,
            plan,
            execution,
            itemExecution,
            finishedAt,
          });
          finalRuns.push(finalization.run);
          finalItems.push(finalization.item);
          finalAttempts.push(finalization.attempt);
          continue;
        }
      }
      await this.store.appendRunEvent({
        runId: record.run.id,
        queueItemId: record.item.id,
        type: releaseForPredecessor
          ? "QueueItemTrainBlocked"
          : "QueueItemIntegrationFailed",
        actorKind: "steward",
        actorId: workerId,
        payload: result,
        createdAt: finishedAt,
      });
      finalRuns.push(finalRun);
      finalItems.push(finalItem);
      finalAttempts.push(await this.store.getAttempt(record.attempt.id));
    }

    return {
      claimed: true,
      item: finalItems[0],
      items: finalItems,
      run: finalRuns[0],
      runs: finalRuns,
      attempt: finalAttempts[0],
      attempts: finalAttempts,
      plan,
      execution,
    };
  }

  async createQueueRun({ item, workerId, now }) {
    return this.store.upsertRun({
      id: `run:${item.id}:attempt:${item.attemptCount ?? 1}`,
      queueItemId: item.id,
      repo: item.repo,
      pullRequestId: item.pullRequestId,
      targetBranch: item.targetBranch,
      headSha: item.headSha ?? null,
      status: "running",
      ownerKind: "steward",
      ownerId: workerId,
      startedAt: now,
      heartbeatAt: now,
    });
  }

  async markQueueRunStarted({ run, item, workerId, now }) {
    await this.store.upsertRunNode({
      runId: run.id,
      nodeId: "queue_claim",
      status: "succeeded",
      queueItemId: item.id,
      startedAt: item.claimedAt ?? now,
      completedAt: now,
      output: {
        workerId,
        queueState: item.queueState,
        attemptCount: item.attemptCount ?? 1,
      },
    });
    await this.store.appendRunEvent({
      runId: run.id,
      queueItemId: item.id,
      type: "QueueItemClaimed",
      actorKind: "steward",
      actorId: workerId,
      payload: {
        claimedAt: item.claimedAt ?? now,
        attemptCount: item.attemptCount ?? 1,
      },
      createdAt: now,
    });
  }

  async recordIntegrationActionCheckpoint({
    records = [],
    workerId,
    eventType,
    itemPlan,
    action,
    result,
    previousActions,
  }) {
    const record = records.find((candidate) =>
      queueItemMatchesPlan(candidate.item, itemPlan),
    );
    if (!record)
      return {
        ok: true,
        skipped: true,
        reason: "integration_record_not_found",
      };

    const now = new Date().toISOString();
    const attempt = await this.store.heartbeatAttempt(record.attempt.id, {
      ownerId: workerId,
      now,
    });
    if (!attempt) {
      return { ok: false, reason: "integration_attempt_heartbeat_lost" };
    }

    await this.store.appendRunEvent({
      runId: record.run.id,
      queueItemId: record.item.id,
      type: eventType,
      actorKind: "steward",
      actorId: workerId,
      payload: {
        actionIndex: Number(previousActions?.length ?? 0) + 1,
        actionType: action?.type ?? null,
        repo: itemPlan?.repo ?? null,
        pullRequestId: itemPlan?.pullRequestId ?? null,
        integrationBranch: itemPlan?.integrationBranch ?? null,
        status: result?.status ?? null,
        reason: result?.reason ?? null,
        error: result?.error ?? null,
      },
      createdAt: now,
    });

    return { ok: true };
  }

  async prepareClaimedItemForIntegration(item) {
    if (this.config.enrichment?.enabled !== true) return item;
    return this.refreshLiveIntegrationItem(item);
  }

  isLiveIntegrationExecution() {
    return (
      this.config.integration?.enabled === true &&
      this.config.integration.dryRun === false
    );
  }

  async loadLiveIntegrationItems() {
    const items = await this.store.listQueueItems();
    if (this.config.enrichment?.enabled !== true) {
      return items;
    }

    const refreshedItems = [];
    for (const item of items) {
      refreshedItems.push(await this.refreshLiveIntegrationItem(item));
    }
    return refreshedItems;
  }

  async refreshLiveIntegrationItem(item) {
    const enrichment = await this.enrichItem(item);
    if (!enrichment.patch) {
      return {
        ...item,
        headShaMatches: false,
        liveRefresh: {
          skipped: true,
          reason: enrichment.reason ?? "live_enrichment_unavailable",
        },
      };
    }

    return this.store.upsertQueueItem(
      mergeQueuePatch(item, {
        ...enrichment.patch,
        replaceCheckResults: true,
        replaceRequiredChecks: true,
      }),
    );
  }

  async handleWebhookDelivery({ headers, rawBody }) {
    const event = parseForgejoWebhook({
      headers,
      rawBody,
      secret: this.webhookSecret(),
    });
    this.assertDeliveryId(event);

    const eventSummary = summarizeEvent(event);
    const duplicateEvent = await this.findDuplicateDelivery(eventSummary);
    if (duplicateEvent) {
      return {
        accepted: true,
        duplicate: true,
        reason: "duplicate_delivery",
        event,
        storedEvent: duplicateEvent,
        item: await this.findQueueItemForEvent(eventSummary),
        decision: null,
        comment: null,
        feedback: {
          enabled: false,
          skipped: true,
          reason: "duplicate_delivery",
        },
      };
    }

    const eventGate = gateForgejoEvent(event, this.config.eventGate);
    await this.store.appendEvent(
      eventGate.allowed ? eventSummary : { ...eventSummary, gate: eventGate },
    );

    if (!eventGate.allowed) {
      return {
        accepted: true,
        gated: true,
        reason: eventGate.reason,
        gate: eventGate,
        event,
        item: null,
        decision: null,
        comment: null,
      };
    }

    const queuePatch = queuePatchFromEvent(event, this.config.agentRunReceipt);
    if (!queuePatch) {
      return {
        accepted: true,
        event,
        item: null,
        decision: null,
        comment: null,
      };
    }

    const existing = await this.findExistingQueueItem(queuePatch);
    if (!existing && queuePatch.source === "check") {
      return {
        accepted: true,
        event,
        item: null,
        decision: null,
        comment: null,
      };
    }

    const baseItem = mergeQueuePatch(existing, queuePatch);
    const enrichment = await this.enrichItem(baseItem);
    const [effectiveItem] = await this.applyQueuePolicyEvidence([
      mergeQueuePatch(baseItem, enrichment.patch ?? {}),
    ]);
    const item = await this.store.upsertQueueItem(effectiveItem);
    const decision = evaluateMergePolicy(item, await this.effectivePolicy());
    const comment = renderQueueComment({ decision, item });
    const feedback = await this.mirrorDecision({
      event,
      item,
      decision,
      comment,
    });

    return {
      accepted: true,
      event,
      item,
      decision,
      comment,
      enrichment,
      feedback,
    };
  }

  webhookSecret() {
    const envName = this.config.webhookSecretEnv;
    return envName ? process.env[envName] : undefined;
  }

  assertDeliveryId(event) {
    if (this.config.webhook?.requireDeliveryId === true && !event.deliveryId) {
      throw new WebhookPayloadError("Forgejo webhook delivery id is required");
    }
  }

  async findDuplicateDelivery(eventSummary) {
    if (
      !eventSummary.deliveryId ||
      typeof this.store.findEventByDeliveryId !== "function"
    ) {
      return null;
    }

    return this.store.findEventByDeliveryId(eventSummary.deliveryId);
  }

  async findQueueItemForEvent(eventSummary) {
    if (eventSummary.repo && eventSummary.pullRequestId) {
      return this.store.getQueueItem(
        `${eventSummary.repo}#${eventSummary.pullRequestId}`,
      );
    }

    if (
      eventSummary.commitSha &&
      typeof this.store.findQueueItemByHeadSha === "function"
    ) {
      return this.store.findQueueItemByHeadSha(eventSummary.commitSha);
    }

    return null;
  }

  async findExistingQueueItem(patch) {
    if (patch.repo && patch.pullRequestId) {
      return this.store.getQueueItem(`${patch.repo}#${patch.pullRequestId}`);
    }

    if (
      patch.headSha &&
      typeof this.store.findQueueItemByHeadSha === "function"
    ) {
      return this.store.findQueueItemByHeadSha(patch.headSha);
    }

    return null;
  }

  async enrichItem(item) {
    const result = await enrichQueueItem({
      client: this.enrichmentClient,
      item,
      config: {
        ...this.config.enrichment,
        agentRunReceipt: this.config.agentRunReceipt,
      },
    });

    this.logger.info?.("[MergeSteward] enrichment evaluated", {
      enabled: result.enabled,
      skipped: result.skipped,
      reason: result.reason,
    });

    return result;
  }

  async mirrorDecision({ event, item, decision, comment }) {
    if (!this.config.feedback?.enabled) {
      return {
        enabled: false,
      };
    }

    let feedback;
    try {
      const claims = await this.feedbackClaimsForItem(item);
      feedback = buildForgejoFeedback({
        event,
        item,
        decision,
        comment,
        claims,
        config: this.config.feedback,
      });
      const result = await applyForgejoFeedback({
        client: this.feedbackClient,
        feedback,
        dryRun: this.config.feedback.dryRun !== false,
      });

      this.logger.info?.("[MergeSteward] feedback planned", {
        dryRun: result.dryRun,
        skipped: result.skipped,
        operationCount: result.operations?.length ?? 0,
      });

      return result;
    } catch (error) {
      // error-policy:J1 Forgejo feedback mirroring is a side-effect boundary:
      // the failure is translated into an explicit skipped/error result that the
      // decision pipeline records and surfaces, never a silent success.
      this.logger.error?.("[MergeSteward] feedback failed", { error });
      return {
        enabled: true,
        skipped: true,
        reason: "forgejo_feedback_failed",
        dryRun: this.config.feedback.dryRun !== false,
        operations: feedback?.operations ?? [],
        error: {
          name: error instanceof Error ? error.name : "Error",
          message:
            error instanceof Error
              ? error.message
              : "Unknown Forgejo feedback error",
          status: error?.status ?? null,
        },
      };
    }
  }

  async feedbackClaimsForItem(item) {
    if (
      !item?.repo ||
      item.pullRequestId == null ||
      typeof this.store.listAgentClaims !== "function"
    )
      return [];
    // A broken claim lookup must not be mistaken for "no claims": the error
    // propagates to mirrorDecision, which reports the whole feedback pass as
    // failed instead of mirroring a decision built on fabricated data.
    const claims = await this.store.listAgentClaims({ repo: item.repo });
    return claims.filter((claim) => claimMatchesItem(claim, item));
  }

  async appendQueueAuditEvent({ item, type, actorId, payload, now }) {
    const event = await this.store.appendEvent({
      type: `queue.${type}`,
      repo: item.repo,
      pullRequestId: item.pullRequestId,
      queueItemId: item.id,
      actorKind: "human",
      actorId,
      payload,
      receivedAt: now,
    });

    const runs =
      typeof this.store.listRuns === "function"
        ? await this.store.listRuns({ queueItemId: item.id })
        : [];
    for (const run of runs) {
      await this.store.appendRunEvent({
        runId: run.id,
        queueItemId: item.id,
        type,
        actorKind: "human",
        actorId,
        payload,
        createdAt: now,
      });
    }

    return event;
  }

  async applyRepoPolicies(items = []) {
    if (!items.length || typeof this.store.listRepoPolicies !== "function") {
      return items;
    }
    const policies = new Map(
      (await this.store.listRepoPolicies()).map((policy) => [
        policy.repo,
        policy,
      ]),
    );
    return items.map((item) => applyRepoPolicy(item, policies.get(item.repo)));
  }

  async applyQueuePolicyEvidence(items = [], { now } = {}) {
    const policyItems = await this.applyRepoPolicies(items);
    const requireWorkReservation =
      this.config.policy?.requireWorkReservationForAgentPrs === true;
    const requireWorkItem =
      this.config.policy?.requireWorkItemForAgentPrs === true;
    if (!requireWorkReservation && !requireWorkItem) {
      return applyStackDependencyEvidence(policyItems);
    }

    const withPolicyEvidence = await Promise.all(
      policyItems.map(async (item) => {
        let next = item;
        if (requireWorkItem) {
          next = await this.attachWorkItemEvidence(next);
        }
        if (requireWorkReservation) {
          next = await this.attachWorkReservationEvidence(next, { now });
        }
        return next;
      }),
    );
    return applyStackDependencyEvidence(withPolicyEvidence);
  }

  async attachWorkItemEvidence(item = {}) {
    if (item.authorKind !== "agent") return item;
    const workItemLink = await this.workItemLinkForQueueItem(item);
    return workItemLink ? { ...item, workItemLink } : item;
  }

  async attachWorkReservationEvidence(item = {}, { now } = {}) {
    if (item.authorKind !== "agent" || !item.ownerAgentId) return item;

    const submissionGate = await this.submissionGateForBrief(item, {
      requireWorkReservation: true,
      now,
    });
    const workReservation =
      workReservationSnapshotFromSubmissionGate(submissionGate);
    return workReservation ? { ...item, workReservation } : item;
  }

  async workItemLinkForQueueItem(item = {}) {
    if (!item.repo || typeof this.store.listWorkItems !== "function") {
      return workItemLinkSnapshot(item, []);
    }
    return workItemLinkSnapshot(
      item,
      await this.store.listWorkItems({ repo: item.repo }),
    );
  }
}

function decisionSummary(decision) {
  return {
    allowed: decision.allowed,
    state: decision.state,
    blockers: decision.blockers,
    originalBlockers: decision.originalBlockers ?? [],
    policyOverride: decision.policyOverride ?? null,
  };
}

function normalizeSimulationProposedItems(options = {}) {
  if (Array.isArray(options.proposedItems)) return options.proposedItems;
  if (Array.isArray(options.items)) return options.items;
  if (options.proposedItem && typeof options.proposedItem === "object")
    return [options.proposedItem];
  if (options.item && typeof options.item === "object") return [options.item];
  return [];
}

const ACTIVE_RUN_STATUSES = new Set([
  "running",
  "waiting_approval",
  "waiting_event",
  "waiting_timer",
  "paused",
  "recovering",
]);

const ACTIVE_RUN_NODE_STATUSES = new Set([
  "pending",
  "running",
  "waiting_approval",
  "approval_requested",
  "waiting_event",
  "waiting_timer",
  "recovering",
]);

const ACTIVE_ATTEMPT_STATUSES = new Set(["running", "recovering"]);
const RECOVERABLE_QUEUE_STATES = new Set([
  QUEUE_STATES.RUNNING,
  QUEUE_STATES.BUILDING_INTEGRATION,
]);

function repoSlugToObject(repo) {
  const [owner, name, ...rest] = String(repo ?? "").split("/");
  if (!owner || !name || rest.length > 0) return null;
  return { owner, repo: name };
}

function latestIso(values = []) {
  const latest = values
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

function isTimestampStale(timestamp, now, staleAfterMs) {
  const thenMs = Date.parse(timestamp);
  const nowMs = Date.parse(now);
  return (
    Number.isFinite(thenMs) &&
    Number.isFinite(nowMs) &&
    nowMs - thenMs >= staleAfterMs
  );
}

function queueItemFenceMatches(
  item = null,
  { activeRunId, claimedBy, queueState } = {},
) {
  if (!item) return false;
  if (activeRunId != null && item.activeRunId !== activeRunId) return false;
  if (claimedBy != null && item.claimedBy !== claimedBy) return false;
  if (queueState != null && item.queueState !== queueState) return false;
  return true;
}

function queueItemMatchesPlan(item = {}, itemPlan = {}) {
  return (
    String(item.repo ?? "") === String(itemPlan.repo ?? "") &&
    String(item.pullRequestId ?? item.id ?? "") ===
      String(itemPlan.pullRequestId ?? "")
  );
}

function mergeEvaluationInput(queueItems = [], input = {}) {
  const identity = queueItemContextIdentity(input);
  if (!identity) return [...queueItems, input];

  let replaced = false;
  const merged = queueItems.map((item) => {
    if (queueItemContextIdentity(item) !== identity) return item;
    replaced = true;
    return {
      ...item,
      ...input,
    };
  });

  return replaced ? merged : [...merged, input];
}

function findEvaluationItem(queueItems = [], input = {}) {
  const identity = queueItemContextIdentity(input);
  if (!identity) return null;
  return (
    queueItems.find((item) => queueItemContextIdentity(item) === identity) ??
    null
  );
}

function queueItemContextIdentity(item = {}) {
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  if (item.repo && item.number != null) return `${item.repo}#${item.number}`;
  if (item.repo && item.prNumber != null)
    return `${item.repo}#${item.prNumber}`;
  if (item.id != null) return `id:${item.id}`;
  return null;
}

function executionForQueueItem(execution = {}, item = {}) {
  return (
    (execution.executions ?? []).find((itemExecution) =>
      queueItemMatchesPlan(item, itemExecution),
    ) ?? null
  );
}

function integrationExecutionResultForItem(
  execution = {},
  itemExecution = null,
) {
  const overall = integrationExecutionResult({
    ...execution,
    executions: itemExecution ? [itemExecution] : [],
  });
  if (!itemExecution && overall.reason === "integration_execution_empty") {
    return { ok: false, reason: "integration_execution_missing" };
  }
  return overall;
}

function integrationExecutionResult(execution = {}) {
  if (execution.enabled !== true) {
    return { ok: false, reason: execution.reason ?? "integration_disabled" };
  }
  if (execution.dryRun === true) {
    return { ok: false, reason: "integration_dry_run" };
  }
  if (execution.skipped === true) {
    return {
      ok: false,
      reason: execution.reason ?? "integration_execution_skipped",
    };
  }

  const executions = execution.executions ?? [];
  if (executions.length === 0) {
    return { ok: false, reason: "integration_execution_empty" };
  }

  const failed = executions.find((item) => item.status !== "executed");
  if (!failed) {
    return { ok: true, reason: null };
  }

  return {
    ok: false,
    reason:
      failed.reason ??
      failed.error?.message ??
      `integration_execution_${failed.status}`,
    execution: {
      repo: failed.repo ?? null,
      pullRequestId: failed.pullRequestId ?? null,
      status: failed.status ?? null,
    },
  };
}

function nodeWaitsForSignal(node, signal, run) {
  if (normalizeRuntimeStatus(node.status) !== "waiting-event") return false;
  if (signal.runId && node.runId !== signal.runId) return false;

  const correlationMatches =
    signal.correlationKey &&
    (node.correlationKey === signal.correlationKey ||
      run.correlationKey === signal.correlationKey);
  const typeMatches =
    signal.type && node.signalType && node.signalType === signal.type;

  return Boolean(correlationMatches || typeMatches);
}

function runWaitsForSignal(run, signal) {
  if (normalizeRuntimeStatus(run.status) !== "waiting-event") return false;
  if (signal.runId && run.id !== signal.runId) return false;
  return Boolean(
    signal.correlationKey && run.correlationKey === signal.correlationKey,
  );
}

function applyRepoPolicy(item = {}, policy) {
  if (!policy) return item;

  const requiredChecks = unique([
    ...(policy.requiredChecks ?? []),
    ...(item.requiredChecks ?? []),
  ]);
  const protectedBranches = policy.protectedBranches ?? [];
  const trustedActors = policy.trustedActors ?? [];
  const ownerTrusted =
    item.ownerAgentId && trustedActors.includes(item.ownerAgentId);

  return {
    ...item,
    targetProtected:
      item.targetProtected === true ||
      protectedBranches.includes(item.targetBranch),
    agentKnown: item.agentKnown === true || ownerTrusted === true,
    requiredChecks,
    policySnapshot: {
      ...(item.policySnapshot ?? {}),
      repo: policy.repo,
      queueMode: policy.queueMode,
      protectedBranches,
      requiredChecks: policy.requiredChecks ?? [],
      trustedActors,
      allowForks: policy.allowForks === true,
      policy: policy.policy ?? {},
    },
  };
}

function workReservationSnapshotFromSubmissionGate(submissionGate) {
  const gate = Array.isArray(submissionGate?.gates)
    ? submissionGate.gates.find((item) => item.name === "work_reservation")
    : null;
  if (!gate) return null;

  const evidence =
    gate.evidence && typeof gate.evidence === "object" ? gate.evidence : {};
  return {
    allowed: gate.status !== "fail",
    state: workReservationStateForGateStatus(gate.status),
    required: evidence.required === true,
    activeClaimCount: numberOrZero(evidence.activeClaimCount),
    coveredFiles: stringArray(evidence.coveredFiles),
    coveredPackages: stringArray(evidence.coveredPackages),
    missingFiles: stringArray(evidence.missingFiles),
    missingPackages: stringArray(evidence.missingPackages),
    requiredActions: stringArray(gate.requiredActions),
  };
}

function workReservationStateForGateStatus(status) {
  if (status === "pass") return "covered";
  if (status === "fail") return "blocked";
  if (status === "warn") return "missing";
  return "unknown";
}

function unique(values) {
  return [...new Set(values)];
}

function stringArray(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item))
    .filter(Boolean);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function intOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function stringOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeRuntimeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

export function queuePatchFromEvent(event, agentRunReceiptOptions) {
  if (!event?.repository) {
    return null;
  }

  if (event.status || event.workflow) {
    return {
      source: "check",
      repo: event.repository.fullName,
      headSha:
        event.commitSha ??
        event.status?.sha ??
        event.workflow?.run?.head_sha ??
        null,
      ...checkPatchFromEvent(event),
    };
  }

  if (!event.pullRequest) {
    return null;
  }

  const labels = labelNames(event.labels ?? event.pullRequest.labels);
  const labelChanges = {
    added: labelNames(event.labelChanges?.added ?? []),
    removed: labelNames(event.labelChanges?.removed ?? []),
  };
  const partialLabelPayload =
    labels.length === 0 &&
    (labelChanges.added.length > 0 || labelChanges.removed.length > 0);
  const effectiveLabels = new Set(labels);
  for (const label of labelChanges.added) effectiveLabels.add(label);
  for (const label of labelChanges.removed) effectiveLabels.delete(label);

  const reviewSatisfied = reviewApproved(event.review) ? true : undefined;
  const checkPatch = checkPatchFromEvent(event);
  const author = event.pullRequest.author ?? event.actor;
  const authorKind = authorKindFromUser(author);
  const ownerAgentId = agentIdFromLabels(effectiveLabels);
  const text = `${event.pullRequest.title ?? ""}\n${event.pullRequest.body ?? ""}`;
  const planSignals = detectAgentPlanSignals(text, agentRunReceiptOptions);

  return {
    source: "pull_request",
    repo: event.repository.fullName,
    pullRequestId: event.pullRequest.number,
    sourceBranch: event.pullRequest.head?.branch ?? "",
    targetBranch: event.pullRequest.base?.branch ?? "",
    headSha: event.pullRequest.head?.sha ?? event.commitSha ?? null,
    authorKind,
    ownerAgentId: partialLabelPayload ? undefined : ownerAgentId,
    taskId: taskIdFromText(text),
    changedFiles: [],
    labels,
    labelChanges,
    pullRequestState: event.pullRequest.state,
    pullRequestDraft: event.pullRequest.draft,
    pullRequestMerged: event.pullRequest.merged,
    pullRequestMergeable: event.pullRequest.mergeable,
    hasIssueLink: hasIssueLink(text),
    ...planSignals,
    hasHumanApproval: partialLabelPayload
      ? undefined
      : effectiveLabels.has("human-approved") ||
        effectiveLabels.has("maintainer-approved"),
    agentKnown: partialLabelPayload
      ? undefined
      : Boolean(ownerAgentId) || authorKind !== "agent",
    reviewSatisfied,
    headShaMatches: true,
    ...checkPatch,
  };
}

function mergeQueuePatch(existing, patch) {
  const checkResults =
    patch.replaceCheckResults === true || patch.headShaMatches === false
      ? { ...(patch.checkResults ?? {}) }
      : {
          ...(existing?.checkResults ?? {}),
          ...(patch.checkResults ?? {}),
        };
  const labels = mergeLabels(existing?.labels, patch);
  let requiredChecks = Object.keys(checkResults);
  if (existing?.requiredChecks?.length) {
    requiredChecks = existing.requiredChecks;
  }
  if (patch.requiredChecks?.length || patch.replaceRequiredChecks === true) {
    requiredChecks = patch.requiredChecks ?? [];
  }
  const targetProtected =
    patch.targetProtected ?? existing?.targetProtected ?? false;
  const changedLines = Number.isFinite(patch.changedLines)
    ? patch.changedLines
    : (existing?.changedLines ?? 0);
  const changedFiles = patch.changedFiles?.length
    ? patch.changedFiles
    : (existing?.changedFiles ?? []);
  const {
    labelChanges,
    replaceCheckResults,
    replaceRequiredChecks,
    ...storedPatch
  } = dropUndefined(patch);

  return {
    ...existing,
    ...storedPatch,
    labels,
    checkResults,
    requiredChecks,
    targetProtected,
    changedLines,
    changedFiles,
  };
}

function claimMatchesItem(claim = {}, item = {}) {
  const itemId =
    item.id ??
    (item.repo && item.pullRequestId != null
      ? `${item.repo}#${item.pullRequestId}`
      : null);
  const metadata =
    claim.metadata && typeof claim.metadata === "object" ? claim.metadata : {};

  if (
    claim.resourceKind === "pull_request" &&
    String(claim.resourceId) === String(item.pullRequestId)
  )
    return true;
  if (
    claim.resourceKind === "queue_item" &&
    itemId &&
    String(claim.resourceId) === String(itemId)
  )
    return true;
  if (metadata.itemId && itemId && String(metadata.itemId) === String(itemId))
    return true;
  if (
    metadata.pullRequestId != null &&
    String(metadata.pullRequestId) === String(item.pullRequestId)
  )
    return true;
  if (
    claim.queueItemId &&
    itemId &&
    String(claim.queueItemId) === String(itemId)
  )
    return true;
  return false;
}

function mergeLabels(existingLabels = [], patch) {
  if (!patch.labelChanges) {
    return patch.labels ?? existingLabels;
  }

  const labels = new Set(patch.labels?.length ? patch.labels : existingLabels);
  for (const label of patch.labelChanges.added ?? []) labels.add(label);
  for (const label of patch.labelChanges.removed ?? []) labels.delete(label);
  return [...labels];
}

function checkPatchFromEvent(event) {
  if (event.status?.context && event.status?.state) {
    return {
      checkResults: {
        [event.status.context]: normalizeCheckState(event.status.state),
      },
    };
  }

  const workflowName =
    event.workflow?.workflow?.name ??
    event.workflow?.run?.name ??
    event.workflow?.job?.name;
  const workflowState =
    event.workflow?.run?.conclusion ??
    event.workflow?.job?.conclusion ??
    event.workflow?.run?.status ??
    event.workflow?.job?.status ??
    event.workflow?.action;
  if (workflowName && workflowState) {
    return {
      checkResults: {
        [workflowName]: normalizeCheckState(workflowState),
      },
    };
  }

  return {};
}

function labelNames(labels = []) {
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

function reviewApproved(review) {
  return review?.state === "approved" || review?.type === "approved";
}

function normalizeCheckState(state) {
  if (state === "success" || state === "skipped" || state === "neutral")
    return state;
  if (state === "completed") return "success";
  if (state === "failure" || state === "failed" || state === "error")
    return "failure";
  return state ?? "pending";
}

function summarizeEvent(event) {
  return {
    type: event.type,
    kind: event.kind,
    action: event.action,
    deliveryId: event.deliveryId,
    repo: event.repository?.fullName ?? null,
    pullRequestId: event.pullRequest?.number ?? null,
    commitSha: event.commitSha,
  };
}

function authorKindFromUser(user) {
  const login = user?.login ?? user?.username ?? "";
  if (/agent|codex|bot/i.test(login)) return "agent";
  if (/bot/i.test(user?.type ?? "")) return "bot";
  return login ? "human" : "unknown";
}

function agentIdFromLabels(labels) {
  for (const label of labels) {
    const match = /^agent:(.+)$/.exec(label);
    if (
      match &&
      !["owned", "stale", "needs-human", "duplicate-risk"].includes(match[1])
    ) {
      return match[1];
    }
  }
  return null;
}

const TERMINAL_WORK_ITEM_STATES = new Set(["done", "cancelled"]);

function workItemLinkSnapshot(item = {}, workItems = []) {
  const candidates = arrayValue(workItems);
  const pullRequestId = intOrNull(item.pullRequestId);
  const taskId = stringOrNull(item.taskId);
  const issueId = intOrNull(item.issueId);
  const matches = [
    pullRequestId == null
      ? null
      : candidates.find(
          (workItem) => intOrNull(workItem.pullRequestId) === pullRequestId,
        ),
    taskId == null
      ? null
      : candidates.find((workItem) => stringOrNull(workItem.taskId) === taskId),
    issueId == null
      ? null
      : candidates.find((workItem) => intOrNull(workItem.issueId) === issueId),
  ];
  const workItem = matches.find(Boolean);
  const matchIndex = matches.findIndex(Boolean);
  const match = ["pull_request", "task", "issue"][matchIndex] ?? null;
  const base = {
    repo: item.repo ?? null,
    pullRequestId,
    taskId,
    issueId,
    ownerAgentId: item.ownerAgentId ?? null,
    match,
  };

  if (!workItem) {
    return {
      ...base,
      state: "missing",
      workItemId: null,
      workItemState: null,
    };
  }

  if (
    item.ownerAgentId &&
    workItem.ownerAgentId &&
    item.ownerAgentId !== workItem.ownerAgentId
  ) {
    return {
      ...base,
      state: "owner_mismatch",
      workItemId: workItem.id,
      workItemState: workItem.state ?? null,
      workItemOwnerAgentId: workItem.ownerAgentId,
    };
  }

  if (TERMINAL_WORK_ITEM_STATES.has(workItem.state)) {
    return {
      ...base,
      state: "terminal",
      workItemId: workItem.id,
      workItemState: workItem.state,
      workItemOwnerAgentId: workItem.ownerAgentId ?? null,
    };
  }

  return {
    ...base,
    state: "linked",
    workItemId: workItem.id,
    workItemState: workItem.state ?? null,
    workItemOwnerAgentId: workItem.ownerAgentId ?? null,
  };
}

function hasIssueLink(text) {
  return /(?:#\d+|(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+|task[-_ ]?[a-z0-9-]+)/i.test(
    text,
  );
}

function taskIdFromText(text) {
  const taskMatch = /(task[-_ ][a-z0-9-]+)/i.exec(text);
  if (taskMatch) return taskMatch[1].replace(/\s+/g, "-");
  const issueMatch = /#(\d+)/.exec(text);
  return issueMatch ? `issue-${issueMatch[1]}` : null;
}

function claimsFromWorkPreflight(preflight, { maxClaims } = {}) {
  const limit =
    positiveOptionalInteger(maxClaims) ?? preflight.suggestedClaims.length;
  const proposed = preflight.proposed ?? {};
  const changedFiles = uniqueStrings(proposed.changedFiles);
  const packages = uniqueStrings(proposed.affectedPackages);

  return preflight.suggestedClaims.slice(0, limit).map((suggestion) => {
    const resourceKind = String(suggestion.resourceKind);
    const resourceId = String(suggestion.resourceId);
    return {
      repo: preflight.repo,
      resourceKind,
      resourceId,
      ownerAgentId: preflight.agentId,
      branch: proposed.sourceBranch ?? null,
      paths: resourceKind === "path" ? [resourceId] : changedFiles,
      metadata: {
        source: "agent-work-reservation",
        targetBranch: preflight.targetBranch,
        preflightState: preflight.decision.state,
        preflightWarnings: preflight.decision.warnings,
        pullRequestId: proposed.pullRequestId ?? null,
        packages: resourceKind === "package" ? [resourceId] : packages,
      },
    };
  });
}

function workItemFromReservationPreflight({ preflight, workItem, now } = {}) {
  const proposed = preflight.proposed ?? {};
  const supplied =
    workItem && typeof workItem === "object" && !Array.isArray(workItem)
      ? workItem
      : {};
  const repo = stringOrNull(supplied.repo ?? preflight.repo);
  if (!repo) return null;

  const paths = uniqueStrings(
    supplied.paths ?? supplied.changedFiles ?? proposed.changedFiles,
  );
  const packages = uniqueStrings(
    supplied.packages ?? supplied.affectedPackages ?? proposed.affectedPackages,
  );
  const ownerAgentId = stringOrNull(supplied.ownerAgentId ?? preflight.agentId);
  const targetBranch = stringOrNull(
    supplied.targetBranch ?? preflight.targetBranch ?? proposed.targetBranch,
  );
  const pullRequestId = intOrNull(
    supplied.pullRequestId ?? proposed.pullRequestId,
  );
  const issueId = intOrNull(supplied.issueId ?? proposed.issueId);
  const taskId =
    stringOrNull(supplied.taskId ?? proposed.taskId) ??
    (pullRequestId == null && issueId == null
      ? reservationTaskId({ ownerAgentId, paths, packages, targetBranch })
      : null);
  const kind =
    stringOrNull(supplied.kind ?? proposed.kind) ??
    (pullRequestId != null
      ? "pull_request"
      : paths.length === 1 && packages.length === 0
        ? "path"
        : packages.length === 1 && paths.length === 0
          ? "package"
          : "task");
  const title =
    stringOrNull(supplied.title ?? proposed.title) ??
    reservationTitle({ ownerAgentId, paths, packages, targetBranch });
  const suppliedMetadata = plainObject(supplied.metadata);
  const reservationMetadata = plainObject(suppliedMetadata.reservation);
  const metadata = {
    ...suppliedMetadata,
    reservation: {
      ...reservationMetadata,
      source: "agent-work-reservation",
      reservedAt: now,
      preflightState: preflight.decision?.state ?? null,
      preflightWarnings: preflight.decision?.warnings ?? [],
      requestedClaimCount: preflight.suggestedClaims?.length ?? 0,
    },
  };

  return {
    ...supplied,
    repo,
    kind,
    state: supplied.state ?? "claimed",
    title,
    ownerAgentId,
    targetBranch,
    taskId,
    issueId,
    pullRequestId,
    paths,
    packages,
    labels: uniqueStrings([
      ...uniqueStrings(supplied.labels),
      "work:reserved",
      "agent:reserved-work",
      ...uniqueStrings(preflight.labels),
    ]),
    metadata,
    updatedAt: now,
  };
}

function reservationTaskId({
  ownerAgentId,
  paths,
  packages,
  targetBranch,
} = {}) {
  return `reservation-${slugSegment(ownerAgentId ?? "agent")}-${slugSegment(paths[0] ?? packages[0] ?? targetBranch ?? "scope")}`;
}

function reservationTitle({
  ownerAgentId,
  paths,
  packages,
  targetBranch,
} = {}) {
  const scope = paths[0] ?? packages[0] ?? targetBranch ?? "scoped work";
  return `Reserved agent work: ${ownerAgentId ?? "agent"} ${scope}`;
}

function proposedWorkItemFor({
  proposedItem,
  ownerAgentId,
  repo,
  targetBranch,
  changedFiles,
  affectedPackages,
}) {
  const item =
    proposedItem &&
    typeof proposedItem === "object" &&
    !Array.isArray(proposedItem)
      ? proposedItem
      : null;
  const files = uniqueStrings(
    changedFiles ?? item?.changedFiles ?? item?.paths,
  );
  const packages = uniqueStrings(
    affectedPackages ?? item?.affectedPackages ?? item?.packages,
  );

  if (!item && files.length === 0 && packages.length === 0) return null;

  return {
    ...(item ?? {}),
    repo: repo ?? item?.repo,
    targetBranch: targetBranch ?? item?.targetBranch,
    ownerAgentId: ownerAgentId ?? item?.ownerAgentId,
    authorKind: item?.authorKind ?? "agent",
    changedFiles: files,
    affectedPackages: packages,
  };
}

function workReservationResult({
  reserved,
  dryRun = false,
  reason,
  preflight,
  requestedClaims = [],
  attempted = [],
  claims = [],
  rolledBackClaims = [],
  workItem = null,
  plannedWorkItem = null,
  workItemAction = "disabled",
  workItemError = null,
}) {
  const labels = [
    ...preflight.labels,
    reserved ? "work-reservation:reserved" : "work-reservation:not-reserved",
    dryRun ? "work-reservation:dry-run" : null,
    workItemAction === "upserted" ? "work-item:reserved" : null,
    workItemAction === "planned" ? "work-item:planned" : null,
    workItemAction === "failed" ? "work-item:failed" : null,
    reason ? `work-reservation:${labelSegment(reason)}` : null,
  ].filter(Boolean);

  return {
    reserved,
    dryRun,
    reason,
    preflight,
    requestedClaims,
    attempted,
    claims,
    rolledBackClaims,
    workItem,
    plannedWorkItem,
    workItemAction,
    workItemError,
    labels: uniqueStrings(labels),
  };
}

function uniqueStrings(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [
    ...new Set(values.map((item) => String(item).trim()).filter(Boolean)),
  ];
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function positiveOptionalInteger(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function labelSegment(value) {
  return String(value).replace(/_/g, "-");
}

function slugSegment(value) {
  return (
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "scope"
  );
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function dropUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}
