import {
  type Content,
  ContentType,
  composePromptFromState,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  type Media,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { resourceAnalysisTemplate } from "../templates/resourceAnalysisTemplate";
import { toolReasoningTemplate } from "../templates/toolReasoningTemplate";
import type { McpProviderData, McpResourceContent } from "../types";
import { createMcpMemory } from "./mcp";

function getMimeTypeToContentType(mimeType: string | undefined): ContentType | undefined {
  if (!mimeType) return undefined;

  if (mimeType.startsWith("image/")) return ContentType.IMAGE;
  if (mimeType.startsWith("video/")) return ContentType.VIDEO;
  if (mimeType.startsWith("audio/")) return ContentType.AUDIO;
  if (mimeType.includes("pdf") || mimeType.includes("document")) return ContentType.DOCUMENT;

  return undefined;
}

interface ResourceResult {
  readonly contents: readonly McpResourceContent[];
}

export function processResourceResult(
  result: ResourceResult,
  uri: string
): { resourceContent: string; resourceMeta: string } {
  let resourceContent = "";
  let resourceMeta = "";

  for (const content of result.contents) {
    if (content.text) {
      resourceContent += content.text;
    } else if (content.blob) {
      resourceContent += `[Binary data${content.mimeType ? ` - ${content.mimeType}` : ""}]`;
    }

    resourceMeta += `Resource: ${content.uri ?? uri}\n`;
    if (content.mimeType) {
      resourceMeta += `Type: ${content.mimeType}\n`;
    }
  }

  return { resourceContent, resourceMeta };
}

interface ToolContentItem {
  readonly type: string;
  readonly text?: string;
  readonly mimeType?: string;
  readonly data?: string;
  readonly resource?: {
    readonly uri: string;
    readonly text?: string;
    readonly blob?: string;
  };
}

interface ToolResult {
  readonly content: readonly ToolContentItem[];
  readonly isError?: boolean;
}

export function processToolResult(
  result: ToolResult,
  serverName: string,
  toolName: string,
  runtime: IAgentRuntime,
  messageEntityId: string
): { toolOutput: string; hasAttachments: boolean; attachments: Media[] } {
  let toolOutput = "";
  let hasAttachments = false;
  const attachments: Media[] = [];

  for (const content of result.content) {
    if (content.type === "text" && content.text) {
      toolOutput += content.text;
    } else if (content.type === "image" && content.data && content.mimeType) {
      hasAttachments = true;
      attachments.push({
        contentType: getMimeTypeToContentType(content.mimeType),
        url: `data:${content.mimeType};base64,${content.data}`,
        id: createUniqueUuid(runtime, messageEntityId),
        title: "Generated image",
        source: `${serverName}/${toolName}`,
        description: "Tool-generated image",
        text: "Generated image",
      });
    } else if (content.type === "resource" && content.resource) {
      const resource = content.resource;
      if ("text" in resource && resource.text) {
        toolOutput += `\n\nResource (${resource.uri}):\n${resource.text}`;
      } else if ("blob" in resource) {
        toolOutput += `\n\nResource (${resource.uri}): [Binary data]`;
      }
    }
  }

  return { toolOutput, hasAttachments, attachments };
}

export async function handleResourceAnalysis(
  runtime: IAgentRuntime,
  message: Memory,
  uri: string,
  serverName: string,
  resourceContent: string,
  resourceMeta: string,
  callback?: HandlerCallback
): Promise<void> {
  await createMcpMemory(runtime, message, "resource", serverName, resourceContent, {
    uri,
    isResourceAccess: true,
  });

  const analysisPrompt = createAnalysisPrompt(
    uri,
    message.content.text ?? "",
    resourceContent,
    resourceMeta
  );

  const analyzedResponse = (await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt: analysisPrompt,
  })) as string;

  if (callback) {
    await callback({
      text: analyzedResponse,
      actions: ["READ_MCP_RESOURCE"],
    });
  }
}

interface McpProviderArg {
  readonly values: { readonly mcp: McpProviderData };
  readonly data: { readonly mcp: McpProviderData };
  readonly text: string;
}

export async function handleToolResponse(
  runtime: IAgentRuntime,
  message: Memory,
  serverName: string,
  toolName: string,
  toolArgs: Readonly<Record<string, unknown>>,
  toolOutput: string,
  hasAttachments: boolean,
  attachments: readonly Media[],
  state: State,
  mcpProvider: McpProviderArg,
  callback?: HandlerCallback
): Promise<Memory> {
  await createMcpMemory(runtime, message, "tool", serverName, toolOutput, {
    toolName,
    arguments: toolArgs,
    isToolCall: true,
  });

  const reasoningPrompt = createReasoningPrompt(
    state,
    mcpProvider,
    toolName,
    serverName,
    message.content.text ?? "",
    toolOutput,
    hasAttachments
  );

  const reasonedResponse = (await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt: reasoningPrompt,
  })) as string;

  const agentId = message.agentId ?? runtime.agentId;
  const replyMemory: Memory = {
    entityId: agentId,
    roomId: message.roomId,
    worldId: message.worldId,
    content: {
      text: reasonedResponse,
      actions: ["CALL_MCP_TOOL"],
      attachments: hasAttachments && attachments.length > 0 ? [...attachments] : undefined,
    },
  };

  await runtime.createMemory(replyMemory, "messages");

  if (callback) {
    await callback({
      text: reasonedResponse,
      actions: ["CALL_MCP_TOOL"],
      attachments: hasAttachments && attachments.length > 0 ? [...attachments] : undefined,
    });
  }

  return replyMemory;
}

export async function sendInitialResponse(callback?: HandlerCallback): Promise<void> {
  if (callback) {
    const responseContent: Content = {
      text: "I'll retrieve that information for you. Let me access the resource...",
      actions: ["READ_MCP_RESOURCE"],
    };
    await callback(responseContent);
  }
}

function createAnalysisPrompt(
  uri: string,
  userMessage: string,
  resourceContent: string,
  resourceMeta: string
): string {
  const enhancedState: State = {
    data: {},
    text: "",
    values: {
      uri,
      userMessage,
      resourceContent,
      resourceMeta,
    },
  };

  return composePromptFromState({
    state: enhancedState,
    template: resourceAnalysisTemplate,
  });
}

function createReasoningPrompt(
  state: State,
  mcpProvider: McpProviderArg,
  toolName: string,
  serverName: string,
  userMessage: string,
  toolOutput: string,
  hasAttachments: boolean
): string {
  const enhancedState: State = {
    ...state,
    values: {
      ...state.values,
      mcpProvider,
      toolName,
      serverName,
      userMessage,
      toolOutput,
      hasAttachments,
    },
  };

  return composePromptFromState({
    state: enhancedState,
    template: toolReasoningTemplate,
  });
}
