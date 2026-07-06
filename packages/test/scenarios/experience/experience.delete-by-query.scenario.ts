/** Live scenario for deleting an experience by natural language without a raw selector. */
import {
  type ExperienceService,
  ExperienceServiceType,
  ExperienceType,
  type IAgentRuntime,
  OutcomeType,
  type UUID,
} from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

let seededExperienceId: UUID | undefined;

function getExperienceService(
  runtime: IAgentRuntime,
): ExperienceService | undefined {
  return runtime.getService(ExperienceServiceType.EXPERIENCE) as
    | ExperienceService
    | undefined;
}

async function seedDeleteTarget(ctx: {
  runtime?: unknown;
}): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime) return "scenario runtime unavailable";
  const service = getExperienceService(runtime);
  if (!service) return "EXPERIENCE service unavailable";

  const experience = await service.recordExperience({
    type: ExperienceType.LEARNING,
    outcome: OutcomeType.NEUTRAL,
    context: "The agent answered onboarding help with outdated launcher copy.",
    action: "Suggested opening a stale Tutorial launcher tile.",
    result: "The user corrected that tutorial guidance must be chat-native.",
    learning:
      "Do not tell users to open a Tutorial launcher tile; use chat-native tutorial cards instead.",
    domain: "onboarding",
    tags: ["onboarding", "tutorial", "chat-native"],
    confidence: 0.92,
    importance: 0.83,
  });
  seededExperienceId = experience.id;
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "experience.delete-by-query",
  title: "Experience action deletes a uniquely matched experience by topic",
  domain: "experience",
  tags: ["experience", "views-chat-integration", "mvp"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Experience Action",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-delete-target-experience",
      apply: seedDeleteTarget,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "delete-experience-by-topic",
      text: "Delete the experience about stale Tutorial launcher tile guidance. Yes, confirm deleting that experience.",
      expectedActions: ["EXPERIENCE"],
      responseIncludesAny: ["Deleted experience", "deleted the experience"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "seeded-experience-was-deleted",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as IAgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        const service = getExperienceService(runtime);
        if (!service) return "EXPERIENCE service unavailable";
        if (!seededExperienceId) return "seeded experience id missing";

        const remaining = await service.getExperience(seededExperienceId);
        if (remaining) {
          return `expected seeded experience ${seededExperienceId} to be deleted`;
        }
        return undefined;
      },
    },
  ],
});
