import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
} from "@elizaos/core";
import { BlockRuleWriter } from "../block-rule-service.js";

interface ReleaseBlockParams {
  ruleId?: unknown;
  confirmed?: unknown;
  reason?: unknown;
}

function coerceString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  if (typeof value === "number") return value !== 0;
  return false;
}

export const releaseBlockAction: Action = {
  name: "RELEASE_BLOCK",
  similes: [
    "RELEASE_WEBSITE_BLOCK",
    "END_BLOCK_RULE",
    "BYPASS_BLOCK_RULE",
  ],
  description:
    "Release an active website block rule. Requires confirmed:true. " +
    "harsh_no_bypass rules cannot be released via confirmation — they must wait for gate fulfillment.",
  descriptionCompressed:
    "Release a website block rule; requires confirmation.",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    options?: HandlerOptions,
  ): Promise<ActionResult> => {
    const params = (options?.parameters ?? {}) as ReleaseBlockParams;
    const ruleId = coerceString(params.ruleId);
    if (!ruleId) {
      return {
        success: false,
        text: "RELEASE_BLOCK requires a ruleId.",
      };
    }
    if (!coerceBoolean(params.confirmed)) {
      return {
        success: false,
        text: "RELEASE_BLOCK requires confirmed:true to release the rule.",
      };
    }
    const reason = coerceString(params.reason) ?? "user_confirmed";
    const writer = new BlockRuleWriter(runtime);
    try {
      await writer.releaseBlockRule(ruleId, { confirmed: true, reason });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        text: `Failed to release block rule ${ruleId}: ${message}`,
      };
    }
    return {
      success: true,
      text: `Released block rule ${ruleId}.`,
      data: { ruleId, reason },
    };
  },
  parameters: [
    {
      name: "ruleId",
      description: "ID of the block rule to release.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description: "Must be true to release. Prevents accidental unblocking.",
      required: true,
      schema: { type: "boolean" as const },
    },
    {
      name: "reason",
      description: "Optional reason for release, stored on the rule.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Release the block rule I just created." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Released block rule <id>.",
          action: "RELEASE_BLOCK",
        },
      },
    ],
  ] as ActionExample[][],
};
