/**
 * Household resource-capacity policy over the canonical entity graph, shared
 * approval queue, and shared ScheduledTask runner.
 *
 * The service persists resource evidence and review proposals only. Approval
 * means the humans reviewed exact bytes; it never reserves a caregiver,
 * vehicle, or restraint, mutates a calendar, or sends a message.
 */
import { randomUUID } from "node:crypto";
import { type EntityStore, resolveKnowledgeGraphService } from "@elizaos/agent";
import { type IAgentRuntime, Service } from "@elizaos/core";
import type { ScheduledTaskRunnerHandle } from "@elizaos/plugin-scheduling";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../approval-queue.types.js";
import {
  createHouseholdCoordinationService,
  getHouseholdCoordinationService,
  type HouseholdCoordinationService,
} from "../household/service.js";
import { getScheduledTaskRunner } from "../scheduled-task/service.js";
import { ResourceCapacityRepository } from "./repository.js";
import { evaluateResourceCapacity } from "./solver.js";
import {
  capacityPlanEarliestOccupiedAt,
  type HouseholdResourceDefinition,
  type HouseholdResourceRevision,
  normalizeCapacityEvaluationInput,
  normalizeResourceDefinition,
  type PendingResourceReservation,
  proposalContentSha256,
  proposalInputSha256,
  RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID,
  type ResourceCapacityApprovalLink,
  ResourceCapacityError,
  type ResourceCapacityEvaluation,
  type ResourceCapacityEvaluationInput,
  type ResourceCapacityProposal,
  type ResourceCapacityProposalTerminal,
  type ResourceCapacityReviewProjection,
  type ResourceCapacityTerminalState,
  requireCapacityInteger,
  requireCapacityText,
  requireCapacityTimestamp,
  resourceCapacitySha256,
  uniqueCapacityIds,
} from "./types.js";

export const RESOURCE_CAPACITY_SERVICE = "lifeops_resource_capacity";
const MAXIMUM_PROPOSAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface ResourceCapacityDependencies {
  readonly runtime: IAgentRuntime;
  readonly agentId: string;
  readonly entityStore: EntityStore;
  readonly household: HouseholdCoordinationService;
  readonly repository: ResourceCapacityRepository;
  readonly approvalQueue: ApprovalQueue;
  readonly scheduledTasks: ScheduledTaskRunnerHandle;
  readonly now?: () => Date;
}

interface CreateProposalInput {
  readonly principalEntityId: string;
  readonly evaluation: ResourceCapacityEvaluationInput;
  readonly requiredApproverEntityIds: readonly string[];
  readonly idempotencyKey: string;
  readonly expiresAt: string;
}

function proposalApprovalKey(
  proposal: ResourceCapacityProposal,
  partyEntityId: string,
): string {
  return `resource-capacity-review:${resourceCapacitySha256({
    proposalId: proposal.proposalId,
    version: proposal.version,
    partyEntityId,
    contentSha256: proposal.contentSha256,
  })}`;
}

function approvalMatches(
  request: ApprovalRequest,
  proposal: ResourceCapacityProposal,
  partyEntityId: string,
): boolean {
  if (
    request.action !== "execute_workflow" ||
    request.subjectUserId !== partyEntityId ||
    request.payload.action !== "execute_workflow" ||
    request.payload.workflowId !== RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID
  ) {
    return false;
  }
  const input = request.payload.input;
  return (
    input.proposalId === proposal.proposalId &&
    input.proposalVersion === proposal.version &&
    input.partyEntityId === partyEntityId &&
    input.contentSha256 === proposal.contentSha256 &&
    input.noExternalEffect === true
  );
}

function pendingReservations(
  proposals: readonly ResourceCapacityProposal[],
): PendingResourceReservation[] {
  const reservations: PendingResourceReservation[] = [];
  for (const proposal of proposals) {
    const needs = new Map(
      proposal.plan.needs.map((need) => [need.needId, need]),
    );
    for (const assignment of proposal.assignments) {
      const need = needs.get(assignment.needId);
      if (!need) {
        throw new ResourceCapacityError(
          "Persisted proposal assignment names a missing need",
          "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
          {
            proposalId: proposal.proposalId,
            needId: assignment.needId,
          },
        );
      }
      reservations.push({
        proposalId: proposal.proposalId,
        resourceId: assignment.resourceId,
        needId: assignment.needId,
        startsAt: new Date(
          Date.parse(need.startsAt) - need.preparationMinutes * 60 * 1000,
        ).toISOString(),
        endsAt: new Date(
          Date.parse(need.endsAt) + need.recoveryMinutes * 60 * 1000,
        ).toISOString(),
        expiresAt: proposal.expiresAt,
      });
    }
  }
  return reservations;
}

function invalidatedResourceIds(
  proposal: ResourceCapacityProposal,
  resources: readonly HouseholdResourceRevision[],
): string[] {
  const currentById = new Map(
    resources.map((resource) => [resource.resourceId, resource]),
  );
  return proposal.evaluation.resourceSnapshots
    .filter((snapshot) => {
      const current = currentById.get(snapshot.resourceId);
      return (
        !current ||
        current.revision !== snapshot.revision ||
        current.contentSha256 !== snapshot.contentSha256
      );
    })
    .map((snapshot) => snapshot.resourceId)
    .sort();
}

function reevaluateProposal(
  proposal: ResourceCapacityProposal,
  resources: readonly HouseholdResourceRevision[],
  evaluatedAt: string,
): ResourceCapacityEvaluation {
  return evaluateResourceCapacity({
    evaluation: {
      plan: proposal.plan,
      assignments: proposal.assignments,
      transitions: proposal.transitions,
      maximumSourceAgeMinutes: proposal.maximumSourceAgeMinutes,
    },
    resources,
    pendingReservations: [],
    evaluatedAt,
  });
}

export class ResourceCapacityService {
  private readonly now: () => Date;
  private readonly reviewTaskEnsures = new Map<
    string,
    Promise<string | null>
  >();

  constructor(private readonly deps: ResourceCapacityDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.deps.repository.ensureSchema();
  }

  private async requireEntity(entityIdValue: string): Promise<string> {
    const entityId = requireCapacityText(entityIdValue, "entityId");
    if (!(await this.deps.entityStore.get(entityId))) {
      throw new ResourceCapacityError(
        `Entity ${entityId} does not exist in the canonical graph`,
        "RESOURCE_CAPACITY_ENTITY_NOT_FOUND",
        { entityId },
      );
    }
    return entityId;
  }

  private async requireScope(
    principalEntityIdValue: string,
    scope: "calendar.freebusy" | "calendar.mutate",
    childEntityIds: readonly string[],
  ): Promise<string> {
    const principalEntityId = await this.requireEntity(principalEntityIdValue);
    for (const childEntityId of childEntityIds) {
      await this.requireEntity(childEntityId);
      await this.deps.household.requireScope({
        principalEntityId,
        scope,
        subjectEntityId: childEntityId,
        at: this.now(),
      });
    }
    return principalEntityId;
  }

  private async settleTerminalArtifacts(
    proposal: ResourceCapacityProposal,
    terminal: ResourceCapacityProposalTerminal,
  ): Promise<void> {
    const links = await this.deps.repository.listApprovalLinks(
      proposal.proposalId,
    );
    for (const link of links) {
      const request = await this.deps.approvalQueue.byId(
        link.approvalRequestId,
      );
      if (!request || !approvalMatches(request, proposal, link.partyEntityId)) {
        throw new ResourceCapacityError(
          "Terminal capacity review references a missing or mismatched approval",
          "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
          {
            proposalId: proposal.proposalId,
            approvalRequestId: link.approvalRequestId,
          },
        );
      }
      if (request.state === "pending" || request.state === "approved") {
        await this.deps.approvalQueue.markExpired(request.id);
      }
    }
    const taskId = await this.deps.repository.getReviewTaskId(
      proposal.proposalId,
    );
    if (!taskId) return;
    const task = (await this.deps.scheduledTasks.list()).find(
      (candidate) => candidate.taskId === taskId,
    );
    if (!task) {
      throw new ResourceCapacityError(
        "Terminal capacity review references a missing ScheduledTask",
        "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
        { proposalId: proposal.proposalId, taskId },
      );
    }
    if (
      task.state.status !== "completed" &&
      task.state.status !== "skipped" &&
      task.state.status !== "expired" &&
      task.state.status !== "failed" &&
      task.state.status !== "dismissed"
    ) {
      await this.deps.scheduledTasks.apply(taskId, "dismiss", {
        reason: `Resource-capacity proposal ${terminal.state}: ${terminal.reason}`,
      });
    }
  }

  private async terminalizeReview(
    proposal: ResourceCapacityProposal,
    state: ResourceCapacityTerminalState,
    reason: string,
  ): Promise<ResourceCapacityProposalTerminal> {
    const terminal = await this.deps.repository.terminalizeProposal({
      proposalId: proposal.proposalId,
      state,
      reason,
      terminalAt: this.now().toISOString(),
    });
    await this.settleTerminalArtifacts(proposal, terminal);
    return terminal;
  }

  private async reconcileTerminalReview(
    proposal: ResourceCapacityProposal,
  ): Promise<ResourceCapacityProposalTerminal | null> {
    if (proposal.status === "blocked") return null;
    const persisted = await this.deps.repository.getProposalTerminal(
      proposal.proposalId,
    );
    if (persisted) {
      await this.settleTerminalArtifacts(proposal, persisted);
      return persisted;
    }
    if (Date.parse(proposal.expiresAt) <= this.now().getTime()) {
      return this.terminalizeReview(
        proposal,
        "expired",
        "The proposal review window expired.",
      );
    }
    const links = await this.deps.repository.listApprovalLinks(
      proposal.proposalId,
    );
    for (const link of links) {
      const request = await this.deps.approvalQueue.byId(
        link.approvalRequestId,
      );
      if (!request || !approvalMatches(request, proposal, link.partyEntityId)) {
        throw new ResourceCapacityError(
          "Capacity review references a missing or mismatched approval",
          "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
          {
            proposalId: proposal.proposalId,
            approvalRequestId: link.approvalRequestId,
          },
        );
      }
      if (request.state === "rejected") {
        return this.terminalizeReview(
          proposal,
          "declined",
          request.resolutionReason ?? "A required reviewer declined.",
        );
      }
      if (request.state === "expired") {
        return this.terminalizeReview(
          proposal,
          "expired",
          request.resolutionReason ?? "A required review was cancelled.",
        );
      }
    }
    return null;
  }

  private async validateResourceGraph(
    definition: HouseholdResourceDefinition,
  ): Promise<void> {
    const referencedEntities = [
      ...definition.authorization.authorizedByEntityIds,
      ...(definition.kind === "caregiver"
        ? [definition.caregiverEntityId, ...definition.authorizedChildEntityIds]
        : definition.kind === "vehicle"
          ? definition.authorizedOperatorEntityIds
          : definition.compatibleChildEntityIds),
    ];
    for (const entityId of uniqueCapacityIds(
      referencedEntities,
      "resource.referencedEntityIds",
    )) {
      await this.requireEntity(entityId);
    }
    if (definition.kind === "caregiver") {
      const bindings = await this.deps.household.listRoleBindings();
      const binding = bindings.find(
        (candidate) => candidate.entityId === definition.caregiverEntityId,
      );
      if (
        definition.caregiverEntityId !== SELF_ENTITY_ID &&
        (!binding ||
          binding.role === "child" ||
          binding.role === "professional" ||
          definition.authorizedChildEntityIds.some(
            (childEntityId) =>
              !binding.subjectEntityIds.includes(childEntityId),
          ))
      ) {
        throw new ResourceCapacityError(
          "Caregiver capacity requires an adult household role explicitly related to every named child",
          "RESOURCE_CAPACITY_ACCESS_DENIED",
          {
            caregiverEntityId: definition.caregiverEntityId,
            authorizedChildEntityIds: definition.authorizedChildEntityIds,
          },
        );
      }
    }
  }

  async putResource(input: {
    principalEntityId: string;
    definition: HouseholdResourceDefinition;
    expectedRevision: number;
  }): Promise<HouseholdResourceRevision> {
    const principalEntityId = await this.requireEntity(input.principalEntityId);
    if (principalEntityId !== SELF_ENTITY_ID) {
      throw new ResourceCapacityError(
        "Only the owner may create or revise resource authorization records",
        "RESOURCE_CAPACITY_ACCESS_DENIED",
        { principalEntityId },
      );
    }
    const definition = normalizeResourceDefinition(input.definition);
    await this.validateResourceGraph(definition);
    return this.deps.repository.putResource(
      definition,
      requireCapacityInteger(input.expectedRevision, "expectedRevision", 0),
      this.now().toISOString(),
    );
  }

  async evaluate(input: {
    principalEntityId: string;
    evaluation: ResourceCapacityEvaluationInput;
  }): Promise<ResourceCapacityEvaluation> {
    const evaluation = normalizeCapacityEvaluationInput(input.evaluation);
    await this.requireScope(
      input.principalEntityId,
      "calendar.freebusy",
      evaluation.plan.childEntityIds,
    );
    const evaluatedAt = this.now().toISOString();
    const [resources, activeProposals] = await Promise.all([
      this.deps.repository.listCurrentResources(evaluation.plan.householdId),
      this.deps.repository.listUnexpiredReviewProposals(
        evaluation.plan.householdId,
        evaluatedAt,
      ),
    ]);
    const nonterminalProposals: ResourceCapacityProposal[] = [];
    for (const proposal of activeProposals) {
      if (!(await this.reconcileTerminalReview(proposal))) {
        nonterminalProposals.push(proposal);
      }
    }
    const currentProposals = nonterminalProposals.filter((proposal) => {
      if (invalidatedResourceIds(proposal, resources).length > 0) return false;
      return reevaluateProposal(proposal, resources, evaluatedAt).feasible;
    });
    return evaluateResourceCapacity({
      evaluation,
      resources,
      pendingReservations: pendingReservations(currentProposals),
      evaluatedAt,
    });
  }

  private async validateApprovers(
    approverIdsValue: readonly string[],
    childEntityIds: readonly string[],
  ): Promise<string[]> {
    const approverIds = uniqueCapacityIds(
      approverIdsValue,
      "requiredApproverEntityIds",
    );
    const bindings = await this.deps.household.listRoleBindings();
    for (const approverId of approverIds) {
      await this.requireEntity(approverId);
      if (approverId === SELF_ENTITY_ID) continue;
      const binding = bindings.find(
        (candidate) => candidate.entityId === approverId,
      );
      if (
        !binding ||
        binding.role === "child" ||
        binding.role === "professional" ||
        childEntityIds.some(
          (childEntityId) => !binding.subjectEntityIds.includes(childEntityId),
        )
      ) {
        throw new ResourceCapacityError(
          "Every reviewer must be an affected adult related to every named child",
          "RESOURCE_CAPACITY_ACCESS_DENIED",
          { approverId, childEntityIds },
        );
      }
      await this.requireScope(approverId, "calendar.freebusy", childEntityIds);
    }
    return approverIds;
  }

  private assertFutureProposalExpiry(
    expiresAt: string,
    evaluation: ResourceCapacityEvaluationInput,
  ): void {
    const nowMs = this.now().getTime();
    const expiresAtMs = Date.parse(expiresAt);
    const earliestOccupiedAt = capacityPlanEarliestOccupiedAt(evaluation.plan);
    if (
      expiresAtMs <= nowMs ||
      expiresAtMs - nowMs > MAXIMUM_PROPOSAL_TTL_MS ||
      expiresAtMs > Date.parse(earliestOccupiedAt)
    ) {
      throw new ResourceCapacityError(
        "Proposal expiry must be in the future, no more than 90 days away, and no later than the first occupied resource window",
        "RESOURCE_CAPACITY_INVALID_CONTRACT",
        { expiresAt, earliestOccupiedAt },
      );
    }
  }

  private async ensureApprovalLinks(
    proposal: ResourceCapacityProposal,
  ): Promise<ResourceCapacityApprovalLink[]> {
    const existing = await this.deps.repository.listApprovalLinks(
      proposal.proposalId,
    );
    const links: ResourceCapacityApprovalLink[] = [];
    for (const partyEntityId of proposal.requiredApproverEntityIds) {
      const current = existing.find(
        (link) => link.partyEntityId === partyEntityId,
      );
      if (current) {
        const request = await this.deps.approvalQueue.byId(
          current.approvalRequestId,
        );
        if (!request || !approvalMatches(request, proposal, partyEntityId)) {
          throw new ResourceCapacityError(
            "Persisted review approval does not match the exact proposal bytes",
            "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
            {
              proposalId: proposal.proposalId,
              partyEntityId,
              approvalRequestId: current.approvalRequestId,
            },
          );
        }
        links.push(current);
        continue;
      }
      const request = await this.deps.approvalQueue.enqueue({
        requestedBy: proposal.createdByEntityId,
        subjectUserId: partyEntityId,
        action: "execute_workflow",
        payload: {
          action: "execute_workflow",
          workflowId: RESOURCE_CAPACITY_REVIEW_WORKFLOW_ID,
          input: {
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            partyEntityId,
            contentSha256: proposal.contentSha256,
            noExternalEffect: true,
          },
        },
        channel: "internal",
        reason: `Review resource-capacity proposal ${proposal.proposalId} v1; approval does not reserve or execute it`,
        idempotencyKey: proposalApprovalKey(proposal, partyEntityId),
        expiresAt: new Date(proposal.expiresAt),
      });
      links.push(
        await this.deps.repository.insertApprovalLink({
          proposalId: proposal.proposalId,
          proposalVersion: 1,
          partyEntityId,
          approvalRequestId: request.id,
          createdAt: this.now().toISOString(),
        }),
      );
    }
    return links.sort((left, right) =>
      left.partyEntityId.localeCompare(right.partyEntityId),
    );
  }

  private async ensureReviewTaskClaimed(
    proposal: ResourceCapacityProposal,
  ): Promise<string | null> {
    if (await this.deps.repository.getProposalTerminal(proposal.proposalId)) {
      return null;
    }
    const existing = await this.deps.repository.getReviewTaskId(
      proposal.proposalId,
    );
    if (existing) return existing;
    const attemptToken = randomUUID();
    let claim:
      | { kind: "claimed" }
      | { kind: "busy" }
      | { kind: "complete"; scheduledTaskId: string } = { kind: "busy" };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const claimedAt = this.now();
      claim = await this.deps.repository.claimReviewTask({
        proposalId: proposal.proposalId,
        attemptToken,
        now: claimedAt.toISOString(),
        leaseExpiresAt: new Date(claimedAt.getTime() + 60 * 1000).toISOString(),
      });
      if (claim.kind === "complete") return claim.scheduledTaskId;
      if (claim.kind === "claimed") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const completed = await this.deps.repository.getReviewTaskId(
        proposal.proposalId,
      );
      if (completed) return completed;
    }
    if (claim.kind !== "claimed") {
      throw new ResourceCapacityError(
        "Another process is still creating the proposal review task",
        "RESOURCE_CAPACITY_CONFLICT",
        { proposalId: proposal.proposalId },
      );
    }
    if (await this.deps.repository.getProposalTerminal(proposal.proposalId)) {
      return null;
    }
    const idempotencyKey = `resource-capacity:review-expiry:${proposal.proposalId}`;
    const existingTasks = (await this.deps.scheduledTasks.list()).filter(
      (task) => task.idempotencyKey === idempotencyKey,
    );
    if (existingTasks.length > 1) {
      throw new ResourceCapacityError(
        "Multiple review tasks share one proposal idempotency key",
        "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
        { proposalId: proposal.proposalId, idempotencyKey },
      );
    }
    const scheduledTaskId =
      existingTasks[0]?.taskId ??
      (
        await this.deps.scheduledTasks.schedule({
          kind: "watcher",
          promptInstructions:
            "The exact resource-capacity review window ended. Show the owner one factual in-app closure card saying the plan must be re-evaluated before anyone relies on it. Do not reserve a caregiver, vehicle, or restraint; do not mutate a calendar; do not send a message.",
          trigger: { kind: "once", atIso: proposal.expiresAt },
          priority: "medium",
          output: {
            destination: "in_app_card",
            target: `entity:${SELF_ENTITY_ID}`,
          },
          subject: { kind: "thread", id: proposal.proposalId },
          idempotencyKey,
          respectsGlobalPause: true,
          source: "plugin",
          createdBy: this.deps.agentId,
          ownerVisible: true,
          metadata: {
            resourceCapacityKind: "proposal_review_expiry",
            proposalId: proposal.proposalId,
            proposalVersion: proposal.version,
            contentSha256: proposal.contentSha256,
            expiresAt: proposal.expiresAt,
            noReservation: true,
            noCalendarMutation: true,
            noExternalSend: true,
          },
        })
      ).taskId;
    const attached = await this.deps.repository.attachReviewTask(
      proposal.proposalId,
      scheduledTaskId,
      this.now().toISOString(),
    );
    const completed = await this.deps.repository.completeReviewTaskClaim({
      proposalId: proposal.proposalId,
      attemptToken,
      scheduledTaskId: attached,
      completedAt: this.now().toISOString(),
    });
    const terminal = await this.deps.repository.getProposalTerminal(
      proposal.proposalId,
    );
    if (terminal) await this.settleTerminalArtifacts(proposal, terminal);
    return completed;
  }

  private async ensureReviewTask(
    proposal: ResourceCapacityProposal,
  ): Promise<string | null> {
    const active = this.reviewTaskEnsures.get(proposal.proposalId);
    if (active) return active;
    const promise = this.ensureReviewTaskClaimed(proposal);
    this.reviewTaskEnsures.set(proposal.proposalId, promise);
    try {
      return await promise;
    } finally {
      if (this.reviewTaskEnsures.get(proposal.proposalId) === promise) {
        this.reviewTaskEnsures.delete(proposal.proposalId);
      }
    }
  }

  private async ensureReviewArtifacts(
    proposal: ResourceCapacityProposal,
  ): Promise<void> {
    if (
      proposal.status === "blocked" ||
      Date.parse(proposal.expiresAt) <= this.now().getTime()
    ) {
      return;
    }
    if (await this.reconcileTerminalReview(proposal)) return;
    const resources = await this.deps.repository.listCurrentResources(
      proposal.householdId,
    );
    if (
      invalidatedResourceIds(proposal, resources).length > 0 ||
      !reevaluateProposal(proposal, resources, this.now().toISOString())
        .feasible
    ) {
      return;
    }
    await this.ensureApprovalLinks(proposal);
    if (await this.reconcileTerminalReview(proposal)) return;
    await this.ensureReviewTask(proposal);
  }

  async createProposal(
    inputValue: CreateProposalInput,
  ): Promise<
    ResourceCapacityReviewProjection & { readonly replayed: boolean }
  > {
    const evaluation = normalizeCapacityEvaluationInput(inputValue.evaluation);
    const createdByEntityId = await this.requireScope(
      inputValue.principalEntityId,
      "calendar.mutate",
      evaluation.plan.childEntityIds,
    );
    const requiredApproverEntityIds = await this.validateApprovers(
      inputValue.requiredApproverEntityIds,
      evaluation.plan.childEntityIds,
    );
    const idempotencyKey = requireCapacityText(
      inputValue.idempotencyKey,
      "idempotencyKey",
    );
    const expiresAt = requireCapacityTimestamp(
      inputValue.expiresAt,
      "expiresAt",
    );
    const inputSha256 = proposalInputSha256({
      ...evaluation,
      requiredApproverEntityIds,
      expiresAt,
    });
    const replay =
      await this.deps.repository.getProposalByIdempotencyKey(idempotencyKey);
    if (replay) {
      if (replay.inputSha256 !== inputSha256) {
        throw new ResourceCapacityError(
          "Proposal idempotency key was reused for different input",
          "RESOURCE_CAPACITY_CONFLICT",
          { idempotencyKey, proposalId: replay.proposalId },
        );
      }
      await this.ensureReviewArtifacts(replay);
      return {
        ...(await this.projectReview(replay)),
        replayed: true,
      };
    }
    this.assertFutureProposalExpiry(expiresAt, evaluation);

    const result = await this.evaluate({
      principalEntityId: createdByEntityId,
      evaluation,
    });
    const createdAt = this.now().toISOString();
    const withoutHash: Omit<ResourceCapacityProposal, "contentSha256"> = {
      proposalId: `resource-capacity-${randomUUID()}`,
      agentId: this.deps.agentId,
      version: 1,
      householdId: evaluation.plan.householdId,
      createdByEntityId,
      idempotencyKey,
      inputSha256,
      plan: evaluation.plan,
      assignments: evaluation.assignments,
      transitions: evaluation.transitions,
      maximumSourceAgeMinutes: evaluation.maximumSourceAgeMinutes,
      evaluation: result,
      requiredApproverEntityIds,
      status: result.feasible ? "pending_review" : "blocked",
      expiresAt,
      createdAt,
      noExternalEffect: true,
    };
    const proposal: ResourceCapacityProposal = {
      ...withoutHash,
      contentSha256: proposalContentSha256(withoutHash),
    };
    const persisted = await this.deps.repository.insertProposal(proposal);
    await this.ensureReviewArtifacts(persisted.proposal);
    return {
      ...(await this.projectReview(persisted.proposal)),
      replayed: !persisted.inserted,
    };
  }

  private async projectReview(
    proposal: ResourceCapacityProposal,
  ): Promise<ResourceCapacityReviewProjection> {
    const terminal = await this.reconcileTerminalReview(proposal);
    const resources = await this.deps.repository.listCurrentResources(
      proposal.householdId,
    );
    const invalidated = invalidatedResourceIds(proposal, resources);
    const invalidationConflicts =
      proposal.status === "pending_review" && invalidated.length === 0
        ? reevaluateProposal(proposal, resources, this.now().toISOString())
            .conflicts
        : [];
    if (proposal.status === "blocked") {
      return {
        proposal,
        effectiveState: "blocked",
        approvals: [],
        reviewTaskId: null,
        invalidatedResourceIds: invalidated,
        invalidationConflicts,
        noReservationCreated: true,
        noCalendarMutationCreated: true,
        noMessageSent: true,
      };
    }
    const links = await this.deps.repository.listApprovalLinks(
      proposal.proposalId,
    );
    const approvals: ResourceCapacityReviewProjection["approvals"][number][] =
      [];
    for (const link of links) {
      const request = await this.deps.approvalQueue.byId(
        link.approvalRequestId,
      );
      if (!request || !approvalMatches(request, proposal, link.partyEntityId)) {
        throw new ResourceCapacityError(
          "Capacity review references a missing or mismatched approval",
          "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
          {
            proposalId: proposal.proposalId,
            approvalRequestId: link.approvalRequestId,
          },
        );
      }
      approvals.push({
        partyEntityId: link.partyEntityId,
        approvalRequestId: link.approvalRequestId,
        state: request.state,
      });
    }
    const nowMs = this.now().getTime();
    const effectiveState =
      terminal !== null
        ? terminal.state
        : Date.parse(proposal.expiresAt) <= nowMs
          ? "expired"
          : invalidated.length > 0 || invalidationConflicts.length > 0
            ? "invalidated"
            : approvals.some(
                  (approval) =>
                    approval.state === "rejected" ||
                    approval.state === "expired",
                )
              ? "declined"
              : approvals.length ===
                    proposal.requiredApproverEntityIds.length &&
                  approvals.every(
                    (approval) =>
                      approval.state === "approved" ||
                      approval.state === "executing" ||
                      approval.state === "done",
                  )
                ? "review_complete"
                : "pending_review";
    return {
      proposal,
      effectiveState,
      approvals: approvals.sort((left, right) =>
        left.partyEntityId.localeCompare(right.partyEntityId),
      ),
      reviewTaskId: await this.deps.repository.getReviewTaskId(
        proposal.proposalId,
      ),
      invalidatedResourceIds: invalidated,
      invalidationConflicts,
      noReservationCreated: true,
      noCalendarMutationCreated: true,
      noMessageSent: true,
    };
  }

  async readProposal(input: {
    principalEntityId: string;
    proposalId: string;
  }): Promise<ResourceCapacityReviewProjection> {
    const proposal = await this.deps.repository.getProposal(
      requireCapacityText(input.proposalId, "proposalId"),
    );
    if (!proposal) {
      throw new ResourceCapacityError(
        "Resource-capacity proposal was not found",
        "RESOURCE_CAPACITY_NOT_FOUND",
        { proposalId: input.proposalId },
      );
    }
    await this.requireScope(
      input.principalEntityId,
      "calendar.freebusy",
      proposal.plan.childEntityIds,
    );
    await this.ensureReviewArtifacts(proposal);
    return this.projectReview(proposal);
  }

  async respondToProposal(input: {
    principalEntityId: string;
    proposalId: string;
    proposalVersion: number;
    partyEntityId: string;
    approvalRequestId: string;
    contentSha256: string;
    decision: "approve" | "reject";
    reason: string;
  }): Promise<ApprovalRequest> {
    const principalEntityId = await this.requireEntity(input.principalEntityId);
    const partyEntityId = await this.requireEntity(input.partyEntityId);
    if (principalEntityId !== partyEntityId) {
      throw new ResourceCapacityError(
        "A reviewer may only resolve their own capacity proposal request",
        "RESOURCE_CAPACITY_ACCESS_DENIED",
        { principalEntityId, partyEntityId },
      );
    }
    if (
      requireCapacityInteger(input.proposalVersion, "proposalVersion", 1) !== 1
    ) {
      throw new ResourceCapacityError(
        "Resource-capacity proposal version is unsupported",
        "RESOURCE_CAPACITY_INVALID_CONTRACT",
        { proposalVersion: input.proposalVersion },
      );
    }
    const proposal = await this.deps.repository.getProposal(
      requireCapacityText(input.proposalId, "proposalId"),
    );
    if (!proposal) {
      throw new ResourceCapacityError(
        "Resource-capacity proposal was not found",
        "RESOURCE_CAPACITY_NOT_FOUND",
        { proposalId: input.proposalId },
      );
    }
    await this.requireScope(
      principalEntityId,
      "calendar.freebusy",
      proposal.plan.childEntityIds,
    );
    if (
      proposal.status !== "pending_review" ||
      Date.parse(proposal.expiresAt) <= this.now().getTime() ||
      proposal.contentSha256 !==
        requireCapacityText(input.contentSha256, "contentSha256", 64)
    ) {
      throw new ResourceCapacityError(
        "Capacity review no longer matches an active exact proposal",
        "RESOURCE_CAPACITY_CONFLICT",
        {
          proposalId: proposal.proposalId,
          status: proposal.status,
          expiresAt: proposal.expiresAt,
        },
      );
    }
    const resources = await this.deps.repository.listCurrentResources(
      proposal.householdId,
    );
    const invalidated = invalidatedResourceIds(proposal, resources);
    const invalidationConflicts =
      invalidated.length === 0
        ? reevaluateProposal(proposal, resources, this.now().toISOString())
            .conflicts
        : [];
    if (invalidated.length > 0 || invalidationConflicts.length > 0) {
      throw new ResourceCapacityError(
        "Capacity review is invalid because assigned resources or source evidence changed after evaluation",
        "RESOURCE_CAPACITY_CONFLICT",
        {
          proposalId: proposal.proposalId,
          invalidatedResourceIds: invalidated,
          invalidationConflictKinds: invalidationConflicts.map(
            (conflict) => conflict.kind,
          ),
        },
      );
    }
    const link = (
      await this.deps.repository.listApprovalLinks(proposal.proposalId)
    ).find((candidate) => candidate.partyEntityId === partyEntityId);
    const approvalRequestId = requireCapacityText(
      input.approvalRequestId,
      "approvalRequestId",
    );
    const request = await this.deps.approvalQueue.byId(approvalRequestId);
    if (
      !link ||
      link.approvalRequestId !== approvalRequestId ||
      !request ||
      !approvalMatches(request, proposal, partyEntityId)
    ) {
      throw new ResourceCapacityError(
        "Capacity review request does not match the exact proposal and party",
        "RESOURCE_CAPACITY_CONFLICT",
        {
          proposalId: proposal.proposalId,
          partyEntityId,
          approvalRequestId,
        },
      );
    }
    const reason = requireCapacityText(input.reason, "reason", 2_000);
    const resolution = {
      resolvedBy: partyEntityId,
      resolutionReason: reason,
    };
    if (input.decision === "approve") {
      return this.deps.approvalQueue.approve(approvalRequestId, resolution);
    }
    const rejected = await this.deps.approvalQueue.reject(
      approvalRequestId,
      resolution,
    );
    await this.terminalizeReview(proposal, "declined", reason);
    return rejected;
  }

  async cancelProposal(input: {
    principalEntityId: string;
    proposalId: string;
    reason: string;
  }): Promise<
    ResourceCapacityReviewProjection & { readonly replayed: boolean }
  > {
    const principalEntityId = await this.requireEntity(input.principalEntityId);
    if (principalEntityId !== SELF_ENTITY_ID) {
      throw new ResourceCapacityError(
        "Only the owner may cancel a resource-capacity proposal",
        "RESOURCE_CAPACITY_ACCESS_DENIED",
        { principalEntityId },
      );
    }
    const proposal = await this.deps.repository.getProposal(
      requireCapacityText(input.proposalId, "proposalId"),
    );
    if (!proposal) {
      throw new ResourceCapacityError(
        "Resource-capacity proposal was not found",
        "RESOURCE_CAPACITY_NOT_FOUND",
        { proposalId: input.proposalId },
      );
    }
    const existingTerminal = await this.deps.repository.getProposalTerminal(
      proposal.proposalId,
    );
    if (existingTerminal) {
      if (existingTerminal.state !== "cancelled") {
        throw new ResourceCapacityError(
          "Resource-capacity proposal already has a different terminal outcome",
          "RESOURCE_CAPACITY_CONFLICT",
          {
            proposalId: proposal.proposalId,
            terminalState: existingTerminal.state,
          },
        );
      }
      await this.settleTerminalArtifacts(proposal, existingTerminal);
      return {
        ...(await this.projectReview(proposal)),
        replayed: true,
      };
    }
    if (proposal.status !== "pending_review") {
      throw new ResourceCapacityError(
        "Only a pending resource-capacity review may be cancelled",
        "RESOURCE_CAPACITY_CONFLICT",
        { proposalId: proposal.proposalId, status: proposal.status },
      );
    }
    await this.terminalizeReview(
      proposal,
      "cancelled",
      requireCapacityText(input.reason, "reason", 2_000),
    );
    return {
      ...(await this.projectReview(proposal)),
      replayed: false,
    };
  }
}

export function createResourceCapacityService(
  runtime: IAgentRuntime,
): ResourceCapacityService {
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw new ResourceCapacityError(
      "KnowledgeGraphService is required for resource-capacity planning",
      "RESOURCE_CAPACITY_PERSISTED_DATA_INVALID",
      { agentId: runtime.agentId },
    );
  }
  return new ResourceCapacityService({
    runtime,
    agentId: runtime.agentId,
    entityStore: graph.getEntityStore(runtime.agentId),
    household:
      getHouseholdCoordinationService(runtime) ??
      createHouseholdCoordinationService(runtime),
    repository: new ResourceCapacityRepository(runtime, runtime.agentId),
    approvalQueue: createApprovalQueue(runtime, {
      agentId: runtime.agentId,
    }),
    scheduledTasks: getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    }),
  });
}

export class ResourceCapacityRuntimeService extends Service {
  static override serviceType = RESOURCE_CAPACITY_SERVICE;

  override capabilityDescription =
    "Source-grounded caregiver, vehicle, restraint, accessibility, handoff, and transition-capacity proposals";

  private capacityInstance: ResourceCapacityService | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new ResourceCapacityError(
        "ResourceCapacityRuntimeService requires a runtime",
        "RESOURCE_CAPACITY_INVALID_CONTRACT",
      );
    }
  }

  get capacity(): ResourceCapacityService {
    if (!this.capacityInstance) {
      // Plugin services can register before the agent-owned graph service has
      // started. Construction is deferred until the first real action or
      // connector review, where a missing graph is an observable hard failure.
      this.capacityInstance = createResourceCapacityService(this.runtime);
    }
    return this.capacityInstance;
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<ResourceCapacityRuntimeService> {
    return new ResourceCapacityRuntimeService(runtime);
  }

  async stop(): Promise<void> {}
}

export function getResourceCapacityService(
  runtime: IAgentRuntime,
): ResourceCapacityService | null {
  return (
    runtime.getService<ResourceCapacityRuntimeService>(
      RESOURCE_CAPACITY_SERVICE,
    )?.capacity ?? null
  );
}
