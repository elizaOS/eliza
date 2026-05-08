/**
 * OAUTH - Consolidated cloud OAuth action.
 *
 * Single Pattern C action keyed by `op` (connect | get | list | revoke).
 * Replaces the four leaf actions OAUTH_CONNECT / OAUTH_GET / OAUTH_LIST /
 * OAUTH_REVOKE. Old leaf names live as similes so older inbound callers still
 * resolve.
 */

import {
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { oauthService } from "@/lib/services/oauth";
import { type OAuthConnectionRole } from "@/lib/services/oauth/types";
import {
  type ActionWithParams,
  defineActionParameters,
} from "../../plugin-cloud-bootstrap/types";
import {
  capitalize,
  extractParams,
  extractPlatform,
  formatConnectionIdentifier,
  getSupportedPlatforms,
  isSupportedPlatform,
  isUserLookupError,
  lookupUser,
} from "../utils";

const OAUTH_OPS = ["connect", "get", "list", "revoke"] as const;
type OAuthOp = (typeof OAUTH_OPS)[number];

function normalizeRole(value: unknown): OAuthConnectionRole | undefined {
  return value === "agent" || value === "owner" ? value : undefined;
}

function normalizeScopes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = value.filter(
    (scope): scope is string => typeof scope === "string" && !!scope,
  );
  return scopes.length > 0 ? scopes : undefined;
}

function normalizeOp(value: unknown): OAuthOp | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, OAuthOp> = {
    connect_account: "connect",
    connect_oauth: "connect",
    link: "connect",
    link_account: "connect",
    add: "connect",
    add_connection: "connect",
    authorize: "connect",
    authorize_app: "connect",
    check: "get",
    check_connection: "get",
    verify: "get",
    verify_connection: "get",
    status: "get",
    is_connected: "get",
    show: "list",
    show_connections: "list",
    list_connections: "list",
    my_accounts: "list",
    connected_apps: "list",
    disconnect: "revoke",
    disconnect_account: "revoke",
    disconnect_oauth: "revoke",
    unlink: "revoke",
    unlink_account: "revoke",
    remove: "revoke",
    remove_connection: "revoke",
    revoke_connection: "revoke",
  };
  if (aliases[normalized]) return aliases[normalized];
  return (OAUTH_OPS as readonly string[]).includes(normalized)
    ? (normalized as OAuthOp)
    : null;
}

function inferOpFromMessage(text: string): OAuthOp | null {
  const lower = text.toLowerCase();
  if (
    /\b(disconnect|unlink|remove|revoke)\b/.test(lower) &&
    /\b(account|connection|oauth)\b/.test(lower)
  ) {
    return "revoke";
  }
  if (
    /\b(disconnect|unlink|revoke)\b/.test(lower) ||
    /\bdisconnect\s+(google|slack|github|twitter|x|microsoft|notion|jira|linkedin|asana|dropbox|salesforce|airtable|zoom|linear)\b/.test(
      lower,
    )
  ) {
    return "revoke";
  }
  if (
    /\b(connect|link|authorize|add)\b.*\b(google|slack|github|twitter|x|microsoft|notion|jira|linkedin|asana|dropbox|salesforce|airtable|zoom|linear|account|oauth|integration)\b/.test(
      lower,
    ) ||
    /\bconnect\s+(google|slack|github|twitter|x|microsoft|notion|jira|linkedin|asana|dropbox|salesforce|airtable|zoom|linear)\b/.test(
      lower,
    )
  ) {
    return "connect";
  }
  if (
    /\b(list|show|what)\b.*\b(connection|account|integration)s?\b/.test(lower) ||
    /\b(my|all)\s+(connection|account|integration)s?\b/.test(lower) ||
    /\bconnected\s+apps?\b/.test(lower)
  ) {
    return "list";
  }
  if (
    /\b(check|verify|status|is\s+(my|the))\b.*\b(connect|connection|connected)\b/.test(
      lower,
    ) ||
    /^\s*(done|finished|completed)\s*[!?.]?\s*$/.test(lower) ||
    /\bdid\s+it\s+work\b/.test(lower)
  ) {
    return "get";
  }
  return null;
}

function failureResult(
  text: string,
  error: string,
  data: Record<string, unknown> = {},
): ActionResult {
  return {
    text,
    success: false,
    error,
    data: { actionName: "OAUTH", ...data },
  };
}

async function runConnect(
  message: Memory,
  state: State | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const params = extractParams(message, state);
  const platform = extractPlatform(message, state);

  if (!platform) {
    const supported = getSupportedPlatforms();
    return failureResult(
      `Which platform do you want to connect? Currently available: ${supported.map(capitalize).join(", ") || "none configured"}`,
      "MISSING_PLATFORM",
      { op: "connect" },
    );
  }

  if (!isSupportedPlatform(platform)) {
    const supported = getSupportedPlatforms();
    return failureResult(
      `Platform '${platform}' is not available. Supported: ${supported.length > 0 ? supported.join(", ") : "none configured"}`,
      "UNSUPPORTED_PLATFORM",
      { op: "connect", platform },
    );
  }

  logger.info(`[OAUTH/connect] platform=${platform}, entityId=${message.entityId}`);

  const userResult = await lookupUser(message.entityId as string, "OAUTH");
  if (isUserLookupError(userResult)) return userResult;

  const { organizationId, user } = userResult;
  const platformName = capitalize(platform);

  try {
    const alreadyConnected = await oauthService.isPlatformConnected(
      organizationId,
      platform,
      user.id,
      normalizeRole(params.connectionRole),
    );

    if (alreadyConnected) {
      const connections = await oauthService.listConnections({
        organizationId,
        userId: user.id,
        platform,
        connectionRole: normalizeRole(params.connectionRole),
      });
      const active = connections.find((c) => c.status === "active");
      const identifier = active ? formatConnectionIdentifier(active) : "";
      const text = `Your ${platformName} account is already connected${identifier ? ` (${identifier})` : ""}.`;
      if (callback) await callback({ text, actions: ["OAUTH"] });
      return {
        text,
        success: true,
        data: {
          actionName: "OAUTH",
          op: "connect",
          alreadyConnected: true,
          platform,
        },
      };
    }

    const result = await oauthService.initiateAuth({
      organizationId,
      userId: user.id,
      platform,
      redirectUrl:
        typeof params.redirectUrl === "string" ? params.redirectUrl : undefined,
      scopes: normalizeScopes(params.scopes),
      connectionRole: normalizeRole(params.connectionRole),
    });

    if (!result.authUrl) {
      return failureResult(
        "Failed to generate authorization link. Please try again.",
        "AUTH_URL_GENERATION_FAILED",
        { op: "connect", platform },
      );
    }

    const text = `Open this link to connect ${platformName}: ${result.authUrl}`;
    if (callback) await callback({ text, actions: ["OAUTH"] });
    return {
      text,
      success: true,
      data: {
        actionName: "OAUTH",
        op: "connect",
        platform,
        authUrl: result.authUrl,
        state: result.state,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      { platform, error: errorMessage },
      "[OAUTH/connect] failed to start OAuth",
    );
    return failureResult(
      `Failed to start ${platformName} connection. Please try again later.`,
      "OAUTH_INITIATION_FAILED",
      { op: "connect", platform, errorMessage },
    );
  }
}

async function runGet(
  message: Memory,
  state: State | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const platform = extractPlatform(message, state);

  logger.info(`[OAUTH/get] platform=${platform || "all"}, entityId=${message.entityId}`);

  const userResult = await lookupUser(message.entityId as string, "OAUTH");
  if (isUserLookupError(userResult)) return userResult;

  const { organizationId, user } = userResult;

  try {
    if (platform) {
      const isConnected = await oauthService.isPlatformConnected(
        organizationId,
        platform,
        user.id,
      );
      const platformName = capitalize(platform);

      if (isConnected) {
        const connections = await oauthService.listConnections({
          organizationId,
          userId: user.id,
          platform,
        });
        const active = connections.find((c) => c.status === "active");
        const identifier = active ? formatConnectionIdentifier(active) : "";
        const text = identifier
          ? `${platformName} is connected! Logged in as ${identifier}.\n\nYou're all set — I can now help you with ${platformName} tasks. What would you like to do?`
          : `${platformName} is connected!\n\nYou're all set — what would you like to do with it?`;

        if (callback) await callback({ text, actions: ["OAUTH"] });
        return {
          text,
          success: true,
          data: {
            actionName: "OAUTH",
            op: "get",
            connected: true,
            platform,
            identifier: identifier || undefined,
          },
        };
      }

      const text = `${platformName} isn't connected yet. Say "connect ${platform}" and I'll generate a fresh link for you.`;
      if (callback) await callback({ text, actions: ["OAUTH"] });
      return {
        text,
        success: true,
        data: { actionName: "OAUTH", op: "get", connected: false, platform },
      };
    }

    const connections = await oauthService.listConnections({
      organizationId,
      userId: user.id,
    });
    const active = connections.filter((c) => c.status === "active");

    if (active.length === 0) {
      const text =
        'You don\'t have any connected accounts yet. Try saying "connect google" or "connect twitter" to get started — it only takes a few seconds.';
      if (callback) await callback({ text, actions: ["OAUTH"] });
      return {
        text,
        success: true,
        data: { actionName: "OAUTH", op: "get", connections: [] },
      };
    }

    const list = active
      .map((c) => {
        const id = formatConnectionIdentifier(c);
        return id ? `${capitalize(c.platform)} (${id})` : capitalize(c.platform);
      })
      .join(", ");

    const text = `Connected: ${list}`;
    if (callback) await callback({ text, actions: ["OAUTH"] });
    return {
      text,
      success: true,
      data: {
        actionName: "OAUTH",
        op: "get",
        count: active.length,
        connections: active.slice(0, 10).map((c) => ({
          platform: c.platform,
          status: c.status,
          identifier: formatConnectionIdentifier(c) || "",
        })),
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to check OAuth connection status.";
    logger.error("[OAUTH/get] failed to load connection status", errorMessage);
    return failureResult(
      platform
        ? `I couldn't check your ${capitalize(platform)} connection right now.`
        : "I couldn't check your connected accounts right now.",
      "oauth_status_check_failed",
      {
        op: "get",
        platform: platform || null,
        errorMessage,
      },
    );
  }
}

async function runList(
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  logger.info(`[OAUTH/list] entityId=${message.entityId}`);

  const userResult = await lookupUser(message.entityId as string, "OAUTH");
  if (isUserLookupError(userResult)) return userResult;

  const { organizationId, user } = userResult;
  const connections = await oauthService.listConnections({
    organizationId,
    userId: user.id,
  });

  if (connections.length === 0) {
    const text =
      "You don't have any connected accounts. Say 'connect google' to get started.";
    if (callback) await callback({ text, actions: ["OAUTH"] });
    return {
      text,
      success: true,
      data: { actionName: "OAUTH", op: "list", count: 0 },
    };
  }

  const lines = connections.map((c) => {
    const name = capitalize(c.platform);
    const id = formatConnectionIdentifier(c);
    const status = c.status === "active" ? "active" : c.status;
    return id ? `• ${name}: ${id} (${status})` : `• ${name}: ${status}`;
  });

  const activeCount = connections.filter((c) => c.status === "active").length;
  const header =
    activeCount === connections.length
      ? "Your connected accounts:"
      : `Your connections (${activeCount} active):`;

  const text = `${header}\n${lines.join("\n")}`;

  logger.info(`[OAUTH/list] Found ${connections.length} connections`);

  if (callback) await callback({ text, actions: ["OAUTH"] });
  return {
    text,
    success: true,
    data: {
      actionName: "OAUTH",
      op: "list",
      count: connections.length,
      activeCount,
    },
  };
}

async function runRevoke(
  message: Memory,
  state: State | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const params = extractParams(message, state);
  const platform = extractPlatform(message, state);

  if (!platform) {
    const supported = getSupportedPlatforms();
    return failureResult(
      `Which platform do you want to disconnect? Currently available: ${supported.map(capitalize).join(", ") || "none configured"}`,
      "MISSING_PLATFORM",
      { op: "revoke" },
    );
  }

  if (!isSupportedPlatform(platform)) {
    const supported = getSupportedPlatforms();
    return failureResult(
      `Platform '${platform}' is not recognized. Supported: ${supported.length > 0 ? supported.join(", ") : "none configured"}`,
      "UNSUPPORTED_PLATFORM",
      { op: "revoke", platform },
    );
  }

  logger.info(`[OAUTH/revoke] platform=${platform}, entityId=${message.entityId}`);

  const userResult = await lookupUser(message.entityId as string, "OAUTH");
  if (isUserLookupError(userResult)) return userResult;

  const { organizationId, user } = userResult;
  const platformName = capitalize(platform);

  const connections = await oauthService.listConnections({
    organizationId,
    userId: user.id,
    platform,
    connectionRole: normalizeRole(params.connectionRole),
  });
  const activeConnection = connections.find((c) => c.status === "active");

  if (!activeConnection) {
    const text = `${platformName} wasn't connected.`;
    if (callback) await callback({ text, actions: ["OAUTH"] });
    return {
      text,
      success: true,
      data: {
        actionName: "OAUTH",
        op: "revoke",
        wasConnected: false,
        platform,
      },
    };
  }

  await oauthService.revokeConnection({
    organizationId,
    connectionId: activeConnection.id,
  });

  const text = `${platformName} has been disconnected.`;
  if (callback) await callback({ text, actions: ["OAUTH"] });
  return {
    text,
    success: true,
    data: {
      actionName: "OAUTH",
      op: "revoke",
      platform,
      revokedConnectionId: activeConnection.id,
    },
  };
}

export const oauthAction: ActionWithParams = {
  name: "OAUTH",
  contexts: ["connectors", "settings", "secrets"],
  contextGate: { anyOf: ["connectors", "settings", "secrets"] },
  // OWNER for connect/revoke; ADMIN for get/list. Per-op gate handled in handler.
  roleGate: { minRole: "ADMIN" },
  similes: [
    "OAUTH_CONNECT",
    "OAUTH_GET",
    "OAUTH_LIST",
    "OAUTH_REVOKE",
    "CONNECT_ACCOUNT",
    "CONNECT_OAUTH",
    "LINK_ACCOUNT",
    "LINK_INTEGRATION",
    "ADD_CONNECTION",
    "AUTHORIZE_APP",
    "CHECK_CONNECTION",
    "VERIFY_CONNECTION",
    "CONNECTION_STATUS",
    "IS_CONNECTED",
    "DONE",
    "FINISHED",
    "COMPLETED",
    "DID_IT_WORK",
    "LIST_CONNECTIONS",
    "SHOW_CONNECTIONS",
    "MY_ACCOUNTS",
    "CONNECTED_APPS",
    "WHAT_IS_CONNECTED",
    "MY_INTEGRATIONS",
    "SHOW_INTEGRATIONS",
    "DISCONNECT_ACCOUNT",
    "DISCONNECT_OAUTH",
    "UNLINK_ACCOUNT",
    "REMOVE_CONNECTION",
    "REVOKE_CONNECTION",
  ],
  description:
    "Manage cloud OAuth connections. Operations: connect (start an OAuth flow), get (check connection status), list (show all connected accounts), revoke (disconnect a platform). Supported platforms: google, linear, slack, github, notion, twitter, jira, linkedin, microsoft, asana, dropbox, salesforce, airtable, zoom. The op is inferred from message text when not explicitly provided.",

  parameters: defineActionParameters({
    op: {
      type: "string",
      description:
        "Operation to perform: connect, get, list, or revoke. Inferred from message text when omitted.",
      required: false,
      enum: ["connect", "get", "list", "revoke"],
    },
    platform: {
      type: "string",
      description:
        "Platform to act on (e.g. google, linear, slack, github, notion, twitter, jira, linkedin, microsoft, asana, dropbox, salesforce, airtable, zoom). Required for connect/revoke; optional for get (omit to check all).",
      required: false,
    },
    redirectUrl: {
      type: "string",
      description:
        "For op=connect: optional URL to redirect to after OAuth completes.",
      required: false,
    },
    connectionRole: {
      type: "string",
      description:
        "For op=connect or op=revoke: connection role: owner or agent.",
      required: false,
      enum: ["owner", "agent"],
    },
    scopes: {
      type: "array",
      description: "For op=connect: optional OAuth scopes to request.",
      required: false,
    },
  }),

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return !!message.entityId;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = extractParams(message, state);
    const explicitOp = normalizeOp(params.op ?? params.subaction);
    const op =
      explicitOp ??
      inferOpFromMessage(
        typeof message.content?.text === "string" ? message.content.text : "",
      );

    if (!op) {
      const text = `OAUTH could not determine the operation. Specify one of: ${OAUTH_OPS.join(", ")}.`;
      if (callback) await callback({ text, actions: ["OAUTH"] });
      return {
        success: false,
        text,
        values: { error: "MISSING_OP" },
        data: {
          actionName: "OAUTH",
          availableOps: [...OAUTH_OPS],
        },
      };
    }

    switch (op) {
      case "connect":
        return runConnect(message, state, callback);
      case "get":
        return runGet(message, state, callback);
      case "list":
        return runList(message, callback);
      case "revoke":
        return runRevoke(message, state, callback);
    }
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "connect google" } },
      {
        name: "{{name2}}",
        content: {
          text: "Open this link to connect Google: https://example.com/oauth",
          actions: ["OAUTH"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "is my google connected?" } },
      {
        name: "{{name2}}",
        content: {
          text: "Google is connected! Logged in as user@gmail.com.",
          actions: ["OAUTH"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "what accounts are connected?" } },
      {
        name: "{{name2}}",
        content: {
          text: "Your connected accounts:\n• Google: user@gmail.com (active)",
          actions: ["OAUTH"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "disconnect google" } },
      {
        name: "{{name2}}",
        content: {
          text: "Google has been disconnected.",
          actions: ["OAUTH"],
        },
      },
    ],
  ] as ActionExample[][],
};
