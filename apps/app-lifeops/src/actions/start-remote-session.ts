/**
 * START_REMOTE_SESSION — control-plane action for T9a.
 *
 * Requires owner access. If MILADY_REMOTE_LOCAL_MODE=1, the pairing code is
 * not required (but `confirmed: true` still is). Otherwise, a valid 6-digit
 * pairing code issued via the cloud pair endpoint must be provided.
 *
 * Does not open a pixel transport. The data-plane ingress is resolved by
 * RemoteSessionService; when no data plane is configured, the action returns
 * an explicit `ingressUrl: null` with `reason: "data-plane-not-configured"`.
 */

import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  getRemoteSessionService,
  RemoteSessionError,
} from "../remote/remote-session-service.js";

const ACTION_NAME = "START_REMOTE_SESSION";

interface StartParams {
  pairingCode?: string;
  confirmed?: boolean;
  requesterIdentity?: string;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const startRemoteSessionAction: Action = {
  name: ACTION_NAME,
  similes: ["OPEN_REMOTE_SESSION", "BEGIN_REMOTE_SESSION", "REMOTE_START"],
  description:
    "Open a remote-control session. Requires confirmed: true. If running in local mode (MILADY_REMOTE_LOCAL_MODE=1) no pairing code is needed; otherwise a valid 6-digit pairing code is required. Use this only to start a remote session, not for local screenshots, Finder/Desktop tasks, or browser/file automation on this Mac — those belong to LIFEOPS_COMPUTER_USE.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  parameters: [
    {
      name: "pairingCode",
      description:
        "6-digit one-time pairing code. Required unless MILADY_REMOTE_LOCAL_MODE=1.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description: "Must be true to actually start the session.",
      required: true,
      schema: { type: "boolean" as const },
    },
    {
      name: "requesterIdentity",
      description:
        "Identifier for who is asking (entity id, friend name, device id). Logged for audit.",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Start a remote session with code 482193" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Remote session active. Data plane ingress: vnc://host:5900",
        },
      },
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
        text: "Permission denied: only the owner may start a remote session.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as StartParams;

    const confirmed = params.confirmed === true;
    if (!confirmed) {
      return {
        text: "Remote sessions require explicit confirmation. Re-issue with confirmed: true.",
        success: false,
        values: { success: false, error: "NOT_CONFIRMED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const requesterIdentity =
      coerceString(params.requesterIdentity) ??
      String(message.entityId ?? "unknown");

    const service = getRemoteSessionService();

    try {
      const result = await service.startSession({
        requesterIdentity,
        pairingCode: coerceString(params.pairingCode),
        confirmed: true,
      });

      if (result.status === "denied") {
        return {
          text: "Pairing code was invalid or expired. Request a fresh code and retry.",
          success: false,
          values: {
            success: false,
            error: "PAIRING_DENIED",
            sessionId: result.sessionId,
          },
          data: { actionName: ACTION_NAME, session: result },
        };
      }

      if (result.ingressUrl === null) {
        return {
          text: `Remote session ${result.sessionId} is authorized but the data plane is not configured (${result.reason ?? "unknown"}). Configure Tailscale (T9b) or the Eliza Cloud tunnel to complete pixel transport.`,
          success: false,
          values: {
            success: false,
            error: "DATA_PLANE_NOT_CONFIGURED",
            sessionId: result.sessionId,
            status: result.status,
            ingressUrl: null,
            reason: result.reason,
            localMode: result.localMode,
          },
          data: { actionName: ACTION_NAME, session: result },
        };
      }

      return {
        text: `Remote session ${result.sessionId} active. Connect via ${result.ingressUrl}.`,
        success: true,
        values: {
          success: true,
          sessionId: result.sessionId,
          status: result.status,
          ingressUrl: result.ingressUrl,
          localMode: result.localMode,
        },
        data: { actionName: ACTION_NAME, session: result },
      };
    } catch (error) {
      if (error instanceof RemoteSessionError) {
        return {
          text: error.message,
          success: false,
          values: { success: false, error: error.code },
          data: { actionName: ACTION_NAME },
        };
      }
      throw error;
    }
  },
};
