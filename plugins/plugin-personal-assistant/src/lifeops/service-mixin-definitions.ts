import type {
  CompleteLifeOpsOccurrenceRequest,
  CreateLifeOpsDefinitionRequest,
  LifeOpsDefinitionRecord,
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
  LifeOpsOwnership,
  LifeOpsOwnershipInput,
  LifeOpsReminderPlan,
  LifeOpsTaskDefinition,
  SnoozeLifeOpsOccurrenceRequest,
  UpdateLifeOpsDefinitionRequest,
} from "../contracts/index.js";
import {
  LIFEOPS_DEFINITION_KINDS,
  LIFEOPS_DEFINITION_STATUSES,
} from "../contracts/index.js";
import { createLifeOpsTaskDefinition } from "./repository.js";
import {
  cloneRecord,
  computeSnoozedUntil,
  mergeMetadata,
  normalizeOptionalRecord,
  normalizeReminderPlanDraft,
} from "./service-helpers-misc.js";
import { computeDefinitionPerformance } from "./service-helpers-occurrence.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalString,
  normalizePriority,
  normalizeValidTimeZone,
  requireNonEmptyString,
} from "./service-normalize.js";
import { normalizeWindowPolicyInput } from "./service-normalize-connector.js";
import {
  normalizeCadence,
  normalizeProgressionRule,
  normalizeWebsiteAccessPolicy,
} from "./service-normalize-task.js";

// Routine seeding is a FIRST_RUN customize-path concern — see
// `src/lifeops/first-run/service.ts`. The migrator at
// `src/lifeops/seed-routine-migration/migrator.ts` rewrites legacy
// `seedKey: "load-test-user-profile:*"` definitions onto the
// `default-packs/habit-starters.ts` `ScheduledTask` records.

export interface LifeOpsDefinitionService {
  listDefinitions(): Promise<LifeOpsDefinitionRecord[]>;
  getDefinition(definitionId: string): Promise<LifeOpsDefinitionRecord>;
  createDefinition(
    request: CreateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord>;
  updateDefinition(
    definitionId: string,
    request: UpdateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord>;
  deleteDefinition(definitionId: string): Promise<void>;
  completeOccurrence(
    occurrenceId: string,
    request: CompleteLifeOpsOccurrenceRequest,
    now?: Date,
  ): Promise<LifeOpsOccurrenceView>;
  skipOccurrence(
    occurrenceId: string,
    now?: Date,
  ): Promise<LifeOpsOccurrenceView>;
  snoozeOccurrence(
    occurrenceId: string,
    request: SnoozeLifeOpsOccurrenceRequest,
    now?: Date,
  ): Promise<LifeOpsOccurrenceView>;
}

type ReminderPlanDraft = ReturnType<typeof normalizeReminderPlanDraft>;

type DefinitionMixinDependencies = LifeOpsServiceBase & {
  getDefinitionRecord(definitionId: string): Promise<LifeOpsDefinitionRecord>;
  ensureGoalExists(
    goalId: string | null,
    ownership: LifeOpsOwnership,
  ): Promise<string | null>;
  syncReminderPlan(
    definition: LifeOpsTaskDefinition,
    draft: ReminderPlanDraft | undefined,
  ): Promise<LifeOpsReminderPlan | null>;
  syncGoalLink(definition: LifeOpsTaskDefinition): Promise<void>;
  refreshDefinitionOccurrences(
    definition: LifeOpsTaskDefinition,
    now?: Date,
  ): Promise<void>;
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
    resolution: "completed" | "skipped" | "snoozed";
    note?: string | null;
  }): Promise<void>;
  normalizeOwnership(
    input: LifeOpsOwnershipInput | undefined,
    current?: LifeOpsOwnership,
  ): LifeOpsOwnership;
};

export function withDefinitions<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsDefinitionService> {
  const DefinitionsBase =
    Base as unknown as Constructor<DefinitionMixinDependencies>;

  class LifeOpsDefinitionServiceMixin extends DefinitionsBase {
    async listDefinitions(): Promise<LifeOpsDefinitionRecord[]> {
      const definitions = await this.repository.listDefinitions(this.agentId());
      const plans = await this.repository.listReminderPlansForOwners(
        this.agentId(),
        "definition",
        definitions.map((definition) => definition.id),
      );
      const planMap = new Map(plans.map((plan) => [plan.ownerId, plan]));
      const occurrences = await this.repository.listOccurrencesForDefinitions(
        this.agentId(),
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

    async getDefinition(
      definitionId: string,
    ): Promise<LifeOpsDefinitionRecord> {
      return this.getDefinitionRecord(definitionId);
    }

    async createDefinition(
      request: CreateLifeOpsDefinitionRequest,
    ): Promise<LifeOpsDefinitionRecord> {
      const agentId = this.agentId();
      const ownership = this.normalizeOwnership(request.ownership);
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
      const goalId = await this.ensureGoalExists(
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
          normalizeWebsiteAccessPolicy(
            request.websiteAccess,
            "websiteAccess",
          ) ?? null,
        reminderPlanId: null,
        goalId,
        source: normalizeOptionalString(request.source) ?? "manual",
        metadata: mergeMetadata(
          {},
          normalizeOptionalRecord(request.metadata, "metadata"),
        ),
      });
      await this.repository.createDefinition(definition);
      const reminderPlan = await this.syncReminderPlan(
        definition,
        reminderPlanDraft,
      );
      if (definition.reminderPlanId !== null) {
        await this.repository.updateDefinition(definition);
      }
      await this.syncGoalLink(definition);
      await this.refreshDefinitionOccurrences(definition);
      definition =
        (await this.syncNativeAppleReminderForDefinition({
          definition,
        })) ?? definition;
      await this.repository.updateDefinition(definition);
      await this.recordAudit(
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
      await this.syncWebsiteAccessState();
      const occurrences = await this.repository.listOccurrencesForDefinition(
        this.agentId(),
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
      const current = await this.getDefinitionRecord(definitionId);
      const ownership = this.normalizeOwnership(
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
            ? await this.ensureGoalExists(request.goalId ?? null, ownership)
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
      await this.repository.updateDefinition(nextDefinition);
      const reminderPlan = await this.syncReminderPlan(
        nextDefinition,
        reminderPlanDraft,
      );
      await this.repository.updateDefinition(nextDefinition);
      await this.syncGoalLink(nextDefinition);
      if (nextDefinition.status === "active") {
        await this.refreshDefinitionOccurrences(nextDefinition);
      }
      nextDefinition =
        (await this.syncNativeAppleReminderForDefinition({
          definition: nextDefinition,
          previousDefinition: current.definition,
        })) ?? nextDefinition;
      await this.repository.updateDefinition(nextDefinition);
      await this.recordAudit(
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
      await this.syncWebsiteAccessState();
      const occurrences = await this.repository.listOccurrencesForDefinition(
        this.agentId(),
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
      const definition = await this.repository.getDefinition(
        this.agentId(),
        definitionId,
      );
      if (!definition) {
        fail(404, "life-ops definition not found");
      }
      await this.syncNativeAppleReminderForDefinition({
        definition: null,
        previousDefinition: definition,
      });
      await this.repository.deleteDefinition(this.agentId(), definitionId);
      await this.recordAudit(
        "definition_deleted",
        "definition",
        definitionId,
        "definition deleted",
        { title: definition.title },
        {},
      );
      await this.syncWebsiteAccessState();
    }

    async completeOccurrence(
      occurrenceId: string,
      request: CompleteLifeOpsOccurrenceRequest,
      now = new Date(),
    ): Promise<LifeOpsOccurrenceView> {
      const { definition, occurrence } = await this.getFreshOccurrence(
        occurrenceId,
        now,
      );
      if (occurrence.state === "completed") {
        const current = await this.repository.getOccurrenceView(
          this.agentId(),
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
      await this.repository.updateOccurrence(updatedOccurrence);
      await this.recordAudit(
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
      await this.awardWebsiteAccessGrant(definition, updatedOccurrence.id, now);
      await this.refreshDefinitionOccurrences(definition, now);
      await this.syncWebsiteAccessState(now);
      await this.resolveReminderEscalation({
        ownerType: "occurrence",
        ownerId: updatedOccurrence.id,
        resolvedAt: now.toISOString(),
        resolution: "completed",
        note: normalizeOptionalString(request.note) ?? null,
      });
      const view = await this.repository.getOccurrenceView(
        this.agentId(),
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
      const { definition, occurrence } = await this.getFreshOccurrence(
        occurrenceId,
        now,
      );
      if (occurrence.state === "skipped") {
        const current = await this.repository.getOccurrenceView(
          this.agentId(),
          occurrence.id,
        );
        if (!current) {
          fail(404, "life-ops occurrence not found");
        }
        return current;
      }
      if (["completed", "expired", "muted"].includes(occurrence.state)) {
        fail(
          409,
          `occurrence cannot be skipped from state ${occurrence.state}`,
        );
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
      await this.repository.updateOccurrence(updatedOccurrence);
      await this.recordAudit(
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
      await this.refreshDefinitionOccurrences(definition, now);
      await this.resolveReminderEscalation({
        ownerType: "occurrence",
        ownerId: updatedOccurrence.id,
        resolvedAt: now.toISOString(),
        resolution: "skipped",
      });
      const view = await this.repository.getOccurrenceView(
        this.agentId(),
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
      const { occurrence, definition } = await this.getFreshOccurrence(
        occurrenceId,
        now,
      );
      if (
        ["completed", "skipped", "expired", "muted"].includes(occurrence.state)
      ) {
        fail(
          409,
          `occurrence cannot be snoozed from state ${occurrence.state}`,
        );
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
      await this.repository.updateOccurrence(updatedOccurrence);
      await this.recordAudit(
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
      await this.resolveReminderEscalation({
        ownerType: "occurrence",
        ownerId: updatedOccurrence.id,
        resolvedAt: now.toISOString(),
        resolution: "snoozed",
      });
      const view = await this.repository.getOccurrenceView(
        this.agentId(),
        updatedOccurrence.id,
      );
      if (!view) {
        fail(404, "life-ops occurrence not found after snooze");
      }
      return view;
    }
  }

  return LifeOpsDefinitionServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsDefinitionService
  >;
}
