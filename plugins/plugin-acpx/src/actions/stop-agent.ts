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

export const stopAgentAction: Action = {
  name: "STOP_AGENT",
  roleGate: { minRole: "OWNER" },
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
    "Stop a running task-agent session, terminating the session and cleaning up resources.",
  parameters: [
    {
      name: "sessionId",
      description: "Session ID to stop",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "all",
      description: "Stop all active sessions",
      required: false,
      schema: { type: "boolean" },
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
      const sessions = await Promise.resolve(service.listSessions());

      if (all) {
        await Promise.all(
          sessions.map((session) => service.stopSession(session.id)),
        );
        if (state)
          (
            state as unknown as {
              codingSession?: unknown;
              codingSessions?: unknown;
            }
          ).codingSession = undefined;
        if (state)
          (state as unknown as { codingSessions?: unknown }).codingSessions =
            [];
        const text = `Stopped ${sessions.length} sessions`;
        await callbackText(callback, text);
        return { success: true, text, data: { stoppedCount: sessions.length } };
      }

      const requestedId =
        pickString(params, content, "sessionId") ??
        (state as unknown as { codingSession?: { id?: string } } | undefined)
          ?.codingSession?.id;
      const target = requestedId
        ? await Promise.resolve(service.getSession(requestedId))
        : newestSession(sessions);

      if (!target) {
        if (requestedId) {
          const text = `Session ${requestedId} not found.`;
          await callbackText(callback, text);
          return errorResult("SESSION_NOT_FOUND");
        }
        await callbackText(callback, "No sessions to stop");
        return { success: true, text: "No sessions to stop" };
      }

      await service.stopSession(target.id);
      if (
        (state as unknown as { codingSession?: { id?: string } } | undefined)
          ?.codingSession?.id === target.id
      ) {
        (state as unknown as { codingSession?: unknown }).codingSession =
          undefined;
      }
      await callbackText(callback, `Stopped task-agent session ${target.id}.`);
      return {
        success: true,
        text: `Stopped session ${target.id}`,
        data: { sessionId: target.id, agentType: String(target.agentType) },
      };
    } catch (error) {
      const msg = failureMessage(error);
      await callbackText(callback, `Failed to stop agent: ${msg}`);
      return { success: false, error: msg };
    }
  },
};

export const stopTaskAgentAction = stopAgentAction;
