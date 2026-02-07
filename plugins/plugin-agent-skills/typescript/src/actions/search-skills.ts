/**
 * Search Skills Action
 *
 * Search the skill registry for available skills.
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  ActionResult,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";

export const searchSkillsAction: Action = {
  name: "SEARCH_SKILLS",
  similes: ["BROWSE_SKILLS", "LIST_SKILLS", "FIND_SKILLS"],
  description:
    "Search the skill registry for available skills by keyword or category.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService<AgentSkillsService>(
      "AGENT_SKILLS_SERVICE",
    );
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService<AgentSkillsService>(
        "AGENT_SKILLS_SERVICE",
      );
      if (!service) {
        throw new Error("AgentSkillsService not available");
      }

      const query = message.content?.text || "";
      const results = await service.search(query, 10);

      if (results.length === 0) {
        const text = `No skills found matching "${query}".`;
        if (callback) await callback({ text });
        return { success: true, text, data: { results: [] } };
      }

      const skillList = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.displayName}** (\`${r.slug}\`)\n   ${r.summary}`,
        )
        .join("\n\n");

      const text = `## Skills matching "${query}"

${skillList}

Use GET_SKILL_GUIDANCE with a skill name to get detailed instructions.`;

      if (callback) await callback({ text });

      return {
        success: true,
        text,
        data: { results },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({ text: `Error searching skills: ${errorMsg}` });
      }
      return {
        success: false,
        error: error instanceof Error ? error : new Error(errorMsg),
      };
    }
  },

  examples: [
    [
      {
        name: "{{userName}}",
        content: { text: "Search for skills about data analysis" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: '## Skills matching "data analysis"\n\n1. **Data Analysis** (`data-analysis`)\n   Analyze datasets and generate insights...',
          actions: ["SEARCH_SKILLS"],
        },
      },
    ],
  ],
};

export default searchSkillsAction;
