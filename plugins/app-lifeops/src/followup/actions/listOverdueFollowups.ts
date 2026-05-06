import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type { Action, ActionExample, IAgentRuntime } from "@elizaos/core";
import {
  computeOverdueFollowups,
  FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
} from "../followup-tracker.js";

interface ListOverdueFollowupsParams {
  thresholdDays?: unknown;
  limit?: unknown;
}

function coercePositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

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
  handler: async (runtime: IAgentRuntime, _message, _state, options) => {
    const params = (options?.parameters ?? {}) as ListOverdueFollowupsParams;
    const thresholdDays =
      coercePositiveNumber(params.thresholdDays) ??
      FOLLOWUP_DEFAULT_THRESHOLD_DAYS;
    const limit = coercePositiveNumber(params.limit);
    const digest = await computeOverdueFollowups(
      runtime,
      Date.now(),
      thresholdDays,
    );
    const overdue = limit
      ? digest.overdue.slice(0, Math.floor(limit))
      : digest.overdue;
    if (overdue.length === 0) {
      return {
        success: true,
        text: "No overdue follow-ups.",
        data: { digest },
      };
    }
    const lines = overdue.map(
      (entry) =>
        `${entry.displayName}: last contacted ${entry.lastContactedAt} (+${entry.daysOverdue}d over ${entry.thresholdDays}d threshold)`,
    );
    return {
      success: true,
      text: lines.join("\n"),
      data: { digest: { ...digest, overdue } },
    };
  },
  parameters: [
    {
      name: "thresholdDays",
      description:
        "Override the default overdue threshold in days for this query.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "limit",
      description: "Maximum number of overdue contacts to return.",
      required: false,
      schema: { type: "number" as const },
    },
  ],
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
