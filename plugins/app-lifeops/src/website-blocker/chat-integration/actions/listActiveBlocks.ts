import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
} from "@elizaos/core";
import {
  formatWebsiteList,
  getSelfControlStatus,
} from "../../../website-blocker/engine.js";
import { BlockRuleReader } from "../block-rule-service.js";

const BLOCK_STATUS_INTENT_RE =
  /\b(block|blocking|blocked|unblock|website block|site block|focus block|selfcontrol|self-control|distracting sites?|blocked websites?|blocked sites?|app block)\b/i;

function getMessageText(
  message: { content?: { text?: unknown } } | undefined,
): string {
  return typeof message?.content?.text === "string" ? message.content.text : "";
}

interface ListActiveBlocksParams {
  includeLiveStatus?: unknown;
  includeManagedRules?: unknown;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1", "on"].includes(normalized)) return true;
    if (["false", "no", "0", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function formatLiveWebsiteBlockStatus(
  status: Awaited<ReturnType<typeof getSelfControlStatus>>,
): string {
  if (!status.available) {
    return (
      status.reason ??
      "The live website blocker is unavailable on this machine."
    );
  }

  const permissionNote = status.reason ? ` ${status.reason}` : "";
  if (!status.active) {
    return `No live website block is active right now.${permissionNote}`;
  }

  const websites =
    status.websites.length > 0
      ? formatWebsiteList(status.websites)
      : "an unknown website set";

  return status.endsAt
    ? `A live website block is active for ${websites} until ${status.endsAt}.${permissionNote}`
    : `A live website block is active for ${websites} until you remove it.${permissionNote}`;
}

export const listActiveBlocksAction: Action = {
  name: "LIST_ACTIVE_BLOCKS",
  similes: ["LIST_BLOCK_RULES", "SHOW_ACTIVE_BLOCKS", "WEBSITE_BLOCKS_STATUS"],
  description:
    "List the live website blocker status and any active managed website block rules, including their gate type and gate target. Only use this for website/app blocking status. Do not use it for inbox blockers, message priority, morning briefs, night briefs, operating pictures, end-of-day reviews, or general executive-assistant triage.",
  descriptionCompressed:
    "List live website blocker status and active block rules.",
  contexts: ["screen_time", "browser", "tasks", "automation"],
  roleGate: { minRole: "OWNER" },
  validate: async (_runtime, message) =>
    BLOCK_STATUS_INTENT_RE.test(getMessageText(message)),
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options?.parameters ?? {}) as ListActiveBlocksParams;
    const includeLiveStatus = coerceBoolean(params.includeLiveStatus, true);
    const includeManagedRules = coerceBoolean(params.includeManagedRules, true);
    const reader = new BlockRuleReader(runtime);
    const [rules, liveStatus] = await Promise.all([
      includeManagedRules ? reader.listActiveBlocks() : Promise.resolve([]),
      includeLiveStatus
        ? getSelfControlStatus()
        : Promise.resolve(
            null as Awaited<ReturnType<typeof getSelfControlStatus>> | null,
          ),
    ]);
    const sections = liveStatus
      ? [formatLiveWebsiteBlockStatus(liveStatus)]
      : [];

    if (!includeManagedRules) {
      return {
        success: true,
        text:
          sections.join("\n") ||
          "Managed block rule listing was not requested.",
        data: { rules: [], liveStatus },
      };
    }

    if (rules.length === 0) {
      sections.push("No managed website block rules are active.");
      return {
        success: true,
        text: sections.join("\n"),
        data: { rules: [], liveStatus },
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
      if (rule.gateType === "fixed_duration" && rule.fixedDurationMs !== null) {
        parts.push(`duration_ms=${rule.fixedDurationMs}`);
      }
      return parts.join(" ");
    });
    sections.push(`Managed block rules:\n${summaries.join("\n")}`);

    return {
      success: true,
      text: sections.join("\n"),
      data: { rules, liveStatus },
    };
  },
  parameters: [
    {
      name: "includeLiveStatus",
      description:
        "Whether to include the current hosts-file/SelfControl live block state.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "includeManagedRules",
      description:
        "Whether to include managed LifeOps block rules and gate metadata.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What website blocks are active right now?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "A live website block is active for x.com until 2026-04-04T13:44:54.000Z.\nManaged block rules: ...",
          action: "LIST_ACTIVE_BLOCKS",
        },
      },
    ],
  ] as ActionExample[][],
};
