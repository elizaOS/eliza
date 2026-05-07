/**
 * OAUTH_LIST - Lists all OAuth connections for the user.
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
import { capitalize, formatConnectionIdentifier, isUserLookupError, lookupUser } from "../utils";

export const oauthListAction: ActionWithParams = {
  name: "OAUTH_LIST",
  contexts: ["connectors", "settings"],
  contextGate: { anyOf: ["connectors", "settings"] },
  similes: [
    "LIST_CONNECTIONS",
    "SHOW_CONNECTIONS",
    "MY_ACCOUNTS",
    "CONNECTED_APPS",
    "WHAT_IS_CONNECTED",
    "MY_INTEGRATIONS",
    "SHOW_INTEGRATIONS",
  ],
  description: "List all OAuth connections for the user. Shows which platforms are connected.",

  parameters: defineActionParameters({}),

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return !!message.entityId;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const actionName = "OAUTH_LIST";

    logger.info(`[${actionName}] entityId=${message.entityId}`);

    const userResult = await lookupUser(message.entityId as string, actionName);
    if (isUserLookupError(userResult)) return userResult;

    const { organizationId, user } = userResult;
    const connections = await oauthService.listConnections({
      organizationId,
      userId: user.id,
    });

    if (connections.length === 0) {
      const text = "You don't have any connected accounts. Say 'connect google' to get started.";
      if (callback) await callback({ text, actions: [actionName] });
      return { text, success: true, data: { actionName, count: 0 } };
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

    logger.info(`[${actionName}] Found ${connections.length} connections`);

    if (callback) await callback({ text, actions: [actionName] });
    return {
      text,
      success: true,
      data: { actionName, count: connections.length, activeCount },
    };
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "what accounts are connected?" } },
      {
        name: "{{name2}}",
        content: {
          text: "Your connected accounts:\n• Google: user@gmail.com (active)",
          actions: ["OAUTH_LIST"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "show my connections" } },
      {
        name: "{{name2}}",
        content: {
          text: "You don't have any connected accounts. Say 'connect google' to get started.",
          actions: ["OAUTH_LIST"],
        },
      },
    ],
  ] as ActionExample[][],
};
