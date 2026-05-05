import type { IAgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { LifeOpsService } from "../../../plugins/app-lifeops/src/lifeops/service.ts";

function scenarioNow(ctx: { now?: string | Date }): Date {
  return typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
    ? new Date(ctx.now)
    : ctx.now instanceof Date
      ? ctx.now
      : new Date();
}

async function seedWeeklyGoalReview(ctx: {
  runtime?: unknown;
  now?: string | Date;
}): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime) {
    return "scenario runtime unavailable";
  }

  await LifeOpsRepository.bootstrapSchema(runtime);
  const service = new LifeOpsService(runtime);
  const now = scenarioNow(ctx);

  const onTrackGoal = await service.createGoal({
    title: "Ship the investor memo",
    description: "Finish the memo this week.",
    supportStrategy: {},
    successCriteria: {
      memoSent: true,
    },
    status: "active",
  });

  const onTrackDefinition = await service.createDefinition({
    kind: "task",
    title: "Draft the memo outline",
    description: "First pass at the memo.",
    cadence: {
      kind: "once",
      dueAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      visibilityLeadMinutes: 120,
      visibilityLagMinutes: 720,
    },
    goalId: onTrackGoal.goal.id,
    source: "seed",
    metadata: {},
  });

  const atRiskGoal = await service.createGoal({
    title: "Get back into running shape",
    description: "Restart base mileage this month.",
    supportStrategy: {},
    successCriteria: {
      sessionsPerWeek: 3,
    },
    status: "active",
  });

  const atRiskDefinition = await service.createDefinition({
    kind: "habit",
    title: "Easy run",
    description: "Base mileage support habit.",
    cadence: {
      kind: "once",
      dueAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      visibilityLeadMinutes: 120,
      visibilityLagMinutes: 720,
    },
    goalId: atRiskGoal.goal.id,
    source: "seed",
    metadata: {},
  });

  const overview = await service.getOverview(now);
  const onTrackOccurrence = overview.owner.occurrences.find(
    (item) => item.definitionId === onTrackDefinition.definition.id,
  );
  if (!onTrackOccurrence) {
    return "seeded on-track occurrence not found";
  }
  await service.completeOccurrence(onTrackOccurrence.id, {
    note: "Completed current memo work.",
  });

  const refreshedOverview = await service.getOverview(now);
  const atRiskOccurrence = refreshedOverview.owner.occurrences.find(
    (item) => item.definitionId === atRiskDefinition.definition.id,
  );
  if (!atRiskOccurrence) {
    return "seeded at-risk occurrence not found";
  }

  return atRiskOccurrence.state === "visible" ||
    atRiskOccurrence.state === "snoozed"
    ? undefined
    : "expected at-risk occurrence to remain active and overdue";
}

export default scenario({
  id: "goal.experience-loop.weekly-review",
  title: "Weekly goal review returns drifting versus on-track goals",
  domain: "goals",
  tags: ["lifeops", "goals", "experience-loop", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Weekly Review",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-weekly-goal-review",
      apply: seedWeeklyGoalReview,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weekly-review",
      text: "Give me my weekly goal review and call out which goals are drifting versus on track.",
      expectedActions: ["LIFE"],
      responseIncludesAny: [
        "weekly goal review",
        "Ship the investor memo",
        "Get back into running shape",
      ],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "LIFE",
    },
    {
      type: "custom",
      name: "weekly-review-returns-typed-goal-buckets",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "LIFE",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                reviewWindow?: string;
                summary?: {
                  totalGoals?: number;
                  onTrackCount?: number;
                  atRiskCount?: number;
                  needsAttentionCount?: number;
                };
                onTrack?: Array<{ goal?: { title?: string } }>;
                atRisk?: Array<{ goal?: { title?: string } }>;
              })
            : null;
        if (!data?.summary) {
          return "expected structured weekly goal review data";
        }
        if (data.reviewWindow !== "this_week") {
          return `expected this_week review window, got ${data.reviewWindow ?? "(missing)"}`;
        }
        if (data.summary.totalGoals !== 2) {
          return `expected 2 active goals, got ${data.summary.totalGoals ?? "(missing)"}`;
        }
        if (data.summary.onTrackCount !== 1) {
          return `expected 1 on-track goal, got ${data.summary.onTrackCount ?? "(missing)"}`;
        }
        if (data.summary.atRiskCount !== 1) {
          return `expected 1 at-risk goal, got ${data.summary.atRiskCount ?? "(missing)"}`;
        }
        if (data.onTrack?.[0]?.goal?.title !== "Ship the investor memo") {
          return `expected Ship the investor memo in the onTrack bucket, got ${data.onTrack?.[0]?.goal?.title ?? "(missing)"}`;
        }
        if (data.atRisk?.[0]?.goal?.title !== "Get back into running shape") {
          return `expected Get back into running shape in the atRisk bucket, got ${data.atRisk?.[0]?.goal?.title ?? "(missing)"}`;
        }
        return undefined;
      },
    },
  ],
});
