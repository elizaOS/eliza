import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
} from "@elizaos/core";
import { BlockRuleReader } from "../block-rule-service.js";

export const listActiveBlocksAction: Action = {
  name: "LIST_ACTIVE_BLOCKS",
  similes: ["LIST_BLOCK_RULES", "SHOW_ACTIVE_BLOCKS", "WEBSITE_BLOCKS_STATUS"],
  description:
    "List all currently active website block rules, including their gate type and gate target.",
  descriptionCompressed: "List active website block rules.",
  validate: async () => true,
  handler: async (runtime: IAgentRuntime): Promise<ActionResult> => {
    const reader = new BlockRuleReader(runtime);
    const rules = await reader.listActiveBlocks();
    if (rules.length === 0) {
      return {
        success: true,
        text: "No active website block rules.",
        data: { rules: [] },
      };
    }
    const summaries = rules.map((rule) => {
      const parts = [
        `${rule.id} (${rule.gateType})`,
        `sites=${rule.websites.join(",")}`,
      ];
      if (rule.gateType === "until_todo" && rule.gateTodoId) {
        parts.push(`todo=${rule.gateTodoId}`);
      }
      if (rule.gateType === "until_iso" && rule.gateUntilMs !== null) {
        parts.push(`until=${new Date(rule.gateUntilMs).toISOString()}`);
      }
      if (
        rule.gateType === "fixed_duration" &&
        rule.fixedDurationMs !== null
      ) {
        parts.push(`duration_ms=${rule.fixedDurationMs}`);
      }
      return parts.join(" ");
    });
    return {
      success: true,
      text: `Active block rules:\n${summaries.join("\n")}`,
      data: { rules },
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What website blocks are active right now?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Active block rules: ...",
          action: "LIST_ACTIVE_BLOCKS",
        },
      },
    ],
  ] as ActionExample[][],
};
