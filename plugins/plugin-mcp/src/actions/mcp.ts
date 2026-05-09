import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { McpService } from "../service";
import { resourceSelectionTemplate } from "../templates/resourceSelectionTemplate";
import { MCP_SERVICE_NAME, type McpServer, type McpServerInfo } from "../types";
import { handleMcpError } from "../utils/error";
import { handleNoToolAvailable } from "../utils/handler";
import {
  handleResourceAnalysis,
  handleToolResponse,
  processResourceResult,
  processToolResult,
  sendInitialResponse,
} from "../utils/processing";
import type { ResourceSelection } from "../utils/schemas";
import { createToolSelectionArgument, createToolSelectionName } from "../utils/selection";
import {
  createResourceSelectionFeedbackPrompt,
  validateResourceSelection,
} from "../utils/validation";
import { withModelRetry } from "../utils/wrapper";

export const MCP_ACTION_CONTEXT = "mcp";

export type McpOp = "call_tool" | "read_resource" | "search_actions" | "list_connections";

function readOptions(options?: HandlerOptions | Record<string, unknown>): Record<string, unknown> {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function normalizeOp(value: unknown): McpOp | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "call_tool" || v === "tool" || v === "call") return "call_tool";
  if (v === "read_resource" || v === "resource" || v === "read") return "read_resource";
  if (v === "search_actions" || v === "search" || v === "discover") return "search_actions";
  if (v === "list_connections" || v === "list" || v === "connections") return "list_connections";
  return null;
}

function inferOpFromText(text: string): McpOp | null {
  if (
    /\b(read|get|fetch|access|open|list)\b.*\b(resource|resources|document|docs?|file)\b/i.test(
      text
    )
  ) {
    return "read_resource";
  }
  if (/\b(call|use|run|execute|invoke|search|query)\b.*\b(tool|tools|mcp)\b/i.test(text)) {
    return "call_tool";
  }
  return null;
}

function getDirectResourceSelection(options?: unknown): ResourceSelection | null {
  const params = readOptions(options as HandlerOptions);
  const serverName = typeof params.serverName === "string" ? params.serverName.trim() : "";
  const uri = typeof params.uri === "string" ? params.uri.trim() : "";
  if (!serverName || !uri) return null;
  return {
    serverName,
    uri,
    reasoning:
      typeof params.reasoning === "string" && params.reasoning.trim()
        ? params.reasoning.trim()
        : "Selected from structured MCP read_resource parameters.",
  };
}

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

async function handleCallTool(
  runtime: IAgentRuntime,
  message: Memory,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const composedState = await runtime.composeState(message, ["RECENT_MESSAGES", "MCP"]);
  const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
  if (!mcpService) {
    throw new Error("MCP service not available");
  }
  const mcpProvider = mcpService.getProviderData();

  try {
    const toolSelectionName = await createToolSelectionName({
      runtime,
      state: composedState,
      message,
      callback,
      mcpProvider,
    });
    if (!toolSelectionName || toolSelectionName.noToolAvailable) {
      return await handleNoToolAvailable(callback, toolSelectionName);
    }
    const { serverName, toolName } = toolSelectionName;

    const toolSelectionArgument = await createToolSelectionArgument({
      runtime,
      state: composedState,
      message,
      callback,
      mcpProvider,
      toolSelectionName,
    });
    if (!toolSelectionArgument) {
      return await handleNoToolAvailable(callback, toolSelectionName);
    }

    const result = await mcpService.callTool(
      serverName,
      toolName,
      toolSelectionArgument.toolArguments
    );

    const { toolOutput, hasAttachments, attachments } = processToolResult(
      result,
      serverName,
      toolName,
      runtime,
      message.entityId
    );

    const replyMemory = await handleToolResponse(
      runtime,
      message,
      serverName,
      toolName,
      toolSelectionArgument.toolArguments,
      toolOutput,
      hasAttachments,
      attachments,
      composedState,
      mcpProvider,
      callback
    );

    return {
      text: `Successfully called tool: ${serverName}/${toolName}. Reasoned response: ${replyMemory.content.text}`,
      values: {
        success: true,
        toolExecuted: true,
        serverName,
        toolName,
        hasAttachments,
        output: toolOutput,
      },
      data: {
        actionName: "MCP",
        op: "call_tool",
        serverName,
        toolName,
        toolArgumentsJson: JSON.stringify(toolSelectionArgument.toolArguments),
        reasoning: toolSelectionName.reasoning,
        output: toolOutput,
        attachmentCount: attachments?.length ?? 0,
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
      "tool",
      callback
    );
  }
}

async function handleReadResource(
  runtime: IAgentRuntime,
  message: Memory,
  options: HandlerOptions | Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const composedState = await runtime.composeState(message, ["RECENT_MESSAGES", "MCP"]);
  const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
  if (!mcpService) {
    throw new Error("MCP service not available");
  }
  const mcpProvider = mcpService.getProviderData();

  try {
    await sendInitialResponse(callback);

    const parsedSelection =
      getDirectResourceSelection(options) ??
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
          actionName: "MCP",
          op: "read_resource",
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
        actionName: "MCP",
        op: "read_resource",
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
}

function textOf(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function hasConnectedCapability(runtime: IAgentRuntime): boolean {
  const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
  if (!mcpService) return false;
  return mcpService.getServers().some((server: McpServer) => {
    if (server.status !== "connected") return false;
    return (server.tools?.length ?? 0) > 0 || (server.resources?.length ?? 0) > 0;
  });
}

export function getMcpRouteForTest(
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>
): McpOp | null {
  const requested = normalizeOp(readOptions(options).op ?? readOptions(options).operation);
  if (requested) return requested;
  return inferOpFromText(textOf(message));
}

export const mcpAction: Action = {
  name: "MCP",
  contexts: ["general", "automation", "knowledge", "connectors", MCP_ACTION_CONTEXT, "files"],
  contextGate: {
    anyOf: ["general", "automation", "knowledge", "connectors", MCP_ACTION_CONTEXT, "files"],
  },
  roleGate: { minRole: "USER" },
  similes: [
    "MCP_ACTION",
    "MCP_ROUTER",
    "USE_MCP",
    "CALL_MCP_TOOL",
    "CALL_TOOL",
    "USE_TOOL",
    "USE_MCP_TOOL",
    "EXECUTE_TOOL",
    "EXECUTE_MCP_TOOL",
    "RUN_TOOL",
    "RUN_MCP_TOOL",
    "INVOKE_TOOL",
    "INVOKE_MCP_TOOL",
    "READ_MCP_RESOURCE",
    "READ_RESOURCE",
    "GET_RESOURCE",
    "GET_MCP_RESOURCE",
    "FETCH_RESOURCE",
    "FETCH_MCP_RESOURCE",
    "ACCESS_RESOURCE",
    "ACCESS_MCP_RESOURCE",
  ],
  description:
    "Single MCP entry point. Use op=call_tool to invoke an MCP tool, op=read_resource to read an MCP resource. Cloud runtimes also accept op=search_actions and op=list_connections.",
  descriptionCompressed: "MCP call_tool read_resource search_actions list_connections",
  parameters: [
    {
      name: "op",
      description: "MCP operation: call_tool | read_resource | search_actions | list_connections",
      required: false,
      schema: {
        type: "string",
        enum: ["call_tool", "read_resource", "search_actions", "list_connections"],
      },
    },
    {
      name: "serverName",
      description: "Optional MCP server name that owns the tool or resource.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "toolName",
      description: "For op=call_tool: optional exact MCP tool name to call.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "arguments",
      description: "For op=call_tool: optional JSON arguments to pass to the selected MCP tool.",
      required: false,
      schema: { type: "object" },
    },
    {
      name: "uri",
      description: "For op=read_resource: exact MCP resource URI to read.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "query",
      description:
        "Natural-language description of the tool call or resource to select; for op=search_actions, the keyword query.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "platform",
      description: "For op=search_actions: filter results to a single connected platform.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "For op=search_actions: maximum results to return.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "offset",
      description: "For op=search_actions: skip first N results for pagination.",
      required: false,
      schema: { type: "number" },
    },
  ],

  validate: async (runtime) => {
    if (!hasConnectedCapability(runtime)) return false;
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const opts = readOptions(options);
    const requested = normalizeOp(opts.op ?? opts.operation);
    const op = requested ?? inferOpFromText(textOf(message)) ?? "call_tool";

    if (op === "read_resource") {
      return handleReadResource(runtime, message, options, callback);
    }

    if (op === "search_actions" || op === "list_connections") {
      const text = `MCP op=${op} is only available in the cloud runtime.`;
      await callback?.({ text, source: message.content?.source });
      return {
        success: false,
        text,
        values: { error: "OP_NOT_SUPPORTED" },
        data: { actionName: "MCP", op },
      };
    }

    return handleCallTool(runtime, message, callback);
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Use the MCP GitHub tool to read the repository README" },
      },
      {
        name: "{{assistant}}",
        content: {
          text: "I'll route that through MCP.",
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
          text: "I'll read the MCP resource for that.",
          actions: ["MCP"],
        },
      },
    ],
  ],
};
