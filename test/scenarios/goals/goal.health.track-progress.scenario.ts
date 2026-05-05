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

async function seedHealthGoalProgress(ctx: {
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

  const goal = await service.createGoal({
    title: "Weight loss goal",
    description: "Lose 10 lbs by June.",
    supportStrategy: {},
    successCriteria: {
      weeklyWeighIns: true,
    },
    status: "active",
  });

  const definition = await service.createDefinition({
    kind: "habit",
    title: "Weekly weigh-in",
    description: "Track a weekly weigh-in to support the goal.",
    cadence: {
      kind: "once",
      dueAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      visibilityLeadMinutes: 120,
      visibilityLagMinutes: 720,
    },
    goalId: goal.goal.id,
    source: "seed",
    metadata: {},
  });

  const overview = await service.getOverview(now);
  const occurrence = overview.owner.occurrences.find(
    (item) => item.definitionId === definition.definition.id,
  );
  if (!occurrence) {
    return "seeded occurrence not found";
  }

  await service.completeOccurrence(occurrence.id, {
    note: "Seeded progress for the scenario",
  });
  return undefined;
}

export default scenario({
  id: "goal.health.track-progress",
  title: "Health goal review returns a structured progress summary",
  domain: "goals",
  tags: ["lifeops", "goals", "health", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Health Goal Progress",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-weight-loss-goal-progress",
      apply: seedHealthGoalProgress,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "progress-query",
      text: "Review my Weight loss goal.",
      expectedActions: ["LIFE"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "health-goal-review-structured",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "LIFE",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                summary?: {
                  reviewState?: string;
                  linkedDefinitionCount?: number;
                  completedLast7Days?: number;
                  activeOccurrenceCount?: number;
                };
                linkedDefinitions?: Array<{ title?: string }>;
                recentCompletions?: Array<{ title?: string }>;
              })
            : null;
        if (!data?.summary) {
          return "expected structured goal review data";
        }
        if (data.summary.reviewState !== "on_track") {
          return `expected on_track review state, got ${data.summary.reviewState ?? "(missing)"}`;
        }
        if (data.summary.linkedDefinitionCount !== 1) {
          return `expected one linked definition, got ${data.summary.linkedDefinitionCount ?? "(missing)"}`;
        }
        if ((data.summary.completedLast7Days ?? 0) < 1) {
          return `expected at least one recent completion, got ${data.summary.completedLast7Days ?? "(missing)"}`;
        }
        if ((data.summary.activeOccurrenceCount ?? 0) !== 0) {
          return `expected no active occurrences, got ${data.summary.activeOccurrenceCount}`;
        }
        if (data.linkedDefinitions?.[0]?.title !== "Weekly weigh-in") {
          return `expected linked definition title Weekly weigh-in, got ${data.linkedDefinitions?.[0]?.title ?? "(missing)"}`;
        }
        if (data.recentCompletions?.[0]?.title !== "Weekly weigh-in") {
          return `expected recent completion for Weekly weigh-in, got ${data.recentCompletions?.[0]?.title ?? "(missing)"}`;
        }
        return undefined;
      },
    },
  ],
});
