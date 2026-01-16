import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  type UUID,
} from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import { createGoalDataService } from "../services/goalDataService.js";

const spec = requireProviderSpec("goals");

export const goalsProvider: Provider = {
  name: spec.name,
  description: "Provides information about active goals and recent achievements",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const dataService = createGoalDataService(runtime);
      let ownerType: "agent" | "entity" = "agent";
      let ownerId: UUID = runtime.agentId;

      if (message?.entityId && message.entityId !== runtime.agentId) {
        ownerType = "entity";
        ownerId = message.entityId;
      }

      const activeGoals = await dataService.getGoals({
        ownerType,
        ownerId,
        isCompleted: false,
      });

      const completedGoals = await dataService.getGoals({
        ownerType,
        ownerId,
        isCompleted: true,
      });

      const recentCompleted = completedGoals
        .sort((a, b) => (b.completedAt?.getTime() || 0) - (a.completedAt?.getTime() || 0))
        .slice(0, 5);

      let output = "";

      if (activeGoals.length > 0) {
        output += "## Active Goals\n";
        activeGoals.forEach((goal) => {
          const tags = goal.tags && goal.tags.length > 0 ? ` [${goal.tags.join(", ")}]` : "";
          output += `- ${goal.name}${tags}`;
          if (goal.description) {
            output += ` - ${goal.description}`;
          }
          output += "\n";
        });
        output += "\n";
      }

      if (recentCompleted.length > 0) {
        output += "## Recently Completed Goals\n";
        recentCompleted.forEach((goal) => {
          const completedDate = goal.completedAt
            ? new Date(goal.completedAt).toLocaleDateString()
            : "Unknown date";
          output += `- ${goal.name} (completed ${completedDate})\n`;
        });
        output += "\n";
      }

      const totalActive = activeGoals.length;
      const totalCompleted = completedGoals.length;

      output += `## Summary\n`;
      output += `- Active goals: ${totalActive}\n`;
      output += `- Completed goals: ${totalCompleted}\n`;

      if (activeGoals.length === 0 && completedGoals.length === 0) {
        output = "No goals have been set yet. Consider creating some goals to track progress!";
      }

      return {
        text: output.trim(),
        data: {
          activeGoalCount: totalActive,
          completedGoalCount: totalCompleted,
        },
        values: {
          activeGoalCount: totalActive.toString(),
          completedGoalCount: totalCompleted.toString(),
        },
      };
    } catch (error) {
      logger.error("Error in goals provider:", error);
      return {
        text: "Unable to retrieve goals information at this time.",
        data: {},
        values: {},
      };
    }
  },
};

export default goalsProvider;
