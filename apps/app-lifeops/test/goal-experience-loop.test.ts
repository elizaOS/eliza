import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { LifeOpsOccurrence } from "@elizaos/shared";
import { createLifeOpsChatTestRuntime } from "./helpers/lifeops-chat-runtime.js";
import {
  createLifeOpsGoalDefinition,
  createLifeOpsTaskDefinition,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

function createRuntime(agentId: string) {
  const runtime = createLifeOpsChatTestRuntime({
    agentId,
    useModel: async () => {
      throw new Error("useModel should not be called in goal experience tests");
    },
    handleTurn: async () => ({ text: "ok" }),
  });
  runtime.adapter.runPluginMigrations = async () => {
    await runtime.adapter.db.execute({
      queryChunks: [
        {
          value: `
            CREATE TABLE IF NOT EXISTS life_goal_definitions (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              domain TEXT NOT NULL,
              subject_type TEXT NOT NULL,
              subject_id TEXT NOT NULL,
              visibility_scope TEXT NOT NULL,
              context_policy TEXT NOT NULL,
              title TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              cadence_json TEXT,
              support_strategy_json TEXT NOT NULL DEFAULT '{}',
              success_criteria_json TEXT NOT NULL DEFAULT '{}',
              status TEXT NOT NULL DEFAULT 'active',
              review_state TEXT NOT NULL DEFAULT 'idle',
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS life_goal_links (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              goal_id TEXT NOT NULL,
              linked_type TEXT NOT NULL,
              linked_id TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS life_task_definitions (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              domain TEXT NOT NULL,
              subject_type TEXT NOT NULL,
              subject_id TEXT NOT NULL,
              visibility_scope TEXT NOT NULL,
              context_policy TEXT NOT NULL,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              original_intent TEXT NOT NULL DEFAULT '',
              timezone TEXT NOT NULL DEFAULT 'UTC',
              status TEXT NOT NULL DEFAULT 'active',
              priority INTEGER NOT NULL DEFAULT 3,
              cadence_json TEXT NOT NULL DEFAULT '{}',
              window_policy_json TEXT NOT NULL DEFAULT '{}',
              progression_rule_json TEXT NOT NULL DEFAULT '{}',
              website_access_json TEXT,
              reminder_plan_id TEXT,
              goal_id TEXT,
              source TEXT NOT NULL DEFAULT 'manual',
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS life_task_occurrences (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              domain TEXT NOT NULL,
              subject_type TEXT NOT NULL,
              subject_id TEXT NOT NULL,
              visibility_scope TEXT NOT NULL,
              context_policy TEXT NOT NULL,
              definition_id TEXT NOT NULL,
              occurrence_key TEXT NOT NULL,
              scheduled_at TEXT,
              due_at TEXT,
              relevance_start_at TEXT NOT NULL,
              relevance_end_at TEXT NOT NULL,
              window_name TEXT,
              state TEXT NOT NULL,
              snoozed_until TEXT,
              completion_payload_json TEXT,
              derived_target_json TEXT,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_life_task_occurrences_unique
              ON life_task_occurrences(agent_id, definition_id, occurrence_key);
            CREATE TABLE IF NOT EXISTS life_audit_events (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              event_type TEXT NOT NULL,
              owner_type TEXT NOT NULL,
              owner_id TEXT NOT NULL,
              reason TEXT NOT NULL DEFAULT '',
              inputs_json TEXT NOT NULL DEFAULT '{}',
              decision_json TEXT NOT NULL DEFAULT '{}',
              actor TEXT NOT NULL DEFAULT 'agent',
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS life_activity_signals (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              source TEXT NOT NULL,
              platform TEXT NOT NULL DEFAULT '',
              state TEXT NOT NULL,
              observed_at TEXT NOT NULL,
              idle_state TEXT,
              idle_time_seconds INTEGER,
              on_battery BOOLEAN,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL
            );
          `,
        },
      ],
    });
  };
  runtime.runPluginMigrations = async () => {
    await runtime.adapter.runPluginMigrations?.();
  };
  return runtime;
}

function makeOccurrence(args: {
  agentId: string;
  definitionId: string;
  dueAt: string;
  state: LifeOpsOccurrence["state"];
  updatedAt?: string;
  completionPayload?: LifeOpsOccurrence["completionPayload"];
}): LifeOpsOccurrence {
  const updatedAt = args.updatedAt ?? args.dueAt;
  return {
    id: crypto.randomUUID(),
    agentId: args.agentId,
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: args.agentId,
    visibilityScope: "owner_agent_admin",
    contextPolicy: "explicit_only",
    definitionId: args.definitionId,
    occurrenceKey: `occ-${args.definitionId}-${args.dueAt}`,
    scheduledAt: args.dueAt,
    dueAt: args.dueAt,
    relevanceStartAt: args.dueAt,
    relevanceEndAt: new Date(
      new Date(args.dueAt).getTime() + 60 * 60 * 1000,
    ).toISOString(),
    windowName: null,
    state: args.state,
    snoozedUntil: null,
    completionPayload: args.completionPayload ?? null,
    derivedTarget: null,
    metadata: {},
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("goal experience loop and weekly review", () => {
  beforeEach(() => {});

  it("buildGoalExperienceLoop surfaces a similar completed goal and carry-forward support", async () => {
    const runtime = createRuntime("goal-experience-loop-agent");
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const service = new LifeOpsService(runtime);
    const goal = createLifeOpsGoalDefinition({
      agentId: String(runtime.agentId),
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: String(runtime.agentId),
      visibilityScope: "owner_agent_admin",
      contextPolicy: "explicit_only",
      title: "Lose 5 lbs by March",
      description: "Completed cut before spring.",
      cadence: null,
      supportStrategy: {},
      successCriteria: {
        scaleTrend: "down",
      },
      status: "satisfied",
      reviewState: "on_track",
      metadata: {},
    });
    await repository.createGoal(goal);

    const definition = createLifeOpsTaskDefinition({
      agentId: String(runtime.agentId),
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: String(runtime.agentId),
      visibilityScope: "owner_agent_admin",
      contextPolicy: "explicit_only",
      kind: "habit",
      title: "Weekly weigh-in",
      description: "Check the scale every Sunday morning.",
      originalIntent: "Weekly weigh-in",
      timezone: "UTC",
      status: "active",
      priority: 3,
      cadence: {
        kind: "once",
        dueAt: "2026-04-18T09:00:00.000Z",
        visibilityLeadMinutes: 120,
        visibilityLagMinutes: 720,
      },
      windowPolicy: {},
      progressionRule: {},
      websiteAccess: null,
      reminderPlanId: null,
      goalId: goal.id,
      source: "seed",
      metadata: {},
    });
    await repository.createDefinition(definition);
    await repository.upsertOccurrence(
      makeOccurrence({
        agentId: String(runtime.agentId),
        definitionId: definition.id,
        dueAt: "2026-04-18T09:00:00.000Z",
        updatedAt: "2026-04-18T09:15:00.000Z",
        state: "completed",
        completionPayload: {
          completedAt: "2026-04-18T09:15:00.000Z",
          note: "Seeded completion",
          metadata: {},
          previousState: "visible",
        },
      }),
    );

    const experienceLoop = await service.buildGoalExperienceLoop(
      {
        title: "Lose another 5 lbs this quarter",
        description: "Run the next cut cleanly.",
        successCriteria: {
          scaleTrend: "down",
        },
      },
      new Date("2026-04-20T10:00:00.000Z"),
    );

    expect(experienceLoop.similarGoals[0]?.title).toBe("Lose 5 lbs by March");
    expect(experienceLoop.suggestedCarryForward[0]?.title).toBe(
      "Weekly weigh-in",
    );
    expect(experienceLoop.summary).toContain("Lose 5 lbs by March");
  });

  it("reviewGoalsForWeek returns typed on-track and at-risk buckets", async () => {
    const runtime = createRuntime("goal-weekly-review-agent");
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const service = new LifeOpsService(runtime);

    const onTrackGoal = createLifeOpsGoalDefinition({
      agentId: String(runtime.agentId),
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: String(runtime.agentId),
      visibilityScope: "owner_agent_admin",
      contextPolicy: "explicit_only",
      title: "Ship the investor memo",
      description: "Finish the memo this week.",
      cadence: null,
      supportStrategy: {},
      successCriteria: {
        memoSent: true,
      },
      status: "active",
      reviewState: "idle",
      metadata: {},
    });
    await repository.createGoal(onTrackGoal);

    const atRiskGoal = createLifeOpsGoalDefinition({
      agentId: String(runtime.agentId),
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: String(runtime.agentId),
      visibilityScope: "owner_agent_admin",
      contextPolicy: "explicit_only",
      title: "Get back into running shape",
      description: "Restart base mileage this month.",
      cadence: null,
      supportStrategy: {},
      successCriteria: {
        sessionsPerWeek: 3,
      },
      status: "active",
      reviewState: "idle",
      metadata: {},
    });
    await repository.createGoal(atRiskGoal);

    const onTrackDefinition = createLifeOpsTaskDefinition({
      agentId: String(runtime.agentId),
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: String(runtime.agentId),
      visibilityScope: "owner_agent_admin",
      contextPolicy: "explicit_only",
      kind: "task",
      title: "Draft the memo outline",
      description: "First pass at the memo.",
      originalIntent: "Draft the memo outline",
      timezone: "UTC",
      status: "active",
      priority: 3,
      cadence: {
        kind: "once",
        dueAt: "2026-04-20T16:00:00.000Z",
        visibilityLeadMinutes: 120,
        visibilityLagMinutes: 720,
      },
      windowPolicy: {},
      progressionRule: {},
      websiteAccess: null,
      reminderPlanId: null,
      goalId: onTrackGoal.id,
      source: "seed",
      metadata: {},
    });
    await repository.createDefinition(onTrackDefinition);
    await repository.upsertOccurrence(
      makeOccurrence({
        agentId: String(runtime.agentId),
        definitionId: onTrackDefinition.id,
        dueAt: "2026-04-20T16:00:00.000Z",
        updatedAt: "2026-04-20T09:30:00.000Z",
        state: "completed",
        completionPayload: {
          completedAt: "2026-04-20T09:30:00.000Z",
          note: "Finished memo outline",
          metadata: {},
          previousState: "visible",
        },
      }),
    );

    const atRiskDefinition = createLifeOpsTaskDefinition({
      agentId: String(runtime.agentId),
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: String(runtime.agentId),
      visibilityScope: "owner_agent_admin",
      contextPolicy: "explicit_only",
      kind: "habit",
      title: "Easy run",
      description: "Base mileage support habit.",
      originalIntent: "Easy run",
      timezone: "UTC",
      status: "active",
      priority: 3,
      cadence: {
        kind: "once",
        dueAt: "2026-04-19T08:00:00.000Z",
        visibilityLeadMinutes: 120,
        visibilityLagMinutes: 720,
      },
      windowPolicy: {},
      progressionRule: {},
      websiteAccess: null,
      reminderPlanId: null,
      goalId: atRiskGoal.id,
      source: "seed",
      metadata: {},
    });
    await repository.createDefinition(atRiskDefinition);
    await repository.upsertOccurrence(
      makeOccurrence({
        agentId: String(runtime.agentId),
        definitionId: atRiskDefinition.id,
        dueAt: "2026-04-19T08:00:00.000Z",
        updatedAt: "2026-04-19T08:00:00.000Z",
        state: "visible",
      }),
    );

    const weeklyReview = await service.reviewGoalsForWeek(
      new Date("2026-04-20T10:00:00.000Z"),
    );

    expect(weeklyReview.reviewWindow).toBe("this_week");
    expect(weeklyReview.summary.totalGoals).toBe(2);
    expect(weeklyReview.summary.onTrackCount).toBe(1);
    expect(weeklyReview.summary.atRiskCount).toBe(1);
    expect(weeklyReview.onTrack[0]?.goal.title).toBe("Ship the investor memo");
    expect(weeklyReview.atRisk[0]?.goal.title).toBe(
      "Get back into running shape",
    );
  });
});
