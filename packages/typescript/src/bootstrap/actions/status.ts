/**
 * Status Action
 *
 * Provides information about the agent's current state, pending tasks,
 * and session information. Useful for debugging and understanding
 * what the agent is tracking.
 */

import { logger } from "../../logger.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";

export const statusAction: Action = {
  name: "STATUS",
  similes: ["SHOW_STATUS", "AGENT_STATUS", "CHECK_STATUS", "INFO", "STATE"],
  description:
    "Shows the agent's current status including pending tasks, session info, and configuration. Use when the user asks about the agent's state or what tasks are pending.",

  validate: async (_runtime: IAgentRuntime): Promise<boolean> => {
    // Status is always available
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    try {
      const room = state?.data.room ?? (await runtime.getRoom(message.roomId));
      const roomId = message.roomId;

      // Gather status information
      const statusInfo: Record<string, unknown> = {
        agentId: runtime.agentId,
        agentName: runtime.character.name,
        roomId: roomId,
      };

      // Room info
      if (room) {
        statusInfo.room = {
          name: room.name,
          type: room.type,
          source: room.source,
          lastCompactionAt: room.metadata?.lastCompactionAt,
        };
      }

      // Get pending tasks for this room
      const pendingTasks = await runtime.getTasks({
        roomId: roomId,
      });

      const awaitingChoice = pendingTasks.filter((t) =>
        t.tags?.includes("AWAITING_CHOICE"),
      );

      const queuedTasks = pendingTasks.filter((t) => t.tags?.includes("queue"));

      statusInfo.tasks = {
        total: pendingTasks.length,
        awaitingChoice: awaitingChoice.length,
        queued: queuedTasks.length,
        details: pendingTasks.slice(0, 5).map((t) => ({
          id: t.id?.substring(0, 8),
          name: t.name,
          tags: t.tags,
          options: t.metadata?.options
            ? (t.metadata.options as { name: string }[]).map((o) => o.name)
            : undefined,
        })),
      };

      // Format status message
      const lines: string[] = [];
      lines.push(`**Agent Status**`);
      lines.push(`- Name: ${runtime.character.name}`);
      lines.push(`- Agent ID: ${runtime.agentId.substring(0, 8)}...`);

      if (room) {
        lines.push("");
        lines.push(`**Room**`);
        lines.push(`- Name: ${room.name || "Unknown"}`);
        lines.push(`- Type: ${room.type || "Unknown"}`);
        if (room.metadata?.lastCompactionAt) {
          const compactionDate = new Date(
            room.metadata.lastCompactionAt as number,
          );
          lines.push(`- Last Reset: ${compactionDate.toLocaleString()}`);
        }
      }

      if (pendingTasks.length > 0) {
        lines.push("");
        lines.push(`**Pending Tasks** (${pendingTasks.length})`);

        if (awaitingChoice.length > 0) {
          lines.push(`- Awaiting choice: ${awaitingChoice.length}`);
          for (const task of awaitingChoice.slice(0, 3)) {
            const options = task.metadata?.options as
              | { name: string }[]
              | undefined;
            const optionNames = options?.map((o) => o.name).join(", ") || "N/A";
            lines.push(
              `  - ${task.name} [${task.id?.substring(0, 8)}]: ${optionNames}`,
            );
          }
        }

        if (queuedTasks.length > 0) {
          lines.push(`- Queued: ${queuedTasks.length}`);
        }
      } else {
        lines.push("");
        lines.push("**No pending tasks**");
      }

      const statusText = lines.join("\n");

      logger.info(
        { src: "action:status", roomId, agentId: runtime.agentId },
        "Status requested",
      );

      if (callback) {
        await callback({
          text: statusText,
          actions: ["STATUS"],
          source: message.content.source,
        });
      }

      return {
        text: statusText,
        success: true,
        values: {
          success: true,
          ...statusInfo,
        },
        data: {
          actionName: "STATUS",
          statusInfo,
        },
      };
    } catch (error) {
      logger.error({ src: "action:status", error }, "Error getting status");

      if (callback) {
        await callback({
          text: "Sorry, I encountered an error while getting status information.",
          actions: ["STATUS_FAILED"],
          source: message.content.source,
        });
      }

      return {
        text: `Error getting status: ${error instanceof Error ? error.message : "Unknown error"}`,
        success: false,
        values: { error: String(error) },
        data: { actionName: "STATUS" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "What's your status?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "**Agent Status**\n- Name: Eliza\n- Agent ID: a1b2c3d4...\n\n**No pending tasks**",
          actions: ["STATUS"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me pending tasks",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "**Agent Status**\n- Name: Eliza\n\n**Pending Tasks** (2)\n- Awaiting choice: 1\n  - Confirm Tweet [c0a8012e]: post, cancel",
          actions: ["STATUS"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default statusAction;
