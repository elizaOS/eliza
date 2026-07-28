/**
 * Household-operations policy over the runtime graph and durable SQL records.
 *
 * The service validates canonical people and vendor identities, enforces
 * role/child-scoped visibility, and produces only structural observations,
 * approval-bound drafts, and responsibility-review proposals. Connector
 * dispatch, calendar mutation, purchase, and scheduled-task firing remain
 * owned by their existing services.
 */
import {
  type EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  type RelationshipStore,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import { type IAgentRuntime, Service } from "@elizaos/core";
import type { Relationship } from "@elizaos/shared";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  evaluateItemReplacement,
  evaluateOpportunity,
  expandAlmanacWindowForPreparation,
  proposeResponsibilityReview,
  resolveAlmanacWindow,
  resolveHouseholdObservation,
} from "./planner.js";
import { HouseholdOperationsRepository } from "./repository.js";
import {
  contentSha,
  type HouseholdCalendarCheck,
  type HouseholdObservation,
  type HouseholdObservationInput,
  type HouseholdObservationResolution,
  type HouseholdOperationDefinition,
  type HouseholdOperationRecordKind,
  type HouseholdOperationRevision,
  HouseholdOperationsError,
  type HouseholdOperationsVisibility,
  type HouseholdServiceEvent,
  type HouseholdServiceEventInput,
  type HouseholdWeeklyBrief,
  type HouseholdWeeklyBriefItem,
  type HouseholdWeeklyBriefQuestion,
  type HouseholdWeeklyBriefView,
  type ItemReplacementRecommendation,
  normalizeCalendarCheck,
  normalizeObservationInput,
  normalizeOperationDefinition,
  normalizeResponsibilitySignalInput,
  normalizeServiceEventInput,
  normalizeServiceWindow,
  type OpportunityEvaluation,
  type ResponsibilityAssignmentDefinition,
  type ResponsibilityReviewProposal,
  type ResponsibilitySignal,
  type ResponsibilitySignalInput,
  requireOperationsInteger,
  requireOperationsText,
  stableOperationsId,
  type VendorProfileDefinition,
} from "./types.js";

export const HOUSEHOLD_OPERATIONS_SERVICE = "lifeops_household_operations";

export interface HouseholdOperationsServiceDependencies {
  runtime: IAgentRuntime;
  agentId: string;
  entityStore: EntityStore;
  relationshipStore: RelationshipStore;
  repository: HouseholdOperationsRepository;
  now?: () => Date;
}

function householdRole(relationship: Relationship): string | null {
  const value = relationship.metadata?.householdRole;
  return typeof value === "string" ? value : null;
}

function relationshipSubjects(relationship: Relationship): string[] {
  const value = relationship.metadata?.householdSubjectEntityIds;
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new HouseholdOperationsError(
      "Household relationship has invalid subject scope metadata",
      "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
      { relationshipId: relationship.relationshipId },
    );
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function phaseOwner(
  assignment: ResponsibilityAssignmentDefinition,
  phase: ResponsibilitySignalInput["phase"],
): string {
  if (phase === "conception") return assignment.owners.conceptionOwnerId;
  if (phase === "planning") return assignment.owners.planningOwnerId;
  if (phase === "execution") return assignment.owners.executionOwnerId;
  return assignment.owners.monitoringOwnerId;
}

function isRevisionKind<K extends HouseholdOperationRecordKind>(
  revision: HouseholdOperationRevision,
  kind: K,
): revision is HouseholdOperationRevision<
  Extract<HouseholdOperationDefinition, { kind: K }>
> {
  return revision.kind === kind;
}

function windowsOverlap(
  left: { startsAt: string; endsAt: string },
  right: { startsAt: string; endsAt: string },
): boolean {
  return (
    Date.parse(left.startsAt) < Date.parse(right.endsAt) &&
    Date.parse(right.startsAt) < Date.parse(left.endsAt)
  );
}

function findCalendarCheck(
  checks: readonly HouseholdCalendarCheck[],
  subjectKey: string,
  window: { startsAt: string; endsAt: string },
): HouseholdCalendarCheck | null {
  return (
    checks.find(
      (check) =>
        check.subjectKey === subjectKey &&
        check.window.startsAt === window.startsAt &&
        check.window.endsAt === window.endsAt,
    ) ?? null
  );
}

export class HouseholdOperationsService {
  private readonly now: () => Date;

  constructor(private readonly deps: HouseholdOperationsServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.deps.repository.ensureSchema();
  }

  private assertOwnerPrincipal(principalEntityId: string): void {
    if (principalEntityId !== SELF_ENTITY_ID) {
      throw new HouseholdOperationsError(
        "Only the authenticated owner may mutate household-operation policy records",
        "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
        { principalEntityId },
      );
    }
  }

  private async requireEntity(entityId: string): Promise<void> {
    if (!(await this.deps.entityStore.get(entityId))) {
      throw new HouseholdOperationsError(
        `Knowledge-graph entity ${entityId} does not exist`,
        "HOUSEHOLD_OPERATIONS_ENTITY_NOT_FOUND",
        { entityId },
      );
    }
  }

  private async activeHouseholdRelationships(
    entityId: string,
  ): Promise<Relationship[]> {
    if (entityId === SELF_ENTITY_ID) return [];
    const [outbound, inbound] = await Promise.all([
      this.deps.relationshipStore.list({
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: entityId,
      }),
      this.deps.relationshipStore.list({
        fromEntityId: entityId,
        toEntityId: SELF_ENTITY_ID,
      }),
    ]);
    return [...outbound, ...inbound].filter(
      (relationship) =>
        relationship.status === "active" &&
        householdRole(relationship) !== null,
    );
  }

  private async requireHouseholdMember(entityId: string): Promise<void> {
    await this.requireEntity(entityId);
    if (
      entityId !== SELF_ENTITY_ID &&
      (await this.activeHouseholdRelationships(entityId)).length === 0
    ) {
      throw new HouseholdOperationsError(
        `Entity ${entityId} has no active household relationship`,
        "HOUSEHOLD_OPERATIONS_RELATIONSHIP_REQUIRED",
        { entityId },
      );
    }
  }

  private async assertVisibilityEntities(
    visibility: HouseholdOperationsVisibility,
  ): Promise<void> {
    if (visibility.kind === "child_scoped") {
      await this.requireHouseholdMember(visibility.childEntityId);
    } else if (visibility.kind === "principals") {
      for (const principalEntityId of visibility.principalEntityIds) {
        await this.requireHouseholdMember(principalEntityId);
      }
    }
  }

  private async canView(
    visibility: HouseholdOperationsVisibility,
    principalEntityId: string,
  ): Promise<boolean> {
    await this.requireEntity(principalEntityId);
    if (principalEntityId === SELF_ENTITY_ID) return true;
    if (visibility.kind === "owner_private") return false;
    const relationships =
      await this.activeHouseholdRelationships(principalEntityId);
    if (relationships.length === 0) return false;
    if (visibility.kind === "household") return true;
    if (visibility.kind === "principals") {
      return visibility.principalEntityIds.includes(principalEntityId);
    }
    if (visibility.childEntityId === principalEntityId) return true;
    return relationships.some((relationship) =>
      relationshipSubjects(relationship).includes(visibility.childEntityId),
    );
  }

  private async requireCurrentRevision<K extends HouseholdOperationRecordKind>(
    kind: K,
    recordId: string,
  ): Promise<
    HouseholdOperationRevision<
      Extract<HouseholdOperationDefinition, { kind: K }>
    >
  > {
    const revision = await this.deps.repository.getCurrentRevision(
      kind,
      recordId,
    );
    if (!revision || !isRevisionKind(revision, kind)) {
      throw new HouseholdOperationsError(
        `${kind} record ${recordId} does not exist`,
        "HOUSEHOLD_OPERATIONS_NOT_FOUND",
        { kind, recordId },
      );
    }
    return revision;
  }

  private async validateDefinitionGraph(
    definition: HouseholdOperationDefinition,
  ): Promise<void> {
    await this.assertVisibilityEntities(definition.visibility);
    if (definition.kind === "vendor_profile") {
      await this.requireEntity(definition.vendorEntityId);
      return;
    }
    if (definition.kind === "almanac_entry") {
      if (definition.vendorProfileRecordId) {
        const vendor = await this.requireCurrentRevision(
          "vendor_profile",
          definition.vendorProfileRecordId,
        );
        if (vendor.householdId !== definition.householdId) {
          throw new HouseholdOperationsError(
            "Almanac and vendor records must belong to the same household",
            "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
          );
        }
      }
      if (definition.responsibilityAssignmentId) {
        const assignment = await this.requireCurrentRevision(
          "responsibility_assignment",
          definition.responsibilityAssignmentId,
        );
        if (assignment.householdId !== definition.householdId) {
          throw new HouseholdOperationsError(
            "Almanac and responsibility records must belong to the same household",
            "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
          );
        }
      }
      for (const observationId of definition.sourceObservationIds) {
        const observation =
          await this.deps.repository.getObservation(observationId);
        if (
          !observation ||
          observation.householdId !== definition.householdId
        ) {
          throw new HouseholdOperationsError(
            "Almanac source observation does not exist in this household",
            "HOUSEHOLD_OPERATIONS_NOT_FOUND",
            { observationId },
          );
        }
      }
      return;
    }
    if (definition.kind === "opportunity") {
      for (const entityId of definition.subjectEntityIds) {
        await this.requireHouseholdMember(entityId);
      }
      const almanac = await this.requireCurrentRevision(
        "almanac_entry",
        definition.almanacEntryRecordId,
      );
      if (almanac.householdId !== definition.householdId) {
        throw new HouseholdOperationsError(
          "Opportunity and almanac records must belong to the same household",
          "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
        );
      }
      return;
    }
    if (definition.kind === "item_threshold") {
      await this.requireHouseholdMember(definition.childEntityId);
      return;
    }
    const ownerIds = Object.values(definition.owners);
    for (const ownerId of Array.from(new Set(ownerIds))) {
      await this.requireHouseholdMember(ownerId);
    }
    for (const acceptedEntityId of definition.acceptedByEntityIds) {
      await this.requireHouseholdMember(acceptedEntityId);
    }
  }

  async putRevision(input: {
    principalEntityId: string;
    definition: HouseholdOperationDefinition;
    expectedRevision: number;
  }): Promise<HouseholdOperationRevision> {
    this.assertOwnerPrincipal(input.principalEntityId);
    const definition = normalizeOperationDefinition(input.definition);
    await this.validateDefinitionGraph(definition);
    return this.deps.repository.putRevision(
      definition,
      requireOperationsInteger(input.expectedRevision, "expectedRevision", 0),
      this.now().toISOString(),
    );
  }

  async recordObservation(input: {
    principalEntityId: string;
    observation: HouseholdObservationInput;
  }): Promise<{ observation: HouseholdObservation; inserted: boolean }> {
    this.assertOwnerPrincipal(input.principalEntityId);
    const observation = normalizeObservationInput(input.observation);
    await this.assertVisibilityEntities(observation.visibility);
    for (const entityId of observation.subjectEntityIds) {
      await this.requireHouseholdMember(entityId);
    }
    if (observation.value.kind === "child_item_size") {
      await this.requireHouseholdMember(observation.value.childEntityId);
      if (
        !observation.subjectEntityIds.includes(observation.value.childEntityId)
      ) {
        throw new HouseholdOperationsError(
          "A child-size observation must name that child in subjectEntityIds",
          "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
        );
      }
      if (
        observation.visibility.kind !== "child_scoped" ||
        observation.visibility.childEntityId !== observation.value.childEntityId
      ) {
        throw new HouseholdOperationsError(
          "Child-size history must use child-scoped visibility",
          "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
        );
      }
    }
    return this.deps.repository.recordObservation(
      observation,
      this.now().toISOString(),
    );
  }

  async recordServiceEvent(input: {
    principalEntityId: string;
    event: HouseholdServiceEventInput;
  }): Promise<{ event: HouseholdServiceEvent; inserted: boolean }> {
    this.assertOwnerPrincipal(input.principalEntityId);
    const event = normalizeServiceEventInput(input.event);
    await this.assertVisibilityEntities(event.visibility);
    if (event.vendorEntityId) await this.requireEntity(event.vendorEntityId);
    return this.deps.repository.recordServiceEvent(
      event,
      this.now().toISOString(),
    );
  }

  async recordResponsibilitySignal(input: {
    actingEntityId: string;
    signal: ResponsibilitySignalInput;
  }): Promise<{ signal: ResponsibilitySignal; inserted: boolean }> {
    const signal = normalizeResponsibilitySignalInput(input.signal);
    await this.requireHouseholdMember(input.actingEntityId);
    const assignment = await this.requireCurrentRevision(
      "responsibility_assignment",
      signal.assignmentRecordId,
    );
    if (
      assignment.householdId !== signal.householdId ||
      assignment.revision !== signal.assignmentRevision
    ) {
      throw new HouseholdOperationsError(
        "Responsibility signal references a stale or unrelated assignment revision",
        "HOUSEHOLD_OPERATIONS_CONFLICT",
        {
          assignmentRecordId: signal.assignmentRecordId,
          assignmentRevision: signal.assignmentRevision,
        },
      );
    }
    const expectedOwner = phaseOwner(assignment, signal.phase);
    if (
      signal.ownerEntityId !== expectedOwner ||
      (input.actingEntityId !== SELF_ENTITY_ID &&
        input.actingEntityId !== signal.ownerEntityId)
    ) {
      throw new HouseholdOperationsError(
        "An authenticated principal may not record another person's responsibility response",
        "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
        {
          actingEntityId: input.actingEntityId,
          signalOwnerEntityId: signal.ownerEntityId,
        },
      );
    }
    if (input.actingEntityId === SELF_ENTITY_ID) {
      if (
        signal.ownerEntityId !== SELF_ENTITY_ID &&
        signal.provenance.kind !== "provider_receipt" &&
        signal.provenance.kind !== "scheduled_task_state"
      ) {
        throw new HouseholdOperationsError(
          "The owner may record another adult's response only from a provider receipt or scheduled-task state",
          "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
          { ownerEntityId: signal.ownerEntityId },
        );
      }
    } else if (
      signal.provenance.kind !== "authenticated_user" ||
      signal.provenance.authority !== "user_confirmed"
    ) {
      throw new HouseholdOperationsError(
        "A household principal's direct response requires authenticated-user provenance",
        "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
        { actingEntityId: input.actingEntityId },
      );
    }
    return this.deps.repository.recordResponsibilitySignal(
      signal,
      this.now().toISOString(),
    );
  }

  async listVisibleObservations(input: {
    principalEntityId: string;
    householdId: string;
    subjectKey?: string;
    observationKind?: string;
  }): Promise<HouseholdObservation[]> {
    const observations = await this.deps.repository.listObservations(
      input.householdId,
      {
        subjectKey: input.subjectKey,
        observationKind: input.observationKind,
      },
    );
    const visible: HouseholdObservation[] = [];
    for (const observation of observations) {
      if (await this.canView(observation.visibility, input.principalEntityId)) {
        visible.push(observation);
      }
    }
    return visible;
  }

  async resolveObservation(input: {
    principalEntityId: string;
    householdId: string;
    subjectKey: string;
    observationKind: string;
  }): Promise<HouseholdObservationResolution> {
    return resolveHouseholdObservation(
      await this.listVisibleObservations(input),
    );
  }

  async evaluateOpportunity(input: {
    principalEntityId: string;
    opportunityRecordId: string;
  }): Promise<OpportunityEvaluation> {
    const opportunity = await this.requireCurrentRevision(
      "opportunity",
      input.opportunityRecordId,
    );
    if (
      !(await this.canView(opportunity.visibility, input.principalEntityId))
    ) {
      throw new HouseholdOperationsError(
        "Principal may not view this household opportunity",
        "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
        { opportunityRecordId: input.opportunityRecordId },
      );
    }
    return evaluateOpportunity(opportunity);
  }

  async evaluateItemReplacement(input: {
    principalEntityId: string;
    thresholdRecordId: string;
  }): Promise<ItemReplacementRecommendation> {
    const threshold = await this.requireCurrentRevision(
      "item_threshold",
      input.thresholdRecordId,
    );
    if (!(await this.canView(threshold.visibility, input.principalEntityId))) {
      throw new HouseholdOperationsError(
        "Principal may not view this item threshold",
        "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
        { thresholdRecordId: input.thresholdRecordId },
      );
    }
    const allObservations = await this.listVisibleObservations({
      principalEntityId: input.principalEntityId,
      householdId: threshold.householdId,
    });
    const sizeObservations = allObservations.filter(
      (observation) =>
        observation.value.kind === "child_item_size" &&
        observation.value.childEntityId === threshold.childEntityId &&
        observation.value.itemCategory === threshold.itemCategory,
    );
    const inventoryObservations = threshold.inventorySubjectKey
      ? allObservations.filter(
          (observation) =>
            observation.subjectKey === threshold.inventorySubjectKey &&
            observation.observationKind === "inventory_level",
        )
      : [];
    return evaluateItemReplacement({
      threshold,
      sizeObservations,
      inventoryObservations,
    });
  }

  async listChildItemSizeHistory(input: {
    principalEntityId: string;
    householdId: string;
    childEntityId: string;
    itemCategory: string;
  }): Promise<HouseholdObservation[]> {
    return (
      await this.listVisibleObservations({
        principalEntityId: input.principalEntityId,
        householdId: input.householdId,
        observationKind: "child_item_size",
      })
    ).filter(
      (observation) =>
        observation.value.kind === "child_item_size" &&
        observation.value.childEntityId === input.childEntityId &&
        observation.value.itemCategory === input.itemCategory,
    );
  }

  async assessResponsibility(input: {
    principalEntityId: string;
    assignmentRecordId: string;
  }): Promise<
    (ResponsibilityReviewProposal & { readonly replayed: boolean }) | null
  > {
    this.assertOwnerPrincipal(input.principalEntityId);
    const assignment = await this.requireCurrentRevision(
      "responsibility_assignment",
      input.assignmentRecordId,
    );
    const signals = await this.deps.repository.listResponsibilitySignals(
      assignment.householdId,
      assignment.recordId,
      assignment.revision,
    );
    const proposal = proposeResponsibilityReview({
      assignment,
      signals,
      now: this.now(),
    });
    if (!proposal) return null;
    const persisted =
      await this.deps.repository.putResponsibilityReview(proposal);
    return {
      ...persisted.proposal,
      replayed: !persisted.inserted,
    };
  }

  private async responsibilityForEntry(
    entry: HouseholdOperationRevision<
      Extract<HouseholdOperationDefinition, { kind: "almanac_entry" }>
    >,
  ): Promise<HouseholdOperationRevision<ResponsibilityAssignmentDefinition> | null> {
    if (!entry.responsibilityAssignmentId) return null;
    const assignment = await this.requireCurrentRevision(
      "responsibility_assignment",
      entry.responsibilityAssignmentId,
    );
    return assignment.active ? assignment : null;
  }

  private async vendorForEntry(
    entry: HouseholdOperationRevision<
      Extract<HouseholdOperationDefinition, { kind: "almanac_entry" }>
    >,
  ): Promise<HouseholdOperationRevision<VendorProfileDefinition> | null> {
    if (!entry.vendorProfileRecordId) return null;
    const vendor = await this.requireCurrentRevision(
      "vendor_profile",
      entry.vendorProfileRecordId,
    );
    return vendor.active ? vendor : null;
  }

  async generateWeeklyBrief(input: {
    principalEntityId: string;
    householdId: string;
    window: { startsAt: string; endsAt: string };
    calendarChecks: HouseholdCalendarCheck[];
  }): Promise<
    HouseholdWeeklyBrief & {
      readonly replayed: boolean;
      readonly responsibilityReviewIds: readonly string[];
    }
  > {
    this.assertOwnerPrincipal(input.principalEntityId);
    const window = normalizeServiceWindow(input.window, "window");
    const calendarChecks = input.calendarChecks.map((check, index) =>
      normalizeCalendarCheck(check, `calendarChecks[${index}]`),
    );
    const current = await this.deps.repository.listCurrentRevisions(
      input.householdId,
    );
    const serviceEvents = await this.deps.repository.listServiceEvents(
      input.householdId,
    );
    const observations = await this.deps.repository.listObservations(
      input.householdId,
    );
    const assignments = current.filter((revision) =>
      isRevisionKind(revision, "responsibility_assignment"),
    );
    const activeResponsibilityReviewIds = new Set<string>();
    let responsibilityReviewApplied = false;
    for (const assignment of assignments) {
      if (assignment.active) {
        const review = await this.assessResponsibility({
          principalEntityId: input.principalEntityId,
          assignmentRecordId: assignment.recordId,
        });
        if (review) {
          activeResponsibilityReviewIds.add(review.reviewId);
          responsibilityReviewApplied ||= !review.replayed;
        }
      }
    }
    const reviews = await this.deps.repository.listResponsibilityReviews(
      input.householdId,
    );
    const items: HouseholdWeeklyBriefItem[] = [];
    const questions: HouseholdWeeklyBriefQuestion[] = [];

    for (const revision of current) {
      if (!revision.active || !isRevisionKind(revision, "almanac_entry")) {
        continue;
      }
      if (revision.category !== "maintenance") continue;
      const resolved = resolveAlmanacWindow({
        entry: revision,
        serviceEvents,
        asOf: this.now(),
      });
      const assignment = await this.responsibilityForEntry(revision);
      const vendor = await this.vendorForEntry(revision);
      if (resolved.state === "unknown") {
        const itemId = stableOperationsId("hhbriefitem", {
          kind: "maintenance_due",
          recordId: revision.recordId,
          revision: revision.revision,
          state: "unknown",
        });
        items.push({
          itemId,
          kind: "maintenance_due",
          title: revision.title,
          subjectKey: revision.subjectKey,
          state: "needs_service_history",
          dueWindow: null,
          responsibleEntityIds: assignment
            ? [
                assignment.owners.executionOwnerId,
                assignment.owners.monitoringOwnerId,
              ]
            : [],
          sourceRefs: [
            `almanac:${revision.recordId}:${revision.revision}`,
            ...revision.sourceObservationIds,
          ],
          uncertainty: "needs_information",
          visibility: revision.visibility,
          proposedAction: {
            effect: "verify",
            approvalRequirement: "none",
            idempotencyKey: null,
          },
          vendorContext: vendor
            ? {
                vendorEntityId: vendor.vendorEntityId,
                contactRouteRefs: vendor.contactRouteRefs,
                accessWindows: vendor.accessWindows,
              }
            : null,
          countsAsCoverage: null,
          calendarCheck: null,
        });
        questions.push({
          questionId: stableOperationsId("hhbriefq", {
            recordId: revision.recordId,
            revision: revision.revision,
            reason: resolved.reason,
          }),
          prompt: `Confirm the last evidenced completion for ${revision.title}; no due date is being guessed.`,
          sourceRefs: [`almanac:${revision.recordId}:${revision.revision}`],
          visibility: revision.visibility,
        });
        continue;
      }
      if (!resolved.startsAt || !resolved.endsAt) {
        throw new HouseholdOperationsError(
          "Known almanac window is missing timestamps",
          "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
          { recordId: revision.recordId },
        );
      }
      const dueWindow = {
        startsAt: resolved.startsAt,
        endsAt: resolved.endsAt,
      };
      const preparationWindow = expandAlmanacWindowForPreparation(
        revision,
        dueWindow,
      );
      if (!windowsOverlap(preparationWindow, window)) continue;
      const calendarCheck = findCalendarCheck(
        calendarChecks,
        revision.subjectKey,
        dueWindow,
      );
      const calendarReady = calendarCheck?.state === "available";
      const calendarState = calendarCheck?.state ?? "required";
      items.push({
        itemId: stableOperationsId("hhbriefitem", {
          kind: "maintenance_due",
          recordId: revision.recordId,
          revision: revision.revision,
          dueWindow,
          calendarState,
        }),
        kind: "maintenance_due",
        title: revision.title,
        subjectKey: revision.subjectKey,
        state: calendarReady
          ? "ready_for_outreach_draft"
          : `blocked_on_calendar_${calendarState}`,
        dueWindow,
        responsibleEntityIds: assignment
          ? [
              assignment.owners.executionOwnerId,
              assignment.owners.monitoringOwnerId,
            ]
          : [],
        sourceRefs: [
          `almanac:${revision.recordId}:${revision.revision}`,
          ...(resolved.sourceEventId ? [resolved.sourceEventId] : []),
          ...revision.sourceObservationIds,
          ...(calendarCheck?.sourceRefs ?? []),
        ],
        uncertainty:
          calendarReady && vendor
            ? "none"
            : calendarState === "conflicted"
              ? "ambiguous"
              : "needs_information",
        visibility: revision.visibility,
        proposedAction:
          calendarReady && vendor
            ? {
                effect: "external_outreach_draft",
                approvalRequirement: "owner_approval",
                idempotencyKey: stableOperationsId("hhoutreach", {
                  almanacRecordId: revision.recordId,
                  revision: revision.revision,
                  dueWindow,
                  vendorRecordId: vendor.recordId,
                  vendorRevision: vendor.revision,
                }),
              }
            : {
                effect: "verify",
                approvalRequirement: "none",
                idempotencyKey: null,
              },
        vendorContext: vendor
          ? {
              vendorEntityId: vendor.vendorEntityId,
              contactRouteRefs: vendor.contactRouteRefs,
              accessWindows: vendor.accessWindows,
            }
          : null,
        countsAsCoverage: null,
        calendarCheck: {
          state: calendarState,
          checkedAt: calendarCheck?.checkedAt ?? null,
          sourceRefs: calendarCheck?.sourceRefs ?? [],
          conflictRefs: calendarCheck?.conflictRefs ?? [],
        },
      });
      if (!calendarReady || !vendor) {
        questions.push({
          questionId: stableOperationsId("hhbriefq", {
            recordId: revision.recordId,
            calendarState,
            vendor: vendor?.recordId ?? null,
          }),
          prompt: !vendor
            ? `Choose an existing vendor record for ${revision.title}; no contact is being invented.`
            : `Resolve the calendar availability check for ${revision.title} before outreach is drafted.`,
          sourceRefs: [`almanac:${revision.recordId}:${revision.revision}`],
          visibility: revision.visibility,
        });
      }
    }

    for (const revision of current) {
      if (!revision.active || !isRevisionKind(revision, "opportunity")) {
        continue;
      }
      const opportunityWindow = {
        startsAt: revision.opensAt,
        endsAt: revision.closesAt,
      };
      if (
        !windowsOverlap(opportunityWindow, window) &&
        revision.state !== "waitlisted" &&
        revision.state !== "confirmed"
      ) {
        continue;
      }
      const evaluation = evaluateOpportunity(revision);
      const effect =
        evaluation.effectDraft?.effect === "registration"
          ? "registration_draft"
          : evaluation.effectDraft?.effect === "external_outreach"
            ? "external_outreach_draft"
            : "read_only";
      items.push({
        itemId: stableOperationsId("hhbriefitem", {
          kind: "opportunity",
          recordId: revision.recordId,
          revision: revision.revision,
          evaluation,
        }),
        kind: "opportunity",
        title: revision.title,
        subjectKey: revision.subjectKey,
        state: evaluation.state,
        dueWindow: opportunityWindow,
        responsibleEntityIds: revision.subjectEntityIds,
        sourceRefs: [
          `opportunity:${revision.recordId}:${revision.revision}`,
          revision.provenance.evidenceRef,
          ...revision.capacityPolicy.evidenceRefs,
        ],
        uncertainty:
          evaluation.state === "needs_information"
            ? "needs_information"
            : "none",
        visibility: revision.visibility,
        proposedAction: {
          effect,
          approvalRequirement:
            evaluation.effectDraft?.approvalRequirement ?? "none",
          idempotencyKey: evaluation.effectDraft?.idempotencyKey ?? null,
        },
        vendorContext: null,
        countsAsCoverage: evaluation.countsAsCoverage,
        calendarCheck: null,
      });
      if (evaluation.state === "needs_information") {
        questions.push({
          questionId: stableOperationsId("hhbriefq", {
            recordId: revision.recordId,
            revision: revision.revision,
            evaluation,
          }),
          prompt: `Confirm availability or family-capacity evidence for ${revision.title}; it is not being treated as coverage.`,
          sourceRefs: [`opportunity:${revision.recordId}:${revision.revision}`],
          visibility: revision.visibility,
        });
      }
    }

    for (const revision of current) {
      if (!revision.active || !isRevisionKind(revision, "item_threshold")) {
        continue;
      }
      const sizeObservations = observations.filter(
        (observation) =>
          observation.value.kind === "child_item_size" &&
          observation.value.childEntityId === revision.childEntityId &&
          observation.value.itemCategory === revision.itemCategory,
      );
      const inventoryObservations = revision.inventorySubjectKey
        ? observations.filter(
            (observation) =>
              observation.subjectKey === revision.inventorySubjectKey &&
              observation.observationKind === "inventory_level",
          )
        : [];
      const recommendation = evaluateItemReplacement({
        threshold: revision,
        sizeObservations,
        inventoryObservations,
      });
      if (recommendation.state === "no_action") continue;
      items.push({
        itemId: stableOperationsId("hhbriefitem", {
          kind: "item_replacement",
          recordId: revision.recordId,
          revision: revision.revision,
          recommendation,
        }),
        kind: "item_replacement",
        title: `${revision.itemCategory} for ${revision.childEntityId}`,
        subjectKey: `child-item:${revision.childEntityId}:${revision.itemCategory}`,
        state: recommendation.state,
        dueWindow: null,
        responsibleEntityIds: [SELF_ENTITY_ID],
        sourceRefs: [
          `item-threshold:${revision.recordId}:${revision.revision}`,
          ...recommendation.sourceObservationIds,
        ],
        uncertainty:
          recommendation.state === "verify" ? "needs_information" : "none",
        visibility: revision.visibility,
        proposedAction: {
          effect:
            recommendation.state === "replacement_draft"
              ? "purchase_draft"
              : "verify",
          approvalRequirement: recommendation.approvalRequirement ?? "none",
          idempotencyKey:
            recommendation.state === "replacement_draft"
              ? stableOperationsId("hhreplace", {
                  thresholdRecordId: revision.recordId,
                  thresholdRevision: revision.revision,
                  sourceObservationIds: recommendation.sourceObservationIds,
                })
              : null,
        },
        vendorContext: null,
        countsAsCoverage: null,
        calendarCheck: null,
      });
      if (recommendation.state === "verify") {
        questions.push({
          questionId: stableOperationsId("hhbriefq", {
            thresholdRecordId: revision.recordId,
            recommendation,
          }),
          prompt: `Verify the current ${revision.itemCategory} size or usable count before a replacement draft is proposed.`,
          sourceRefs: recommendation.sourceObservationIds,
          visibility: revision.visibility,
        });
      }
    }

    const currentReviewByAssignment = Array.from(
      reviews
        .filter((review) => activeResponsibilityReviewIds.has(review.reviewId))
        .reduce((latest, review) => {
          const currentReview = latest.get(review.assignmentRecordId);
          if (
            !currentReview ||
            Date.parse(currentReview.createdAt) < Date.parse(review.createdAt)
          ) {
            latest.set(review.assignmentRecordId, review);
          }
          return latest;
        }, new Map<string, ResponsibilityReviewProposal>()),
    ).map(([, review]) => review);
    for (const review of currentReviewByAssignment) {
      const assignment = assignments.find(
        (candidate) =>
          candidate.recordId === review.assignmentRecordId &&
          candidate.revision === review.assignmentRevision &&
          candidate.active,
      );
      if (!assignment) continue;
      items.push({
        itemId: stableOperationsId("hhbriefitem", {
          kind: "responsibility_review",
          reviewId: review.reviewId,
        }),
        kind: "responsibility_review",
        title: `Responsibility review for ${assignment.subjectKey}`,
        subjectKey: assignment.subjectKey,
        state: review.trigger,
        dueWindow: null,
        responsibleEntityIds: review.affectedEntityIds,
        sourceRefs: [
          `responsibility:${assignment.recordId}:${assignment.revision}`,
          review.snapshotSha256,
        ],
        uncertainty: "none",
        visibility: assignment.visibility,
        proposedAction: {
          effect: "renegotiation_proposal",
          approvalRequirement: "multi_party_approval",
          idempotencyKey: review.reviewId,
        },
        vendorContext: null,
        countsAsCoverage: null,
        calendarCheck: null,
      });
    }

    items.sort(
      (left, right) =>
        (left.dueWindow?.startsAt ?? "9999").localeCompare(
          right.dueWindow?.startsAt ?? "9999",
        ) || left.itemId.localeCompare(right.itemId),
    );
    questions.sort((left, right) =>
      left.questionId.localeCompare(right.questionId),
    );
    const selectedQuestions = questions.slice(0, 3);
    const snapshotSha256 = contentSha({
      revisions: current.map((revision) => ({
        kind: revision.kind,
        recordId: revision.recordId,
        revision: revision.revision,
        contentSha256: revision.contentSha256,
      })),
      observationIds: observations.map(
        (observation) => observation.observationId,
      ),
      serviceEventIds: serviceEvents.map((event) => event.eventId),
      reviewIds: currentReviewByAssignment.map((review) => review.reviewId),
      calendarChecks,
      items,
      questions: selectedQuestions,
    });
    const generatedAt = this.now().toISOString();
    const brief: HouseholdWeeklyBrief = {
      briefId: stableOperationsId("hhbrief", {
        agentId: this.deps.agentId,
        householdId: input.householdId,
        window,
        snapshotSha256,
      }),
      householdId: requireOperationsText(input.householdId, "householdId", 300),
      window,
      generatedAt,
      snapshotSha256,
      items,
      questions: selectedQuestions,
      createdAt: generatedAt,
    };
    const persisted = await this.deps.repository.putWeeklyBrief(brief);
    return {
      ...persisted.brief,
      replayed: !persisted.inserted && !responsibilityReviewApplied,
      responsibilityReviewIds: [...activeResponsibilityReviewIds].sort(),
    };
  }

  async readWeeklyBrief(input: {
    principalEntityId: string;
    briefId: string;
  }): Promise<HouseholdWeeklyBriefView> {
    const brief = await this.deps.repository.getWeeklyBrief(input.briefId);
    if (!brief) {
      throw new HouseholdOperationsError(
        "Household weekly brief does not exist",
        "HOUSEHOLD_OPERATIONS_NOT_FOUND",
        { briefId: input.briefId },
      );
    }
    const items: HouseholdWeeklyBriefItem[] = [];
    for (const item of brief.items) {
      if (await this.canView(item.visibility, input.principalEntityId)) {
        items.push(item);
      }
    }
    const questions: HouseholdWeeklyBriefQuestion[] = [];
    for (const question of brief.questions) {
      if (await this.canView(question.visibility, input.principalEntityId)) {
        questions.push(question);
      }
    }
    if (
      input.principalEntityId !== SELF_ENTITY_ID &&
      items.length === 0 &&
      questions.length === 0
    ) {
      throw new HouseholdOperationsError(
        "Principal has no visible content in this weekly brief",
        "HOUSEHOLD_OPERATIONS_ACCESS_DENIED",
        { principalEntityId: input.principalEntityId, briefId: input.briefId },
      );
    }
    return {
      briefId: brief.briefId,
      householdId: brief.householdId,
      window: brief.window,
      generatedAt: brief.generatedAt,
      snapshotSha256: brief.snapshotSha256,
      items,
      questions,
    };
  }
}

export function createHouseholdOperationsService(
  runtime: IAgentRuntime,
): HouseholdOperationsService {
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw new HouseholdOperationsError(
      "KnowledgeGraphService is required for household operations",
      "HOUSEHOLD_OPERATIONS_GRAPH_UNAVAILABLE",
      { agentId: runtime.agentId },
    );
  }
  return new HouseholdOperationsService({
    runtime,
    agentId: runtime.agentId,
    entityStore: graph.getEntityStore(runtime.agentId),
    relationshipStore: graph.getRelationshipStore(runtime.agentId),
    repository: new HouseholdOperationsRepository(runtime, runtime.agentId),
  });
}

export class HouseholdOperationsRuntimeService extends Service {
  static override serviceType = HOUSEHOLD_OPERATIONS_SERVICE;

  override capabilityDescription =
    "Durable vendor, maintenance, seasonal, child-item, C/P/E/M ownership, non-use review, and scoped weekly-brief coordination";

  readonly operations: HouseholdOperationsService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new HouseholdOperationsError(
        "HouseholdOperationsRuntimeService requires a runtime",
        "HOUSEHOLD_OPERATIONS_INVALID_CONTRACT",
      );
    }
    this.operations = createHouseholdOperationsService(runtime);
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<HouseholdOperationsRuntimeService> {
    await runtime.getServiceLoadPromise(KNOWLEDGE_GRAPH_SERVICE);
    const service = new HouseholdOperationsRuntimeService(runtime);
    await service.operations.initialize();
    return service;
  }

  async stop(): Promise<void> {}
}

export function getHouseholdOperationsService(
  runtime: IAgentRuntime,
): HouseholdOperationsService | null {
  return (
    runtime.getService<HouseholdOperationsRuntimeService>(
      HOUSEHOLD_OPERATIONS_SERVICE,
    )?.operations ?? null
  );
}
