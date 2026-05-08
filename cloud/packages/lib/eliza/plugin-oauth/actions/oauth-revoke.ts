/**
 * OAUTH_REVOKE - Revokes a connected OAuth platform.
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
  getSupportedPlatforms,
  isSupportedPlatform,
  isUserLookupError,
  lookupUser,
} from "../utils";

function normalizeRole(value: unknown): OAuthConnectionRole | undefined {
  return value === "agent" || value === "owner" ? value : undefined;
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

export const oauthRevokeAction: ActionWithParams = {
  name: "OAUTH_REVOKE",
  contexts: ["connectors", "settings", "secrets"],
  contextGate: { anyOf: ["connectors", "settings", "secrets"] },
  roleGate: { minRole: "OWNER" },
  similes: [
    "DISCONNECT_ACCOUNT",
    "DISCONNECT_OAUTH",
    "UNLINK_ACCOUNT",
    "REMOVE_CONNECTION",
    "REVOKE_CONNECTION",
    "DISCONNECT_GOOGLE",
    "DISCONNECT_SLACK",
    "DISCONNECT_GITHUB",
    "DISCONNECT_TWITTER",
    "DISCONNECT_X",
    "DISCONNECT_MICROSOFT",
  ],
  description:
    "Disconnect an OAuth platform. Removes stored tokens and revokes access when the user asks to unlink or remove a connected account.",

  parameters: defineActionParameters({
    platform: {
      type: "string",
      description:
        "Platform to disconnect, such as google, linear, slack, github, notion, twitter, jira, linkedin, or microsoft.",
      required: true,
    },
    connectionRole: {
      type: "string",
      description: "Connection role: owner or agent.",
      required: false,
      enum: ["owner", "agent"],
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
    const actionName = "OAUTH_REVOKE";
    const params = extractParams(message, state);
    const platform = extractPlatform(message, state);

    if (!platform) {
      const supported = getSupportedPlatforms();
      return failureResult(
        actionName,
        `Which platform do you want to disconnect? Currently available: ${supported.map(capitalize).join(", ") || "none configured"}`,
        "MISSING_PLATFORM",
      );
    }

    if (!isSupportedPlatform(platform)) {
      const supported = getSupportedPlatforms();
      return failureResult(
        actionName,
        `Platform '${platform}' is not recognized. Supported: ${supported.length > 0 ? supported.join(", ") : "none configured"}`,
        "UNSUPPORTED_PLATFORM",
        { platform },
      );
    }

    logger.info(`[${actionName}] platform=${platform}, entityId=${message.entityId}`);

    const userResult = await lookupUser(message.entityId as string, actionName);
    if (isUserLookupError(userResult)) return userResult;

    const { organizationId, user } = userResult;
    const platformName = capitalize(platform);

    const connections = await oauthService.listConnections({
      organizationId,
      userId: user.id,
      platform,
      connectionRole: normalizeRole(params.connectionRole),
    });
    const activeConnection = connections.find((connection) => connection.status === "active");

    if (!activeConnection) {
      const text = `${platformName} wasn't connected.`;
      if (callback) await callback({ text, actions: [actionName] });
      return { text, success: true, data: { actionName, wasConnected: false, platform } };
    }

    await oauthService.revokeConnection({
      organizationId,
      connectionId: activeConnection.id,
    });

    const text = `${platformName} has been disconnected.`;
    if (callback) await callback({ text, actions: [actionName] });
    return {
      text,
      success: true,
      data: { actionName, platform, revokedConnectionId: activeConnection.id },
    };
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "disconnect google" } },
      {
        name: "{{name2}}",
        content: {
          text: "Google has been disconnected.",
          actions: ["OAUTH_REVOKE"],
        },
      },
    ],
  ] as ActionExample[][],
};
