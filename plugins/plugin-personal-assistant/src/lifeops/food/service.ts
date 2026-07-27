/**
 * Food-domain policy service over the canonical entity/relationship graph,
 * owner approval queue, durable food repository, and Instacart link boundary.
 * It never treats a generated link as a cart, checkout, order, or delivery.
 */
import {
  type EntityStore,
  type RelationshipStore,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import { type IAgentRuntime, Service } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../approval-queue.types.js";
import { InstacartProductsLinkClient } from "./instacart.js";
import {
  assertMealPlanSafe,
  buildShoppingListContent,
  type EvaluateMealPlanInput,
  evaluateMealPlan,
} from "./planner.js";
import { FoodRepository } from "./repository.js";
import {
  assertNonEmptyText,
  type FoodChildView,
  FoodDomainError,
  type FoodHouseholdProfile,
  type FoodOwnerView,
  type FoodPreference,
  type FoodShoppingHandoff,
  type FoodView,
  type HardFoodConstraint,
  type InventoryObservation,
  type MealPlanEvaluation,
  type PublishedMealPlan,
} from "./types.js";

const FOOD_APPROVAL_WORKFLOW_ID = "food.instacart.create_products_link";
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROVIDER_LEASE_MS = 2 * 60 * 1000;
const HOUSEHOLD_ROLE_METADATA_KEY = "householdRole";
const HOUSEHOLD_SUBJECTS_METADATA_KEY = "householdSubjectEntityIds";

export interface FoodDomainDependencies {
  runtime: IAgentRuntime;
  agentId: string;
  entityStore: EntityStore;
  relationshipStore: RelationshipStore;
  approvalQueue: ApprovalQueue;
  repository: FoodRepository;
  instacart: InstacartProductsLinkClient | null;
  now?: () => Date;
}

function exactApprovalPayloadMatches(
  request: ApprovalRequest | null,
  handoff: FoodShoppingHandoff,
): boolean {
  return (
    request !== null &&
    request.action === "execute_workflow" &&
    request.payload.action === "execute_workflow" &&
    request.payload.workflowId === FOOD_APPROVAL_WORKFLOW_ID &&
    request.payload.input.handoffId === handoff.handoffId &&
    request.payload.input.householdId === handoff.householdId &&
    request.payload.input.contentSha256 === handoff.contentSha256
  );
}

function relationshipRole(
  relationships: Awaited<ReturnType<RelationshipStore["list"]>>,
): string | null {
  for (const relationship of relationships) {
    const role = relationship.metadata?.[HOUSEHOLD_ROLE_METADATA_KEY];
    if (typeof role === "string") return role;
  }
  return null;
}

function relationshipSubjects(
  relationships: Awaited<ReturnType<RelationshipStore["list"]>>,
): string[] {
  return Array.from(
    new Set(
      relationships.flatMap((relationship) => {
        const subjects =
          relationship.metadata?.[HOUSEHOLD_SUBJECTS_METADATA_KEY];
        return Array.isArray(subjects)
          ? subjects.filter(
              (subject): subject is string => typeof subject === "string",
            )
          : [];
      }),
    ),
  );
}

export class FoodDomainService {
  private readonly now: () => Date;

  constructor(private readonly deps: FoodDomainDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.deps.repository.ensureSchema();
    await this.deps.repository.recoverStaleHandoffs(this.now().toISOString());
  }

  private assertOwnerPrincipal(principalEntityId: string): void {
    if (principalEntityId !== SELF_ENTITY_ID) {
      throw new FoodDomainError(
        "Only the authenticated household owner may mutate food policy, inventory, or shopping handoffs",
        "FOOD_ACCESS_DENIED",
        { principalEntityId },
      );
    }
  }

  private async requireProfile(
    householdId: string,
  ): Promise<FoodHouseholdProfile> {
    const profile = await this.deps.repository.getHouseholdProfile(householdId);
    if (!profile) {
      throw new FoodDomainError(
        "Food household profile does not exist",
        "FOOD_INVALID_CONTRACT",
        { householdId },
      );
    }
    return profile;
  }

  private async assertKnownEntity(entityId: string): Promise<void> {
    if (!(await this.deps.entityStore.get(entityId))) {
      throw new FoodDomainError(
        `Food-domain subject ${entityId} is not a canonical EntityStore entity`,
        "FOOD_ENTITY_NOT_FOUND",
        { entityId },
      );
    }
  }

  private async assertHouseholdRelationship(entityId: string): Promise<void> {
    if (entityId === SELF_ENTITY_ID) return;
    const relationships = await this.deps.relationshipStore.list({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: entityId,
    });
    if (relationships.length === 0) {
      throw new FoodDomainError(
        `Food-domain member ${entityId} has no active household relationship`,
        "FOOD_RELATIONSHIP_REQUIRED",
        { entityId },
      );
    }
  }

  private async assertProfileMember(
    profile: FoodHouseholdProfile,
    entityId: string,
  ): Promise<void> {
    if (!profile.memberEntityIds.includes(entityId)) {
      throw new FoodDomainError(
        `Entity ${entityId} is outside food household ${profile.householdId}`,
        "FOOD_ACCESS_DENIED",
        { entityId, householdId: profile.householdId },
      );
    }
    await this.assertKnownEntity(entityId);
    await this.assertHouseholdRelationship(entityId);
  }

  async putHouseholdProfile(input: {
    principalEntityId: string;
    householdId: string;
    memberEntityIds: string[];
    expectedVersion: number;
  }): Promise<FoodHouseholdProfile> {
    this.assertOwnerPrincipal(input.principalEntityId);
    for (const memberEntityId of input.memberEntityIds) {
      await this.assertKnownEntity(memberEntityId);
      await this.assertHouseholdRelationship(memberEntityId);
    }
    return this.deps.repository.putHouseholdProfile({
      householdId: input.householdId,
      memberEntityIds: input.memberEntityIds,
      expectedVersion: input.expectedVersion,
      now: this.now().toISOString(),
    });
  }

  async putConstraint(input: {
    principalEntityId: string;
    constraint: HardFoodConstraint;
    expectedVersion: number;
  }): Promise<HardFoodConstraint> {
    this.assertOwnerPrincipal(input.principalEntityId);
    const profile = await this.requireProfile(input.constraint.householdId);
    if (input.constraint.appliesToEntityId !== null) {
      await this.assertProfileMember(
        profile,
        input.constraint.appliesToEntityId,
      );
    }
    return this.deps.repository.putConstraint(
      input.constraint,
      input.expectedVersion,
      this.now().toISOString(),
    );
  }

  async putPreference(input: {
    principalEntityId: string;
    preference: FoodPreference;
    expectedVersion: number;
  }): Promise<FoodPreference> {
    this.assertOwnerPrincipal(input.principalEntityId);
    const profile = await this.requireProfile(input.preference.householdId);
    if (input.preference.appliesToEntityId !== null) {
      await this.assertProfileMember(
        profile,
        input.preference.appliesToEntityId,
      );
    }
    return this.deps.repository.putPreference(
      input.preference,
      input.expectedVersion,
      this.now().toISOString(),
    );
  }

  async recordInventoryObservation(input: {
    principalEntityId: string;
    observation: InventoryObservation;
  }): Promise<{
    current: Awaited<ReturnType<FoodRepository["listInventory"]>>[number];
    applied: boolean;
  }> {
    this.assertOwnerPrincipal(input.principalEntityId);
    await this.requireProfile(input.observation.lot.householdId);
    return this.deps.repository.recordInventoryObservation(
      input.observation,
      this.now().toISOString(),
    );
  }

  async evaluateMeal(input: {
    principalEntityId: string;
    householdId: string;
    plannedFor: string;
    meal: EvaluateMealPlanInput["meal"];
    participants: EvaluateMealPlanInput["participants"];
  }): Promise<MealPlanEvaluation> {
    this.assertOwnerPrincipal(input.principalEntityId);
    const profile = await this.requireProfile(input.householdId);
    for (const participant of input.participants) {
      await this.assertProfileMember(profile, participant.entityId);
    }
    const [constraints, preferences, inventory] = await Promise.all([
      this.deps.repository.listConstraints(input.householdId),
      this.deps.repository.listPreferences(input.householdId),
      this.deps.repository.listInventory(input.householdId),
    ]);
    return evaluateMealPlan({
      householdId: input.householdId,
      plannedFor: input.plannedFor,
      meal: input.meal,
      participants: input.participants,
      constraints,
      preferences,
      inventory,
    });
  }

  async publishMealPlan(input: {
    principalEntityId: string;
    planId: string;
    evaluation: MealPlanEvaluation;
  }): Promise<PublishedMealPlan> {
    this.assertOwnerPrincipal(input.principalEntityId);
    const evaluation = assertMealPlanSafe(
      await this.currentCanonicalEvaluation(input.evaluation),
    );
    return this.deps.repository.publishMealPlan(
      {
        planId: assertNonEmptyText(input.planId, "planId", 200),
        householdId: evaluation.householdId,
        mealDate: evaluation.plannedFor,
        title: evaluation.meal.title,
        attendeeEntityIds: evaluation.participants.map(
          (participant) => participant.entityId,
        ),
        evaluation,
        contentSha256: evaluation.contentSha256,
      },
      this.now().toISOString(),
    );
  }

  private async currentCanonicalEvaluation(
    evaluation: MealPlanEvaluation,
  ): Promise<MealPlanEvaluation> {
    const profile = await this.requireProfile(evaluation.householdId);
    for (const participant of evaluation.participants) {
      await this.assertProfileMember(profile, participant.entityId);
    }
    const [constraints, preferences, inventory] = await Promise.all([
      this.deps.repository.listConstraints(evaluation.householdId),
      this.deps.repository.listPreferences(evaluation.householdId),
      this.deps.repository.listInventory(evaluation.householdId),
    ]);
    const canonical = evaluateMealPlan({
      householdId: evaluation.householdId,
      plannedFor: evaluation.plannedFor,
      meal: evaluation.meal,
      participants: evaluation.participants,
      constraints,
      preferences,
      inventory,
    });
    if (canonical.contentSha256 !== evaluation.contentSha256) {
      throw new FoodDomainError(
        "Meal evaluation is stale or does not match its deterministic content hash",
        "FOOD_STALE_SOURCE",
        {
          householdId: evaluation.householdId,
          safetyPolicyChanged:
            canonical.safetyPolicySha256 !== evaluation.safetyPolicySha256,
          inventoryChanged:
            canonical.inventorySnapshotSha256 !==
            evaluation.inventorySnapshotSha256,
        },
      );
    }
    return canonical;
  }

  async requestShoppingHandoffApproval(input: {
    principalEntityId: string;
    evaluation: MealPlanEvaluation;
    idempotencyKey: string;
  }): Promise<{
    handoff: FoodShoppingHandoff;
    approvalRequest: ApprovalRequest;
  }> {
    this.assertOwnerPrincipal(input.principalEntityId);
    const evaluation = await this.currentCanonicalEvaluation(input.evaluation);
    const content = buildShoppingListContent(evaluation);
    let handoff = await this.deps.repository.prepareHandoff({
      householdId: content.householdId,
      requestedByEntityId: input.principalEntityId,
      idempotencyKey: assertNonEmptyText(
        input.idempotencyKey,
        "idempotencyKey",
        300,
      ),
      content,
      now: this.now().toISOString(),
    });
    if (handoff.approvalRequestId !== null) {
      const existing = await this.deps.approvalQueue.byId(
        handoff.approvalRequestId,
      );
      if (!existing || !exactApprovalPayloadMatches(existing, handoff)) {
        throw new FoodDomainError(
          "Persisted shopping handoff approval does not match its exact content",
          "FOOD_APPROVAL_MISMATCH",
          { handoffId: handoff.handoffId },
        );
      }
      return { handoff, approvalRequest: existing };
    }
    const approvalRequest = await this.deps.approvalQueue.enqueue({
      requestedBy: `food-domain:${this.deps.agentId}`,
      subjectUserId: input.principalEntityId,
      action: "execute_workflow",
      payload: {
        action: "execute_workflow",
        workflowId: FOOD_APPROVAL_WORKFLOW_ID,
        input: {
          handoffId: handoff.handoffId,
          householdId: handoff.householdId,
          contentSha256: handoff.contentSha256,
        },
      },
      channel: "internal",
      reason:
        "Create this exact external shopping-list link for human store, product-label, cart, and checkout review.",
      idempotencyKey: `food-handoff-approval:${handoff.handoffId}`,
      expiresAt: new Date(
        Date.parse(handoff.createdAt) + DEFAULT_APPROVAL_TTL_MS,
      ),
    });
    handoff = await this.deps.repository.bindApproval(
      handoff.handoffId,
      approvalRequest.id,
      this.now().toISOString(),
    );
    return { handoff, approvalRequest };
  }

  private async approvedRequestFor(
    handoff: FoodShoppingHandoff,
  ): Promise<ApprovalRequest> {
    if (handoff.approvalRequestId === null) {
      throw new FoodDomainError(
        "Shopping handoff has no approval request",
        "FOOD_APPROVAL_REQUIRED",
        { handoffId: handoff.handoffId },
      );
    }
    const request = await this.deps.approvalQueue.byId(
      handoff.approvalRequestId,
    );
    if (
      request?.state !== "approved" ||
      !exactApprovalPayloadMatches(request, handoff)
    ) {
      throw new FoodDomainError(
        "Shopping handoff requires approval of its exact current content",
        request && !exactApprovalPayloadMatches(request, handoff)
          ? "FOOD_APPROVAL_MISMATCH"
          : "FOOD_APPROVAL_REQUIRED",
        { handoffId: handoff.handoffId, approvalState: request?.state },
      );
    }
    return request;
  }

  private async reconcileCompletedApproval(
    handoff: FoodShoppingHandoff,
  ): Promise<void> {
    if (handoff.approvalRequestId === null) {
      throw new FoodDomainError(
        "Completed shopping handoff is missing its approval receipt",
        "FOOD_APPROVAL_MISMATCH",
        { handoffId: handoff.handoffId },
      );
    }
    let request = await this.deps.approvalQueue.byId(handoff.approvalRequestId);
    if (!request || !exactApprovalPayloadMatches(request, handoff)) {
      throw new FoodDomainError(
        "Completed shopping handoff approval does not match its content",
        "FOOD_APPROVAL_MISMATCH",
        { handoffId: handoff.handoffId },
      );
    }
    if (request.state === "done") return;
    if (request.state === "approved") {
      request = await this.deps.approvalQueue.markExecuting(request.id);
    }
    if (request.state === "executing") {
      await this.deps.approvalQueue.markDone(request.id);
      return;
    }
    throw new FoodDomainError(
      "Completed shopping handoff has a contradictory approval state",
      "FOOD_APPROVAL_MISMATCH",
      { handoffId: handoff.handoffId, approvalState: request.state },
    );
  }

  async materializeApprovedShoppingHandoff(input: {
    principalEntityId: string;
    handoffId: string;
  }): Promise<FoodShoppingHandoff> {
    this.assertOwnerPrincipal(input.principalEntityId);
    const current = await this.deps.repository.getHandoff(input.handoffId);
    if (!current) {
      throw new FoodDomainError(
        "Shopping handoff does not exist",
        "FOOD_INVALID_CONTRACT",
        { handoffId: input.handoffId },
      );
    }
    if (current.state === "link_created") {
      await this.reconcileCompletedApproval(current);
      return current;
    }
    const approval = await this.approvedRequestFor(current);
    const [policyHash, inventoryHash] = await Promise.all([
      this.deps.repository.getSafetyPolicySha256(current.householdId),
      this.deps.repository.getInventorySnapshotSha256(current.householdId),
    ]);
    if (
      policyHash !== current.content.safetyPolicySha256 ||
      inventoryHash !== current.content.inventorySnapshotSha256
    ) {
      await this.deps.approvalQueue.markExpired(approval.id);
      await this.deps.repository.blockHandoff(
        current.handoffId,
        "source_changed_after_approval",
        this.now().toISOString(),
      );
      throw new FoodDomainError(
        "Safety or inventory state changed after approval",
        "FOOD_STALE_SOURCE",
        {
          handoffId: current.handoffId,
          safetyPolicyChanged:
            policyHash !== current.content.safetyPolicySha256,
          inventoryChanged:
            inventoryHash !== current.content.inventorySnapshotSha256,
        },
      );
    }
    const instacart = this.deps.instacart;
    if (!instacart) {
      throw new FoodDomainError(
        "Instacart products-link capability is not configured",
        "FOOD_PROVIDER_UNAVAILABLE",
        { handoffId: current.handoffId },
      );
    }
    const claim = await this.deps.repository.claimHandoff({
      handoffId: current.handoffId,
      now: this.now().toISOString(),
      leaseMs: DEFAULT_PROVIDER_LEASE_MS,
    });
    let receipt: Awaited<
      ReturnType<InstacartProductsLinkClient["createProductsLink"]>
    >;
    try {
      receipt = await instacart.createProductsLink(claim.handoff.content);
    } catch (error) {
      // error-policy:J1 this is the external side-effect boundary: persist a
      // visible terminal/ambiguous state, then preserve the typed failure.
      const code =
        error instanceof FoodDomainError
          ? error.code
          : "FOOD_PROVIDER_UNAVAILABLE";
      const definitiveFailure =
        code === "FOOD_INVALID_CONTRACT" || code === "FOOD_PROVIDER_REJECTED";
      const safelyRetryable = code === "FOOD_PROVIDER_RATE_LIMITED";
      await this.deps.repository.failClaim({
        handoffId: claim.handoff.handoffId,
        attemptToken: claim.attemptToken,
        state: definitiveFailure
          ? "blocked"
          : safelyRetryable
            ? "awaiting_approval"
            : "ambiguous",
        failureCode: code,
        now: this.now().toISOString(),
      });
      if (error instanceof FoodDomainError) throw error;
      throw new FoodDomainError(
        "Shopping-list provider failed after the handoff attempt was claimed",
        "FOOD_PROVIDER_UNAVAILABLE",
        { handoffId: claim.handoff.handoffId },
        error,
      );
    }
    try {
      await this.deps.approvalQueue.markExecuting(approval.id);
    } catch (error) {
      // error-policy:J2 a post-provider approval race makes the external
      // outcome unsafe to replay; persist ambiguity and preserve the cause.
      await this.deps.repository.failClaim({
        handoffId: claim.handoff.handoffId,
        attemptToken: claim.attemptToken,
        state: "ambiguous",
        failureCode: "approval_transition_failed_after_provider_success",
        now: this.now().toISOString(),
      });
      throw new FoodDomainError(
        "Approval state changed after the provider created a shopping link",
        "FOOD_APPROVAL_MISMATCH",
        { handoffId: claim.handoff.handoffId },
        error,
      );
    }
    const completed = await this.deps.repository.completeHandoff({
      handoffId: claim.handoff.handoffId,
      attemptToken: claim.attemptToken,
      providerLinkUrl: receipt.productsLinkUrl,
      now: this.now().toISOString(),
    });
    await this.deps.approvalQueue.markDone(approval.id);
    return completed;
  }

  async getView(input: {
    principalEntityId: string;
    householdId: string;
  }): Promise<FoodView> {
    const profile = await this.requireProfile(input.householdId);
    if (input.principalEntityId === SELF_ENTITY_ID) {
      const [constraints, preferences, inventory, mealPlans, handoffs] =
        await Promise.all([
          this.deps.repository.listConstraints(input.householdId),
          this.deps.repository.listPreferences(input.householdId),
          this.deps.repository.listInventory(input.householdId),
          this.deps.repository.listMealPlans(input.householdId),
          this.deps.repository.listHandoffs(input.householdId),
        ]);
      const ownerView: FoodOwnerView = {
        profile,
        constraints,
        preferences,
        inventory,
        mealPlans,
        handoffs,
      };
      return ownerView;
    }
    await this.assertProfileMember(profile, input.principalEntityId);
    const relationships = await this.deps.relationshipStore.list({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: input.principalEntityId,
    });
    const role = relationshipRole(relationships);
    const subjects = relationshipSubjects(relationships);
    if (
      role !== "child" ||
      (subjects.length > 0 && !subjects.includes(input.principalEntityId))
    ) {
      throw new FoodDomainError(
        "Food detail views are owner-only; only a child-safe meal projection is available to child principals",
        "FOOD_ACCESS_DENIED",
        { principalEntityId: input.principalEntityId, role },
      );
    }
    const plans = await this.deps.repository.listMealPlans(input.householdId);
    const childView: FoodChildView = {
      householdId: input.householdId,
      principalEntityId: input.principalEntityId,
      meals: plans
        .filter((plan) =>
          plan.attendeeEntityIds.includes(input.principalEntityId),
        )
        .map((plan) => ({
          planId: plan.planId,
          mealDate: plan.mealDate,
          title: plan.title,
          attending: true,
        })),
    };
    return childView;
  }
}

export const FOOD_DOMAIN_SERVICE = "lifeops_food_domain";

export function createFoodDomainService(
  runtime: IAgentRuntime,
): FoodDomainService {
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw new FoodDomainError(
      "KnowledgeGraphService is required for the food domain",
      "FOOD_INVALID_CONTRACT",
    );
  }
  const apiKeySetting = runtime.getSetting("INSTACART_API_KEY");
  const environmentSetting = runtime.getSetting("INSTACART_ENVIRONMENT");
  if (
    environmentSetting !== undefined &&
    environmentSetting !== null &&
    environmentSetting !== "" &&
    environmentSetting !== "development" &&
    environmentSetting !== "production"
  ) {
    throw new FoodDomainError(
      "INSTACART_ENVIRONMENT must be development or production",
      "FOOD_INVALID_CONTRACT",
    );
  }
  const environment =
    environmentSetting === "development" ? "development" : "production";
  const instacart =
    typeof apiKeySetting === "string" && apiKeySetting.trim().length > 0
      ? new InstacartProductsLinkClient({
          apiKey: apiKeySetting,
          environment,
        })
      : null;
  return new FoodDomainService({
    runtime,
    agentId: runtime.agentId,
    entityStore: graph.getEntityStore(runtime.agentId),
    relationshipStore: graph.getRelationshipStore(runtime.agentId),
    approvalQueue: createApprovalQueue(runtime, { agentId: runtime.agentId }),
    repository: new FoodRepository(runtime, runtime.agentId),
    instacart,
  });
}

export class FoodDomainRuntimeService extends Service {
  static override serviceType = FOOD_DOMAIN_SERVICE;

  override capabilityDescription =
    "Constraint-safe meal, inventory, and approval-bound shopping-list coordination";

  readonly food: FoodDomainService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new FoodDomainError(
        "FoodDomainRuntimeService requires a runtime",
        "FOOD_INVALID_CONTRACT",
      );
    }
    this.food = createFoodDomainService(runtime);
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<FoodDomainRuntimeService> {
    const service = new FoodDomainRuntimeService(runtime);
    await service.food.initialize();
    return service;
  }

  async stop(): Promise<void> {}
}

export function getFoodDomainService(
  runtime: IAgentRuntime,
): FoodDomainService {
  const runtimeService =
    runtime.getService<FoodDomainRuntimeService>(FOOD_DOMAIN_SERVICE);
  if (!runtimeService) {
    throw new FoodDomainError(
      "FoodDomainRuntimeService is required for food-domain operations",
      "FOOD_INVALID_CONTRACT",
    );
  }
  return runtimeService.food;
}

export {
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_PROVIDER_LEASE_MS,
  FOOD_APPROVAL_WORKFLOW_ID,
};
