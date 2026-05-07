import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import { BlockRuleWriter } from "../block-rule-service.js";

interface ReleaseBlockParams {
  ruleId?: unknown;
  confirmed?: unknown;
  reason?: unknown;
}

const RELEASE_BLOCK_CONTEXTS = ["screen_time", "browser", "tasks", "automation"] as const;
const RELEASE_BLOCK_KEYWORDS = [
  "release",
  "unblock",
  "remove block",
  "disable block",
  "bypass",
  "website block",
  "screen time",
  "liberar",
  "desbloquear",
  "bloqueo",
  "débloquer",
  "blocage",
  "freigeben",
  "entsperren",
  "sbloccare",
  "desbloquear",
  "解除",
  "ブロック",
  "解锁",
  "解除封锁",
  "차단 해제",
] as const;

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

function hasSelectedContext(state: State | undefined): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect((state?.values as Record<string, unknown> | undefined)?.selectedContexts);
  collect((state?.data as Record<string, unknown> | undefined)?.selectedContexts);
  const contextObject = (state?.data as Record<string, unknown> | undefined)?.contextObject as
    | { trajectoryPrefix?: { selectedContexts?: unknown }; metadata?: { selectedContexts?: unknown } }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return RELEASE_BLOCK_CONTEXTS.some((context) => selected.has(context));
}

function hasReleaseBlockIntent(message: Memory, state: State | undefined): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string" ? state.values.recentMessages : "",
  ]
    .join("\n")
    .toLowerCase();
  return RELEASE_BLOCK_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

export const releaseBlockAction: Action = {
  name: "RELEASE_BLOCK",
  similes: ["RELEASE_WEBSITE_BLOCK", "END_BLOCK_RULE", "BYPASS_BLOCK_RULE"],
  description:
    "Release an active website block rule. Requires confirmed:true. " +
    "harsh_no_bypass rules cannot be released via confirmation — they must wait for gate fulfillment.",
  descriptionCompressed: "Release a website block rule; requires confirmation.",
  contexts: [...RELEASE_BLOCK_CONTEXTS],
  contextGate: { anyOf: [...RELEASE_BLOCK_CONTEXTS] },
  roleGate: { minRole: "OWNER" },
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    if (!(await hasOwnerAccess(runtime, message))) return false;
    return hasSelectedContext(state) || hasReleaseBlockIntent(message, state);
  },
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
      const message = error instanceof Error ? error.message : String(error);
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
