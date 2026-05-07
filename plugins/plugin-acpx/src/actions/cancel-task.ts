import type { Action, ActionResult } from "@elizaos/core";
import {
  callbackText,
  contentRecord,
  errorResult,
  failureMessage,
  getAcpService,
  type HandlerOptionsLike,
  newestSession,
  paramsRecord,
  pickBoolean,
  pickString,
  validateHasSessions,
} from "./common.js";

export const cancelTaskAction: Action = {
  name: "CANCEL_TASK",
  similes: [
    "STOP_TASK",
    "CANCEL_AGENT_TASK",
    "CANCEL_TASK_AGENT",
    "ABORT_TASK",
    "KILL_TASK",
    "STOP_SUBTASK",
  ],
  description:
    "Cancel a durable task and stop any associated task-agent sessions, preserving history and marking sessions or threads as canceled or interrupted.",
  parameters: [
    {
      name: "threadId",
      description: "Task thread ID",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "sessionId",
      description: "Session ID",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "search",
      description: "Search text for a matching task",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "all",
      description: "Cancel all active tasks",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "reason",
      description: "Cancellation reason",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: validateHasSessions,
  handler: async (
    runtime,
    message,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const service = getAcpService(runtime);
    if (!service) {
      await callbackText(callback, "PTY Service is not available.");
      return errorResult("SERVICE_UNAVAILABLE");
    }

    try {
      const params = paramsRecord(options as HandlerOptionsLike | undefined);
      const content = contentRecord(message);
      const all = pickBoolean(params, content, "all") ?? false;
      const threadId = pickString(params, content, "threadId");
      const sessionId =
        pickString(params, content, "sessionId") ??
        (state as unknown as { codingSession?: { id?: string } } | undefined)
          ?.codingSession?.id;
      const search = pickString(params, content, "search")?.toLowerCase();
      const sessions = await Promise.resolve(service.listSessions());

      if (all) {
        const stoppedSessions: string[] = [];
        for (const session of sessions) {
          await (service.cancelSession?.(session.id) ??
            service.stopSession(session.id));
          stoppedSessions.push(session.id);
        }
        const text = `Canceled ${stoppedSessions.length} task(s).`;
        await callbackText(callback, text);
        return {
          success: true,
          text,
          data: { canceledCount: stoppedSessions.length, stoppedSessions },
        };
      }

      const target = sessionId
        ? await Promise.resolve(service.getSession(sessionId))
        : search
          ? sessions.find((session) =>
              `${session.id} ${session.name ?? ""} ${session.metadata?.label ?? ""}`
                .toLowerCase()
                .includes(search),
            )
          : newestSession(sessions);

      if (!target) {
        const code = sessionId ? "SESSION_NOT_FOUND" : "TASK_NOT_FOUND";
        const text = sessionId
          ? `Session ${sessionId} not found.`
          : "No matching task found.";
        await callbackText(callback, text);
        return errorResult(code);
      }

      await (service.cancelSession?.(target.id) ??
        service.stopSession(target.id));
      const id = threadId ?? target.id;
      const text = `Canceled task ${id}`;
      await callbackText(callback, text);
      return {
        success: true,
        text,
        data: {
          ...(threadId ? { threadId } : {}),
          sessionId: target.id,
          stoppedSessions: [target.id],
          status: "canceled",
        },
      };
    } catch (error) {
      const msg = failureMessage(error);
      await callbackText(callback, `Failed to cancel task: ${msg}`);
      return { success: false, error: msg };
    }
  },
};
