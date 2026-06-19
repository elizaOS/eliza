import {
  ContentType,
  composePromptFromState,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  type Media,
  type Memory,
  ModelType,
} from "@elizaos/core";
import { resourceAnalysisTemplate } from "../templates/resourceAnalysisTemplate";
import { createMcpMemory } from "./mcp";

const MAX_TOOL_OUTPUT_CHARS = 12_000;
const MAX_TOOL_ATTACHMENTS = 4;

function getMimeTypeToContentType(mimeType?: string): ContentType | undefined {
  if (!mimeType) return undefined;
  if (mimeType.startsWith("image/")) return ContentType.IMAGE;
  if (mimeType.startsWith("video/")) return ContentType.VIDEO;
  if (mimeType.startsWith("audio/")) return ContentType.AUDIO;
  if (mimeType.includes("pdf") || mimeType.includes("document")) return ContentType.DOCUMENT;
  return undefined;
}

/** Process resource result from MCP */
export function processResourceResult(
  result: {
    contents: Array<{
      uri: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }>;
  },
  uri: string,
): { resourceContent: string; resourceMeta: string } {
  let resourceContent = "";
  let resourceMeta = "";

  for (const content of result.contents) {
    resourceContent +=
      content.text || (content.blob ? `[Binary: ${content.mimeType || "unknown"}]` : "");
    resourceMeta += `Resource: ${content.uri || uri}\n`;
    if (content.mimeType) resourceMeta += `Type: ${content.mimeType}\n`;
  }

  return { resourceContent, resourceMeta };
}

/** Process tool result from MCP - used by dynamic-tool-actions */
export function processToolResult(
  result: {
    content: Array<{
      type: string;
      text?: string;
      mimeType?: string;
      data?: string;
      resource?: { uri: string; text?: string; blob?: string };
    }>;
    isError?: boolean;
  },
  serverName: string,
  toolName: string,
  runtime: IAgentRuntime,
  messageEntityId: string,
): { toolOutput: string; hasAttachments: boolean; attachments: Media[] } {
  let toolOutput = "";
  let hasAttachments = false;
  const attachments: Media[] = [];
  let attachmentIndex = 0;

  const appendToolOutput = (text: string) => {
    if (!text || toolOutput.length >= MAX_TOOL_OUTPUT_CHARS) return;
    const remaining = MAX_TOOL_OUTPUT_CHARS - toolOutput.length;
    toolOutput += text.slice(0, remaining);
    if (text.length > remaining) {
      toolOutput += "\n\n[Tool output truncated]";
    }
  };

  for (const content of result.content) {
    if (content.type === "text") {
      appendToolOutput(content.text ?? "");
    } else if (content.type === "image" && attachments.length < MAX_TOOL_ATTACHMENTS) {
      hasAttachments = true;
      attachments.push({
        contentType: getMimeTypeToContentType(content.mimeType),
        url: `data:${content.mimeType};base64,${content.data}`,
        id: createUniqueUuid(runtime, `${messageEntityId}-attachment-${attachmentIndex++}`),
        title: "Generated image",
        source: `${serverName}/${toolName}`,
        description: "Tool-generated image",
        text: "Generated image",
      });
    } else if (content.type === "resource" && content.resource) {
      const r = content.resource;
      appendToolOutput(
        r.text ? `\n\nResource (${r.uri}):\n${r.text}` : `\n\nResource (${r.uri}): [Binary]`,
      );
    }
  }

  return { toolOutput, hasAttachments, attachments };
}

/** Handle resource analysis for readResourceAction */
export async function handleResourceAnalysis(
  runtime: IAgentRuntime,
  message: Memory,
  uri: string,
  serverName: string,
  resourceContent: string,
  resourceMeta: string,
  callback?: HandlerCallback,
): Promise<void> {
  await createMcpMemory(runtime, message, "resource", serverName, resourceContent, {
    uri,
    isResourceAccess: true,
  });

  const prompt = composePromptFromState({
    state: {
      data: {},
      text: "",
      values: {
        uri,
        userMessage: message.content.text || "",
        resourceContent,
        resourceMeta,
      },
    },
    template: resourceAnalysisTemplate,
  });

  const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });

  if (callback) {
    await callback({
      text: response,
      thought: `Analyzed resource ${uri} from ${serverName}`,
      actions: ["READ_MCP_RESOURCE"],
    });
  }
}

/** Send initial response for readResourceAction */
export async function sendInitialResponse(callback?: HandlerCallback): Promise<void> {
  if (callback) {
    await callback({
      thought: "Retrieving MCP resource...",
      text: "I'll retrieve that information for you. Let me access the resource...",
      actions: ["READ_MCP_RESOURCE"],
    });
  }
}
