// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import type {
  CompleteLifeOpsOccurrenceRequest,
  CreateLifeOpsDefinitionRequest,
  LifeOpsDefinitionRecord,
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
  LifeOpsTaskDefinition,
  SnoozeLifeOpsOccurrenceRequest,
  UpdateLifeOpsDefinitionRequest,
} from "../contracts/index.js";
import {
  LIFEOPS_DEFINITION_KINDS,
  LIFEOPS_DEFINITION_STATUSES,
} from "../contracts/index.js";
import { resolveDefaultTimeZone } from "./defaults.js";
import { createLifeOpsTaskDefinition } from "./repository.js";
import {
  ROUTINE_SEED_TEMPLATES,
  type RoutineSeedTemplate,
} from "./seed-routines.js";
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

const ROUTINE_SEED_METADATA_PREFIX = "load-test-user-profile";

function resolveRoutineSeedKey(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const seedKey = metadata?.seedKey;
  return typeof seedKey === "string" && seedKey.length > 0 ? seedKey : null;
}

function buildRoutineSeedKey(templateKey: string): string {
  return `${ROUTINE_SEED_METADATA_PREFIX}:${templateKey}`;
}

export interface LifeOpsDefinitionService {
  listDefinitions(): Promise<LifeOpsDefinitionRecord[]>;
  getDefinition(definitionId: string): Promise<LifeOpsDefinitionRecord>;
  createDefinition(
    request: CreateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord>;
  /**
   * @deprecated Use the FIRST_RUN action via `FirstRunService` instead. The
   * mixin entry point is kept so existing callers (e.g. legacy onboarding
   * messages) keep compiling, but new work should call into the first-run
   * capability — `eliza/plugins/app-lifeops/src/lifeops/first-run/service.ts`.
   */
  checkAndOfferSeeding(): Promise<{
    needsSeeding: boolean;
    availableTemplates: RoutineSeedTemplate[];
  }>;
  /** @deprecated Tracked through the FIRST_RUN state machine going forward. */
  markSeedingOffered(): Promise<void>;
  /**
   * @deprecated Routine seeding moves into the FIRST_RUN customize path
   * ("habit starters" question). New code should not call this directly.
   */
  applySeedRoutines(keys: string[], timezone?: string): Promise<string[]>;
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

export function withDefinitions<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsDefinitionService> {
  return class extends Base {
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

    async checkAndOfferSeeding(): Promise<{
      needsSeeding: boolean;
      availableTemplates: RoutineSeedTemplate[];
    }> {
      const existing = await this.repository.listActiveDefinitions(
        this.agentId(),
      );
      if (existing.length > 0) {
        return { needsSeeding: false, availableTemplates: [] };
      }

      // Check if seeding was already offered via audit trail
      const audits = await this.repository.listAuditEvents(
        this.agentId(),
        "definition",
        `seeding:${this.agentId()}`,
      );
      const seedingOffered = audits.some(
        (event) => event.eventType === "seeding_offered",
      );
      if (seedingOffered) {
        return { needsSeeding: false, availableTemplates: [] };
      }

      return { needsSeeding: true, availableTemplates: ROUTINE_SEED_TEMPLATES };
    }

    async markSeedingOffered(): Promise<void> {
      await this.recordAudit(
        "seeding_offered",
        "definition",
        `seeding:${this.agentId()}`,
        "seed routines offered",
        {},
        {
          offeredAt: new Date().toISOString(),
        },
      );
    }

    async applySeedRoutines(
      keys: string[],
      timezone?: string,
    ): Promise<string[]> {
      const effectiveTimezone = timezone
        ? normalizeValidTimeZone(timezone, "timezone")
        : resolveDefaultTimeZone();
      const templates = ROUTINE_SEED_TEMPLATES.filter((t) =>
        keys.includes(t.key),
      );
      if (templates.length === 0) {
        fail(400, "no valid seed template keys provided");
      }

      const existingDefinitions = await this.repository.listDefinitions(
        this.agentId(),
      );
      const existingBySeedKey = new Map(
        existingDefinitions
          .map((record) => {
            const seedKey = resolveRoutineSeedKey(record.definition.metadata);
            return seedKey ? [seedKey, record.definition.id] : null;
          })
          .filter((entry): entry is [string, string] => entry !== null),
      );

      const createdIds: string[] = [];
      for (const template of templates) {
        const seedKey = buildRoutineSeedKey(template.key);
        const existingId = existingBySeedKey.get(seedKey);
        if (existingId) {
          continue;
        }
        const result = await this.createDefinition({
          ...template.request,
          timezone: effectiveTimezone,
          source: "seed",
          metadata: {
            ...(template.request.metadata ?? {}),
            seedKey,
          },
        });
        createdIds.push(result.definition.id);
      }

      if (createdIds.length > 0) {
        await this.recordAudit(
          "seeding_offered",
          "definition",
          `seeding:${this.agentId()}`,
          "seed routines applied",
          { keys },
          {
            appliedKeys: keys,
            timezone: effectiveTimezone,
            createdIds,
          },
        );
      }

      return createdIds;
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
  } as MixinClass<TBase, LifeOpsDefinitionService>;
}
