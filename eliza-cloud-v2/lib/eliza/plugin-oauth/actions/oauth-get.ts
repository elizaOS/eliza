/**
 * OAUTH_GET - Check status of an OAuth connection.
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
  extractPlatform,
  lookupUser,
  isUserLookupError,
  capitalize,
  formatConnectionIdentifier,
} from "../utils";

export const oauthGetAction: ActionWithParams = {
  name: "OAUTH_GET",
  similes: [
    "CHECK_CONNECTION", "VERIFY_CONNECTION", "CONNECTION_STATUS", "IS_CONNECTED",
    "DONE", "FINISHED", "COMPLETED", "DID_IT_WORK", "CHECK_GOOGLE",
    "CHECK_LINEAR", "CHECK_SLACK", "CHECK_GITHUB", "CHECK_NOTION",
  ],
  description:
    "Check status of an OAuth connection. Use when user says 'done' after connecting, or asks about connection status.",

  parameters: {
    platform: {
      type: "string",
      description: "Platform to check: google, linear, slack, github, notion. If not specified, checks all.",
      required: false,
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
    const actionName = "OAUTH_GET";

    logger.info(`[${actionName}] platform=${platform || "all"}, entityId=${message.entityId}`);

    const userResult = await lookupUser(message.entityId as string, actionName);
    if (isUserLookupError(userResult)) return userResult;

    const { organizationId } = userResult;

    // Check specific platform
    if (platform) {
      const isConnected = await oauthService.isPlatformConnected(organizationId, platform);
      const platformName = capitalize(platform);

      if (isConnected) {
        const connections = await oauthService.listConnections({ organizationId, platform });
        const active = connections.find((c) => c.status === "active");
        const identifier = active ? formatConnectionIdentifier(active) : "";
        const text = identifier
          ? `${platformName} connected! Logged in as ${identifier}.`
          : `${platformName} connected!`;

        if (callback) await callback({ text, actions: [actionName] });
        return { text, success: true, data: { actionName, connected: true } };
      }

      const text = `${platformName} is not connected yet. Complete the authorization in your browser, then try again.`;
      if (callback) await callback({ text, actions: [actionName] });
      return { text, success: true, data: { actionName, connected: false } };
    }

    // Check all connections
    const connections = await oauthService.listConnections({ organizationId });
    const active = connections.filter((c) => c.status === "active");

    if (active.length === 0) {
      const text = "You don't have any connected accounts. Say 'connect google' to get started.";
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
    return { text, success: true, data: { actionName, count: active.length } };
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "done" } },
      { name: "{{name2}}", content: { text: "Google connected! Logged in as user@gmail.com.", actions: ["OAUTH_GET"] } },
    ],
    [
      { name: "{{name1}}", content: { text: "is my google connected?" } },
      { name: "{{name2}}", content: { text: "Google connected! Logged in as user@gmail.com.", actions: ["OAUTH_GET"] } },
    ],
  ] as ActionExample[][],
};
