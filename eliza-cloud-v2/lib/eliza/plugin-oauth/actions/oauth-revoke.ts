/**
 * OAUTH_REVOKE - Disconnect an OAuth platform.
 */

import {
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  type ActionResult,
  logger,
} from "@elizaos/core";
import { oauthService } from "@/lib/services/oauth";
import type { ActionWithParams } from "../../plugin-cloud-bootstrap/types";
import {
  getSupportedPlatforms,
  isSupportedPlatform,
  extractPlatform,
  lookupUser,
  isUserLookupError,
  capitalize,
  formatConnectionIdentifier,
} from "../utils";

export const oauthRevokeAction: ActionWithParams = {
  name: "OAUTH_REVOKE",
  similes: [
    "DISCONNECT", "REMOVE_CONNECTION", "UNLINK", "REVOKE_ACCESS",
    "DELETE_CONNECTION", "DISCONNECT_GOOGLE", "REMOVE_GOOGLE",
    "DISCONNECT_LINEAR", "DISCONNECT_SLACK", "DISCONNECT_GITHUB", "DISCONNECT_NOTION",
  ],
  description:
    "Disconnect an OAuth platform. Removes stored tokens and revokes access. Use when user wants to unlink or remove a connected account.",

  parameters: {
    platform: {
      type: "string",
      description: "Platform to disconnect: google, linear, slack, github, notion",
      required: true,
    },
  },

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return !!message.entityId;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const platform = extractPlatform(message, state);
    const actionName = "OAUTH_REVOKE";

    logger.info(`[${actionName}] platform=${platform}, entityId=${message.entityId}`);

    if (!platform) {
      return {
        text: "Which platform do you want to disconnect? Currently available: Google",
        success: false,
        error: "MISSING_PLATFORM",
        data: { actionName },
      };
    }

    if (!isSupportedPlatform(platform)) {
      const supported = getSupportedPlatforms();
      return {
        text: `Platform '${platform}' is not recognized. Supported: ${supported.length > 0 ? supported.join(", ") : "none configured"}`,
        success: false,
        error: "UNSUPPORTED_PLATFORM",
        data: { actionName },
      };
    }

    const userResult = await lookupUser(message.entityId as string, actionName);
    if (isUserLookupError(userResult)) return userResult;

    const { organizationId } = userResult;
    const platformName = capitalize(platform);

    const connections = await oauthService.listConnections({ organizationId, platform });
    const activeConnection = connections.find((c) => c.status === "active");

    if (!activeConnection) {
      const text = `${platformName} wasn't connected.`;
      if (callback) await callback({ text, actions: [actionName] });
      return { text, success: true, data: { actionName, wasConnected: false } };
    }

    await oauthService.revokeConnection({
      organizationId,
      connectionId: activeConnection.id,
    });

    const identifier = formatConnectionIdentifier(activeConnection);
    const text = identifier
      ? `${platformName} (${identifier}) has been disconnected.`
      : `${platformName} has been disconnected.`;

    logger.info(`[${actionName}] Revoked connection ${activeConnection.id}`);

    if (callback) await callback({ text, actions: [actionName] });
    return { text, success: true, data: { actionName, revokedConnectionId: activeConnection.id } };
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "disconnect google" } },
      { name: "{{name2}}", content: { text: "Google (user@gmail.com) has been disconnected.", actions: ["OAUTH_REVOKE"] } },
    ],
    [
      { name: "{{name1}}", content: { text: "unlink my gmail" } },
      { name: "{{name2}}", content: { text: "Google has been disconnected.", actions: ["OAUTH_REVOKE"] } },
    ],
  ] as ActionExample[][],
};
