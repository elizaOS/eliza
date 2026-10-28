/**
 * The unified MCP action: a single entry point that routes an agent request to
 * call_tool or read_resource. The op is taken from structured parameters when
 * present, else inferred from message text. A complete structured selection
 * (serverName with toolName or uri) is used as given; with none, tool and
 * resource selection are model-driven with retry/feedback; a partial one is
 * refused. Results are synthesized back to the user and persisted as
 * memories. validate() gates the action on there being at least one connected
 * server that exposes a tool or resource.
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { composePromptFromState } from "@elizaos/plugin-assistant/text/template-rendering";
import { resourceSelectionTemplate } from "../protocol-utils/prompts.js";
import type { McpService } from "../service";
import { MCP_SERVICE_NAME, type McpServer, type McpServerInfo } from "../types";
import { handleMcpError, McpError } from "../utils/error";
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
export type McpOp = "call_tool" | "read_resource";
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
/**
 * A structured selection names its own operation: toolName belongs to call_tool
 * and uri to read_resource. It outranks the request-text guess, which would
 * otherwise route a complete tool call to read_resource whenever the user's
 * wording mentions reading a file or doc. `arguments` alone names no target, so
 * it does not decide the operation.
 */
function inferOpFromSelection(params: Record<string, unknown>): McpOp | null {
  if (typeof params.toolName === "string" && params.toolName.trim() !== "") return "call_tool";
  if (typeof params.uri === "string" && params.uri.trim() !== "") return "read_resource";
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
export interface DirectToolSelection {
  readonly serverName: string;
  readonly toolName: string;
  /** Absent when the planner named the tool but supplied no arguments. */
  readonly toolArguments?: Readonly<Record<string, unknown>>;
  readonly reasoning: string;
}
export function getDirectToolSelection(options?: unknown): DirectToolSelection | null {
  const params = readOptions(options as HandlerOptions);
  const serverName = typeof params.serverName === "string" ? params.serverName.trim() : "";
  const toolName = typeof params.toolName === "string" ? params.toolName.trim() : "";
  if (!serverName || !toolName) return null;
  let toolArguments: Record<string, unknown> | undefined;
  const rawArgs = params.arguments ?? params.toolArguments;
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    toolArguments = rawArgs as Record<string, unknown>;
  } else if (typeof rawArgs === "string" && rawArgs.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        toolArguments = parsed as Record<string, unknown>;
      }
    } catch {
      // error-policy:J3 untrusted planner input — a non-JSON arguments string
      // is treated as absent so the model argument pass derives them instead.
    }
  }
  return {
    serverName,
    toolName,
    ...(toolArguments !== undefined ? { toolArguments } : {}),
    reasoning:
      typeof params.reasoning === "string" && params.reasoning.trim()
        ? params.reasoning.trim()
        : "Selected from structured MCP call_tool parameters.",
  };
}
/**
 * Why a structured selection cannot be used, or null when it can. The direct
 * path needs the server and the target together and the model path reads only
 * the request text, so a partial selection would be dropped, not honored.
 */
function incompleteSelectionReason(op: McpOp, params: Record<string, unknown>): string | null {
  const given = (key: string): boolean => {
    const value = params[key];
    return typeof value === "string" && value.trim() !== "";
  };
  const serverName = given("serverName");
  if (op === "read_resource") {
    const uri = given("uri");
    if (uri && !serverName) return "MCP read_resource needs serverName together with uri.";
    if (serverName && !uri) {
      return "MCP read_resource needs uri together with serverName. Omit serverName to select the resource from the request text.";
    }
    return null;
  }
  const toolName = given("toolName");
  if (toolName && !serverName) return "MCP call_tool needs serverName together with toolName.";
  if (!toolName && given("uri")) {
    return "MCP call_tool does not take uri. Use action=read_resource with serverName and uri.";
  }
  if (serverName && !toolName) {
    return "MCP call_tool needs toolName together with serverName. Omit serverName to select the tool from the request text.";
  }
  if (!toolName && params.arguments !== undefined) {
    return "MCP call_tool needs serverName and toolName together with arguments.";
  }
  return null;
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
      resourcesDescription += `Description: ${resource.description ?? "No description available"}\n`;
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
    // Honor the planner's explicit tool selection (serverName + toolName, and
    // arguments when given) instead of re-deriving it with a second model
    // selection pass. When the planner already named the tool, that second pass
    // can spuriously return noToolAvailable and fail an otherwise-valid call.
    let selection: {
      serverName: string;
      toolName: string;
      reasoning?: string;
    };
    let toolArguments: Readonly<Record<string, unknown>>;
    const direct = getDirectToolSelection(options);
    if (direct) {
      selection = direct;
      if (direct.toolArguments) {
        toolArguments = direct.toolArguments;
      } else {
        const derived = await createToolSelectionArgument({
          runtime,
          state: composedState,
          message,
          callback,
          mcpProvider,
          toolSelectionName: direct,
        });
        if (!derived) {
          return await handleNoToolAvailable(callback, direct);
        }
        toolArguments = derived.toolArguments;
      }
    } else {
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
      selection = toolSelectionName;
      toolArguments = toolSelectionArgument.toolArguments;
    }
    const { serverName, toolName } = selection;
    const result = await mcpService.callTool(serverName, toolName, toolArguments);
    const { toolOutput, hasAttachments, attachments, isError } = processToolResult(
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
      toolArguments,
      toolOutput,
      hasAttachments,
      attachments,
      composedState,
      mcpProvider,
      callback,
      isError
    );
    const data = {
      actionName: "MCP",
      op: "call_tool" as const,
      serverName,
      toolName,
      toolArgumentsJson: JSON.stringify(toolArguments),
      reasoning: selection.reasoning,
      output: toolOutput,
      attachmentCount: attachments.length,
      isError,
    };
    if (isError) {
      return {
        text: `Tool ${serverName}/${toolName} reported an error. Reasoned response: ${replyMemory.content.text}`,
        values: {
          success: false,
          toolExecuted: true,
          toolErrored: true,
          serverName,
          toolName,
          hasAttachments,
          output: toolOutput,
        },
        data,
        success: false,
        error: new McpError(
          `MCP tool '${serverName}/${toolName}' returned an error result: ${toolOutput}`,
          "TOOL_EXECUTION_ERROR"
        ),
      };
    }
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
      data,
      success: true,
    };
  } catch (error) {
    // error-policy:J4 action boundary — handleMcpError logs, replies to the user,
    // and returns success:false with the error; no fabricated success value.
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
  // The MCP provider publishes only a compact `mcpServers` line; the selection
  // template renders `mcpProvider.text` and the retry feedback reads
  // `values.mcp`, so both come from the service, as tool selection does.
  const resourceState: State = {
    ...composedState,
    values: {
      ...composedState.values,
      mcp: composedState.values.mcp ?? mcpProvider.data.mcp,
      mcpProvider,
    },
  };
  try {
    await sendInitialResponse(callback);
    const parsedSelection =
      getDirectResourceSelection(options) ??
      (await (async () => {
        const resourceSelectionPrompt = createResourceSelectionPrompt(
          resourceState,
          message.content.text ?? ""
        );
        const resourceSelection = (await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: resourceSelectionPrompt,
        })) as string;
        return withModelRetry<ResourceSelection>({
          runtime,
          state: resourceState,
          message,
          callback,
          input: resourceSelection,
          validationFn: (data) => validateResourceSelection(data, resourceState),
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
    const { resourceContent, resourceMeta, attachments } = processResourceResult(
      result,
      uri,
      runtime,
      serverName,
      message.entityId
    );
    await handleResourceAnalysis(
      runtime,
      message,
      uri,
      serverName,
      resourceContent,
      resourceMeta,
      attachments,
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
        attachments,
        attachmentCount: attachments.length,
        output: resourceContent,
        contentLength: resourceContent?.length ?? 0,
      },
      success: true,
    };
  } catch (error) {
    // error-policy:J4 action boundary — handleMcpError logs, replies to the user,
    // and returns success:false with the error; no fabricated success value.
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
    "USE_MCP_TOOL",
    "EXECUTE_MCP_TOOL",
    "RUN_MCP_TOOL",
    "INVOKE_MCP_TOOL",
    "READ_MCP_RESOURCE",
    "READ_RESOURCE",
    "GET_MCP_RESOURCE",
    "FETCH_MCP_RESOURCE",
    "ACCESS_MCP_RESOURCE",
  ],
  description:
    "Single MCP entry point. Use action=call_tool to invoke an MCP tool, action=read_resource to read an MCP resource.",
  descriptionCompressed: "MCP call_tool read_resource",
  routingHint:
    "call a tool or read a resource on a connected external MCP server -> MCP; do NOT use to invoke an agent skill -> USE_SKILL, or to run a local shell command / edit files -> BASH / FILE",
  parameters: [
    {
      name: "action",
      description: "MCP operation: call_tool | read_resource",
      required: false,
      schema: {
        type: "string",
        enum: ["call_tool", "read_resource"],
      },
    },
    {
      name: "serverName",
      description:
        "MCP server name that owns the tool or resource. Give it together with toolName (call_tool) or uri (read_resource). Omit all three to select from the request text.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "toolName",
      description: "For action=call_tool: exact MCP tool name on serverName. Requires serverName.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "arguments",
      description:
        "For action=call_tool: JSON arguments to pass to toolName. Requires serverName and toolName.",
      required: false,
      schema: { type: "object", additionalProperties: true },
    },
    {
      name: "uri",
      description:
        "For action=read_resource: exact MCP resource URI on serverName. Requires serverName.",
      required: false,
      schema: { type: "string" },
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
    const requested = normalizeOp(opts.action ?? opts.subaction ?? opts.op ?? opts.operation);
    const op =
      requested ?? inferOpFromSelection(opts) ?? inferOpFromText(textOf(message)) ?? "call_tool";
    const incomplete = incompleteSelectionReason(op, opts);
    if (incomplete) {
      await callback?.({ text: incomplete, source: message.content?.source });
      return {
        success: false,
        text: incomplete,
        values: { error: "INCOMPLETE_SELECTION" },
        data: { actionName: "MCP", op },
        error: new McpError(incomplete, "INCOMPLETE_SELECTION"),
      };
    }
    if (op === "read_resource") {
      return handleReadResource(runtime, message, options, callback);
    }
    return handleCallTool(runtime, message, options, callback);
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
