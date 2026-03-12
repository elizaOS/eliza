/**
 * Stop command action
 *
 * Uses EventType.HOOK_COMMAND_STOP from @elizaos/core for proper integration
 * with the messaging pipeline and hook system.
 */

import type {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { EventType, logger } from "@elizaos/core";
import { detectCommand } from "../parser";

export const stopAction: Action = {
  name: "STOP_COMMAND",
  description:
    "Stop current operation or abort running tasks. Triggered by /stop, /abort, or /cancel slash commands only.",
  // Only use slash-command similes to avoid matching natural language
  // like "stop talking" or "cancel that" which should go to bootstrap IGNORE
  similes: ["/stop", "/abort", "/cancel"],

  async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
    const text = message.content?.text ?? "";
    const detection = detectCommand(text);
    return (
      detection.isCommand &&
      ["stop", "abort", "cancel"].includes(detection.command?.key ?? "")
    );
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ) {
    // Emit the proper hook event for the stop command.
    // HookCommandPayload extends HookEventPayload which requires sessionKey,
    // messages, timestamp, context. The runtime injects itself automatically.
    try {
      await runtime.emitEvent(EventType.HOOK_COMMAND_STOP, {
        runtime,
        sessionKey: message.roomId,
        messages: [],
        timestamp: new Date(),
        context: {
          entityId: message.entityId,
          source: message.content?.source,
        },
        command: "stop" as const,
        senderId: message.entityId,
        commandSource: message.content?.source,
      });
    } catch (err) {
      logger.warn(
        { src: "plugin-commands", err },
        "Failed to emit HOOK_COMMAND_STOP event",
      );
    }

    const replyText =
      "✓ Stop requested. Current operations will be cancelled.";
    await callback?.({ text: replyText });

    return {
      success: true,
      text: replyText,
    };
  },

  examples: [
    [
      { name: "user", content: { text: "/stop" } },
      {
        name: "assistant",
        content: {
          text: "✓ Stop requested. Current operations will be cancelled.",
        },
      },
    ],
    [
      { name: "user", content: { text: "/abort" } },
      {
        name: "assistant",
        content: {
          text: "✓ Stop requested. Current operations will be cancelled.",
        },
      },
    ],
  ] as ActionExample[][],
};
