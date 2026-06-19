import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { Team } from "@linear/sdk";
import type { LinearService } from "../services/linear";

const MAX_LINEAR_TEAMS = 20;
const MAX_DESCRIPTION_CHARS = 180;

export const linearTeamsProvider: Provider = {
  name: "LINEAR_TEAMS",
  description: "Provides context about Linear teams",
  descriptionCompressed: "provide context Linear team",
  dynamic: true,
  contexts: ["automation", "connectors"],
  contextGate: { anyOf: ["automation", "connectors"] },
  cacheScope: "agent",
  roleGate: { minRole: "ADMIN" },
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        return {
          text: "Linear service is not available",
        };
      }

      const teams = await linearService.getTeams();
      const listedTeams = teams.slice(0, MAX_LINEAR_TEAMS);

      if (teams.length === 0) {
        return {
          text: "No Linear teams found",
        };
      }

      const teamsList = listedTeams.map(
        (team: Team) =>
          `- ${team.name} (${team.key}): ${(team.description || "No description").slice(0, MAX_DESCRIPTION_CHARS)}`
      );

      const text = `Linear Teams:\n${teamsList.join("\n")}`;

      return {
        text,
        data: {
          teams: listedTeams.map((team: Team) => ({
            id: team.id,
            name: team.name,
            key: team.key,
          })),
          truncated: teams.length > listedTeams.length,
        },
      };
    } catch (_error) {
      return {
        text: "Error retrieving Linear teams",
      };
    }
  },
};
