/**
 * Process Action - Manage running exec sessions
 * Supports: list, poll, log, write, send-keys, submit, paste, kill, clear, remove
 */

import type { Action, ActionResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import { composePromptFromState, logger, ModelType } from "@elizaos/core";
import type { ShellService } from "../services/shellService";
import type { ProcessActionParams } from "../types";

const processActionTemplate = `You are helping extract process management parameters from user messages.

Recent conversation:
{{recentMessages}}

Based on the conversation, extract the process action parameters:
- action: The action to perform (list, poll, log, write, send-keys, submit, paste, kill, clear, remove)
- sessionId: The session ID (required for all actions except "list")
- data: Data to write (for "write" action)
- keys: Array of key tokens (for "send-keys" action)
- literal: Literal string to send (for "send-keys" action)
- text: Text to paste (for "paste" action)
- eof: Whether to close stdin after write (for "write" action)
- offset: Log offset (for "log" action)
- limit: Log limit (for "log" action)

Respond with a JSON object containing the extracted parameters:
\`\`\`json
{
  "action": "list|poll|log|write|send-keys|submit|paste|kill|clear|remove",
  "sessionId": "optional-session-id",
  "data": "optional-data",
  "keys": ["optional", "key", "tokens"],
  "literal": "optional-literal",
  "text": "optional-paste-text",
  "eof": false,
  "offset": 0,
  "limit": 100
}
\`\`\``;

function extractJsonFromResponse(response: string): ProcessActionParams | null {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch?.[1]) {
    try {
      return JSON.parse(jsonMatch[1]) as ProcessActionParams;
    } catch {
      // Try without code blocks
    }
  }

  try {
    const trimmed = response.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return JSON.parse(trimmed) as ProcessActionParams;
    }
  } catch {
    // Fall through
  }

  return null;
}

export const processAction: Action = {
  name: "MANAGE_PROCESS",
  similes: [
    "PROCESS_LIST",
    "PROCESS_POLL",
    "PROCESS_LOG",
    "PROCESS_WRITE",
    "PROCESS_KILL",
    "LIST_SESSIONS",
    "POLL_SESSION",
    "KILL_SESSION",
    "CHECK_PROCESS",
    "SEND_KEYS",
  ],
  description:
    "Manage running shell/exec sessions: list, poll, log, write, send-keys, submit, paste, kill, clear, remove",

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || "";

    const processKeywords = [
      "process",
      "session",
      "sessions",
      "list",
      "poll",
      "log",
      "write",
      "send-keys",
      "send keys",
      "submit",
      "paste",
      "kill",
      "clear",
      "remove",
      "running",
      "background",
    ];

    const actionKeywords = [
      "check",
      "show",
      "get",
      "view",
      "manage",
      "stop",
      "terminate",
      "status",
    ];

    const hasProcessKeyword = processKeywords.some((kw) => text.includes(kw));
    const hasActionKeyword = actionKeywords.some((kw) => text.includes(kw));

    return hasProcessKeyword || (hasActionKeyword && text.includes("session"));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<ActionResult> => {
    const shellService = await runtime.getService<ShellService>("shell");
    if (!shellService) {
      return {
        success: false,
        text: "Shell service is not available.",
        error: "Shell service not found",
      };
    }

    // Try to extract parameters from the message
    const composedState = state ?? (await runtime.composeState(message));

    const prompt = composePromptFromState({
      state: composedState,
      template: processActionTemplate,
    });

    let params: ProcessActionParams | null = null;

    // Simple heuristic extraction for common patterns
    const text = message.content.text?.toLowerCase() || "";

    if (text.includes("list") && (text.includes("session") || text.includes("process"))) {
      params = { action: "list" };
    } else {
      // Use LLM for complex extraction
      try {
        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });
        params = extractJsonFromResponse(String(response));
      } catch (error) {
        logger.error("Failed to extract process parameters:", error);
      }
    }

    if (!params) {
      // Default to list if we can't determine the action
      params = { action: "list" };
    }

    const result = await shellService.processAction(params);

    return {
      success: result.success,
      text: result.message,
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "List all running processes" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here are the running sessions:\ncalm-harbor running 5m30s :: npm install\nbrisk-reef completed 2m15s :: git status",
          action: "MANAGE_PROCESS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Check the status of session calm-harbor" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Session calm-harbor is still running.\n\nOutput:\nnpm WARN deprecated...\n\nProcess still running.",
          action: "MANAGE_PROCESS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Kill the session brisk-reef" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Killed session brisk-reef.",
          action: "MANAGE_PROCESS",
        },
      },
    ],
  ],
};
