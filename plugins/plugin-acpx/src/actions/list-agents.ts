import type { Action, ActionResult } from "@elizaos/core";
import {
  callbackText,
  errorResult,
  getAcpService,
  labelFor,
  listSessionsWithin,
  shortId,
} from "./common.js";

function dateString(value: Date | string | number): string {
  return new Date(value).toISOString();
}

export const listAgentsAction: Action = {
  name: "LIST_AGENTS",
  roleGate: { minRole: "ADMIN" },
  similes: [
    "LIST_CODING_AGENTS",
    "SHOW_CODING_AGENTS",
    "GET_ACTIVE_AGENTS",
    "LIST_SESSIONS",
    "SHOW_CODING_SESSIONS",
    "SHOW_TASK_AGENTS",
    "LIST_SUB_AGENTS",
    "SHOW_TASK_STATUS",
  ],
  description:
    "List active task agents together with current task progress so the main agent can keep the user updated while work continues asynchronously.",
  parameters: [],
  validate: async (runtime) => Boolean(getAcpService(runtime)),
  handler: async (
    runtime,
    _message,
    _state,
    _options,
    callback,
  ): Promise<ActionResult> => {
    const service = getAcpService(runtime);
    if (!service) {
      await callbackText(callback, "PTY Service is not available.");
      return errorResult("SERVICE_UNAVAILABLE");
    }

    const sessions = await listSessionsWithin(service, 2000);
    const preferredTaskAgent = {
      id: String((await service.resolveAgentType?.({})) ?? "codex"),
      reason: "acpx default agent",
    };
    const tasks: Array<Record<string, unknown>> = [];
    const pendingConfirmations = 0;

    if (sessions.length === 0) {
      const text =
        "No active task agents. Use CREATE_TASK when the user needs anything more involved than a simple direct reply.";
      await callbackText(callback, text);
      return {
        success: true,
        text,
        data: { sessions: [], tasks, pendingConfirmations, preferredTaskAgent },
      };
    }

    const lines = [`Active task agents (${sessions.length}):`];
    for (const session of sessions) {
      lines.push(
        `- ${labelFor(session)} [${shortId(session.id)}] ${session.agentType} ${session.status} in ${session.workdir}`,
      );
    }
    const text = lines.join("\n");
    await callbackText(callback, text);

    return {
      success: true,
      text,
      data: {
        sessions: sessions.map((session) => ({
          id: session.id,
          agentType: String(session.agentType),
          status: String(session.status),
          workdir: session.workdir,
          createdAt: dateString(session.createdAt),
          lastActivity: dateString(session.lastActivityAt),
          label: labelFor(session),
        })),
        tasks,
        pendingConfirmations,
        preferredTaskAgent,
      },
    };
  },
};

export const listTaskAgentsAction = listAgentsAction;
