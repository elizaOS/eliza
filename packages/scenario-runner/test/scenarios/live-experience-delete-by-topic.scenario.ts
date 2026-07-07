/**
 * Live-model proof for the Character Experience mutation twin: the user asks
 * to delete a seeded experience by topic, not by id, and the model must route
 * through EXPERIENCE with a query selector and confirmation.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import type { ExperienceService } from "../../../core/src/features/advanced-capabilities/experience/service";
import {
  ExperienceType,
  OutcomeType,
} from "../../../core/src/features/advanced-capabilities/experience/types";
import type { UUID } from "../../../core/src/types/primitives";

const EXPERIENCE_TOPIC = "docker buildkit cache eviction";
let seededExperienceId: UUID | null = null;

function getExperienceService(ctx: ScenarioContext): ExperienceService | null {
  const service = ctx.runtime.getService("EXPERIENCE");
  return service && typeof service === "object"
    ? (service as ExperienceService)
    : null;
}

export default scenario({
  id: "live-experience-delete-by-topic",
  lane: "live-only",
  title: "Character Experience delete by natural-language topic",
  domain: "experience",
  tags: ["live", "experience", "views-chat-integration", "mvp"],
  isolation: "per-scenario",
  seed: [
    {
      type: "custom",
      name: "seed one uniquely identifiable experience",
      apply: async (ctx) => {
        const service = getExperienceService(ctx);
        if (!service) return "EXPERIENCE service was not available";
        const experience = await service.recordExperience({
          agentId: ctx.runtime.agentId as UUID,
          type: ExperienceType.LEARNING,
          outcome: OutcomeType.NEUTRAL,
          context:
            "While reviewing a Docker build failure, the agent diagnosed a cache eviction issue.",
          action: "Enabled BuildKit cache mounts and pruned stale layers.",
          result: "The image build stabilized.",
          learning: `Docker builds with ${EXPERIENCE_TOPIC} should use scoped BuildKit cache mounts.`,
          tags: ["docker", "buildkit", "cache"],
          domain: "coding",
          confidence: 0.82,
          importance: 0.7,
        });
        seededExperienceId = experience.id;
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "chat",
      title: "Experience Delete",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "delete seeded experience by topic",
      text: `Delete the experience about ${EXPERIENCE_TOPIC}; yes, confirm deleting it.`,
      assertTurn: (execution) => {
        const action = execution.actionsCalled.find(
          (candidate) => candidate.actionName === "EXPERIENCE",
        );
        if (!action) {
          return `expected EXPERIENCE action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
        }
        if (action.result?.success !== true) {
          return `expected EXPERIENCE success=true, saw ${JSON.stringify(action.result)}`;
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "EXPERIENCE",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: "EXPERIENCE",
      includesAll: [/delete/i, /docker buildkit cache eviction/i, /confirm/i],
    },
    {
      type: "custom",
      name: "seeded experience was removed",
      predicate: async (ctx) => {
        const service = getExperienceService(ctx);
        if (!service) return "EXPERIENCE service was not available";
        if (!seededExperienceId) return "seeded experience id was not recorded";
        const remaining = await service.getExperience(seededExperienceId);
        return remaining
          ? `expected ${seededExperienceId} to be deleted, but it still exists`
          : undefined;
      },
    },
  ],
});
