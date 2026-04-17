/**
 * LIST_REMOTE_SESSIONS — control-plane action for T9a.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import { getRemoteSessionService } from "../remote/remote-session-service.js";

const ACTION_NAME = "LIST_REMOTE_SESSIONS";

export const listRemoteSessionsAction: Action = {
  name: ACTION_NAME,
  similes: ["REMOTE_SESSIONS", "ACTIVE_REMOTE_SESSIONS", "REMOTE_LIST"],
  description: "List currently active remote-control sessions.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  parameters: [],

  examples: [
    [
      { name: "{{name1}}", content: { text: "Are any remote sessions open?" } },
      { name: "{{agentName}}", content: { text: "No active remote sessions." } },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may view remote sessions.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const sessions = await getRemoteSessionService().listActiveSessions();
    if (sessions.length === 0) {
      return {
        text: "No active remote sessions.",
        success: true,
        values: { success: true, count: 0 },
        data: { actionName: ACTION_NAME, sessions: [] },
      };
    }
    const lines = sessions.map(
      (s) =>
        `• ${s.id} — status=${s.status}${
          s.ingressUrl ? ` ingress=${s.ingressUrl}` : ` ingress=<none:${s.reason ?? "unknown"}>`
        }${s.localMode ? " (local)" : ""}`,
    );
    return {
      text: `Active remote sessions (${sessions.length}):\n${lines.join("\n")}`,
      success: true,
      values: { success: true, count: sessions.length },
      data: { actionName: ACTION_NAME, sessions },
    };
  },
};
