// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  CreateLifeOpsGoalRequest,
  LifeOpsActiveReminderView,
  LifeOpsChannelPolicy,
  LifeOpsGoalDefinition,
  LifeOpsGoalRecord,
  LifeOpsGoalReview,
  LifeOpsGoalSupportSuggestion,
  LifeOpsOccurrenceExplanation,
  LifeOpsOccurrenceView,
  LifeOpsOverview,
  LifeOpsOverviewSection,
  LifeOpsReminderPlan,
  LifeOpsReminderPreference,
  LifeOpsReminderUrgency,
  LifeOpsTaskDefinition,
  UpdateLifeOpsGoalRequest,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_GOAL_STATUSES,
  LIFEOPS_GOAL_SUGGESTION_KINDS,
  LIFEOPS_REVIEW_STATES,
} from "@elizaos/shared/contracts/lifeops";
import {
  createLifeOpsAuditEvent,
  createLifeOpsGoalDefinition,
} from "./repository.js";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalString,
  normalizeReminderUrgency,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  isRecord,
  mergeMetadata,
  normalizeNullableRecord,
  normalizeOptionalRecord,
  requireRecord,
  buildActiveReminders,
  buildActiveCalendarEventReminders,
  selectOverviewOccurrences,
  priorityToUrgency,
} from "./service-helpers-misc.js";
import {
  shouldDeliverReminderForIntensity,
} from "./service-helpers-reminder.js";
import {
  computeDefinitionPerformance,
  summarizeOverviewSection,
} from "./service-helpers-occurrence.js";
import {
  type buildGoalSemanticReviewMetadata,
  mergeGoalSemanticReviewMetadata,
  readGoalGroundingMetadata,
  readGoalSemanticReviewMetadata,
} from "./goal-grounding.js";
import { evaluateGoalProgressWithLlm } from "./goal-semantic-evaluator.js";
import { resolveDefaultTimeZone } from "./defaults.js";
import { refreshLifeOpsScheduleInsight } from "./schedule-insight.js";
import { addMinutes } from "./time.js";
import { getZonedDateParts } from "./time.js";
import {
  GOAL_REVIEW_LOOKBACK_DAYS,
  GOAL_SEMANTIC_REVIEW_CACHE_TTL_MS,
  MAX_OVERVIEW_REMINDERS,
  OVERVIEW_HORIZON_MINUTES,
} from "./service-constants.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withGoals<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsGoalsServiceMixin extends Base {
    async deleteGoal(goalId: string): Promise<void> {
      const goal = await this.repository.getGoal(this.agentId(), goalId);
      if (!goal) {
        fail(404, "life-ops goal not found");
      }
      await this.repository.deleteGoal(this.agentId(), goalId);
      await this.recordAudit(
        "goal_deleted",
        "goal",
        goalId,
        "goal deleted",
        { title: goal.title },
        {},
      );
    }

    async listGoals(): Promise<LifeOpsGoalRecord[]> {
      const goals = await this.repository.listGoals(this.agentId());
      const records: LifeOpsGoalRecord[] = [];
      for (const goal of goals) {
        const links = await this.repository.listGoalLinksForGoal(
          this.agentId(),
          goal.id,
        );
        records.push({ goal, links });
      }
      return records;
    }

    async getGoal(goalId: string): Promise<LifeOpsGoalRecord> {
      return this.getGoalRecord(goalId);
    }

    async createGoal(
      request: CreateLifeOpsGoalRequest,
    ): Promise<LifeOpsGoalRecord> {
      const ownership = this.normalizeOwnership(request.ownership);
      const goal = createLifeOpsGoalDefinition({
        agentId: this.agentId(),
        ...ownership,
        title: requireNonEmptyString(request.title, "title"),
        description: normalizeOptionalString(request.description) ?? "",
        cadence: (() => {
          const cadence = normalizeNullableRecord(request.cadence, "cadence");
          if (cadence && typeof cadence.kind !== "string") {
            fail(400, "goal cadence must include a 'kind' field when provided");
          }
          return cadence ?? null;
        })(),
        supportStrategy: (() => {
          const strategy =
            normalizeOptionalRecord(request.supportStrategy, "supportStrategy") ??
            {};
          if (Array.isArray(strategy)) {
            fail(400, "supportStrategy must be an object, not an array");
          }
          return strategy;
        })(),
        successCriteria: (() => {
          const criteria =
            normalizeOptionalRecord(request.successCriteria, "successCriteria") ??
            {};
          if (Array.isArray(criteria)) {
            fail(400, "successCriteria must be an object, not an array");
          }
          return criteria;
        })(),
        status:
          request.status === undefined
            ? "active"
            : normalizeEnumValue(request.status, "status", LIFEOPS_GOAL_STATUSES),
        reviewState:
          request.reviewState === undefined
            ? "idle"
            : normalizeEnumValue(
                request.reviewState,
                "reviewState",
                LIFEOPS_REVIEW_STATES,
              ),
        metadata: mergeMetadata(
          {},
          normalizeOptionalRecord(request.metadata, "metadata"),
        ),
      });
      await this.repository.createGoal(goal);
      await this.recordAudit(
        "goal_created",
        "goal",
        goal.id,
        "goal created",
        {
          request,
        },
        {
          status: goal.status,
          reviewState: goal.reviewState,
        },
      );
      return {
        goal,
        links: [],
      };
    }

    async updateGoal(
      goalId: string,
      request: UpdateLifeOpsGoalRequest,
    ): Promise<LifeOpsGoalRecord> {
      const current = await this.getGoalRecord(goalId);
      const ownership = this.normalizeOwnership(request.ownership, current.goal);
      const nextGoal: LifeOpsGoalDefinition = {
        ...current.goal,
        ...ownership,
        title:
          request.title !== undefined
            ? requireNonEmptyString(request.title, "title")
            : current.goal.title,
        description:
          request.description !== undefined
            ? (normalizeOptionalString(request.description) ?? "")
            : current.goal.description,
        cadence:
          request.cadence !== undefined
            ? (normalizeNullableRecord(request.cadence, "cadence") ?? null)
            : current.goal.cadence,
        supportStrategy:
          request.supportStrategy !== undefined
            ? requireRecord(request.supportStrategy, "supportStrategy")
            : current.goal.supportStrategy,
        successCriteria:
          request.successCriteria !== undefined
            ? requireRecord(request.successCriteria, "successCriteria")
            : current.goal.successCriteria,
        status:
          request.status !== undefined
            ? normalizeEnumValue(request.status, "status", LIFEOPS_GOAL_STATUSES)
            : current.goal.status,
        reviewState:
          request.reviewState !== undefined
            ? normalizeEnumValue(
                request.reviewState,
                "reviewState",
                LIFEOPS_REVIEW_STATES,
              )
            : current.goal.reviewState,
        metadata:
          request.metadata !== undefined
            ? mergeMetadata(
                current.goal.metadata,
                normalizeOptionalRecord(request.metadata, "metadata"),
              )
            : current.goal.metadata,
        updatedAt: new Date().toISOString(),
      };
      await this.repository.updateGoal(nextGoal);
      await this.recordAudit(
        "goal_updated",
        "goal",
        nextGoal.id,
        "goal updated",
        {
          request,
        },
        {
          status: nextGoal.status,
          reviewState: nextGoal.reviewState,
        },
      );
      return {
        goal: nextGoal,
        links: current.links,
      };
    }

    public async collectLinkedDefinitionsForGoal(
      goalRecord: LifeOpsGoalRecord,
    ): Promise<LifeOpsTaskDefinition[]> {
      const linkedDefinitionIds = new Set(
        goalRecord.links
          .filter((link) => link.linkedType === "definition")
          .map((link) => link.linkedId),
      );
      const definitions = await this.repository.listDefinitions(this.agentId());
      return definitions
        .filter(
          (definition) =>
            definition.status !== "archived" &&
            (definition.goalId === goalRecord.goal.id ||
              linkedDefinitionIds.has(definition.id)),
        )
        .sort((left, right) => left.title.localeCompare(right.title));
    }

    public async collectOccurrenceViewsForDefinitions(
      definitions: LifeOpsTaskDefinition[],
    ): Promise<LifeOpsOccurrenceView[]> {
      const views: LifeOpsOccurrenceView[] = [];
      for (const definition of definitions) {
        const occurrences = await this.repository.listOccurrencesForDefinition(
          this.agentId(),
          definition.id,
        );
        for (const occurrence of occurrences) {
          const view = await this.repository.getOccurrenceView(
            this.agentId(),
            occurrence.id,
          );
          if (view) {
            views.push(view);
          }
        }
      }
      views.sort(
        (left, right) =>
          new Date(left.updatedAt).getTime() -
          new Date(right.updatedAt).getTime(),
      );
      return views;
    }

    public deriveGoalReviewState(
      goal: LifeOpsGoalDefinition,
      definitions: LifeOpsTaskDefinition[],
      activeOccurrences: LifeOpsOccurrenceView[],
      overdueOccurrences: LifeOpsOccurrenceView[],
      recentCompletions: LifeOpsOccurrenceView[],
      lastActivityAt: string | null,
      now: Date,
    ): LifeOpsGoalDefinition["reviewState"] {
      if (goal.status === "satisfied") {
        return "on_track";
      }
      if (goal.status !== "active") {
        return goal.reviewState;
      }
      if (definitions.length === 0) {
        return "needs_attention";
      }
      if (overdueOccurrences.length > 0) {
        return "at_risk";
      }
      if (!lastActivityAt) {
        return "needs_attention";
      }
      const cadenceKind =
        isRecord(goal.cadence) && typeof goal.cadence.kind === "string"
          ? goal.cadence.kind
          : null;
      const staleMs =
        cadenceKind === "daily" ||
        cadenceKind === "times_per_day" ||
        cadenceKind === "interval"
          ? 2 * 24 * 60 * 60 * 1000
          : cadenceKind === "weekly"
            ? 10 * 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
      const lastActivityTime = new Date(lastActivityAt).getTime();
      if (!Number.isFinite(lastActivityTime)) {
        return "needs_attention";
      }
      if (now.getTime() - lastActivityTime > staleMs) {
        return activeOccurrences.length > 0 ? "needs_attention" : "at_risk";
      }
      if (recentCompletions.length === 0 && activeOccurrences.length === 0) {
        return "needs_attention";
      }
      return "on_track";
    }

    public buildGoalReviewExplanation(args: {
      goal: LifeOpsGoalDefinition;
      linkedDefinitionCount: number;
      activeOccurrenceCount: number;
      overdueOccurrenceCount: number;
      completedLast7Days: number;
      reviewState: LifeOpsGoalDefinition["reviewState"];
      lastActivityAt: string | null;
    }): string {
      if (args.goal.status === "satisfied") {
        return "This goal is marked satisfied and currently does not need more support work.";
      }
      if (args.linkedDefinitionCount === 0) {
        return "This goal has no linked support tasks or routines yet, so there is nothing concrete to keep it moving.";
      }
      if (args.overdueOccurrenceCount > 0) {
        return `This goal is at risk because ${args.overdueOccurrenceCount} linked support ${args.overdueOccurrenceCount === 1 ? "item is" : "items are"} overdue.`;
      }
      if (args.completedLast7Days > 0) {
        return `This goal is on track because ${args.completedLast7Days} linked support ${args.completedLast7Days === 1 ? "item was" : "items were"} completed in the last 7 days.`;
      }
      if (args.activeOccurrenceCount > 0) {
        return `This goal has ${args.activeOccurrenceCount} active support ${args.activeOccurrenceCount === 1 ? "item" : "items"} in flight right now.`;
      }
      if (args.lastActivityAt) {
        return `This goal has support structure, but it has been quiet since ${args.lastActivityAt}.`;
      }
      if (args.reviewState === "needs_attention") {
        return "This goal needs a clearer support structure or a new check-in.";
      }
      return "This goal has support structure and does not currently have overdue work.";
    }

    public buildGoalSupportSuggestions(args: {
      goal: LifeOpsGoalDefinition;
      linkedDefinitions: LifeOpsTaskDefinition[];
      activeOccurrences: LifeOpsOccurrenceView[];
      overdueOccurrences: LifeOpsOccurrenceView[];
      recentCompletions: LifeOpsOccurrenceView[];
    }): LifeOpsGoalSupportSuggestion[] {
      const suggestions: LifeOpsGoalSupportSuggestion[] = [];
      if (args.linkedDefinitions.length === 0) {
        suggestions.push({
          kind: LIFEOPS_GOAL_SUGGESTION_KINDS[0],
          title: "Create the first support routine",
          detail:
            "Break this goal into a recurring task, habit, or routine so the agent can track and remind against something concrete.",
          definitionId: null,
          occurrenceId: null,
        });
        return suggestions;
      }
      for (const overdue of args.overdueOccurrences.slice(0, 2)) {
        suggestions.push({
          kind: LIFEOPS_GOAL_SUGGESTION_KINDS[2],
          title: overdue.title,
          detail:
            "Resolve or reschedule this overdue support item so the goal is no longer drifting.",
          definitionId: overdue.definitionId,
          occurrenceId: overdue.id,
        });
      }
      if (suggestions.length === 0 && args.activeOccurrences.length > 0) {
        const next = args.activeOccurrences[0];
        suggestions.push({
          kind: LIFEOPS_GOAL_SUGGESTION_KINDS[1],
          title: next.title,
          detail:
            "This is the clearest current action that advances the goal right now.",
          definitionId: next.definitionId,
          occurrenceId: next.id,
        });
      }
      if (args.recentCompletions.length === 0) {
        suggestions.push({
          kind: LIFEOPS_GOAL_SUGGESTION_KINDS[3],
          title: "Review progress",
          detail:
            "Check whether the current cadence still fits the goal, or whether the goal needs a stronger routine.",
          definitionId: null,
          occurrenceId: null,
        });
      }
      if (
        suggestions.length < 3 &&
        args.linkedDefinitions.every((definition) => definition.kind === "task")
      ) {
        suggestions.push({
          kind: LIFEOPS_GOAL_SUGGESTION_KINDS[4],
          title: "Tighten the support cadence",
          detail:
            "This goal only has one-off tasks linked to it. Consider adding a recurring habit or routine if progress should stay continuous.",
          definitionId: null,
          occurrenceId: null,
        });
      }
      return suggestions.slice(0, 3);
    }

    public formatLocalHourMinute(
      isoValue: string | null,
      timeZone: string,
    ): string | null {
      if (!isoValue) {
        return null;
      }
      const date = new Date(isoValue);
      if (Number.isNaN(date.getTime())) {
        return null;
      }
      const parts = getZonedDateParts(date, timeZone);
      return `${String(parts.hour).padStart(2, "0")}:${String(
        parts.minute,
      ).padStart(2, "0")}`;
    }

    public median(values: number[]): number | null {
      if (values.length === 0) {
        return null;
      }
      const sorted = [...values].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) {
        return sorted[middle];
      }
      return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    public async buildGoalSemanticEvidence(args: {
      activeOccurrences: LifeOpsOccurrenceView[];
      goal: LifeOpsGoalDefinition;
      lastActivityAt: string | null;
      linkedDefinitions: LifeOpsTaskDefinition[];
      overdueOccurrences: LifeOpsOccurrenceView[];
      recentCompletions: LifeOpsOccurrenceView[];
      reviewState: LifeOpsGoalDefinition["reviewState"];
      summary: LifeOpsGoalReview["summary"];
      now: Date;
    }): Promise<Record<string, unknown>> {
      const timeZone = resolveDefaultTimeZone();
      const linkedDefinitionSummaries = args.linkedDefinitions
        .slice(0, 8)
        .map((definition) => ({
          id: definition.id,
          kind: definition.kind,
          title: definition.title,
          cadence: definition.cadence,
          status: definition.status,
        }));
      const sleepSignals = (
        await this.listActivitySignals({
          sinceAt: new Date(
            args.now.getTime() - 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          limit: 80,
        })
      )
        .filter((signal) => signal.health?.sleep)
        .slice(0, 30);
      const sleepSessions = sleepSignals
        .map((signal) => {
          const sleep = signal.health?.sleep;
          if (!sleep) {
            return null;
          }
          return {
            observedAt: signal.observedAt,
            asleepAt: sleep.asleepAt,
            awakeAt: sleep.awakeAt,
            durationMinutes: sleep.durationMinutes,
            localBedtime: this.formatLocalHourMinute(sleep.asleepAt, timeZone),
            localWakeTime: this.formatLocalHourMinute(sleep.awakeAt, timeZone),
            stage: sleep.stage,
          };
        })
        .filter(
          (session): session is NonNullable<typeof session> => session !== null,
        )
        .slice(0, 14);
      const sleepStartHours = sleepSessions
        .map((session) => {
          const localBedtime = session.localBedtime;
          if (!localBedtime) {
            return null;
          }
          const [hour, minute] = localBedtime.split(":").map(Number);
          if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
            return null;
          }
          return hour + minute / 60;
        })
        .filter((value): value is number => value !== null);
      const wakeHours = sleepSessions
        .map((session) => {
          const localWakeTime = session.localWakeTime;
          if (!localWakeTime) {
            return null;
          }
          const [hour, minute] = localWakeTime.split(":").map(Number);
          if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
            return null;
          }
          return hour + minute / 60;
        })
        .filter((value): value is number => value !== null);
      const durations = sleepSessions
        .map((session) => session.durationMinutes)
        .filter((value): value is number => typeof value === "number");
      return {
        now: args.now.toISOString(),
        timeZone,
        goalGrounding: readGoalGroundingMetadata(args.goal.metadata),
        deterministicSummary: args.summary,
        reviewState: args.reviewState,
        linkedDefinitions: linkedDefinitionSummaries,
        activeOccurrences: args.activeOccurrences
          .slice(0, 8)
          .map((occurrence) => ({
            id: occurrence.id,
            title: occurrence.title,
            dueAt: occurrence.dueAt,
            state: occurrence.state,
          })),
        overdueOccurrences: args.overdueOccurrences
          .slice(0, 8)
          .map((occurrence) => ({
            id: occurrence.id,
            title: occurrence.title,
            dueAt: occurrence.dueAt,
            state: occurrence.state,
          })),
        recentCompletions: args.recentCompletions
          .slice(0, 8)
          .map((occurrence) => ({
            id: occurrence.id,
            title: occurrence.title,
            updatedAt: occurrence.updatedAt,
          })),
        lastActivityAt: args.lastActivityAt,
        sleepSummary: {
          sampleCount: sleepSessions.length,
          typicalBedtimeHour: this.median(sleepStartHours),
          typicalWakeHour: this.median(wakeHours),
          typicalSleepDurationMinutes:
            durations.length > 0
              ? Math.round(
                  durations.reduce((sum, value) => sum + value, 0) /
                    durations.length,
                )
              : null,
        },
        sleepSessions,
      };
    }

    public getCachedSemanticGoalReview(args: {
      goal: LifeOpsGoalDefinition;
      now: Date;
    }) {
      const cached = readGoalSemanticReviewMetadata(args.goal.metadata);
      if (!cached) {
        return null;
      }
      const reviewedAtMs = new Date(cached.reviewedAt).getTime();
      if (!Number.isFinite(reviewedAtMs)) {
        return null;
      }
      if (args.now.getTime() - reviewedAtMs > GOAL_SEMANTIC_REVIEW_CACHE_TTL_MS) {
        return null;
      }
      return cached;
    }

    public async syncComputedGoalReviewState(
      goal: LifeOpsGoalDefinition,
      reviewState: LifeOpsGoalDefinition["reviewState"],
      summary: LifeOpsGoalReview["summary"],
      semanticReview: ReturnType<typeof buildGoalSemanticReviewMetadata> | null,
      now: Date,
    ): Promise<LifeOpsGoalDefinition> {
      const currentSemanticReview = readGoalSemanticReviewMetadata(goal.metadata);
      const semanticUnchanged =
        !semanticReview ||
        (currentSemanticReview &&
          semanticReview &&
          currentSemanticReview.reviewedAt === semanticReview.reviewedAt &&
          currentSemanticReview.reviewState === semanticReview.reviewState &&
          currentSemanticReview.explanation === semanticReview.explanation);
      if (goal.reviewState === reviewState && semanticUnchanged) {
        return goal;
      }
      const mergedMetadata = mergeMetadata(goal.metadata, {
        computedGoalReview: {
          reviewedAt: now.toISOString(),
          reviewState,
          summary,
        },
      });
      const nextGoal: LifeOpsGoalDefinition = {
        ...goal,
        reviewState,
        metadata: semanticReview
          ? mergeGoalSemanticReviewMetadata(mergedMetadata, semanticReview)
          : mergedMetadata,
        updatedAt: now.toISOString(),
      };
      await this.repository.updateGoal(nextGoal);
      await this.repository.createAuditEvent(
        createLifeOpsAuditEvent({
          agentId: this.agentId(),
          eventType: "goal_reviewed",
          ownerType: "goal",
          ownerId: goal.id,
          reason: "goal review recomputed",
          inputs: {
            previousReviewState: goal.reviewState,
          },
          decision: {
            reviewState,
            summary,
          },
          actor: "agent",
        }),
      );
      return nextGoal;
    }

    public async buildGoalReview(
      goalRecord: LifeOpsGoalRecord,
      now: Date,
      options: { allowSemanticEvaluation?: boolean } = {},
    ): Promise<LifeOpsGoalReview> {
      const linkedDefinitions =
        await this.collectLinkedDefinitionsForGoal(goalRecord);
      const allOccurrenceViews =
        await this.collectOccurrenceViewsForDefinitions(linkedDefinitions);
      const lookbackStart = new Date(
        now.getTime() - GOAL_REVIEW_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      );
      const activeOccurrences = allOccurrenceViews.filter(
        (occurrence) =>
          occurrence.state === "visible" || occurrence.state === "snoozed",
      );
      const overdueOccurrences = activeOccurrences.filter((occurrence) => {
        if (!occurrence.dueAt) {
          return false;
        }
        return new Date(occurrence.dueAt).getTime() < now.getTime();
      });
      const recentCompletions = allOccurrenceViews.filter(
        (occurrence) =>
          occurrence.state === "completed" &&
          new Date(occurrence.updatedAt).getTime() >= lookbackStart.getTime(),
      );
      const lastActivityAt = allOccurrenceViews.reduce<string | null>(
        (latest, occurrence) => {
          const currentTime = new Date(occurrence.updatedAt).getTime();
          if (!Number.isFinite(currentTime)) {
            return latest;
          }
          if (!latest) {
            return occurrence.updatedAt;
          }
          return currentTime > new Date(latest).getTime()
            ? occurrence.updatedAt
            : latest;
        },
        null,
      );
      const derivedReviewState = this.deriveGoalReviewState(
        goalRecord.goal,
        linkedDefinitions,
        activeOccurrences,
        overdueOccurrences,
        recentCompletions,
        lastActivityAt,
        now,
      );
      const summary: LifeOpsGoalReview["summary"] = {
        linkedDefinitionCount: linkedDefinitions.length,
        activeOccurrenceCount: activeOccurrences.length,
        overdueOccurrenceCount: overdueOccurrences.length,
        completedLast7Days: recentCompletions.length,
        lastActivityAt,
        reviewState: derivedReviewState,
        explanation: this.buildGoalReviewExplanation({
          goal: goalRecord.goal,
          linkedDefinitionCount: linkedDefinitions.length,
          activeOccurrenceCount: activeOccurrences.length,
          overdueOccurrenceCount: overdueOccurrences.length,
          completedLast7Days: recentCompletions.length,
          reviewState: derivedReviewState,
          lastActivityAt,
        }),
      };
      const cachedSemanticReview = this.getCachedSemanticGoalReview({
        goal: goalRecord.goal,
        now,
      });
      const semanticEvidence = readGoalGroundingMetadata(goalRecord.goal.metadata)
        ? await this.buildGoalSemanticEvidence({
            activeOccurrences,
            goal: goalRecord.goal,
            lastActivityAt,
            linkedDefinitions,
            overdueOccurrences,
            recentCompletions,
            reviewState: derivedReviewState,
            summary,
            now,
          })
        : null;
      const semanticReview =
        options.allowSemanticEvaluation && semanticEvidence
          ? await evaluateGoalProgressWithLlm({
              runtime: this.runtime,
              evidence: semanticEvidence,
              goal: goalRecord.goal,
              nowIso: now.toISOString(),
            })
          : cachedSemanticReview;
      const effectiveReviewState =
        semanticReview?.reviewState ?? derivedReviewState;
      const effectiveSummary: LifeOpsGoalReview["summary"] = {
        ...summary,
        reviewState: effectiveReviewState,
        explanation: semanticReview?.explanation ?? summary.explanation,
        progressScore: semanticReview?.progressScore ?? null,
        confidence: semanticReview?.confidence ?? null,
        evidenceSummary: semanticReview?.evidenceSummary ?? null,
        missingEvidence: semanticReview?.missingEvidence ?? [],
        groundingState:
          readGoalGroundingMetadata(goalRecord.goal.metadata)?.groundingState ??
          null,
        groundingSummary:
          readGoalGroundingMetadata(goalRecord.goal.metadata)?.summary ?? null,
        semanticReviewedAt: semanticReview?.reviewedAt ?? null,
      };
      const goal = await this.syncComputedGoalReviewState(
        goalRecord.goal,
        effectiveReviewState,
        effectiveSummary,
        semanticReview,
        now,
      );
      const suggestions = semanticReview?.suggestions.length
        ? semanticReview.suggestions.map((suggestion) => ({
            kind:
              (suggestion.kind as LifeOpsGoalSupportSuggestion["kind"]) ??
              "review_progress",
            title: suggestion.title,
            detail: suggestion.detail,
            definitionId: null,
            occurrenceId: null,
          }))
        : this.buildGoalSupportSuggestions({
            goal,
            linkedDefinitions,
            activeOccurrences,
            overdueOccurrences,
            recentCompletions,
          });
      return {
        goal,
        links: goalRecord.links,
        linkedDefinitions,
        activeOccurrences,
        overdueOccurrences,
        recentCompletions,
        suggestions,
        audits: await this.repository.listAuditEvents(
          this.agentId(),
          "goal",
          goal.id,
        ),
        summary: {
          ...effectiveSummary,
          reviewState: goal.reviewState,
        },
      };
    }

    async reviewGoal(
      goalId: string,
      now = new Date(),
    ): Promise<LifeOpsGoalReview> {
      const goalRecord = await this.getGoalRecord(goalId);
      return this.buildGoalReview(goalRecord, now, {
        allowSemanticEvaluation: true,
      });
    }

    async explainOccurrence(
      occurrenceId: string,
    ): Promise<LifeOpsOccurrenceExplanation> {
      const occurrence = await this.repository.getOccurrenceView(
        this.agentId(),
        occurrenceId,
      );
      if (!occurrence) {
        fail(404, "life-ops occurrence not found");
      }
      const definitionRecord = await this.getDefinitionRecord(
        occurrence.definitionId,
      );
      const linkedGoal = definitionRecord.definition.goalId
        ? await this.getGoalRecord(definitionRecord.definition.goalId)
        : null;
      const reminderInspection = await this.inspectReminder(
        "occurrence",
        occurrence.id,
      );
      const definitionAudits = await this.repository.listAuditEvents(
        this.agentId(),
        "definition",
        definitionRecord.definition.id,
      );
      const lastReminderAttempt = reminderInspection.attempts[0] ?? null;
      const lastOccurrenceAudit = reminderInspection.audits[0] ?? null;
      const whyVisible =
        occurrence.state === "snoozed" && occurrence.snoozedUntil
          ? `This item is still visible because it was snoozed until ${occurrence.snoozedUntil}.`
          : occurrence.dueAt
            ? `This item is visible because it is due at ${occurrence.dueAt} and its current relevance window started at ${occurrence.relevanceStartAt}.`
            : `This item is visible because its current relevance window started at ${occurrence.relevanceStartAt}.`;
      return {
        occurrence,
        definition: definitionRecord.definition,
        definitionPerformance: definitionRecord.performance,
        reminderPlan: definitionRecord.reminderPlan,
        linkedGoal,
        reminderInspection,
        definitionAudits,
        summary: {
          originalIntent: definitionRecord.definition.originalIntent,
          source: definitionRecord.definition.source,
          whyVisible,
          lastReminderAt: lastReminderAttempt?.attemptedAt ?? null,
          lastReminderChannel: lastReminderAttempt?.channel ?? null,
          lastReminderOutcome: lastReminderAttempt?.outcome ?? null,
          lastActionSummary: lastOccurrenceAudit
            ? `${lastOccurrenceAudit.reason} at ${lastOccurrenceAudit.createdAt}`
            : null,
        },
      };
    }

    public async refreshGoalReviewStates(
      now: Date,
    ): Promise<LifeOpsGoalDefinition[]> {
      const goals = (await this.repository.listGoals(this.agentId())).filter(
        (goal) => goal.status === "active",
      );
      const refreshed: LifeOpsGoalDefinition[] = [];
      for (const goal of goals) {
        const review = await this.buildGoalReview(
          {
            goal,
            links: await this.repository.listGoalLinksForGoal(
              this.agentId(),
              goal.id,
            ),
          },
          now,
          { allowSemanticEvaluation: false },
        );
        refreshed.push(review.goal);
      }
      return refreshed;
    }

    async getOverview(now = new Date()): Promise<LifeOpsOverview> {
      const schedule = await refreshLifeOpsScheduleInsight({
        runtime: this.runtime,
        repository: this.repository,
        agentId: this.agentId(),
        timezone: resolveDefaultTimeZone(),
        now,
      });
      const definitions = await this.repository.listActiveDefinitions(
        this.agentId(),
      );
      for (const definition of definitions) {
        await this.refreshDefinitionOccurrences(definition, now);
      }
      const definitionsById = new Map(
        definitions.map((definition) => [definition.id, definition]),
      );
      const horizon = addMinutes(now, OVERVIEW_HORIZON_MINUTES).toISOString();
      const overviewOccurrences =
        await this.repository.listOccurrenceViewsForOverview(
          this.agentId(),
          horizon,
        );
      const reminderPlans = await this.repository.listReminderPlansForOwners(
        this.agentId(),
        "definition",
        overviewOccurrences.map((occurrence) => occurrence.definitionId),
      );
      const policies = await this.repository.listChannelPolicies(this.agentId());
      const definitionPreferencesById = new Map<
        string,
        LifeOpsReminderPreference
      >();
      const plansByDefinitionId = new Map<string, LifeOpsReminderPlan>();
      for (const plan of reminderPlans) {
        const definition = definitionsById.get(plan.ownerId) ?? null;
        const preference = this.buildReminderPreferenceResponse(
          definition,
          policies,
        );
        definitionPreferencesById.set(plan.ownerId, preference);
        const effectivePlan = this.resolveEffectiveReminderPlan(plan, preference);
        if (effectivePlan) {
          plansByDefinitionId.set(plan.ownerId, effectivePlan);
        }
      }
      const calendarEvents = await this.repository.listCalendarEvents(
        this.agentId(),
        "google",
        now.toISOString(),
        addMinutes(now, OVERVIEW_HORIZON_MINUTES).toISOString(),
      );
      const calendarReminderPlans =
        await this.repository.listReminderPlansForOwners(
          this.agentId(),
          "calendar_event",
          calendarEvents.map((event) => event.id),
        );
      const globalReminderPreference = this.buildReminderPreferenceResponse(
        null,
        policies,
      );
      const occurrenceUrgencies = new Map<string, LifeOpsReminderUrgency>();
      for (const occurrence of overviewOccurrences) {
        occurrenceUrgencies.set(
          occurrence.id,
          typeof occurrence.metadata.urgency === "string"
            ? normalizeReminderUrgency(occurrence.metadata.urgency)
            : priorityToUrgency(occurrence.priority),
        );
      }
      const eventUrgencies = new Map<string, LifeOpsReminderUrgency>();
      for (const event of calendarEvents) {
        eventUrgencies.set(
          event.id,
          typeof event.metadata.urgency === "string"
            ? normalizeReminderUrgency(event.metadata.urgency)
            : "medium",
        );
      }
      const plansByEventId = new Map<string, LifeOpsReminderPlan>();
      for (const plan of calendarReminderPlans) {
        const effectivePlan = this.resolveEffectiveReminderPlan(
          plan,
          globalReminderPreference,
        );
        if (effectivePlan) {
          plansByEventId.set(plan.ownerId, effectivePlan);
        }
      }
      const goals = await this.refreshGoalReviewStates(now);
      const allReminders = [
        ...buildActiveReminders(
          overviewOccurrences,
          plansByDefinitionId,
          now,
        ).filter((reminder) =>
          shouldDeliverReminderForIntensity(
            definitionPreferencesById.get(reminder.definitionId ?? "")?.effective
              ?.intensity ?? globalReminderPreference.effective.intensity,
            occurrenceUrgencies.get(reminder.ownerId) ?? "medium",
          ),
        ),
        ...buildActiveCalendarEventReminders(
          calendarEvents,
          plansByEventId,
          this.ownerEntityId(),
          now,
        ).filter((reminder) =>
          shouldDeliverReminderForIntensity(
            globalReminderPreference.effective.intensity,
            eventUrgencies.get(reminder.ownerId) ?? "medium",
          ),
        ),
      ].sort(
        (left, right) =>
          new Date(left.scheduledFor).getTime() -
          new Date(right.scheduledFor).getTime(),
      );
      const ownerSectionBase = {
        occurrences: selectOverviewOccurrences(
          overviewOccurrences.filter(
            (occurrence) => occurrence.subjectType === "owner",
          ),
        ),
        goals: goals.filter((goal) => goal.subjectType === "owner"),
        reminders: allReminders
          .filter((reminder) => reminder.subjectType === "owner")
          .slice(0, MAX_OVERVIEW_REMINDERS),
      };
      const agentSectionBase = {
        occurrences: selectOverviewOccurrences(
          overviewOccurrences.filter(
            (occurrence) => occurrence.subjectType === "agent",
          ),
        ),
        goals: goals.filter((goal) => goal.subjectType === "agent"),
        reminders: allReminders
          .filter((reminder) => reminder.subjectType === "agent")
          .slice(0, MAX_OVERVIEW_REMINDERS),
      };
      const owner: LifeOpsOverviewSection = {
        ...ownerSectionBase,
        summary: summarizeOverviewSection(ownerSectionBase, now),
      };
      const agentOps: LifeOpsOverviewSection = {
        ...agentSectionBase,
        summary: summarizeOverviewSection(agentSectionBase, now),
      };
      return {
        occurrences: owner.occurrences,
        goals: owner.goals,
        reminders: owner.reminders,
        summary: owner.summary,
        owner,
        agentOps,
        schedule,
      };
    }

    async listChannelPolicies(): Promise<LifeOpsChannelPolicy[]> {
      return this.repository.listChannelPolicies(this.agentId());
    }
  }

  return LifeOpsGoalsServiceMixin;
}
