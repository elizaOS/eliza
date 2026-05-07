/**
 * OAUTH_GET - Check status of an OAuth connection.
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
  formatConnectionIdentifier,
  isUserLookupError,
  lookupUser,
} from "../utils";

function oauthGetFailureResult(
  actionName: string,
  message: string,
  extraData: Record<string, unknown> = {},
): ActionResult {
  return {
    success: false,
    text: message,
    error: message,
    data: {
      actionName,
      ...extraData,
    },
  };
}

export const oauthGetAction: ActionWithParams = {
  name: "OAUTH_GET",
  contexts: ["connectors", "settings"],
  contextGate: { anyOf: ["connectors", "settings"] },
  similes: [
    "CHECK_CONNECTION",
    "VERIFY_CONNECTION",
    "CONNECTION_STATUS",
    "IS_CONNECTED",
    "DONE",
    "FINISHED",
    "COMPLETED",
    "DID_IT_WORK",
    "CHECK_GOOGLE",
    "CHECK_LINEAR",
    "CHECK_SLACK",
    "CHECK_GITHUB",
    "CHECK_NOTION",
    "CHECK_TWITTER",
    "CHECK_X",
    "VERIFY_TWITTER",
    "VERIFY_X",
    "CHECK_ASANA",
    "CHECK_DROPBOX",
    "CHECK_SALESFORCE",
    "CHECK_AIRTABLE",
    "CHECK_ZOOM",
    "CHECK_JIRA",
    "VERIFY_JIRA",
    "CHECK_LINKEDIN",
    "VERIFY_LINKEDIN",
    "CHECK_MICROSOFT",
    "CHECK_OUTLOOK",
  ],
  description:
    "Check status of an OAuth connection. Use when user says 'done' after connecting, or asks about connection status.",

  parameters: defineActionParameters({
    platform: {
      type: "string",
      description:
        "Platform to check: google, linear, slack, github, notion, twitter, asana, dropbox, salesforce, airtable, zoom, jira, linkedin, microsoft. If not specified, checks all.",
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
    const platform = extractPlatform(message, state);
    const actionName = "OAUTH_GET";

    logger.info(`[${actionName}] platform=${platform || "all"}, entityId=${message.entityId}`);

    const userResult = await lookupUser(message.entityId as string, actionName);
    if (isUserLookupError(userResult)) return userResult;

    const { organizationId, user } = userResult;

    try {
      // Check specific platform
      if (platform) {
        const isConnected = await oauthService.isPlatformConnected(organizationId, platform, user.id);
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

          if (callback) await callback({ text, actions: [actionName] });
          return {
            text,
            success: true,
            data: { actionName, connected: true, platform, identifier: identifier || undefined },
          };
        }

        const text = `${platformName} isn't connected yet. Say "connect ${platform}" and I'll generate a fresh link for you.`;
        if (callback) await callback({ text, actions: [actionName] });
        return { text, success: true, data: { actionName, connected: false, platform } };
      }

      // Check all connections
      const connections = await oauthService.listConnections({
        organizationId,
        userId: user.id,
      });
      const active = connections.filter((c) => c.status === "active");

      if (active.length === 0) {
        const text =
          'You don\'t have any connected accounts yet. Try saying "connect google" or "connect twitter" to get started — it only takes a few seconds.';
        if (callback) await callback({ text, actions: [actionName] });
        return { text, success: true, data: { actionName, connections: [] } };
      }

      const list = active
        .map((c) => {
          const id = formatConnectionIdentifier(c);
          return id ? `${capitalize(c.platform)} (${id})` : capitalize(c.platform);
        })
        .join(", ");

      const text = `Connected: ${list}`;
      if (callback) await callback({ text, actions: [actionName] });
      return {
        text,
        success: true,
        data: {
          actionName,
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
        error instanceof Error ? error.message : "Failed to check OAuth connection status.";
      logger.error(`[${actionName}] failed to load connection status`, errorMessage);
      return oauthGetFailureResult(
        actionName,
        platform
          ? `I couldn't check your ${capitalize(platform)} connection right now.`
          : "I couldn't check your connected accounts right now.",
        {
          platform: platform || null,
          errorCode: "oauth_status_check_failed",
          errorMessage,
        },
      );
    }
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "done" } },
      {
        name: "{{name2}}",
        content: {
          text: "Google is connected! Logged in as user@gmail.com.\n\nYou're all set — I can now help you with Google tasks. What would you like to do?",
          actions: ["OAUTH_GET"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "is my google connected?" } },
      {
        name: "{{name2}}",
        content: {
          text: "Google is connected! Logged in as user@gmail.com.\n\nYou're all set — I can now help you with Google tasks. What would you like to do?",
          actions: ["OAUTH_GET"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "is my twitter connected?" } },
      {
        name: "{{name2}}",
        content: {
          text: "Twitter is connected! Logged in as @username.\n\nYou're all set — I can now help you with Twitter tasks. What would you like to do?",
          actions: ["OAUTH_GET"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "check my x connection" } },
      {
        name: "{{name2}}",
        content: {
          text: "Twitter is connected! Logged in as @username.\n\nYou're all set — I can now help you with Twitter tasks. What would you like to do?",
          actions: ["OAUTH_GET"],
        },
      },
    ],
  ] as ActionExample[][],
};
