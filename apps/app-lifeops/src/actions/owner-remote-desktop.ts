/**
 * OWNER_REMOTE_DESKTOP — Tier 2-B umbrella.
 *
 * Collapses remote-control session lifecycle into a single owner-only action
 * dispatched by a required `subaction` parameter. Routes to the existing
 * handlers in remote-desktop.ts / start-remote-session.ts /
 * revoke-remote-session.ts / list-remote-sessions.ts without rewriting the
 * underlying logic.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent";
import { remoteDesktopAction } from "./remote-desktop.js";
import { startRemoteSessionAction } from "./start-remote-session.js";
import { revokeRemoteSessionAction } from "./revoke-remote-session.js";
import { listRemoteSessionsAction } from "./list-remote-sessions.js";

const ACTION_NAME = "OWNER_REMOTE_DESKTOP";

type Subaction = "start" | "end" | "status" | "list" | "revoke";

interface OwnerRemoteDesktopParameters {
  subaction?: Subaction | string;
  intent?: string;
  sessionId?: string;
  confirmed?: boolean;
  pairingCode?: string;
  requesterIdentity?: string;
}

function coerceSubaction(value: unknown): Subaction | undefined {
  if (typeof value !== "string") return undefined;
  const n = value.trim().toLowerCase();
  if (n === "start" || n === "end" || n === "status" || n === "list" || n === "revoke") {
    return n;
  }
  return undefined;
}

export const ownerRemoteDesktopAction: Action = {
  name: ACTION_NAME,
  similes: [
    "REMOTE_DESKTOP",
    "START_REMOTE_SESSION",
    "REVOKE_REMOTE_SESSION",
    "LIST_REMOTE_SESSIONS",
    "REMOTE_SESSION",
    "REMOTE_CONTROL",
  ],
  description:
    "Owner-only. Manage remote-control desktop sessions so the owner can connect to this machine from another device. " +
    "Subactions: start (open a session — requires confirmed: true and may require a pairing code), " +
    "end (close a session by id via the legacy backend), " +
    "revoke (revoke an active session by id via the remote-session service), " +
    "status (look up one session by id), " +
    "list (enumerate all active sessions). " +
    "Use this only for remote-session lifecycle work. Do NOT use it for local Finder/Desktop automation, screenshots, browser flows, or file handling on this machine — those belong to LIFEOPS_COMPUTER_USE. " +
    "Do NOT use it for website or app blocking (OWNER_WEBSITE_BLOCK / OWNER_APP_BLOCK) or screen-time analytics (OWNER_SCREEN_TIME).",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  parameters: [
    {
      name: "subaction",
      description: "Required. One of: start, end, status, list, revoke.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description: "Freeform owner intent / reason for the session. Logged for audit.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sessionId",
      description: "Session id — required for status, end, and revoke subactions.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description: "Must be true for start (security sensitive).",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "pairingCode",
      description:
        "6-digit one-time pairing code for start. Required unless MILADY_REMOTE_LOCAL_MODE=1.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "requesterIdentity",
      description:
        "Identifier for who is asking (entity id, friend name, device id). Logged for audit on start.",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Start a remote session with pairing code 482193, confirmed." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Remote session active. Connect via vnc://host:5900.",
          action: "OWNER_REMOTE_DESKTOP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Are any remote sessions open right now?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "No active remote sessions.",
          action: "OWNER_REMOTE_DESKTOP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "End the remote session rs_abc123." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Remote session rs_abc123 revoked.",
          action: "OWNER_REMOTE_DESKTOP",
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may manage remote desktop sessions.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as OwnerRemoteDesktopParameters;
    const subaction = coerceSubaction(params.subaction);
    if (!subaction) {
      return {
        text: "Missing or invalid subaction. Use one of: start, end, status, list, revoke.",
        success: false,
        values: { success: false, error: "INVALID_SUBACTION" },
        data: { actionName: ACTION_NAME },
      };
    }

    if (subaction === "revoke") {
      return (await revokeRemoteSessionAction.handler(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }

    if (subaction === "list") {
      return (await listRemoteSessionsAction.handler(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }

    if (subaction === "start") {
      // Prefer the service-backed start path (requires confirmed; optional pairing code).
      return (await startRemoteSessionAction.handler(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }

    // status / end — forward to the legacy backend router.
    const forwarded: HandlerOptions = {
      ...(options ?? {}),
      parameters: {
        ...(options as HandlerOptions | undefined)?.parameters,
        subaction,
      },
    } as HandlerOptions;
    return (await remoteDesktopAction.handler(
      runtime,
      message,
      state,
      forwarded,
      callback,
    )) as ActionResult;
  },
};
