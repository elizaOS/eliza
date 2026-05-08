// Cloud parent for the MCP plugin. Mirrors plugins/plugin-mcp/src/actions/mcp.ts
// in shape (op-keyed surface) but binds to cloud-only ops: read_resource,
// search_actions, list_connections. The local plugin-mcp parent additionally
// handles call_tool — that op is unavailable in the cloud runtime.
import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { type ActionWithParams, defineActionParameters } from "../../plugin-cloud-bootstrap/types";
import type { McpService } from "../service";
import { resourceSelectionTemplate } from "../templates/resourceSelectionTemplate";
import { MCP_SERVICE_NAME, type McpServer, type McpServerInfo } from "../types";
import { handleMcpError } from "../utils/error";
import { checkMcpOAuthAccess } from "../utils/mcp";
import {
  handleResourceAnalysis,
  processResourceResult,
  sendInitialResponse,
} from "../utils/processing";
import type { ResourceSelection } from "../utils/validation";
import {
  createResourceSelectionFeedbackPrompt,
  validateResourceSelection,
} from "../utils/validation";
import { withModelRetry } from "../utils/wrapper";
import { createMcpToolAction } from "./dynamic-tool-actions";

export type CloudMcpOp = "read_resource" | "search_actions" | "list_connections";

const MCP_CONTEXTS = ["connectors", "automation", "knowledge", "documents", "files", "settings"];

function readParams(message: Memory, state?: State): Record<string, unknown> {
  const content = message.content as Record<string, unknown>;
  return (
    (content.actionParams as Record<string, unknown>) ||
    (content.actionInput as Record<string, unknown>) ||
    (state?.data?.actionParams as Record<string, unknown>) ||
    {}
  );
}

function normalizeOp(value: unknown): CloudMcpOp | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "read_resource" || v === "resource" || v === "read") return "read_resource";
  if (
    v === "search_actions" ||
    v === "search" ||
    v === "discover" ||
    v === "find_actions" ||
    v === "search_tools"
  )
    return "search_actions";
  if (
    v === "list_connections" ||
    v === "list" ||
    v === "connections" ||
    v === "show_connections" ||
    v === "oauth_connections"
  )
    return "list_connections";
  return null;
}

function inferOpFromText(text: string): CloudMcpOp | null {
  const t = text.toLowerCase();
  if (
    /\b(connection|connected|oauth|connected services|integrations linked)\b/i.test(t) ||
    /\bmy connections\b/i.test(t)
  ) {
    return "list_connections";
  }
  if (/\b(search|find|discover)\b.*\b(action|tool|capability|integration)\b/i.test(t)) {
    return "search_actions";
  }
  if (/\b(read|get|fetch|access|open|list)\b.*\b(resource|document|docs?|file)\b/i.test(t)) {
    return "read_resource";
  }
  return null;
}

function createResourceSelectionPrompt(composedState: State, userMessage: string): string {
  const mcpData = (composedState.values.mcp || {}) as Record<string, McpServerInfo>;
  const serverNames = Object.keys(mcpData);

  let resourcesDescription = "";
  for (const serverName of serverNames) {
    const server = mcpData[serverName];
    if (server.status !== "connected") continue;

    const resourceUris = Object.keys(server.resources || {});
    for (const uri of resourceUris) {
      const resource = server.resources[uri];
      resourcesDescription += `Resource: ${uri} (Server: ${serverName})\n`;
      resourcesDescription += `Name: ${resource.name || "No name available"}\n`;
      resourcesDescription += `Description: ${
        resource.description || "No description available"
      }\n`;
      resourcesDescription += `MIME Type: ${resource.mimeType || "Not specified"}\n\n`;
    }
  }

  const enhancedState: State = {
    ...composedState,
    values: {
      ...composedState.values,
      resourcesDescription,
      userMessage,
    },
  };

  return composePromptFromState({
    state: enhancedState,
    template: resourceSelectionTemplate,
  });
}

async function handleReadResource(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const composedState = await runtime.composeState(message, ["RECENT_MESSAGES", "MCP"]);

  const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
  if (!mcpService) {
    return {
      success: false,
      text: "MCP service is not available.",
      error: "MCP_SERVICE_UNAVAILABLE",
      data: { actionName: "MCP", op: "read_resource" },
    };
  }

  const mcpProvider = mcpService.getProviderData();

  try {
    await sendInitialResponse(callback);

    const resourceSelectionPrompt = createResourceSelectionPrompt(
      composedState,
      message.content.text || "",
    );

    const params = readParams(message, state);
    let parsedSelection: ResourceSelection | null;
    if (typeof params.serverName === "string" && typeof params.uri === "string") {
      parsedSelection = {
        serverName: params.serverName,
        uri: params.uri,
        reasoning: "Selected from native action parameters.",
      };
    } else {
      const resourceSelection = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: resourceSelectionPrompt,
      });

      parsedSelection = await withModelRetry<ResourceSelection>({
        runtime,
        state: composedState,
        message,
        callback,
        input: resourceSelection,
        validationFn: (data) => validateResourceSelection(data),
        createFeedbackPromptFn: (originalResponse, errorMessage, st, userMessage) =>
          createResourceSelectionFeedbackPrompt(
            originalResponse as string,
            errorMessage,
            st,
            userMessage,
          ),
        failureMsg: `I'm having trouble finding the resource you're looking for. Could you provide more details about what you need?`,
        retryCount: 0,
      });
    }

    if (!parsedSelection || parsedSelection.noResourceAvailable) {
      const responseText =
        "I don't have a specific resource that contains the information you're looking for. Let me try to assist you directly instead.";
      const thoughtText =
        "No appropriate MCP resource available for this request. Falling back to direct assistance.";

      if (callback && parsedSelection?.noResourceAvailable) {
        await callback({
          text: responseText,
          thought: thoughtText,
          actions: ["REPLY"],
        });
      }
      return {
        text: responseText,
        values: {
          success: true,
          noResourceAvailable: true,
          fallbackToDirectAssistance: true,
        },
        data: {
          actionName: "MCP",
          op: "read_resource",
          noResourceAvailable: true,
          reason: parsedSelection?.reasoning || "No appropriate resource available",
        },
        success: true,
      };
    }

    const { serverName, uri, reasoning } = parsedSelection;
    if (!serverName || !uri) {
      return { text: "No resource selected.", success: false };
    }

    logger.debug(`Selected resource "${uri}" on server "${serverName}" because: ${reasoning}`);

    const result = await mcpService.readResource(serverName, uri);
    logger.debug(`Read resource ${uri} from server ${serverName}`);

    const { resourceContent, resourceMeta } = processResourceResult(
      result as {
        contents: Array<{
          uri: string;
          mimeType?: string;
          text?: string;
          blob?: string;
        }>;
      },
      uri,
    );

    await handleResourceAnalysis(
      runtime,
      message,
      uri,
      serverName,
      resourceContent,
      resourceMeta,
      callback,
    );

    return {
      text: `Successfully read resource: ${uri}`,
      values: {
        success: true,
        resourceRead: true,
        serverName,
        uri,
      },
      data: {
        actionName: "MCP",
        op: "read_resource",
        serverName,
        uri,
        reasoning,
        resourceMeta,
        contentLength: resourceContent?.length || 0,
      },
      success: true,
    };
  } catch (error) {
    return await handleMcpError(
      composedState,
      mcpProvider,
      error,
      runtime,
      message,
      "resource",
      callback,
    );
  }
}

async function handleSearchActions(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
): Promise<ActionResult> {
  const svc = runtime.getService<McpService>(MCP_SERVICE_NAME);
  if (!svc) {
    return { success: false, error: "MCP service not available" };
  }

  const params = readParams(message, state);
  const content = message.content as Record<string, unknown>;
  const query = (params.query as string) || (content.text as string) || "";
  const platform = (params.platform as string) || undefined;
  const rawLimit = Number(params.limit) || 10;
  const limit = Math.min(Math.max(rawLimit, 1), 20);
  const offset = Math.max(Number(params.offset) || 0, 0);

  if (!query.trim()) {
    return { success: false, error: "A search query is required" };
  }

  const tier2Index = svc.getTier2Index();
  const results = tier2Index.search(query, platform, limit, offset);

  if (results.length === 0) {
    return {
      success: true,
      text: platform
        ? `No actions found matching "${query}" for platform "${platform}".`
        : `No actions found matching "${query}".`,
      data: {
        actionName: "MCP",
        op: "search_actions",
        query,
        platform,
        offset,
        resultCount: 0,
        totalAvailable: tier2Index.getToolCount(),
      },
    };
  }

  const existingNames = new Set(runtime.actions.map((a) => a.name));
  const newlyRegistered: string[] = [];
  const alreadyRegistered: string[] = [];
  const promotedTier2Names: string[] = [];

  for (const entry of results) {
    if (existingNames.has(entry.actionName)) {
      alreadyRegistered.push(entry.actionName);
      continue;
    }
    if (runtime.actions.some((a) => a.name === entry.actionName)) {
      existingNames.add(entry.actionName);
      alreadyRegistered.push(entry.actionName);
      continue;
    }
    const action = createMcpToolAction(entry.serverName, entry.tool, existingNames);
    runtime.registerAction(action as unknown as Action);
    existingNames.add(String(action.name));
    newlyRegistered.push(String(action.name));
    promotedTier2Names.push(entry.actionName);
  }

  if (promotedTier2Names.length > 0) {
    svc.removeFromTier2(promotedTier2Names);
  }

  const text = `Registered ${newlyRegistered.length} new action(s) for "${query}". They are now callable.`;

  return {
    success: true,
    text,
    data: {
      actionName: "MCP",
      op: "search_actions",
      query,
      platform,
      offset,
      resultCount: results.length,
      totalAvailable: tier2Index.getToolCount(),
      newlyRegistered,
      alreadyRegistered,
      actions: results.map((r) => ({
        name: r.actionName,
        serverName: r.serverName,
        toolName: r.toolName,
        platform: r.platform,
        description: r.tool.description,
      })),
    },
  };
}

async function handleListConnections(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const orgId = runtime.getSetting("ORGANIZATION_ID") as string | undefined;
  if (!orgId) {
    return { success: false, error: "No organization context available" };
  }

  const params = readParams(message, state);
  const platform = (params.platform as string) || undefined;

  let connections: Array<{
    platform: string;
    status: string;
    email?: string;
    scopes: string[];
    linkedAt: Date;
  }>;

  try {
    const { oauthService } = await import("../../../services/oauth");
    connections = await oauthService.listConnections({
      organizationId: orgId,
      platform,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ error: msg }, "[MCP/list_connections] Failed to fetch connections");
    if (msg.includes("Cannot find module")) {
      return { success: false, error: "OAuth service not available" };
    }
    return { success: false, error: "Failed to fetch OAuth connections" };
  }

  if (connections.length === 0) {
    const text = platform
      ? `No connections found for platform "${platform}".`
      : "No OAuth connections found.";
    if (callback) await callback({ text });
    return {
      success: true,
      text,
      data: { actionName: "MCP", op: "list_connections", connectionCount: 0, platform },
    };
  }

  const lines: string[] = [`Found ${connections.length} connection(s):\n`];
  for (const conn of connections) {
    const email = conn.email ? ` (${conn.email})` : "";
    const linked = conn.linkedAt.toISOString().split("T")[0];
    lines.push(`- **${conn.platform}**${email} — Status: ${conn.status}`);
    lines.push(`  Connected: ${linked}`);
  }

  const text = lines.join("\n");
  if (callback) await callback({ text });

  return {
    success: true,
    text,
    data: {
      actionName: "MCP",
      op: "list_connections",
      platform,
      connectionCount: connections.length,
      platforms: [...new Set(connections.map((c) => c.platform))],
      hasActive: connections.some((c) => c.status === "active"),
    },
  };
}

function hasSelectedContext(state: State | undefined): boolean {
  const selected = [
    state?.data?.selectedContexts,
    state?.data?.activeContexts,
    state?.data?.contexts,
    state?.values?.selectedContexts,
    state?.values?.activeContexts,
    state?.values?.contexts,
  ].flatMap((value) => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []));
  return selected.some((context) => MCP_CONTEXTS.includes(String(context).toLowerCase()));
}

function collectText(message: Memory, state?: State): string {
  return [message.content?.text, state?.values?.conversationLog, state?.values?.recentMessages]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
}

const MCP_KEYWORDS = [
  "mcp",
  "tool",
  "tools",
  "resource",
  "resources",
  "server",
  "servers",
  "connection",
  "connections",
  "oauth",
  "integration",
  "integrations",
  "search",
  "find",
  "discover",
  "read",
  "fetch",
  "documentation",
];

export const mcpAction: ActionWithParams = {
  name: "MCP",
  contexts: MCP_CONTEXTS,
  contextGate: { anyOf: MCP_CONTEXTS },
  roleGate: { minRole: "ADMIN" },
  description:
    "Single MCP entry point. op=read_resource reads an MCP resource; op=search_actions discovers new tool actions across connected platforms; op=list_connections lists OAuth connections.",
  similes: [
    // search_actions
    "SEARCH_ACTIONS",
    "FIND_ACTIONS",
    "DISCOVER_ACTIONS",
    "SEARCH_TOOLS",
    "FIND_TOOLS",
    "DISCOVER_TOOLS",
    "LOOKUP_ACTIONS",
    // list_connections
    "LIST_CONNECTIONS",
    "SHOW_CONNECTIONS",
    "GET_CONNECTIONS",
    "OAUTH_CONNECTIONS",
    "MY_CONNECTIONS",
    "CONNECTED_SERVICES",
    // read_resource
    "READ_MCP_RESOURCE",
    "READ_RESOURCE",
    "GET_RESOURCE",
    "GET_MCP_RESOURCE",
    "FETCH_RESOURCE",
    "FETCH_MCP_RESOURCE",
    "ACCESS_RESOURCE",
    "ACCESS_MCP_RESOURCE",
  ],
  parameters: defineActionParameters({
    op: {
      type: "string",
      description: "MCP operation: read_resource | search_actions | list_connections",
      required: false,
      enum: ["read_resource", "search_actions", "list_connections"],
    },
    serverName: {
      type: "string",
      description: "For op=read_resource: optional MCP server name that owns the resource.",
      required: false,
    },
    uri: {
      type: "string",
      description: "For op=read_resource: optional exact resource URI to read.",
      required: false,
    },
    query: {
      type: "string",
      description:
        "For op=search_actions: keyword search query (use specific verbs and nouns from the request). For op=read_resource: optional natural-language description of the resource.",
      required: false,
    },
    platform: {
      type: "string",
      description:
        "For op=search_actions / list_connections: filter to a single platform name. Omit to search all.",
      required: false,
    },
    limit: {
      type: "number",
      description: "For op=search_actions: maximum results to return (default 10, max 20).",
      required: false,
      default: 10,
    },
    offset: {
      type: "number",
      description:
        "For op=search_actions: skip first N results for pagination when initial search didn't find what you need.",
      required: false,
      default: 0,
    },
  }),

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const orgId = runtime.getSetting("ORGANIZATION_ID") as string | undefined;
    if (!orgId) return false;
    const svc = runtime.getService<McpService>(MCP_SERVICE_NAME);
    if (!svc) return false;
    if (!checkMcpOAuthAccess(runtime)) return false;
    const text = collectText(message, state);
    return hasSelectedContext(state) || MCP_KEYWORDS.some((keyword) => text.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = readParams(message, state);
    const requested = normalizeOp(params.op ?? params.operation);
    const text = typeof message.content?.text === "string" ? message.content.text : "";
    const op = requested ?? inferOpFromText(text) ?? "search_actions";

    if (op === "read_resource") {
      return handleReadResource(runtime, message, state, callback);
    }
    if (op === "list_connections") {
      return handleListConnections(runtime, message, state, callback);
    }
    return handleSearchActions(runtime, message, state);
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Search for email-related actions" },
      },
      {
        name: "{{assistant}}",
        content: {
          text: "I'll search for email-related actions.",
          actions: ["MCP"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "What services are connected?" },
      },
      {
        name: "{{assistant}}",
        content: {
          text: "Let me check your connected services.",
          actions: ["MCP"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Can you get the documentation about installing elizaOS?" },
      },
      {
        name: "{{assistant}}",
        content: {
          text: "I'll retrieve the MCP resource for that.",
          actions: ["MCP"],
        },
      },
    ],
  ],
};
