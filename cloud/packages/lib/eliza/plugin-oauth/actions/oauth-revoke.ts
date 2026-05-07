/**
 * OAUTH_REVOKE - Disconnect an OAuth platform.
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
import { invalidateOAuthState } from "@/lib/services/oauth/invalidation";
import { type ActionWithParams, defineActionParameters } from "../../plugin-cloud-bootstrap/types";
import {
  capitalize,
  extractPlatform,
  formatConnectionIdentifier,
  getSupportedPlatforms,
  isSupportedPlatform,
  isUserLookupError,
  lookupUser,
} from "../utils";

const OAUTH_REVOKE_CONNECTION_LIMIT = 10;

export const oauthRevokeAction: ActionWithParams = {
  name: "OAUTH_REVOKE",
  contexts: ["connectors", "settings", "secrets"],
  contextGate: { anyOf: ["connectors", "settings", "secrets"] },
  similes: [
    "DISCONNECT",
    "REMOVE_CONNECTION",
    "UNLINK",
    "REVOKE_ACCESS",
    "DELETE_CONNECTION",
    "DISCONNECT_GOOGLE",
    "REMOVE_GOOGLE",
    "DISCONNECT_HUBSPOT",
    "REMOVE_HUBSPOT",
    "DISCONNECT_LINEAR",
    "DISCONNECT_SLACK",
    "DISCONNECT_GITHUB",
    "DISCONNECT_NOTION",
    "DISCONNECT_TWITTER",
    "DISCONNECT_X",
    "REMOVE_TWITTER",
    "UNLINK_TWITTER",
    "DISCONNECT_ASANA",
    "DISCONNECT_DROPBOX",
    "DISCONNECT_SALESFORCE",
    "DISCONNECT_AIRTABLE",
    "DISCONNECT_ZOOM",
    "DISCONNECT_JIRA",
    "REMOVE_JIRA",
    "UNLINK_JIRA",
    "DISCONNECT_LINKEDIN",
    "REMOVE_LINKEDIN",
    "UNLINK_LINKEDIN",
    "DISCONNECT_MICROSOFT",
    "DISCONNECT_OUTLOOK",
    "REMOVE_MICROSOFT",
  ],
  description:
    "Disconnect an OAuth platform. Removes stored tokens and revokes access. Use when user wants to unlink or remove a connected account. Available platforms: google, hubspot, linear, slack, github, notion, twitter, asana, dropbox, salesforce, airtable, zoom, jira, linkedin, microsoft.",

  parameters: defineActionParameters({
    platform: {
      type: "string",
      description:
        "Platform to disconnect: google, hubspot, linear, slack, github, notion, twitter, asana, dropbox, salesforce, airtable, zoom, jira, linkedin, microsoft",
      required: true,
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
    const platform = extractPlatform(message, state);
    const actionName = "OAUTH_REVOKE";

    logger.info(`[${actionName}] platform=${platform}, entityId=${message.entityId}`);

    if (!platform) {
      const supported = getSupportedPlatforms();
      return {
        text: `Which platform do you want to disconnect? Currently available: ${supported.map(capitalize).join(", ") || "none configured"}`,
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

    const { organizationId, user } = userResult;
    const platformName = capitalize(platform);

    const connections = await oauthService.listConnections({
      organizationId,
      userId: user.id,
      platform,
    });
    const activeConnection = connections
      .slice(0, OAUTH_REVOKE_CONNECTION_LIMIT)
      .find((c) => c.status === "active");

    if (!activeConnection) {
      const text = `${platformName} wasn't connected.`;
      if (callback) await callback({ text, actions: [actionName] });
      return { text, success: true, data: { actionName, wasConnected: false } };
    }

    await oauthService.revokeConnection({
      organizationId,
      connectionId: activeConnection.id,
    });

    await invalidateOAuthState(organizationId, platform, userResult.user.id, {
      skipVersionBump: true,
    });

    const identifier = formatConnectionIdentifier(activeConnection);
    const text = identifier
      ? `${platformName} (${identifier}) has been disconnected.`
      : `${platformName} has been disconnected.`;

    logger.info(`[${actionName}] Revoked connection ${activeConnection.id}`);

    if (callback) await callback({ text, actions: [actionName] });
    return {
      text,
      success: true,
      data: { actionName, revokedConnectionId: activeConnection.id },
    };
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "disconnect google" } },
      {
        name: "{{name2}}",
        content: {
          text: "Google (user@gmail.com) has been disconnected.",
          actions: ["OAUTH_REVOKE"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "unlink my gmail" } },
      {
        name: "{{name2}}",
        content: {
          text: "Google has been disconnected.",
          actions: ["OAUTH_REVOKE"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "disconnect hubspot" } },
      {
        name: "{{name2}}",
        content: {
          text: "HubSpot has been disconnected.",
          actions: ["OAUTH_REVOKE"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "disconnect my twitter" } },
      {
        name: "{{name2}}",
        content: {
          text: "Twitter has been disconnected.",
          actions: ["OAUTH_REVOKE"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "remove my x account" } },
      {
        name: "{{name2}}",
        content: {
          text: "Twitter has been disconnected.",
          actions: ["OAUTH_REVOKE"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "remove my slack connection" } },
      {
        name: "{{name2}}",
        content: {
          text: "Slack has been disconnected.",
          actions: ["OAUTH_REVOKE"],
        },
      },
    ],
  ] as ActionExample[][],
};
