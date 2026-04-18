import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import {
  detectRemoteDesktopBackend,
  endRemoteSession,
  getSessionStatus,
  listActiveSessions,
  startRemoteSession,
  type RemoteDesktopSession,
} from "../lifeops/remote-desktop.js";

const ACTION_NAME = "REMOTE_DESKTOP";

type RemoteDesktopSubaction = "start" | "status" | "end" | "list";

interface RemoteDesktopParameters {
  subaction?: RemoteDesktopSubaction | string;
  intent?: string;
  sessionId?: string;
  confirmed?: boolean;
}

function parseLooseParameterString(raw: unknown): Partial<RemoteDesktopParameters> {
  if (typeof raw !== "string") {
    return {};
  }
  const subactionMatch = raw.match(
    /\bsubaction\s*[:=]\s*["']?([a-z_]+)["']?/i,
  );
  const intentMatch = raw.match(/\bintent\s*[:=]\s*["']?([^,"']+)["']?/i);
  const sessionIdMatch = raw.match(
    /\bsessionId\s*[:=]\s*["']?([a-z0-9-]+)["']?/i,
  );
  const confirmedMatch = raw.match(/\bconfirmed\s*[:=]\s*(true|false)\b/i);
  return {
    subaction: subactionMatch?.[1],
    intent: intentMatch?.[1]?.trim(),
    sessionId: sessionIdMatch?.[1],
    confirmed:
      confirmedMatch?.[1] != null
        ? confirmedMatch[1].toLowerCase() === "true"
        : undefined,
  };
}

function coerceSubaction(value: unknown): RemoteDesktopSubaction | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "start" ||
    normalized === "status" ||
    normalized === "end" ||
    normalized === "list"
  ) {
    return normalized;
  }
  return undefined;
}

function inferSubactionFromText(
  text: string,
): RemoteDesktopSubaction | undefined {
  const lower = text.toLowerCase();
  if (!lower.trim()) return undefined;
  if (/\b(list|show|what)\b.*\b(remote|sessions?|vnc)\b/.test(lower)) {
    return "list";
  }
  if (
    /\b(status|check|how is|is the)\b.*\b(remote|session|vnc)\b/.test(lower)
  ) {
    return "status";
  }
  if (
    /\b(end|stop|close|terminate|kill|disconnect)\b.*\b(remote|session|vnc)\b/.test(
      lower,
    )
  ) {
    return "end";
  }
  if (
    /\b(start|open|begin|launch|initiate|set up|setup|create)\b.*\b(remote|session|vnc|screen share|desktop)\b/.test(
      lower,
    ) ||
    /\b(connect|access|control)\b.*\b(from my phone|from another|remotely)\b/.test(
      lower,
    )
  ) {
    return "start";
  }
  return undefined;
}

function inferConfirmedFromText(text: string): boolean | undefined {
  const lower = text.toLowerCase();
  if (
    /\bconfirmed\s*:\s*true\b/.test(lower) ||
    /\byes[, ]+confirmed\b/.test(lower) ||
    /\bplease proceed\b/.test(lower)
  ) {
    return true;
  }
  if (/\bconfirmed\s*:\s*false\b/.test(lower)) {
    return false;
  }
  return undefined;
}

function formatSession(session: RemoteDesktopSession): string {
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

export const remoteDesktopAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "REMOTE_SESSION",
    "VNC_SESSION",
    "REMOTE_CONTROL",
    "PHONE_REMOTE_ACCESS",
  ],
  description:
    "Start or end a secure remote desktop session so you can view/control the computer from another device. Requires a pairing code. Use this only for remote-session lifecycle work (start, status, end, list), not for local Finder/Desktop automation, screenshots, browser workflows, or file handling on this machine — those belong to LIFEOPS_COMPUTER_USE.",
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  parameters: [
    {
      name: "subaction",
      description: "One of: start, status, end, list.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Freeform owner intent / reason for the session. Logged for audit.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sessionId",
      description: "Session id required for status and end subactions.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Must be true to actually start a remote session (security sensitive).",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Open a remote desktop so I can help from my phone",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'This will expose your desktop to the network. Re-issue with confirmed: true to start the session.',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Yes, confirmed — start the remote session" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Remote session active. URL: vnc://host:5900 · pairing code: 482193 · expires in 60m.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "End the remote session" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Remote session ended." },
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
        text: "Permission denied: only the owner may manage remote desktop sessions.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const rawParameters = (options as HandlerOptions | undefined)?.parameters;
    const params = {
      ...parseLooseParameterString(rawParameters),
      ...((typeof rawParameters === "object" && rawParameters !== null
        ? (rawParameters as RemoteDesktopParameters)
        : {}) ?? {}),
    } satisfies RemoteDesktopParameters;

    const messageText =
      typeof message.content?.text === "string" ? message.content.text : "";
    const subaction =
      coerceSubaction(params.subaction) ??
      inferSubactionFromText(params.intent ?? "") ??
      inferSubactionFromText(messageText);
    if (!subaction) {
      return {
        text: "Missing or invalid subaction. Use one of: start, status, end, list.",
        success: false,
        values: { success: false, error: "INVALID_SUBACTION" },
        data: { actionName: ACTION_NAME },
      };
    }

    if (subaction === "list") {
      const active = await listActiveSessions();
      if (active.length === 0) {
        return {
          text: "No active remote desktop sessions.",
          success: true,
          values: { success: true, count: 0 },
          data: { actionName: ACTION_NAME, subaction, sessions: [] },
        };
      }
      return {
        text: active.map(formatSession).join("\n\n"),
        success: true,
        values: { success: true, count: active.length },
        data: { actionName: ACTION_NAME, subaction, sessions: active },
      };
    }

    if (subaction === "status") {
      const sessionId = params.sessionId?.trim();
      if (!sessionId) {
        return {
          text: "Missing sessionId.",
          success: false,
          values: { success: false, error: "MISSING_SESSION_ID" },
          data: { actionName: ACTION_NAME, subaction },
        };
      }
      const session = await getSessionStatus(sessionId);
      if (!session) {
        return {
          text: `No session found with id ${sessionId}.`,
          success: false,
          values: { success: false, error: "SESSION_NOT_FOUND" },
          data: { actionName: ACTION_NAME, subaction, sessionId },
        };
      }
      return {
        text: formatSession(session),
        success: true,
        values: { success: true, status: session.status },
        data: { actionName: ACTION_NAME, subaction, session },
      };
    }

    if (subaction === "end") {
      const sessionId = params.sessionId?.trim();
      if (!sessionId) {
        return {
          text: "Missing sessionId.",
          success: false,
          values: { success: false, error: "MISSING_SESSION_ID" },
          data: { actionName: ACTION_NAME, subaction },
        };
      }
      const existing = await getSessionStatus(sessionId);
      if (!existing) {
        return {
          text: `No session found with id ${sessionId}.`,
          success: false,
          values: { success: false, error: "SESSION_NOT_FOUND" },
          data: { actionName: ACTION_NAME, subaction, sessionId },
        };
      }
      await endRemoteSession(sessionId);
      return {
        text: `Remote session ${sessionId} ended.`,
        success: true,
        values: { success: true, sessionId },
        data: { actionName: ACTION_NAME, subaction, sessionId },
      };
    }

    // subaction === "start"
    const confirmed =
      params.confirmed === true
        ? true
        : (inferConfirmedFromText(params.intent ?? messageText) ?? false);
    if (!confirmed) {
      const backend = await detectRemoteDesktopBackend();
      return {
        text:
          `Starting a remote desktop session will expose this machine to the network via ${backend}. ` +
          `Re-issue with confirmed: true to proceed.`,
        success: false,
        values: {
          success: false,
          requiresConfirmation: true,
          backend,
        },
        data: {
          actionName: ACTION_NAME,
          subaction,
          requiresConfirmation: true,
          backend,
          intent: params.intent ?? null,
        },
      };
    }

    const session = await startRemoteSession();

    if (session.status !== "active") {
      return {
        text: `Failed to start remote desktop session: ${
          session.error ?? "unknown error"
        }.`,
        success: false,
        values: {
          success: false,
          error: session.error ?? "START_FAILED",
          backend: session.backend,
        },
        data: { actionName: ACTION_NAME, subaction, session },
      };
    }

    return {
      text: `Remote session active.\n${formatSession(session)}\n\nShare the URL and pairing code out-of-band; the session auto-expires at ${session.expiresAt}.`,
      success: true,
      values: {
        success: true,
        sessionId: session.id,
        backend: session.backend,
        accessUrl: session.accessUrl ?? null,
        accessCode: session.accessCode ?? null,
        expiresAt: session.expiresAt ?? null,
      },
      data: { actionName: ACTION_NAME, subaction, session },
    };
  },
};
