/**
 * Task-definition domain for LifeOps: CRUD over LifeOps task definitions and
 * their occurrences (the recurring reminders/check-ins/routines the scheduler
 * later fires), including reminder-plan normalization and definition-performance
 * scoring.
 */
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
  SnoozeLifeOpsOccurrenceRequest,
  UpdateLifeOpsDefinitionRequest,
} from "../../contracts/index.js";
import {
  LIFEOPS_DEFINITION_KINDS,
  LIFEOPS_DEFINITION_STATUSES,
} from "../../contracts/index.js";
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
  normalizeWebsiteAccessPolicy,
} from "../service-normalize-task.js";

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
    const definitions = await this.ctx.repository.listDefinitions(
      this.ctx.agentId(),
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
    const progressionRule = normalizeProgressionRule(request.progressionRule);
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
      websiteAccess:
        normalizeWebsiteAccessPolicy(request.websiteAccess, "websiteAccess") ??
        null,
      reminderPlanId: null,
      goalId,
      source: normalizeOptionalString(request.source) ?? "manual",
      metadata: mergeMetadata(
        {},
        normalizeOptionalRecord(request.metadata, "metadata"),
      ),
    });
    await this.ctx.repository.createDefinition(definition);
    const reminderPlan = await this.deps.syncReminderPlan(
      definition,
      reminderPlanDraft,
    );
    if (definition.reminderPlanId !== null) {
      await this.ctx.repository.updateDefinition(definition);
    }
    await this.deps.syncGoalLink(definition);
    await this.deps.refreshDefinitionOccurrences(definition);
    definition =
      (await this.deps.syncNativeAppleReminderForDefinition({
        definition,
      })) ?? definition;
    await this.ctx.repository.updateDefinition(definition);
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
    const nextWindowPolicy = normalizeWindowPolicyInput(
      request.windowPolicy ?? current.definition.windowPolicy,
      "windowPolicy",
      nextTimezone,
    );
    const nextCadence = normalizeCadence(
      request.cadence ?? current.definition.cadence,
      nextWindowPolicy,
    );
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
      updatedAt: new Date().toISOString(),
    };
    const reminderPlanDraft = normalizeReminderPlanDraft(
      request.reminderPlan,
      "update",
    );
    await this.ctx.repository.updateDefinition(nextDefinition);
    const reminderPlan = await this.deps.syncReminderPlan(
      nextDefinition,
      reminderPlanDraft,
    );
    await this.ctx.repository.updateDefinition(nextDefinition);
    await this.deps.syncGoalLink(nextDefinition);
    if (nextDefinition.status === "active") {
      await this.deps.refreshDefinitionOccurrences(nextDefinition);
    }
    nextDefinition =
      (await this.deps.syncNativeAppleReminderForDefinition({
        definition: nextDefinition,
        previousDefinition: current.definition,
      })) ?? nextDefinition;
    await this.ctx.repository.updateDefinition(nextDefinition);
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
    const definition = await this.ctx.repository.getDefinition(
      this.ctx.agentId(),
      definitionId,
    );
    if (!definition) {
      fail(404, "life-ops definition not found");
    }
    await this.deps.syncNativeAppleReminderForDefinition({
      definition: null,
      previousDefinition: definition,
    });
    await this.ctx.repository.deleteDefinition(
      this.ctx.agentId(),
      definitionId,
    );
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

  async completeOccurrence(
    occurrenceId: string,
    request: CompleteLifeOpsOccurrenceRequest,
    now = new Date(),
  ): Promise<LifeOpsOccurrenceView> {
    const { definition, occurrence } = await this.deps.getFreshOccurrence(
      occurrenceId,
      now,
    );
    if (occurrence.state === "completed") {
      const current = await this.ctx.repository.getOccurrenceView(
        this.ctx.agentId(),
        occurrence.id,
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
    const updatedOccurrence: LifeOpsOccurrence = {
      ...occurrence,
      state: "completed",
      snoozedUntil: null,
      completionPayload: {
        completedAt: now.toISOString(),
        note: normalizeOptionalString(request.note) ?? null,
        metadata: cloneRecord(request.metadata),
        previousState: occurrence.state,
      },
      updatedAt: now.toISOString(),
    };
    await this.ctx.repository.updateOccurrence(updatedOccurrence);
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
    );
    if (!view) {
      fail(404, "life-ops occurrence not found after completion");
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
    if (occurrence.state === "skipped") {
      const current = await this.ctx.repository.getOccurrenceView(
        this.ctx.agentId(),
        occurrence.id,
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
      updatedAt: now.toISOString(),
    };
    await this.ctx.repository.updateOccurrence(updatedOccurrence);
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
      updatedAt: now.toISOString(),
      metadata: {
        ...occurrence.metadata,
        snoozedAt: now.toISOString(),
        snoozePreset: request.preset ?? null,
      },
    };
    await this.ctx.repository.updateOccurrence(updatedOccurrence);
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
    );
    if (!view) {
      fail(404, "life-ops occurrence not found after snooze");
    }
    return view;
  }
}
