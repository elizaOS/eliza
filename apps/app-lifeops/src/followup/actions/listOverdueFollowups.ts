import type {
  Action,
  ActionExample,
  IAgentRuntime,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import {
  FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
  computeOverdueFollowups,
} from "../followup-tracker.js";

export const listOverdueFollowupsAction: Action = {
  name: "LIST_OVERDUE_FOLLOWUPS",
  similes: [
    "OVERDUE_FOLLOWUPS",
    "WHO_TO_FOLLOW_UP",
    "WHO_HAVEN_T_I_TALKED_TO",
    "LIST_FOLLOWUPS",
    "FOLLOWUP_LIST",
  ],
  description:
    "List contacts whose last-contacted-at timestamp exceeds their follow-up threshold. " +
    "Use this for overdue or pending follow-up list queries, not for scheduling a new reminder. " +
    "Returns an empty list when the RelationshipsService is not available.",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime: IAgentRuntime) => {
    const digest = await computeOverdueFollowups(
      runtime,
      Date.now(),
      FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
    );
    if (digest.overdue.length === 0) {
      return {
        success: true,
        text: "No overdue follow-ups.",
        data: { digest },
      };
    }
    const lines = digest.overdue.map(
      (entry) =>
        `${entry.displayName}: last contacted ${entry.lastContactedAt} (+${entry.daysOverdue}d over ${entry.thresholdDays}d threshold)`,
    );
    return {
      success: true,
      text: lines.join("\n"),
      data: { digest },
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Who should I follow up with?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Carol Patel: last contacted ... (+30d over 30d threshold)",
          action: "LIST_OVERDUE_FOLLOWUPS",
        },
      },
    ],
  ] as ActionExample[][],
};
