import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { McpService } from "../service";
import { resourceSelectionTemplate } from "../templates/resourceSelectionTemplate";
import { MCP_SERVICE_NAME, type McpServer, type McpServerInfo } from "../types";
import { handleMcpError } from "../utils/error";
import {
  handleResourceAnalysis,
  processResourceResult,
  sendInitialResponse,
} from "../utils/processing";
import type { ResourceSelection } from "../utils/schemas";
import {
  createResourceSelectionFeedbackPrompt,
  validateResourceSelection,
} from "../utils/validation";
import { withModelRetry } from "../utils/wrapper";

function createResourceSelectionPrompt(composedState: State, userMessage: string): string {
  const mcpData = (composedState.values.mcp ?? {}) as Record<string, McpServerInfo>;
  const serverNames = Object.keys(mcpData);

  let resourcesDescription = "";
  for (const serverName of serverNames) {
    const server = mcpData[serverName];
    if (server.status !== "connected") continue;

    const resourceUris = Object.keys(server.resources ?? {});
    for (const uri of resourceUris) {
      const resource = server.resources[uri];
      resourcesDescription += `Resource: ${uri} (Server: ${serverName})\n`;
      resourcesDescription += `Name: ${resource.name ?? "No name available"}\n`;
      resourcesDescription += `Description: ${
        resource.description ?? "No description available"
      }\n`;
      resourcesDescription += `MIME Type: ${resource.mimeType ?? "Not specified"}\n\n`;
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

function readOptions(options?: Record<string, unknown> | unknown): Record<string, unknown> {
  const direct = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function getDirectResourceSelection(options?: unknown): ResourceSelection | null {
  const params = readOptions(options);
  const serverName = typeof params.serverName === "string" ? params.serverName.trim() : "";
  const uri = typeof params.uri === "string" ? params.uri.trim() : "";
  if (!serverName || !uri) return null;
  return {
    serverName,
    uri,
    reasoning:
      typeof params.reasoning === "string" && params.reasoning.trim()
        ? params.reasoning.trim()
        : "Selected from structured READ_MCP_RESOURCE parameters.",
  };
}

export const readResourceAction: Action = {
  name: "READ_MCP_RESOURCE",
  contexts: ["connectors", "knowledge", "files"],
  contextGate: { anyOf: ["connectors", "knowledge", "files"] },
  roleGate: { minRole: "USER" },
  similes: [
    "READ_RESOURCE",
    "READ_MCP_RESOURCE",
    "GET_RESOURCE",
    "GET_MCP_RESOURCE",
    "FETCH_RESOURCE",
    "FETCH_MCP_RESOURCE",
    "ACCESS_RESOURCE",
    "ACCESS_MCP_RESOURCE",
  ],
  description: "Reads a resource from an MCP server",
  descriptionCompressed: "read resource MCP server",
  parameters: [
    {
      name: "serverName",
      description: "MCP server name that exposes the resource.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "uri",
      description: "Exact MCP resource URI to read.",
      required: false,
      schema: { type: "string" },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown
  ): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avStructuredSelection = getDirectResourceSelection(options);
    const __avKeywords = ["read", "mcp", "resource"];
    const __avKeywordOk =
      Boolean(__avStructuredSelection) ||
      (__avKeywords.length > 0 &&
        __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw)));
    const __avRegex = /\b(?:read|mcp|resource)\b/i;
    const __avRegexOk = Boolean(__avStructuredSelection) || __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avInputOk =
      __avText.trim().length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: IAgentRuntime,
      _message: Memory,
      _state?: State
    ): Promise<boolean> => {
      const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
      if (!mcpService) return false;

      const servers = mcpService.getServers();
      return (
        servers.length > 0 &&
        servers.some(
          (server: McpServer) =>
            server.status === "connected" && server.resources && server.resources.length > 0
        )
      );
    };
    try {
      return Boolean(await __avLegacyValidate(runtime, message, state));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const composedState = await runtime.composeState(message, ["RECENT_MESSAGES", "MCP"]);

    const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
    if (!mcpService) {
      throw new Error("MCP service not available");
    }

    const mcpProvider = mcpService.getProviderData();

    try {
      await sendInitialResponse(callback);

      const parsedSelection =
        getDirectResourceSelection(_options) ??
        (await (async () => {
          const resourceSelectionPrompt = createResourceSelectionPrompt(
            composedState,
            message.content.text ?? ""
          );

          const resourceSelection = (await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: resourceSelectionPrompt,
          })) as string;

          return withModelRetry<ResourceSelection>({
            runtime,
            state: composedState,
            message,
            callback,
            input: resourceSelection,
            validationFn: (data) => validateResourceSelection(data),
            createFeedbackPromptFn: (originalResponse, errorMessage, state, userMessage) =>
              createResourceSelectionFeedbackPrompt(
                typeof originalResponse === "string"
                  ? originalResponse
                  : JSON.stringify(originalResponse),
                errorMessage,
                state,
                userMessage
              ),
            failureMsg: `I'm having trouble finding the resource you're looking for. Could you provide more details about what you need?`,
            retryCount: 0,
          });
        })());

      if (!parsedSelection || parsedSelection.noResourceAvailable) {
        const responseText =
          "I don't have a specific resource that contains the information you're looking for. Let me try to assist you directly instead.";

        if (callback && parsedSelection?.noResourceAvailable) {
          await callback({
            text: responseText,
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
            actionName: "READ_MCP_RESOURCE",
            noResourceAvailable: true,
            reason: parsedSelection?.reasoning ?? "No appropriate resource available",
          },
          success: true,
        };
      }

      const { serverName, uri } = parsedSelection;

      const result = await mcpService.readResource(serverName, uri);

      const { resourceContent, resourceMeta } = processResourceResult(result, uri);

      await handleResourceAnalysis(
        runtime,
        message,
        uri,
        serverName,
        resourceContent,
        resourceMeta,
        callback
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
          actionName: "READ_MCP_RESOURCE",
          serverName,
          uri,
          reasoning: parsedSelection?.reasoning,
          resourceMeta,
          contentLength: resourceContent?.length ?? 0,
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
        callback
      );
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "Can you get the documentation about installing elizaOS?",
        },
      },
      {
        name: "{{assistant}}",
        content: {
          text: `I'll retrieve that information for you. Let me access the resource...`,
          actions: ["READ_MCP_RESOURCE"],
        },
      },
      {
        name: "{{assistant}}",
        content: {
          text: `elizaOS installation is straightforward. You'll need Node.js 23+ and Git installed. For Windows users, WSL 2 is required. The quickest way to get started is by cloning the elizaOS starter repository with \`git clone https://github.com/elizaos/eliza-starter.git\`, then run \`cd eliza-starter && cp .env.example .env && bun i && bun run build && bun start\`. This will set up a development environment with the core features enabled. After starting, you can access the web interface at http://localhost:3000 to interact with your agent.`,
          actions: ["READ_MCP_RESOURCE"],
        },
      },
    ],
  ],
};
