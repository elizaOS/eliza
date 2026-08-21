/**
 * Task-definition domain for LifeOps: CRUD over LifeOps task definitions and
 * their occurrences (the recurring reminders/check-ins/routines the scheduler
 * later fires), including reminder-plan normalization and definition-performance
 * scoring.
 */

import { ElizaError } from "@elizaos/core";
import type {
  CompleteLifeOpsOccurrenceRequest,
  CreateLifeOpsDefinitionRequest,
  LifeOpsDefinitionRecord,
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
  LifeOpsOwnership,
  LifeOpsReminderPlan,
  LifeOpsReminderStep,
  LifeOpsTaskDefinition,
  RecordLifeOpsProgressRequest,
  RecordLifeOpsProgressResult,
  SnoozeLifeOpsOccurrenceRequest,
  UpdateLifeOpsDefinitionRequest,
} from "../../contracts/index.js";
import {
  LIFEOPS_DEFINITION_KINDS,
  LIFEOPS_DEFINITION_STATUSES,
} from "../../contracts/index.js";
import { settleBriefEngagementReward } from "../briefing/engagement-reward.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import { createLifeOpsTaskDefinition } from "../repository.js";
import {
  cloneRecord,
  computeSnoozedUntil,
  mergeMetadata,
  normalizeOptionalRecord,
  normalizeReminderPlanDraft,
} from "../service-helpers-misc.js";
import { computeDefinitionPerformance } from "../service-helpers-occurrence.js";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalString,
  normalizePriority,
  normalizeValidTimeZone,
  requireNonEmptyString,
} from "../service-normalize.js";
import { normalizeWindowPolicyInput } from "../service-normalize-connector.js";
import {
  normalizeCadence,
  normalizeProgressionRule,
  normalizeQuotaCheckInPolicy,
  normalizeWebsiteAccessPolicy,
} from "../service-normalize-task.js";
import {
  listCallerDefinitions,
  nextMutationRevision,
} from "./definition-authorization.js";

// Routine seeding is a FIRST_RUN customize-path concern — see
// `src/lifeops/first-run/service.ts`. The migrator at
// `src/lifeops/seed-routine-migration/migrator.ts` rewrites legacy
// `seedKey: "load-test-user-profile:*"` definitions onto the
// `default-packs/habit-starters.ts` `ScheduledTask` records.

/**
 * Reminder-domain methods the definitions domain depends on. These live on the
 * reminders domain (`withReminders`), so they are injected as typed callbacks
 * rather than read off {@link LifeOpsContext}.
 */
export type DefinitionsDeps = {
  getDefinitionRecord(
    definitionId: string,
    now?: Date,
  ): Promise<LifeOpsDefinitionRecord>;
  ensureGoalExists(
    goalId: string | null,
    ownership?: Pick<LifeOpsOwnership, "domain" | "subjectType" | "subjectId">,
  ): Promise<string | null>;
  syncReminderPlan(
    definition: LifeOpsTaskDefinition,
    draft:
      | {
          steps: LifeOpsReminderStep[];
          mutePolicy: Record<string, unknown>;
          quietHours: Record<string, unknown>;
        }
      | null
      | undefined,
  ): Promise<LifeOpsReminderPlan | null>;
  syncGoalLink(definition: LifeOpsTaskDefinition): Promise<void>;
  refreshDefinitionOccurrences(
    definition: LifeOpsTaskDefinition,
    now?: Date,
  ): Promise<LifeOpsOccurrence[]>;
  syncNativeAppleReminderForDefinition(args: {
    definition: LifeOpsTaskDefinition | null;
    previousDefinition?: LifeOpsTaskDefinition | null;
  }): Promise<LifeOpsTaskDefinition | null>;
  syncWebsiteAccessState(now?: Date): Promise<void>;
  getFreshOccurrence(
    occurrenceId: string,
    now?: Date,
  ): Promise<{
    definition: LifeOpsTaskDefinition;
    occurrence: LifeOpsOccurrence;
  }>;
  awardWebsiteAccessGrant(
    definition: LifeOpsTaskDefinition,
    occurrenceId: string,
    now?: Date,
  ): Promise<void>;
  resolveReminderEscalation(args: {
    ownerType: "occurrence" | "calendar_event";
    ownerId: string;
    resolvedAt: string;
    resolution: "acknowledged" | "completed" | "skipped" | "snoozed";
    note?: string | null;
  }): Promise<void>;
};

export class DefinitionsDomain {
  constructor(
    private readonly ctx: LifeOpsContext,
    private readonly deps: DefinitionsDeps,
  ) {}

  async listDefinitions(): Promise<LifeOpsDefinitionRecord[]> {
    const definitions = await listCallerDefinitions(
      this.ctx.repository,
      this.ctx,
    );
    const plans = await this.ctx.repository.listReminderPlansForOwners(
      this.ctx.agentId(),
      "definition",
      definitions.map((definition) => definition.id),
    );
    const planMap = new Map(plans.map((plan) => [plan.ownerId, plan]));
    const occurrences = await this.ctx.repository.listOccurrencesForDefinitions(
      this.ctx.agentId(),
      definitions.map((definition) => definition.id),
    );
    const occurrencesByDefinitionId = new Map<string, LifeOpsOccurrence[]>();
    for (const occurrence of occurrences) {
      const current = occurrencesByDefinitionId.get(occurrence.definitionId);
      if (current) {
        current.push(occurrence);
      } else {
        occurrencesByDefinitionId.set(occurrence.definitionId, [occurrence]);
      }
    }
    const now = new Date();
    return definitions.map((definition) => ({
      definition,
      reminderPlan: planMap.get(definition.id) ?? null,
      performance: computeDefinitionPerformance(
        definition,
        occurrencesByDefinitionId.get(definition.id) ?? [],
        now,
      ),
    }));
  }

  async getDefinition(definitionId: string): Promise<LifeOpsDefinitionRecord> {
    return this.deps.getDefinitionRecord(definitionId);
  }

  async createDefinition(
    request: CreateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord> {
    const agentId = this.ctx.agentId();
    const ownership = this.ctx.normalizeOwnership(request.ownership);
    const kind = normalizeEnumValue(
      request.kind,
      "kind",
      LIFEOPS_DEFINITION_KINDS,
    );
    const title = requireNonEmptyString(request.title, "title");
    const description = normalizeOptionalString(request.description) ?? "";
    const originalIntent =
      normalizeOptionalString(request.originalIntent) ?? title;
    const timezone = normalizeValidTimeZone(request.timezone, "timezone");
    const windowPolicy = normalizeWindowPolicyInput(
      request.windowPolicy,
      "windowPolicy",
      timezone,
    );
    const cadence = normalizeCadence(request.cadence, windowPolicy);
    if (cadence.kind === "unscheduled" && kind !== "task") {
      fail(400, "unscheduled cadence is only valid for task definitions");
    }
    const progressionRule = normalizeProgressionRule(request.progressionRule);
    const checkInPolicy = normalizeQuotaCheckInPolicy(
      request.checkInPolicy,
      cadence,
      windowPolicy,
    );
    const reminderPlanDraft = normalizeReminderPlanDraft(
      request.reminderPlan,
      "create",
    );
    const goalId = await this.deps.ensureGoalExists(
      request.goalId ?? null,
      ownership,
    );
    let definition = createLifeOpsTaskDefinition({
      agentId,
      ...ownership,
      kind,
      title,
      description,
      originalIntent,
      timezone,
      status: "active",
      priority: normalizePriority(request.priority),
      cadence,
      windowPolicy,
      progressionRule,
      checkInPolicy,
      websiteAccess:
        normalizeWebsiteAccessPolicy(request.websiteAccess, "websiteAccess") ??
        null,
      reminderPlanId: null,
      goalId,
      source: normalizeOptionalString(request.source) ?? "manual",
      // A laddered progression rule is the structural form of the
      // behavioral-activation "shrink the ask to one small step" transform. The
      // `activationStrategy` marker is asserted last so request metadata cannot
      // override it — when the rule is laddered, the definition is truthfully
      // marked one_small_step. This replaces the old dead `metadata.framing`
      // claim that no runtime code ever read.
      metadata: mergeMetadata(
        normalizeOptionalRecord(request.metadata, "metadata") ?? {},
        progressionRule.kind === "laddered"
          ? { activationStrategy: "one_small_step" }
          : undefined,
      ),
    });
    await this.ctx.repository.createDefinition(definition);
    const reminderPlan = await this.deps.syncReminderPlan(
      definition,
      reminderPlanDraft,
    );
    if (definition.reminderPlanId !== null) {
      await this.ctx.repository.updateDefinition(definition, {
        expectedUpdatedAt: definition.updatedAt,
      });
    }
    await this.deps.syncGoalLink(definition);
    await this.deps.refreshDefinitionOccurrences(definition);
    const persistedUpdatedAt = definition.updatedAt;
    definition =
      (await this.deps.syncNativeAppleReminderForDefinition({
        definition,
      })) ?? definition;
    await this.ctx.repository.updateDefinition(definition, {
      expectedUpdatedAt: persistedUpdatedAt,
    });
    await this.ctx.recordAudit(
      "definition_created",
      "definition",
      definition.id,
      "definition created",
      {
        request,
      },
      {
        kind: definition.kind,
        timezone: definition.timezone,
        cadence: definition.cadence,
        reminderPlanId: definition.reminderPlanId,
      },
    );
    await this.deps.syncWebsiteAccessState();
    const occurrences = await this.ctx.repository.listOccurrencesForDefinition(
      this.ctx.agentId(),
      definition.id,
    );
    return {
      definition,
      reminderPlan,
      performance: computeDefinitionPerformance(
        definition,
        occurrences,
        new Date(),
      ),
    };
  }

  async updateDefinition(
    definitionId: string,
    request: UpdateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord> {
    const current = await this.deps.getDefinitionRecord(definitionId);
    const ownership = this.ctx.normalizeOwnership(
      request.ownership,
      current.definition,
    );
    const nextTimezone = normalizeValidTimeZone(
      request.timezone ?? current.definition.timezone,
      "timezone",
      current.definition.timezone,
    );
    const windowPolicyInput =
      request.windowPolicy ??
      (request.timezone === undefined
        ? current.definition.windowPolicy
        : {
            ...current.definition.windowPolicy,
            timezone: nextTimezone,
          });
    const nextWindowPolicy = normalizeWindowPolicyInput(
      windowPolicyInput,
      "windowPolicy",
      nextTimezone,
    );
    const nextCadence = normalizeCadence(
      request.cadence ?? current.definition.cadence,
      nextWindowPolicy,
    );
    if (
      current.definition.cadence.kind === "count_per_day" &&
      (nextTimezone !== current.definition.timezone ||
        JSON.stringify(nextCadence) !==
          JSON.stringify(current.definition.cadence))
    ) {
      const occurrences =
        await this.ctx.repository.listOccurrencesForDefinition(
          this.ctx.agentId(),
          current.definition.id,
        );
      for (const occurrence of occurrences) {
        if (
          ["completed", "skipped", "expired", "muted"].includes(
            occurrence.state,
          )
        ) {
          continue;
        }
        const progress = await this.ctx.repository.sumProgressEvents(
          this.ctx.agentId(),
          occurrence.id,
        );
        if (progress > 0) {
          fail(
            409,
            "quota cadence or timezone cannot change during an in-progress active day",
          );
        }
      }
    }
    if (
      nextCadence.kind === "unscheduled" &&
      current.definition.kind !== "task"
    ) {
      fail(400, "unscheduled cadence is only valid for task definitions");
    }
    const nextStatus =
      request.status === undefined
        ? current.definition.status
        : normalizeEnumValue(
            request.status,
            "status",
            LIFEOPS_DEFINITION_STATUSES,
          );
    let nextDefinition: LifeOpsTaskDefinition = {
      ...current.definition,
      ...ownership,
      title:
        request.title !== undefined
          ? requireNonEmptyString(request.title, "title")
          : current.definition.title,
      description:
        request.description !== undefined
          ? (normalizeOptionalString(request.description) ?? "")
          : current.definition.description,
      originalIntent:
        request.originalIntent !== undefined
          ? (normalizeOptionalString(request.originalIntent) ??
            current.definition.title)
          : current.definition.originalIntent,
      timezone: nextTimezone,
      status: nextStatus,
      priority: normalizePriority(
        request.priority,
        current.definition.priority,
      ),
      cadence: nextCadence,
      windowPolicy: nextWindowPolicy,
      progressionRule:
        request.progressionRule !== undefined
          ? normalizeProgressionRule(request.progressionRule)
          : current.definition.progressionRule,
      checkInPolicy:
        request.checkInPolicy !== undefined
          ? normalizeQuotaCheckInPolicy(
              request.checkInPolicy,
              nextCadence,
              nextWindowPolicy,
            )
          : nextCadence.kind === "count_per_day"
            ? normalizeQuotaCheckInPolicy(
                current.definition.checkInPolicy,
                nextCadence,
                nextWindowPolicy,
              )
            : null,
      websiteAccess:
        request.websiteAccess !== undefined
          ? (normalizeWebsiteAccessPolicy(
              request.websiteAccess,
              "websiteAccess",
            ) ?? null)
          : current.definition.websiteAccess,
      goalId:
        request.goalId !== undefined
          ? await this.deps.ensureGoalExists(request.goalId ?? null, ownership)
          : current.definition.goalId,
      metadata:
        request.metadata !== undefined
          ? mergeMetadata(
              current.definition.metadata,
              normalizeOptionalRecord(request.metadata, "metadata"),
            )
          : current.definition.metadata,
      updatedAt: nextMutationRevision(current.definition.updatedAt),
    };
    const reminderPlanDraft = normalizeReminderPlanDraft(
      request.reminderPlan,
      "update",
    );
    // Optimistic concurrency: the first write-back must land on the exact
    // revision this update was computed from; a concurrent mutation or delete
    // surfaces as a typed LIFEOPS_DEFINITION_CONFLICT for re-resolution.
    await this.ctx.repository.updateDefinition(nextDefinition, {
      expectedUpdatedAt: current.definition.updatedAt,
      expectedScope: {
        domain: current.definition.domain,
        subjectType: current.definition.subjectType,
        subjectId: current.definition.subjectId,
      },
    });
    const reminderPlan = await this.deps.syncReminderPlan(
      nextDefinition,
      reminderPlanDraft,
    );
    const updatedScope = {
      domain: nextDefinition.domain,
      subjectType: nextDefinition.subjectType,
      subjectId: nextDefinition.subjectId,
    };
    await this.ctx.repository.updateDefinition(nextDefinition, {
      expectedUpdatedAt: nextDefinition.updatedAt,
      expectedScope: updatedScope,
    });
    await this.deps.syncGoalLink(nextDefinition);
    if (nextDefinition.status === "active") {
      await this.deps.refreshDefinitionOccurrences(nextDefinition);
    }
    const persistedUpdatedAt = nextDefinition.updatedAt;
    nextDefinition =
      (await this.deps.syncNativeAppleReminderForDefinition({
        definition: nextDefinition,
        previousDefinition: current.definition,
      })) ?? nextDefinition;
    await this.ctx.repository.updateDefinition(nextDefinition, {
      expectedUpdatedAt: persistedUpdatedAt,
      expectedScope: updatedScope,
    });
    await this.ctx.recordAudit(
      "definition_updated",
      "definition",
      nextDefinition.id,
      "definition updated",
      {
        request,
      },
      {
        status: nextDefinition.status,
        cadence: nextDefinition.cadence,
        timezone: nextDefinition.timezone,
        reminderPlanId: nextDefinition.reminderPlanId,
      },
    );
    await this.deps.syncWebsiteAccessState();
    const occurrences = await this.ctx.repository.listOccurrencesForDefinition(
      this.ctx.agentId(),
      nextDefinition.id,
    );
    return {
      definition: nextDefinition,
      reminderPlan,
      performance: computeDefinitionPerformance(
        nextDefinition,
        occurrences,
        new Date(),
      ),
    };
  }

  async deleteDefinition(definitionId: string): Promise<void> {
    // Resolve through the caller-scoped record boundary before native or
    // database side effects. An immutable ID for another domain/owner is
    // indistinguishable from a missing definition.
    const { definition } = await this.deps.getDefinitionRecord(definitionId);
    await this.ctx.repository.deleteDefinition(
      this.ctx.agentId(),
      definitionId,
      {
        scope: {
          domain: definition.domain,
          subjectType: definition.subjectType,
          subjectId: definition.subjectId,
        },
        expectedUpdatedAt: definition.updatedAt,
      },
    );
    await this.deps.syncNativeAppleReminderForDefinition({
      definition: null,
      previousDefinition: definition,
    });
    await this.ctx.recordAudit(
      "definition_deleted",
      "definition",
      definitionId,
      "definition deleted",
      { title: definition.title },
      {},
    );
    await this.deps.syncWebsiteAccessState();
  }

  /**
   * Records one increment toward a count-per-day quota occurrence. The write
   * is a transactionally serialized append keyed by the caller's idempotency
   * key, and the day's completed count is always re-derived from the
   * append-only event table so concurrent increments can neither lose nor
   * exceed the target: when the derived count reaches the target the
   * occurrence is terminal-completed through the ordinary (retry-idempotent)
   * completion path, and further increments are refused.
   */
  async recordOccurrenceProgress(
    occurrenceId: string,
    request: RecordLifeOpsProgressRequest,
    now = new Date(),
  ): Promise<RecordLifeOpsProgressResult> {
    const { definition, occurrence } = await this.deps.getFreshOccurrence(
      occurrenceId,
      now,
    );
    const cadence = definition.cadence;
    if (cadence.kind !== "count_per_day") {
      fail(409, "occurrence does not track count-per-day progress");
    }
    const idempotencyKey = requireNonEmptyString(
      request.idempotencyKey,
      "idempotencyKey",
    );
    const rawQuantity = request.quantity ?? 1;
    if (
      typeof rawQuantity !== "number" ||
      !Number.isFinite(rawQuantity) ||
      Math.trunc(rawQuantity) <= 0
    ) {
      fail(400, "quantity must be a positive integer");
    }
    const quantity = Math.trunc(rawQuantity);
    if (["skipped", "expired", "muted"].includes(occurrence.state)) {
      fail(409, `progress cannot be recorded from state ${occurrence.state}`);
    }
    const localDateKey = occurrence.metadata.localDateKey;
    if (typeof localDateKey !== "string" || localDateKey.length === 0) {
      fail(500, "quota occurrence is missing its localDateKey");
    }

    const note = normalizeOptionalString(request.note ?? undefined) ?? null;
    let applied = false;
    let progressEventId: string | null = null;
    const alreadyComplete = occurrence.state === "completed";
    if (!alreadyComplete) {
      const eventId = crypto.randomUUID();
      const appliedQuantity =
        await this.ctx.repository.appendProgressEventIfNew(
          {
            id: eventId,
            agentId: this.ctx.agentId(),
            definitionId: definition.id,
            occurrenceId: occurrence.id,
            localDateKey,
            idempotencyKey,
            quantity,
            unit: cadence.unit,
            note,
            actor: "owner",
            createdAt: now.toISOString(),
          },
          cadence.targetCount,
        );
      applied = appliedQuantity !== null;
      if (applied) {
        progressEventId = eventId;
        await this.ctx.recordAudit(
          "occurrence_progress_recorded",
          "occurrence",
          occurrence.id,
          "quota progress increment recorded",
          { idempotencyKey, quantity: appliedQuantity, note },
          {
            definitionId: definition.id,
            occurrenceKey: occurrence.occurrenceKey,
          },
        );
      }
    }

    const rawCount = await this.ctx.repository.sumProgressEvents(
      this.ctx.agentId(),
      occurrence.id,
    );
    const completedCount = Math.min(rawCount, cadence.targetCount);
    const reachedTarget = rawCount >= cadence.targetCount;
    if (reachedTarget && !alreadyComplete) {
      // completeOccurrence is retry-idempotent, so a concurrent increment
      // that also crossed the target results in one terminal completion.
      await this.completeOccurrence(
        occurrence.id,
        { note: note ?? undefined },
        now,
      );
    }
    const view = await this.ctx.repository.getOccurrenceView(
      this.ctx.agentId(),
      occurrence.id,
    );
    if (!view) {
      fail(404, "life-ops occurrence not found after progress record");
    }
    return {
      occurrence: view,
      progress: {
        completedCount,
        targetCount: cadence.targetCount,
        remainingCount: Math.max(cadence.targetCount - completedCount, 0),
        unit: cadence.unit,
        perOccurrenceWork: cadence.perOccurrenceWork,
      },
      applied,
      completed: reachedTarget || alreadyComplete,
      progressEventId,
    };
  }

  async completeOccurrence(
    occurrenceId: string,
    request: CompleteLifeOpsOccurrenceRequest,
    now = new Date(),
  ): Promise<LifeOpsOccurrenceView> {
    const { definition, occurrence } = await this.deps.getFreshOccurrence(
      occurrenceId,
      now,
    );
    const definitionScope = {
      domain: definition.domain,
      subjectType: definition.subjectType,
      subjectId: definition.subjectId,
    };
    if (occurrence.state === "completed") {
      const current = await this.ctx.repository.getOccurrenceView(
        this.ctx.agentId(),
        occurrence.id,
        definitionScope,
      );
      if (!current) {
        fail(404, "life-ops occurrence not found");
      }
      return current;
    }
    if (["skipped", "expired", "muted"].includes(occurrence.state)) {
      fail(
        409,
        `occurrence cannot be completed from state ${occurrence.state}`,
      );
    }
    const completedAt = now.toISOString();
    const updatedOccurrence: LifeOpsOccurrence = {
      ...occurrence,
      state: "completed",
      snoozedUntil: null,
      completionPayload: {
        completedAt,
        note: normalizeOptionalString(request.note) ?? null,
        metadata: cloneRecord(request.metadata),
        previousState: occurrence.state,
      },
      updatedAt: nextMutationRevision(occurrence.updatedAt, now),
    };
    // Concurrent quota increments may race to complete the same day, so the
    // completion write is a state-guarded atomic transition (not a
    // revision-guarded full-row update): exactly one caller wins and runs the
    // completion side effects; losers observe the completed row.
    const wonCompletion =
      await this.ctx.repository.completeOccurrenceIfNonTerminal(
        updatedOccurrence,
        { definitionScope },
      );
    if (!wonCompletion) {
      const current = await this.ctx.repository.getOccurrenceView(
        this.ctx.agentId(),
        occurrence.id,
        definitionScope,
      );
      if (current?.state === "completed") return current;
      if (!current) {
        // The scoped re-read found nothing: the definition moved to another
        // owner between the authorized read and the write. Surface the same
        // typed conflict updateOccurrence raises for a stale scoped mutation.
        throw new ElizaError(
          "[DefinitionsDomain] occurrence completion matched no row for this definition scope",
          {
            code: "LIFEOPS_OCCURRENCE_CONFLICT",
            context: {
              occurrenceId: occurrence.id,
              definitionId: occurrence.definitionId,
              agentId: occurrence.agentId,
            },
          },
        );
      }
      fail(409, `occurrence cannot be completed from state ${current.state}`);
    }
    await this.ctx.recordAudit(
      "occurrence_completed",
      "occurrence",
      updatedOccurrence.id,
      "occurrence completed",
      {
        request,
      },
      {
        definitionId: updatedOccurrence.definitionId,
        occurrenceKey: updatedOccurrence.occurrenceKey,
      },
    );
    await this.deps.awardWebsiteAccessGrant(
      definition,
      updatedOccurrence.id,
      now,
    );
    await this.deps.refreshDefinitionOccurrences(definition, now);
    await this.deps.syncWebsiteAccessState(now);
    await this.deps.resolveReminderEscalation({
      ownerType: "occurrence",
      ownerId: updatedOccurrence.id,
      resolvedAt: now.toISOString(),
      resolution: "completed",
      note: normalizeOptionalString(request.note) ?? null,
    });
    const view = await this.ctx.repository.getOccurrenceView(
      this.ctx.agentId(),
      updatedOccurrence.id,
      definitionScope,
    );
    if (!view) {
      fail(404, "life-ops occurrence not found after completion");
    }
    try {
      const engagement = await this.ctx.repository.attributeBriefItemEngagement(
        {
          agentId: this.ctx.agentId(),
          source: "life",
          sourceId: updatedOccurrence.id,
          eventType: "completed",
          eventAt: completedAt,
          domainEventId: `occurrence_completed:${updatedOccurrence.id}:${completedAt}`,
          weight: 1,
          metadata: {
            definitionId: updatedOccurrence.definitionId,
            occurrenceKey: updatedOccurrence.occurrenceKey,
          },
        },
      );
      if (engagement) {
        await settleBriefEngagementReward({
          runtime: this.ctx.runtime,
          repository: this.ctx.repository,
          engagement,
        });
      }
    } catch (error) {
      // error-policy:J7 engagement attribution is diagnostic learning state;
      // it must not turn an already-committed occurrence completion into a
      // failed owner action. The gap remains visible through RECENT_ERRORS.
      this.ctx.runtime.reportError(
        "LifeOpsDefinitions.attributeBriefCompletion",
        error,
        { occurrenceId: updatedOccurrence.id },
      );
    }
    return view;
  }

  async skipOccurrence(
    occurrenceId: string,
    now = new Date(),
  ): Promise<LifeOpsOccurrenceView> {
    const { definition, occurrence } = await this.deps.getFreshOccurrence(
      occurrenceId,
      now,
    );
    const definitionScope = {
      domain: definition.domain,
      subjectType: definition.subjectType,
      subjectId: definition.subjectId,
    };
    if (occurrence.state === "skipped") {
      const current = await this.ctx.repository.getOccurrenceView(
        this.ctx.agentId(),
        occurrence.id,
        definitionScope,
      );
      if (!current) {
        fail(404, "life-ops occurrence not found");
      }
      return current;
    }
    if (["completed", "expired", "muted"].includes(occurrence.state)) {
      fail(409, `occurrence cannot be skipped from state ${occurrence.state}`);
    }
    const updatedOccurrence: LifeOpsOccurrence = {
      ...occurrence,
      state: "skipped",
      snoozedUntil: null,
      completionPayload: {
        skippedAt: now.toISOString(),
        previousState: occurrence.state,
      },
      updatedAt: nextMutationRevision(occurrence.updatedAt, now),
    };
    await this.ctx.repository.updateOccurrence(updatedOccurrence, {
      definitionScope,
      expectedUpdatedAt: occurrence.updatedAt,
      expectedDefinitionUpdatedAt: definition.updatedAt,
    });
    await this.ctx.recordAudit(
      "occurrence_skipped",
      "occurrence",
      updatedOccurrence.id,
      "occurrence skipped",
      {},
      {
        definitionId: updatedOccurrence.definitionId,
        occurrenceKey: updatedOccurrence.occurrenceKey,
      },
    );
    await this.deps.refreshDefinitionOccurrences(definition, now);
    await this.deps.resolveReminderEscalation({
      ownerType: "occurrence",
      ownerId: updatedOccurrence.id,
      resolvedAt: now.toISOString(),
      resolution: "skipped",
    });
    const view = await this.ctx.repository.getOccurrenceView(
      this.ctx.agentId(),
      updatedOccurrence.id,
      definitionScope,
    );
    if (!view) {
      fail(404, "life-ops occurrence not found after skip");
    }
    return view;
  }

  async snoozeOccurrence(
    occurrenceId: string,
    request: SnoozeLifeOpsOccurrenceRequest,
    now = new Date(),
  ): Promise<LifeOpsOccurrenceView> {
    const { occurrence, definition } = await this.deps.getFreshOccurrence(
      occurrenceId,
      now,
    );
    const definitionScope = {
      domain: definition.domain,
      subjectType: definition.subjectType,
      subjectId: definition.subjectId,
    };
    if (
      ["completed", "skipped", "expired", "muted"].includes(occurrence.state)
    ) {
      fail(409, `occurrence cannot be snoozed from state ${occurrence.state}`);
    }
    const snoozedUntil = computeSnoozedUntil(definition, request, now);
    if (snoozedUntil.getTime() <= now.getTime()) {
      fail(400, "snoozedUntil must be in the future");
    }
    const updatedOccurrence: LifeOpsOccurrence = {
      ...occurrence,
      state: "snoozed",
      snoozedUntil: snoozedUntil.toISOString(),
      updatedAt: nextMutationRevision(occurrence.updatedAt, now),
      metadata: {
        ...occurrence.metadata,
        snoozedAt: now.toISOString(),
        snoozePreset: request.preset ?? null,
      },
    };
    await this.ctx.repository.updateOccurrence(updatedOccurrence, {
      definitionScope,
      expectedUpdatedAt: occurrence.updatedAt,
      expectedDefinitionUpdatedAt: definition.updatedAt,
    });
    await this.ctx.recordAudit(
      "occurrence_snoozed",
      "occurrence",
      updatedOccurrence.id,
      "occurrence snoozed",
      {
        request,
      },
      {
        snoozedUntil: updatedOccurrence.snoozedUntil,
      },
    );
    await this.deps.resolveReminderEscalation({
      ownerType: "occurrence",
      ownerId: updatedOccurrence.id,
      resolvedAt: now.toISOString(),
      resolution: "snoozed",
    });
    const view = await this.ctx.repository.getOccurrenceView(
      this.ctx.agentId(),
      updatedOccurrence.id,
      definitionScope,
    );
    if (!view) {
      fail(404, "life-ops occurrence not found after snooze");
    }
    try {
      const engagement = await this.ctx.repository.attributeBriefItemEngagement(
        {
          agentId: this.ctx.agentId(),
          source: "life",
          sourceId: updatedOccurrence.id,
          eventType: "rescheduled",
          eventAt: updatedOccurrence.updatedAt,
          domainEventId: `occurrence_snoozed:${updatedOccurrence.id}:${updatedOccurrence.updatedAt}`,
          weight: 1,
          metadata: { snoozedUntil: updatedOccurrence.snoozedUntil },
        },
      );
      if (engagement) {
        await settleBriefEngagementReward({
          runtime: this.ctx.runtime,
          repository: this.ctx.repository,
          engagement,
        });
      }
    } catch (error) {
      // error-policy:J7 snooze already committed; learning telemetry cannot
      // rewrite the authoritative occurrence result.
      this.ctx.runtime.reportError(
        "LifeOpsDefinitions.attributeBriefReschedule",
        error,
        { occurrenceId: updatedOccurrence.id },
      );
    }
    return view;
  }
}
