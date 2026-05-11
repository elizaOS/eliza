import {
  type Action,
  type ActionExample,
  CANONICAL_SUBACTION_KEY,
  type Content,
  DEFAULT_SUBACTION_KEYS,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type JsonValue,
  logger,
  type Memory,
  normalizeSubaction,
  type State,
} from "@elizaos/core";
import type { ShellService } from "../services/shellService";

const SHELL_HISTORY_SUBACTIONS = ["clear", "view", "disable"] as const;
type ShellHistorySubaction = (typeof SHELL_HISTORY_SUBACTIONS)[number];

const VIEW_LIMIT_DEFAULT = 20;

function readShellHistorySubaction(
  options: HandlerOptions | undefined,
): ShellHistorySubaction {
  const params = options?.parameters as
    | Record<string, JsonValue | undefined>
    | undefined;
  for (const key of DEFAULT_SUBACTION_KEYS) {
    const normalized = normalizeSubaction(params?.[key]);
    if (
      normalized &&
      (SHELL_HISTORY_SUBACTIONS as readonly string[]).includes(normalized)
    ) {
      return normalized as ShellHistorySubaction;
    }
  }
  return "clear";
}

function inferSubactionFromText(text: string): ShellHistorySubaction | null {
  const lower = text.toLowerCase();
  const wantsView =
    /\b(show|view|list|display|print)\b/.test(lower) &&
    /\b(history|terminal|shell|command)/.test(lower);
  if (wantsView) return "view";
  const wantsClear =
    /\b(clear|reset|delete|remove|clean|wipe)\b/.test(lower) &&
    /\b(history|terminal|shell|command)/.test(lower);
  if (wantsClear) return "clear";
  return null;
}

export const shellHistoryAction: Action = {
  name: "SHELL_HISTORY",
  contexts: ["terminal", "settings"],
  contextGate: { anyOf: ["terminal", "settings"] },
  roleGate: { minRole: "USER" },
  similes: [
    "CLEAR_HISTORY",
    "CLEAR_SHELL_HISTORY",
    "RESET_SHELL",
    "CLEAR_TERMINAL",
    "RESET_HISTORY",
    "VIEW_SHELL_HISTORY",
    "SHOW_SHELL_HISTORY",
    "LIST_SHELL_HISTORY",
  ],
  description:
    "Shell command-history router. action=clear wipes the recorded history; action=view returns recent commands; action=disable is reserved for future use.",
  descriptionCompressed: "Shell history: clear | view | disable.",
  parameters: [
    {
      name: "action",
      description:
        "Operation: clear | view | disable. Inferred from message text when omitted (defaults to clear).",
      required: false,
      schema: {
        type: "string",
        enum: [...SHELL_HISTORY_SUBACTIONS],
      },
    },
    {
      name: "limit",
      description:
        "For action=view: maximum number of history entries to return (default 20).",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
  ): Promise<boolean> => {
    const shellService = runtime.getService<ShellService>("shell");
    if (!shellService) {
      return false;
    }

    const text = message.content.text?.toLowerCase() || "";
    const historyKeyword = /\b(history|terminal|shell|command)\b/.test(text);
    if (!historyKeyword) return false;

    return /\b(show|view|list|display|print|clear|reset|delete|remove|clean|wipe)\b/.test(
      text,
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const shellService = runtime.getService<ShellService>("shell");

    if (!shellService) {
      if (callback) {
        await callback({
          text: "Shell service is not available.",
          source: message.content.source,
        });
      }
      return {
        success: false,
        error: "Shell service is not available.",
      };
    }

    const conversationId = message.roomId || message.agentId;
    if (!conversationId) {
      const errorMsg = "No conversation ID available";
      if (callback) {
        await callback({
          text: errorMsg,
          source: message.content.source,
        });
      }
      return { success: false, error: errorMsg };
    }

    // Resolve subaction: explicit parameter wins; fall back to text inference;
    // ultimate fallback is clear (preserves prior single-purpose behaviour).
    const explicit = readShellHistorySubaction(options);
    const params = options?.parameters as
      | Record<string, JsonValue | undefined>
      | undefined;
    const hadExplicitSubaction = DEFAULT_SUBACTION_KEYS.some(
      (key) => normalizeSubaction(params?.[key]) !== undefined,
    );
    const inferred = inferSubactionFromText(message.content.text ?? "");
    const subaction: ShellHistorySubaction = hadExplicitSubaction
      ? explicit
      : (inferred ?? "clear");

    if (subaction === "clear") {
      shellService.clearCommandHistory(conversationId);
      logger.info(`Cleared shell history for conversation: ${conversationId}`);
      const response: Content = {
        text: "Shell command history has been cleared.",
        source: message.content.source,
      };
      if (callback) {
        await callback(response);
      }
      return {
        success: true,
        text: response.text,
        data: {
          actionName: "SHELL_HISTORY",
          [CANONICAL_SUBACTION_KEY]: "clear",
        },
      };
    }

    if (subaction === "view") {
      const rawLimit = params?.limit;
      const limit =
        typeof rawLimit === "number" && rawLimit > 0
          ? Math.floor(rawLimit)
          : VIEW_LIMIT_DEFAULT;
      const entries = shellService.getCommandHistory(conversationId, limit);
      const lines = entries.length
        ? entries
            .map((entry, index) => {
              // Defensive: history entries may have evolved over time.
              const command =
                typeof (entry as { command?: unknown }).command === "string"
                  ? (entry as { command: string }).command
                  : JSON.stringify(entry);
              return `${index + 1}. ${command}`;
            })
            .join("\n")
        : "(no shell history recorded for this conversation)";
      const text = `Shell command history (last ${entries.length}):\n${lines}`;
      if (callback) {
        await callback({ text, source: message.content.source });
      }
      return {
        success: true,
        text,
        data: {
          actionName: "SHELL_HISTORY",
          [CANONICAL_SUBACTION_KEY]: "view",
          entryCount: entries.length,
        },
      };
    }

    // disable — not yet implemented
    const text = `SHELL_HISTORY action=${subaction} not yet implemented`;
    if (callback) {
      await callback({ text, source: message.content.source });
    }
    return {
      success: false,
      text,
      error: text,
      data: {
        actionName: "SHELL_HISTORY",
        [CANONICAL_SUBACTION_KEY]: subaction,
        errorCode: "not_implemented",
      },
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Clear my shell command history.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Shell command history has been cleared.",
          actions: ["SHELL_HISTORY"],
          thought:
            "User asked to wipe shell history; SHELL_HISTORY with action=clear clears the recorded commands for this conversation.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Reset the terminal history for this conversation.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Shell command history has been cleared.",
          actions: ["SHELL_HISTORY"],
          thought:
            "Reset/terminal-history phrasing maps to SHELL_HISTORY with action=clear.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me my recent shell commands.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here are your recent shell commands.",
          actions: ["SHELL_HISTORY"],
          thought:
            "User asked to view shell history; SHELL_HISTORY with action=view returns the most recent entries.",
        },
      },
    ],
  ] as ActionExample[][],
};

// Back-compat alias for the previous canonical export name. Code that already
// imports `clearHistory` keeps working; new code should import
// `shellHistoryAction`.
export const clearHistory = shellHistoryAction;

export default shellHistoryAction;
