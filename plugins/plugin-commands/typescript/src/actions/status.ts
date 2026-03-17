/**
 * Status command action
 *
 * This is the SLASH COMMAND version (/status, /s). It is distinct from the
 * bootstrap STATUS action which handles natural language like "what's your status?".
 *
 * Key differences:
 * - This action ONLY activates for /status or /s slash commands (validate checks prefix)
 * - Bootstrap STATUS handles conversational requests about agent state
 * - This action shows directive/session settings; bootstrap STATUS shows tasks/room info
 * - No natural language similes to prevent conflict with bootstrap STATUS
 */

import type {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { detectCommand } from "../parser";

interface DirectiveModelState {
  provider?: string;
  model?: string;
}

interface DirectiveSessionState {
  thinking: string | boolean;
  verbose: boolean | string;
  reasoning: boolean | string;
  elevated: boolean | string;
  model?: DirectiveModelState;
}

interface DirectiveParserService {
  getSessionState?: (roomId: string) => DirectiveSessionState | undefined;
}

/**
 * Build status report including directive state
 */
async function buildStatusReport(
  runtime: IAgentRuntime,
  roomId: string,
): Promise<string> {
  const lines: string[] = ["**Session Status:**\n"];

  // Agent info
  lines.push(`**Agent:** ${runtime.character.name ?? runtime.agentId}`);
  lines.push(`**Room:** ${roomId}`);

  // Try to get directive state from plugin-directives if available
  try {
    const directiveService = runtime.getService(
      "directive-parser",
    ) as DirectiveParserService | null;
    if (directiveService) {
      const state = directiveService.getSessionState?.(roomId);
      if (state) {
        lines.push(`\n**Directives:**`);
        lines.push(`• Thinking: ${state.thinking}`);
        lines.push(`• Verbose: ${state.verbose}`);
        lines.push(`• Reasoning: ${state.reasoning}`);
        lines.push(`• Elevated: ${state.elevated}`);
        if (state.model?.provider || state.model?.model) {
          const modelStr = state.model.provider
            ? `${state.model.provider}/${state.model.model}`
            : state.model.model;
          lines.push(`• Model: ${modelStr}`);
        }
      }
    }
  } catch {
    // Directive plugin not available
  }

  // Get pending tasks count for context
  try {
    const tasks = await runtime.getTasks({
      roomId,
      agentIds: [runtime.agentId],
    });
    if (tasks.length > 0) {
      lines.push(`\n**Tasks:** ${tasks.length} pending`);
    }
  } catch {
    // Task retrieval may not be available
  }

  return lines.join("\n");
}

export const statusAction: Action = {
  // Deliberately distinct from bootstrap's "STATUS" action name
  // Normalized: "statuscommand" vs "status" — no exact match collision
  name: "STATUS_COMMAND",
  description:
    "Show session directive settings via /status slash command. Only activates for /status or /s prefix.",
  // Only slash-command similes — no natural language to avoid stealing
  // from bootstrap STATUS which handles "what's your status?" etc.
  similes: ["/status", "/s"],

  async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const text = message.content?.text ?? "";
    // Strict: only activate for slash commands, never natural language
    const detection = detectCommand(text);
    return detection.isCommand && detection.command?.key === "status";
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ) {
    const statusText = await buildStatusReport(runtime, message.roomId);

    await callback?.({ text: statusText });

    return {
      success: true,
      text: statusText,
    };
  },

  examples: [
    [
      { name: "user", content: { text: "/status" } },
      {
        name: "assistant",
        content: {
          text: "**Session Status:**\n\n**Agent:** Eliza\n**Room:** room-456\n\n**Directives:**\n• Thinking: low...",
        },
      },
    ],
  ] as ActionExample[][],
};
