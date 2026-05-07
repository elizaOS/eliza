/**
 * STOP_AGENT action - Stop a running task-agent session.
 *
 * Terminates an active PTY session. Use when the agent is done,
 * stuck, or needs to be cancelled.
 *
 * @module actions/stop-agent
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { PTYService } from "../services/pty-service.js";
import { requireTaskAgentAccess } from "../services/task-policy.js";

const STOP_AGENT_SESSION_LIMIT = 25;
const STOP_AGENT_TIMEOUT_MS = 10_000;

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
 * Use @elizaos/plugin-acpx stopAgentAction / stopTaskAgentAction or cancelTaskAction instead. This action remains during the migration window.
 */
export const stopAgentAction: Action = {
  name: "STOP_AGENT",
  contexts: ["tasks", "automation", "agent_internal"],
  contextGate: { anyOf: ["tasks", "automation", "agent_internal"] },
  roleGate: { minRole: "USER" },

  similes: [
    "STOP_CODING_AGENT",
    "KILL_CODING_AGENT",
    "TERMINATE_AGENT",
    "END_CODING_SESSION",
    "CANCEL_AGENT",
    "CANCEL_TASK_AGENT",
    "STOP_SUB_AGENT",
  ],

  description:
    "Stop a running task-agent session. " +
    "Terminates the PTY session and cleans up resources.",
  descriptionCompressed:
    "stop run task-agent session terminate PTY session clean up resource",

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Stop the task agent" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll stop the task-agent session.",
          action: "STOP_AGENT",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Kill the stuck agent" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Terminating the task agent.",
          action: "STOP_AGENT",
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
      "stopAgentAction / stopTaskAgentAction",
      "@elizaos/plugin-acpx stopAgentAction / stopTaskAgentAction or cancelTaskAction",
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
      all?: boolean;
    };

    // Stop all sessions if requested
    if ((params?.all as boolean) ?? content.all) {
      const sessions = (await ptyService.listSessions()).slice(0, STOP_AGENT_SESSION_LIMIT);
      if (sessions.length === 0) {
        if (callback) {
          await callback({
            text: "No active task-agent sessions to stop.",
          });
        }
        return { success: true, text: "No sessions to stop" };
      }

      for (const session of sessions) {
        try {
          await Promise.race([
            ptyService.stopSession(session.id),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Stop agent timeout")), STOP_AGENT_TIMEOUT_MS),
            ),
          ]);
        } catch (err) {
          logger.error(`Failed to stop session ${session.id}: ${err}`);
        }
      }

      // Clear state
      if (state?.codingSession) {
        delete state.codingSession;
      }

      if (callback) {
        await callback({
          text: `Stopped ${sessions.length} task-agent session(s).`,
        });
      }
      return {
        success: true,
        text: `Stopped ${sessions.length} sessions`,
        data: { stoppedCount: sessions.length },
      };
    }

    // Stop specific session
    let sessionId = (params?.sessionId as string) ?? content.sessionId;
    if (!sessionId && state?.codingSession) {
      sessionId = (state.codingSession as { id: string }).id;
    }

    if (!sessionId) {
      const sessions = (await ptyService.listSessions()).slice(0, STOP_AGENT_SESSION_LIMIT);
      if (sessions.length === 0) {
        if (callback) {
          await callback({
            text: "No active task-agent sessions to stop.",
          });
        }
        return { success: true, text: "No sessions to stop" };
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
      await Promise.race([
        ptyService.stopSession(sessionId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Stop agent timeout")), STOP_AGENT_TIMEOUT_MS),
        ),
      ]);

      // Clear state if this was the current session
      if (
        state?.codingSession &&
        (state.codingSession as { id: string }).id === sessionId
      ) {
        delete state.codingSession;
      }

      if (callback) {
        await callback({
          text: `Stopped task-agent session ${sessionId}.`,
        });
      }
      return {
        success: true,
        text: `Stopped session ${sessionId}`,
        data: { sessionId, agentType: session.agentType },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: `Failed to stop agent: ${errorMessage}`,
        });
      }
      return { success: false, error: errorMessage };
    }
  },

  parameters: [
    {
      name: "sessionId",
      description:
        "ID of the session to stop. If not specified, stops the current session.",
      descriptionCompressed: "Stop running task agent, cleanup resources.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "all",
      description: "If true, stop all active task-agent sessions.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
};

/**
 * @deprecated Use @elizaos/plugin-acpx stopTaskAgentAction or cancelTaskAction instead.
 */
export const stopTaskAgentAction = stopAgentAction;
