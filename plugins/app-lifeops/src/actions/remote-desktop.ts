import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  detectRemoteDesktopBackend,
  endRemoteSession as endStoredRemoteSession,
  getSessionStatus as getStoredSessionStatus,
  type RemoteDesktopSession,
} from "../lifeops/remote-desktop.js";
import {
  getRemoteSessionService,
  RemoteSessionError,
} from "../remote/remote-session-service.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";

const ACTION_NAME = "REMOTE_DESKTOP";

type RemoteSubaction = "start" | "status" | "end" | "list" | "revoke";

interface RemoteParams {
  sessionId?: string;
  confirmed?: boolean;
  pairingCode?: string;
  requesterIdentity?: string;
  intent?: string;
}

const SUBACTIONS: SubactionsMap<RemoteSubaction> = {
  start: {
    description:
      "Open a remote-control session via RemoteSessionService. Requires confirmed: true. " +
      "If running in local mode (ELIZA_REMOTE_LOCAL_MODE=1) no pairing code is needed; " +
      "otherwise a valid 6-digit pairing code is required.",
    descriptionCompressed:
      "open remote session confirmed-true 6-digit-pairing local-mode-skips",
    required: ["confirmed"],
    optional: ["pairingCode"],
  },
  status: {
    description: "Look up one remote session by id via the stored session backend.",
    descriptionCompressed: "lookup remote session sessionId stored-session-backend",
    required: ["sessionId"],
  },
  end: {
    description: "Close a remote session by id via the stored session backend.",
    descriptionCompressed: "close remote session sessionId stored-session-backend",
    required: ["sessionId"],
  },
  list: {
    description:
      "List active remote sessions via RemoteSessionService with ids, statuses, ingress URLs, and local-mode hints.",
    descriptionCompressed:
      "list active remote sessions ids+status+ingress+local-mode-hint",
    required: [],
  },
  revoke: {
    description:
      "Revoke an active remote session by id via RemoteSessionService.",
    descriptionCompressed: "revoke active remote session sessionId",
    required: ["sessionId"],
  },
};

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatLegacySession(session: RemoteDesktopSession): string {
  const lines = [
    `Session ${session.id}`,
    `  backend: ${session.backend}`,
    `  status:  ${session.status}`,
  ];
  if (session.accessUrl) lines.push(`  url:     ${session.accessUrl}`);
  if (session.accessCode) lines.push(`  code:    ${session.accessCode}`);
  if (session.expiresAt) lines.push(`  expires: ${session.expiresAt}`);
  if (session.error) lines.push(`  error:   ${session.error}`);
  return lines.join("\n");
}

async function handleStart(
  message: Memory,
  params: RemoteParams,
): Promise<ActionResult> {
  const confirmed = params.confirmed === true;
  if (!confirmed) {
    const backend = await detectRemoteDesktopBackend();
    return {
      text:
        `Starting a remote desktop session will expose this machine to the network via ${backend}. ` +
        `Re-issue with confirmed: true to proceed.`,
      success: false,
      values: {
        success: false,
        error: "CONFIRMATION_REQUIRED",
        requiresConfirmation: true,
        backend,
      },
      data: {
        actionName: ACTION_NAME,
        subaction: "start",
        requiresConfirmation: true,
        backend,
        intent: params.intent ?? null,
      },
    };
  }

  const requesterIdentity =
    coerceString(params.requesterIdentity) ??
    String(message.entityId ?? "unknown");

  try {
    const result = await getRemoteSessionService().startSession({
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
        data: { actionName: ACTION_NAME, subaction: "start", session: result },
      };
    }

    if (result.ingressUrl === null) {
      return {
        text: `Remote session ${result.sessionId} is authorized but the data plane is not configured (${result.reason ?? "unknown"}). Configure Tailscale (T9b) or the Eliza Cloud tunnel to complete pixel transport.`,
        success: false,
        values: {
          success: false,
          error: "DATA_PLANE_NOT_CONFIGURED",
          requiresConfirmation: true,
          sessionId: result.sessionId,
          status: result.status,
          ingressUrl: null,
          reason: result.reason,
          localMode: result.localMode,
        },
        data: {
          actionName: ACTION_NAME,
          subaction: "start",
          requiresConfirmation: true,
          session: result,
        },
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
      data: { actionName: ACTION_NAME, subaction: "start", session: result },
    };
  } catch (error) {
    if (error instanceof RemoteSessionError) {
      return {
        text: error.message,
        success: false,
        values: { success: false, error: error.code },
        data: { actionName: ACTION_NAME, subaction: "start" },
      };
    }
    throw error;
  }
}

async function handleStatus(params: RemoteParams): Promise<ActionResult> {
  const sessionId = coerceString(params.sessionId);
  if (!sessionId) {
    return {
      text: "Missing sessionId.",
      success: false,
      values: { success: false, error: "MISSING_SESSION_ID" },
      data: { actionName: ACTION_NAME, subaction: "status" },
    };
  }
  const session = await getStoredSessionStatus(sessionId);
  if (!session) {
    return {
      text: `No session found with id ${sessionId}.`,
      success: false,
      values: { success: false, error: "SESSION_NOT_FOUND" },
      data: { actionName: ACTION_NAME, subaction: "status", sessionId },
    };
  }
  return {
    text: formatLegacySession(session),
    success: true,
    values: { success: true, status: session.status },
    data: { actionName: ACTION_NAME, subaction: "status", session },
  };
}

async function handleEnd(params: RemoteParams): Promise<ActionResult> {
  const sessionId = coerceString(params.sessionId);
  if (!sessionId) {
    return {
      text: "Missing sessionId.",
      success: false,
      values: { success: false, error: "MISSING_SESSION_ID" },
      data: { actionName: ACTION_NAME, subaction: "end" },
    };
  }
  const existing = await getStoredSessionStatus(sessionId);
  if (!existing) {
    return {
      text: `No session found with id ${sessionId}.`,
      success: false,
      values: { success: false, error: "SESSION_NOT_FOUND" },
      data: { actionName: ACTION_NAME, subaction: "end", sessionId },
    };
  }
  await endStoredRemoteSession(sessionId);
  return {
    text: `Remote session ${sessionId} ended.`,
    success: true,
    values: { success: true, sessionId },
    data: { actionName: ACTION_NAME, subaction: "end", sessionId },
  };
}

async function handleList(): Promise<ActionResult> {
  const sessions = await getRemoteSessionService().listActiveSessions();
  if (sessions.length === 0) {
    return {
      text: "No active remote sessions.",
      success: true,
      values: { success: true, count: 0 },
      data: { actionName: ACTION_NAME, subaction: "list", sessions: [] },
    };
  }
  const lines = sessions.map(
    (s) =>
      `• ${s.id} — status=${s.status}${
        s.ingressUrl
          ? ` ingress=${s.ingressUrl}`
          : ` ingress=<none:${s.reason ?? "unknown"}>`
      }${s.localMode ? " (local)" : ""}`,
  );
  return {
    text: `Active remote sessions (${sessions.length}):\n${lines.join("\n")}`,
    success: true,
    values: { success: true, count: sessions.length },
    data: { actionName: ACTION_NAME, subaction: "list", sessions },
  };
}

async function handleRevoke(params: RemoteParams): Promise<ActionResult> {
  const sessionId = coerceString(params.sessionId);
  if (!sessionId) {
    return {
      text: "Missing sessionId.",
      success: false,
      values: { success: false, error: "MISSING_SESSION_ID" },
      data: { actionName: ACTION_NAME, subaction: "revoke" },
    };
  }
  try {
    await getRemoteSessionService().revokeSession(sessionId);
    return {
      text: `Remote session ${sessionId} revoked.`,
      success: true,
      values: { success: true, sessionId },
      data: { actionName: ACTION_NAME, subaction: "revoke", sessionId },
    };
  } catch (error) {
    if (error instanceof RemoteSessionError) {
      return {
        text: error.message,
        success: false,
        values: { success: false, error: error.code, sessionId },
        data: { actionName: ACTION_NAME, subaction: "revoke", sessionId },
      };
    }
    throw error;
  }
}

export const remoteDesktopAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "REMOTE_SESSION",
    "VNC_SESSION",
    "REMOTE_CONTROL",
    "PHONE_REMOTE_ACCESS",
    "CONNECT_FROM_PHONE",
  ],
  description:
    "Manage remote-desktop sessions so the owner can connect to this machine from another device. " +
    "Subactions: start (open a session — requires confirmed:true and a pairing code in cloud mode), status (lookup by sessionId), end (close by sessionId), list (active sessions), revoke (revoke an active session by sessionId).",
  descriptionCompressed:
    "remote-desktop sessions: start|status|end|list|revoke; start requires confirmed:true (+ pairing code in cloud mode)",
  tags: [
    "domain:meta",
    "capability:read",
    "capability:write",
    "capability:execute",
    "capability:delete",
    "surface:device",
    "surface:internal",
    "risk:irreversible",
  ],
  contexts: ["browser", "automation", "settings", "admin", "terminal"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async () => true,

  parameters: [
    {
      name: "action",
      description: "One of: start, status, end, list, revoke.",
      descriptionCompressed: "remote-desktop action: start|status|end|list|revoke",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["start", "status", "end", "list", "revoke"],
      },
      examples: ["start", "list", "revoke"],
    },
    {
      name: "sessionId",
      description:
        "Session id - required for status, end, and revoke actions.",
      descriptionCompressed: "session id (status|end|revoke)",
      required: false,
      schema: { type: "string" as const },
      examples: ["rs_abc123"],
    },
    {
      name: "confirmed",
      description: "Must be true for start (security sensitive).",
      descriptionCompressed: "true required for start (security)",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "pairingCode",
      description:
        "6-digit one-time pairing code for start. Required unless ELIZA_REMOTE_LOCAL_MODE=1.",
      descriptionCompressed:
        "6-digit pairing code (start; skipped in local mode)",
      required: false,
      schema: { type: "string" as const, pattern: "^[0-9]{6}$" },
      examples: ["482193"],
    },
    {
      name: "requesterIdentity",
      description:
        "Identifier for who is asking (entity id, friend name, device id). Logged for audit on start.",
      descriptionCompressed: "audit: requester id (start)",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Freeform owner intent / reason for the session. Logged for audit.",
      descriptionCompressed: "audit: owner reason",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Start a remote session with pairing code 482193, confirmed.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Remote session active. Connect via vnc://host:5900.",
          action: ACTION_NAME,
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
          action: ACTION_NAME,
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
          action: ACTION_NAME,
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
  ): Promise<ActionResult> => {
    const resolved = await resolveActionArgs<RemoteSubaction, RemoteParams>({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: SUBACTIONS,
    });
    if (!resolved.ok) {
      return {
        success: false,
        text: resolved.clarification,
        values: {
          success: false,
          error: "MISSING_REMOTE_DESKTOP_ARGUMENTS",
          missing: resolved.missing,
        },
        data: {
          actionName: ACTION_NAME,
          reason: "missing_arguments",
          missing: resolved.missing,
        },
      };
    }

    const { subaction, params } = resolved;
    switch (subaction) {
      case "start":
        return handleStart(message, params);
      case "status":
        return handleStatus(params);
      case "end":
        return handleEnd(params);
      case "list":
        return handleList();
      case "revoke":
        return handleRevoke(params);
    }
  },
};
