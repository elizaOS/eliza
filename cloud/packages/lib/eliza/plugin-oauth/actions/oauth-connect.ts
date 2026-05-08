/**
 * OAUTH_CONNECT - Starts an OAuth connection flow for a supported platform.
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
import { type ActionWithParams, defineActionParameters } from "../../plugin-cloud-bootstrap/types";
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

function normalizeRole(value: unknown): OAuthConnectionRole | undefined {
  return value === "agent" || value === "owner" ? value : undefined;
}

function normalizeScopes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = value.filter((scope): scope is string => typeof scope === "string" && !!scope);
  return scopes.length > 0 ? scopes : undefined;
}

function failureResult(
  actionName: string,
  text: string,
  error: string,
  data: Record<string, unknown> = {},
): ActionResult {
  return {
    text,
    success: false,
    error,
    data: { actionName, ...data },
  };
}

export const oauthConnectAction: ActionWithParams = {
  name: "OAUTH_CONNECT",
  contexts: ["connectors", "settings", "secrets"],
  contextGate: { anyOf: ["connectors", "settings", "secrets"] },
  roleGate: { minRole: "OWNER" },
  similes: [
    "CONNECT_ACCOUNT",
    "CONNECT_OAUTH",
    "LINK_ACCOUNT",
    "LINK_INTEGRATION",
    "ADD_CONNECTION",
    "AUTHORIZE_APP",
    "CONNECT_GOOGLE",
    "CONNECT_SLACK",
    "CONNECT_GITHUB",
    "CONNECT_TWITTER",
    "CONNECT_X",
    "CONNECT_MICROSOFT",
  ],
  description:
    "Connect an OAuth platform for the user. Generate an authorization URL when the user asks to connect an account or integration.",

  parameters: defineActionParameters({
    platform: {
      type: "string",
      description:
        "Platform to connect, such as google, linear, slack, github, notion, twitter, jira, linkedin, or microsoft.",
      required: true,
    },
    redirectUrl: {
      type: "string",
      description: "Optional URL to redirect to after OAuth completes.",
      required: false,
    },
    connectionRole: {
      type: "string",
      description: "Connection role: owner or agent.",
      required: false,
      enum: ["owner", "agent"],
    },
    scopes: {
      type: "array",
      description: "Optional OAuth scopes to request.",
      required: false,
    },
  }),

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return !!message.entityId;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const actionName = "OAUTH_CONNECT";
    const params = extractParams(message, state);
    const platform = extractPlatform(message, state);

    if (!platform) {
      const supported = getSupportedPlatforms();
      return failureResult(
        actionName,
        `Which platform do you want to connect? Currently available: ${supported.map(capitalize).join(", ") || "none configured"}`,
        "MISSING_PLATFORM",
      );
    }

    if (!isSupportedPlatform(platform)) {
      const supported = getSupportedPlatforms();
      return failureResult(
        actionName,
        `Platform '${platform}' is not available. Supported: ${supported.length > 0 ? supported.join(", ") : "none configured"}`,
        "UNSUPPORTED_PLATFORM",
        { platform },
      );
    }

    logger.info(`[${actionName}] platform=${platform}, entityId=${message.entityId}`);

    const userResult = await lookupUser(message.entityId as string, actionName);
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
        const active = connections.find((connection) => connection.status === "active");
        const identifier = active ? formatConnectionIdentifier(active) : "";
        const text = `Your ${platformName} account is already connected${identifier ? ` (${identifier})` : ""}.`;
        if (callback) await callback({ text, actions: [actionName] });
        return {
          text,
          success: true,
          data: { actionName, alreadyConnected: true, platform },
        };
      }

      const result = await oauthService.initiateAuth({
        organizationId,
        userId: user.id,
        platform,
        redirectUrl: typeof params.redirectUrl === "string" ? params.redirectUrl : undefined,
        scopes: normalizeScopes(params.scopes),
        connectionRole: normalizeRole(params.connectionRole),
      });

      if (!result.authUrl) {
        return failureResult(
          actionName,
          "Failed to generate authorization link. Please try again.",
          "AUTH_URL_GENERATION_FAILED",
          { platform },
        );
      }

      const text = `Open this link to connect ${platformName}: ${result.authUrl}`;
      if (callback) await callback({ text, actions: [actionName] });
      return {
        text,
        success: true,
        data: { actionName, platform, authUrl: result.authUrl, state: result.state },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ platform, error: errorMessage }, `[${actionName}] failed to start OAuth`);
      return failureResult(
        actionName,
        `Failed to start ${platformName} connection. Please try again later.`,
        "OAUTH_INITIATION_FAILED",
        { platform, errorMessage },
      );
    }
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "connect google" } },
      {
        name: "{{name2}}",
        content: {
          text: "Open this link to connect Google: https://example.com/oauth",
          actions: ["OAUTH_CONNECT"],
        },
      },
    ],
  ] as ActionExample[][],
};
