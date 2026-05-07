/**
 * OAUTH_CONNECT - Initiates OAuth flow for a platform.
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
import { type ActionWithParams, defineActionParameters } from "../../plugin-cloud-bootstrap/types";
import {
  capitalize,
  extractPlatform,
  getSupportedPlatforms,
  isSupportedPlatform,
  isUserLookupError,
  lookupUser,
} from "../utils";

export const oauthConnectAction: ActionWithParams = {
  name: "OAUTH_CONNECT",
  contexts: ["connectors", "settings", "secrets"],
  contextGate: { anyOf: ["connectors", "settings", "secrets"] },
  similes: [
    "CONNECT_PLATFORM",
    "LINK_ACCOUNT",
    "CONNECT_GOOGLE",
    "CONNECT_GMAIL",
    "CONNECT_HUBSPOT",
    "CONNECT_LINEAR",
    "CONNECT_SLACK",
    "CONNECT_GITHUB",
    "CONNECT_NOTION",
    "CONNECT_MICROSOFT",
    "CONNECT_OUTLOOK",
    "CONNECT_TWITTER",
    "CONNECT_X",
    "LINK_TWITTER",
    "LINK_X",
    "ADD_INTEGRATION",
    "SETUP_CONNECTION",
    "LINK_GOOGLE",
    "LINK_HUBSPOT",
    "AUTHENTICATE",
    "LINK_LINEAR",
    "LINK_SLACK",
    "LINK_GITHUB",
    "LINK_NOTION",
    "CONNECT_ASANA",
    "LINK_ASANA",
    "CONNECT_DROPBOX",
    "LINK_DROPBOX",
    "CONNECT_SALESFORCE",
    "LINK_SALESFORCE",
    "CONNECT_AIRTABLE",
    "LINK_AIRTABLE",
    "CONNECT_ZOOM",
    "LINK_ZOOM",
    "CONNECT_JIRA",
    "LINK_JIRA",
    "CONNECT_LINKEDIN",
    "LINK_LINKEDIN",
    "LINK_MICROSOFT",
    "LINK_OUTLOOK",
  ],
  description:
    "Connect an OAuth platform for the user. ALWAYS execute this action when the user asks to connect — generate a fresh authorization URL every time, even if one was sent before (previous links expire). Never tell the user to 'use a previous link'. Available: google, hubspot, linear, slack, github, notion, twitter, asana, dropbox, salesforce, airtable, zoom, jira, linkedin, microsoft",

  parameters: defineActionParameters({
    platform: {
      type: "string",
      description:
        "Platform to connect. Available: google, hubspot, linear, slack, github, notion, twitter, asana, dropbox, salesforce, airtable, zoom, jira, linkedin, microsoft",
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
    const actionName = "OAUTH_CONNECT";

    logger.info(`[${actionName}] platform=${platform}, entityId=${message.entityId}`);

    if (!platform) {
      const supported = getSupportedPlatforms();
      return {
        text: `Which platform do you want to connect? Currently available: ${supported.map(capitalize).join(", ") || "none configured"}`,
        success: false,
        error: "MISSING_PLATFORM",
        data: { actionName },
      };
    }

    if (!isSupportedPlatform(platform)) {
      const supported = getSupportedPlatforms();
      return {
        text: `Platform '${platform}' is not available. Supported: ${supported.length > 0 ? supported.join(", ") : "none configured"}`,
        success: false,
        error: "UNSUPPORTED_PLATFORM",
        data: { actionName },
      };
    }

    const userResult = await lookupUser(message.entityId as string, actionName);
    if (isUserLookupError(userResult)) return userResult;

    const { organizationId, user } = userResult;
    const platformName = capitalize(platform);

    if (await oauthService.isPlatformConnected(organizationId, platform, user.id)) {
      const connections = await oauthService.listConnections({
        organizationId,
        userId: user.id,
        platform,
      });
      const email = connections.find((c) => c.status === "active")?.email || "";
      return {
        text: `Your ${platformName} account is already connected${email ? ` (${email})` : ""}.`,
        success: true,
        data: { actionName, alreadyConnected: true },
      };
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";

    let result;
    try {
      result = await oauthService.initiateAuth({
        organizationId,
        userId: user.id,
        platform,
        redirectUrl: `${baseUrl}/auth/success`,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        `[${actionName}] OAuth initiation failed: ${errMsg} (platform=${platform}, org=${organizationId})`,
      );
      return {
        text: `Failed to start ${platformName} connection. Please try again later.`,
        success: false,
        error: "OAUTH_INITIATION_FAILED",
        data: { actionName },
      };
    }

    if (!result.authUrl) {
      logger.error(`[${actionName}] Failed to generate auth URL`);
      return {
        text: `Failed to generate authorization link. Please try again.`,
        success: false,
        error: "AUTH_URL_GENERATION_FAILED",
        data: { actionName },
      };
    }

    const text = `Connect ${platformName} here:\n${result.authUrl}\n\nWhen you've finished authorizing, say "done" and I'll verify the connection.`;

    if (callback) await callback({ text, actions: [actionName] });

    return {
      text,
      success: true,
      data: { actionName, authUrl: result.authUrl },
    };
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "connect my google account" } },
      {
        name: "{{name2}}",
        content: {
          text: "Connect Google here:\nhttps://accounts.google.com/...",
          actions: ["OAUTH_CONNECT"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "link gmail" } },
      {
        name: "{{name2}}",
        content: {
          text: "Connect Google here:\nhttps://accounts.google.com/...",
          actions: ["OAUTH_CONNECT"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "connect hubspot" } },
      {
        name: "{{name2}}",
        content: {
          text: "Connect HubSpot here:\nhttps://app.hubspot.com/oauth/...",
          actions: ["OAUTH_CONNECT"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "connect my twitter account" } },
      {
        name: "{{name2}}",
        content: {
          text: "Connect Twitter here:\nhttps://api.twitter.com/oauth/...",
          actions: ["OAUTH_CONNECT"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "link my x account" } },
      {
        name: "{{name2}}",
        content: {
          text: "Connect Twitter here:\nhttps://api.twitter.com/oauth/...",
          actions: ["OAUTH_CONNECT"],
        },
      },
    ],
  ] as ActionExample[][],
};
