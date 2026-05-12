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

async function seedCompletedWeightLossGoal(ctx: {
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
    title: "Lose 5 lbs by March",
    description: "Completed cut before spring.",
    supportStrategy: {},
    successCriteria: {
      scaleTrend: "down",
    },
    status: "satisfied",
  });

  const definition = await service.createDefinition({
    kind: "habit",
    title: "Weekly weigh-in",
    description: "Check the scale every Sunday morning.",
    cadence: {
      kind: "once",
      dueAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
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
    note: "Completed during the prior successful cut.",
  });
  return undefined;
}

export default scenario({
  id: "goal.experience-loop.learn-from-completion",
  title: "New goal previews lessons from a similar completed goal",
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
      title: "LifeOps Experience Loop",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-completed-weight-loss-goal",
      apply: seedCompletedWeightLossGoal,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "new-similar-goal",
      text: "I want a new goal to lose another 5 lbs this quarter.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["Lose 5 lbs by March", "Weekly weigh-in"],
    },
    {
      kind: "message",
      name: "confirm-goal",
      text: "Yes, save it.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["Saved goal", "lose another 5 lbs"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "experience-loop-preview-is-typed",
      predicate: async (ctx) => {
        const previewAction = ctx.turns?.[0]?.actionsCalled?.find(
          (entry) => entry.actionName === "LIFE",
        );
        const data =
          previewAction?.result?.data &&
          typeof previewAction.result.data === "object"
            ? (previewAction.result.data as {
                deferred?: boolean;
                experienceLoop?: {
                  similarGoals?: Array<{ title?: string }>;
                  suggestedCarryForward?: Array<{ title?: string }>;
                  summary?: string | null;
                };
              })
            : null;
        if (!data?.deferred) {
          return "expected the first turn to stay on the real deferred goal-create path";
        }
        if (!data.experienceLoop?.summary) {
          return "expected a typed experienceLoop summary on the goal preview";
        }
        if (
          data.experienceLoop.similarGoals?.[0]?.title !== "Lose 5 lbs by March"
        ) {
          return `expected the similar completed goal to be Lose 5 lbs by March, got ${data.experienceLoop.similarGoals?.[0]?.title ?? "(missing)"}`;
        }
        if (
          data.experienceLoop.suggestedCarryForward?.[0]?.title !==
          "Weekly weigh-in"
        ) {
          return `expected Weekly weigh-in as the carry-forward suggestion, got ${data.experienceLoop.suggestedCarryForward?.[0]?.title ?? "(missing)"}`;
        }
        return undefined;
      },
    },
    {
      type: "custom",
      name: "experience-loop-persists-through-save",
      predicate: async (ctx) => {
        const saveAction = ctx.turns?.[1]?.actionsCalled?.find(
          (entry) => entry.actionName === "LIFE",
        );
        const data =
          saveAction?.result?.data && typeof saveAction.result.data === "object"
            ? (saveAction.result.data as {
                goal?: { title?: string };
                experienceLoop?: {
                  similarGoals?: Array<{ title?: string }>;
                };
              })
            : null;
        if (data?.goal?.title !== "lose another 5 lbs this quarter") {
          return `expected the new goal title to be saved, got ${data?.goal?.title ?? "(missing)"}`;
        }
        if (
          data.experienceLoop?.similarGoals?.[0]?.title !==
          "Lose 5 lbs by March"
        ) {
          return `expected the saved goal payload to keep the experience loop reference, got ${data.experienceLoop?.similarGoals?.[0]?.title ?? "(missing)"}`;
        }
        return undefined;
      },
    },
  ],
});
