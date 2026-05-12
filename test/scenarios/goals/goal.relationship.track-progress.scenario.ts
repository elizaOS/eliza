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

async function seedRelationshipProgress(ctx: {
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
  const lastContactedAt = new Date(
    now.getTime() - 100 * 24 * 60 * 60 * 1000,
  ).toISOString();

  await service.upsertRelationship({
    name: "Alice Chen",
    primaryChannel: "email",
    primaryHandle: "alice@example.com",
    email: "alice@example.com",
    phone: null,
    notes: "Family relationship progress check.",
    tags: [],
    relationshipType: "contact",
    lastContactedAt,
    metadata: {
      followupThresholdDays: 90,
    },
  });

  return undefined;
}

export default scenario({
  id: "goal.relationship.track-progress",
  title: "Relationship progress returns a structured days-since result",
  domain: "goals",
  tags: ["lifeops", "goals", "relationships", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Relationship Goal Progress",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-family-relationship-progress",
      apply: seedRelationshipProgress,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "progress-query",
      text: "How many days since I talked to Alice Chen?",
      expectedActions: ["RELATIONSHIP"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "relationship-progress-structured",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "RELATIONSHIP",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                subaction?: string;
                relationshipId?: string;
                days?: number | null;
              })
            : null;
        if (!data) {
          return "expected structured relationship result data";
        }
        if (data.subaction !== "days_since") {
          return `expected days_since subaction, got ${data.subaction ?? "(missing)"}`;
        }
        if (typeof data.days !== "number" || data.days < 100) {
          return `expected at least 100 days since contact, got ${data.days ?? "(missing)"}`;
        }
        if (!data.relationshipId) {
          return "expected relationshipId in structured result";
        }
        return undefined;
      },
    },
  ],
});
