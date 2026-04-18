/**
 * REVOKE_REMOTE_SESSION — control-plane action for T9a.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import {
  RemoteSessionError,
  getRemoteSessionService,
} from "../remote/remote-session-service.js";

const ACTION_NAME = "REVOKE_REMOTE_SESSION";

interface RevokeParams {
  sessionId?: string;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const revokeRemoteSessionAction: Action = {
  name: ACTION_NAME,
  similes: ["END_REMOTE_SESSION", "CLOSE_REMOTE_SESSION", "REMOTE_REVOKE"],
  description: "Revoke an active remote-control session by id.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  parameters: [
    {
      name: "sessionId",
      description:
        "Session id returned by the REMOTE_DESKTOP start subaction.",
      required: true,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      { name: "{{name1}}", content: { text: "End the remote session" } },
      { name: "{{agentName}}", content: { text: "Remote session revoked." } },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
  ): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may revoke remote sessions.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as RevokeParams;
    const sessionId = coerceString(params.sessionId);
    if (!sessionId) {
      return {
        text: "Missing sessionId.",
        success: false,
        values: { success: false, error: "MISSING_SESSION_ID" },
        data: { actionName: ACTION_NAME },
      };
    }

    try {
      await getRemoteSessionService().revokeSession(sessionId);
      return {
        text: `Remote session ${sessionId} revoked.`,
        success: true,
        values: { success: true, sessionId },
        data: { actionName: ACTION_NAME, sessionId },
      };
    } catch (error) {
      if (error instanceof RemoteSessionError) {
        return {
          text: error.message,
          success: false,
          values: { success: false, error: error.code, sessionId },
          data: { actionName: ACTION_NAME, sessionId },
        };
      }
      throw error;
    }
  },
};
