/**
 * SEND_TO_AGENT action - Send input to a running task agent.
 *
 * Allows sending text or commands to an active PTY session.
 * Useful for responding to prompts, providing feedback, or giving new instructions.
 *
 * @module actions/send-to-agent
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getCoordinator, type PTYService } from "../services/pty-service.js";
import { normalizeAgentType } from "../services/pty-types.js";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import { mergeTaskThreadEvalMetadata } from "./eval-metadata.js";

const deprecatedActionWarnings = new Set<string>();

function warnDeprecatedSpawnSurface(
  actionName: string,
  replacement: string,
): void {
  if (deprecatedActionWarnings.has(actionName)) return;
  deprecatedActionWarnings.add(actionName);
  console.warn(
    `[plugin-agent-orchestrator] ${actionName} is deprecated. Use ${replacement} from @elizaos/plugin-acpx instead.`,
  );
}
/**
 * @deprecated The plugin-agent-orchestrator PTY spawn surface is deprecated.
 * Use @elizaos/plugin-acpx sendToAgentAction / sendToTaskAgentAction instead. This action remains during the migration window.
 */
export const sendToAgentAction: Action = {
  name: "SEND_TO_AGENT",

  similes: [
    "SEND_TO_CODING_AGENT",
    "MESSAGE_CODING_AGENT",
    "INPUT_TO_AGENT",
    "RESPOND_TO_AGENT",
    "TELL_CODING_AGENT",
    "MESSAGE_AGENT",
    "TELL_TASK_AGENT",
  ],

  description:
    "Send text input or key presses to a running task-agent session. " +
    "Use this to respond to agent prompts, provide feedback, continue a task, or assign a fresh tracked task to an existing agent.",
  descriptionCompressed:
    "send text input key press run task-agent session use respond agent prompt, provide feedback, continue task, assign fresh track task exist agent",

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Tell the running sub-agent to accept the changes" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send the approval to the task agent.",
          action: "SEND_TO_AGENT",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Say yes to the agent prompt" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Sending confirmation to the agent.",
          action: "SEND_TO_AGENT",
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const ptyService = runtime.getService("PTY_SERVICE") as unknown as
      | PTYService
      | undefined;
    if (!ptyService) {
      return false;
    }
    // Fast-fail: listSessions() does a JSON-RPC call to the Node worker which
    // can take 30s to timeout when the worker is busy.  Cap at 2s so action
    // validation doesn't block the entire message pipeline.
    try {
      const sessions = await Promise.race([
        ptyService.listSessions(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("validate timeout")), 2000),
        ),
      ]);
      return sessions.length > 0;
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    warnDeprecatedSpawnSurface(
      "sendToAgentAction / sendToTaskAgentAction",
      "@elizaos/plugin-acpx sendToAgentAction / sendToTaskAgentAction",
    );
    const access = await requireTaskAgentAccess(runtime, message, "interact");
    if (!access.allowed) {
      if (callback) {
        await callback({
          text: access.reason,
        });
      }
      return { success: false, error: "FORBIDDEN", text: access.reason };
    }

    const ptyService = runtime.getService("PTY_SERVICE") as unknown as
      | PTYService
      | undefined;
    if (!ptyService) {
      if (callback) {
        await callback({
          text: "PTY Service is not available.",
        });
      }
      return { success: false, error: "SERVICE_UNAVAILABLE" };
    }

    const params = options?.parameters as Record<string, unknown> | undefined;
    const content = message.content as {
      sessionId?: string;
      input?: string;
      keys?: string;
      task?: string;
      label?: string;
    };

    // Get session ID from content or state
    let sessionId = (params?.sessionId as string) ?? content.sessionId;

    if (!sessionId && state?.codingSession) {
      sessionId = (state.codingSession as { id: string }).id;
    }

    if (!sessionId) {
      // Try to find the most recent session
      const sessions = await ptyService.listSessions();
      if (sessions.length === 0) {
        if (callback) {
          await callback({
            text: "No active task-agent sessions. Spawn an agent first.",
          });
        }
        return { success: false, error: "NO_SESSION" };
      }
      sessionId = sessions[sessions.length - 1].id;
    }

    const session = ptyService.getSession(sessionId);
    if (!session) {
      if (callback) {
        await callback({
          text: `Session ${sessionId} not found.`,
        });
      }
      return { success: false, error: "SESSION_NOT_FOUND" };
    }

    try {
      const keys = (params?.keys as string) ?? content.keys;
      const trackedTask = (params?.task as string) ?? content.task;
      const taskLabel = (params?.label as string) ?? content.label;
      const input = (params?.input as string) ?? content.input ?? trackedTask;

      if (keys) {
        // Send special key sequence
        await ptyService.sendKeysToSession(sessionId, keys);
        if (callback) {
          await callback({
            text: "Sent key sequence to task agent.",
          });
        }
        return {
          success: true,
          text: "Sent key sequence",
          data: { sessionId, keys },
        };
      } else if (input) {
        // Send text input
        await ptyService.sendToSession(sessionId, input);
        if (trackedTask) {
          const coordinator = getCoordinator(runtime);
          const existingTask = coordinator?.getTaskContext(sessionId);
          const evalMetadata = mergeTaskThreadEvalMetadata(message, {
            source: "send-to-agent-action",
            messageId: message.id,
            sessionId,
          });
          const taskThread =
            coordinator && !existingTask
              ? await coordinator.createTaskThread({
                  title:
                    taskLabel ||
                    (typeof session.metadata?.label === "string"
                      ? session.metadata.label
                      : `agent-${sessionId.slice(-8)}`),
                  originalRequest: trackedTask,
                  roomId: message.roomId,
                  worldId: message.worldId,
                  ownerUserId:
                    ((message as unknown as Record<string, unknown>).userId as
                      | string
                      | undefined) ?? message.entityId,
                  scenarioId: evalMetadata.scenarioId,
                  batchId: evalMetadata.batchId,
                  metadata: evalMetadata.metadata,
                })
              : null;
          if (coordinator) {
            await coordinator.registerTask(sessionId, {
              threadId: existingTask?.threadId ?? taskThread?.id ?? sessionId,
              agentType: normalizeAgentType(session.agentType),
              label:
                taskLabel ||
                existingTask?.label ||
                (typeof session.metadata?.label === "string"
                  ? session.metadata.label
                  : `agent-${sessionId.slice(-8)}`),
              originalTask: trackedTask,
              workdir: session.workdir,
              ...(existingTask?.repo ? { repo: existingTask.repo } : {}),
              metadata:
                session.metadata &&
                typeof session.metadata === "object" &&
                !Array.isArray(session.metadata)
                  ? (session.metadata as Record<string, unknown>)
                  : undefined,
            });
            await coordinator.setTaskDelivered(sessionId);
          }
        }
        if (callback) {
          await callback({
            text: trackedTask
              ? `Assigned new tracked task to task agent: "${trackedTask}"`
              : `Sent to task agent: "${input}"`,
          });
        }
        return {
          success: true,
          text: trackedTask
            ? "Assigned new task to agent"
            : "Sent input to agent",
          data: {
            sessionId,
            input,
            ...(trackedTask ? { task: trackedTask } : {}),
          },
        };
      } else {
        if (callback) {
          await callback({
            text: "No input provided. Specify 'input', 'task', or 'keys' parameter.",
          });
        }
        return { success: false, error: "NO_INPUT" };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: `Failed to send to agent: ${errorMessage}`,
        });
      }
      return { success: false, error: errorMessage };
    }
  },

  parameters: [
    {
      name: "sessionId",
      description:
        "ID of the task-agent session to send to. If not specified, uses the current session.",
      descriptionCompressed: "Send input/keypresses to running task agent.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "input",
      description: "Text input to send to the running task agent.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "task",
      description:
        "New tracked task to assign to the existing agent. This is also sent as the next input so provider status reflects the new assignment.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "label",
      description:
        "Optional label to use when tracking a newly assigned task on an existing agent.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "keys",
      description:
        "Special key sequence to send (e.g., 'Enter', 'Ctrl-C', 'y').",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};

/**
 * @deprecated Use @elizaos/plugin-acpx sendToTaskAgentAction instead.
 */
export const sendToTaskAgentAction = sendToAgentAction;
