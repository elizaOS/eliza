/**
 * Deep Research model handler
 *
 * Provides deep research capabilities using OpenAI's o3-deep-research and o4-mini-deep-research models.
 * These models can find, analyze, and synthesize hundreds of sources to create comprehensive reports.
 *
 * @see https://platform.openai.com/docs/guides/deep-research
 */

import type {
  IAgentRuntime,
  JsonValue,
  ResearchAnnotation,
  ResearchCodeInterpreterCall,
  ResearchFileSearchCall,
  ResearchMcpToolCall,
  ResearchMessageOutput,
  ResearchOutputItem,
  ResearchParams,
  ResearchResult,
  ResearchTool,
  ResearchWebSearchCall,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getApiKey, getBaseURL, getResearchModel, getResearchTimeout } from "../utils/config";

// ============================================================================
// Types for OpenAI Responses API
// ============================================================================

/**
 * Tool configuration for the Responses API
 */
interface ResponsesApiTool {
  type: "web_search_preview" | "file_search" | "code_interpreter" | "mcp";
  vector_store_ids?: string[];
  container?: { type: "auto" };
  server_label?: string;
  server_url?: string;
  require_approval?: "never";
}

/**
 * Raw response from the OpenAI Responses API
 */
interface ResponsesApiResponse {
  id: string;
  object: string;
  status?: "queued" | "in_progress" | "completed" | "failed";
  output?: ResponsesApiOutputItem[];
  output_text?: string;
  error?: {
    message: string;
    code: string;
  };
}

/**
 * Raw output item from the Responses API
 */
interface ResponsesApiOutputItem {
  id?: string;
  type: string;
  status?: string;
  action?: {
    type: string;
    query?: string;
    url?: string;
  };
  query?: string;
  results?: Array<{
    file_id: string;
    file_name: string;
    score: number;
  }>;
  code?: string;
  output?: string;
  server_label?: string;
  tool_name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  content?: Array<{
    type: string;
    text: string;
    annotations?: Array<{
      url: string;
      title: string;
      start_index: number;
      end_index: number;
    }>;
  }>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Converts ResearchTool params to Responses API tool format
 */
function convertToolToApi(tool: ResearchTool): ResponsesApiTool {
  switch (tool.type) {
    case "web_search_preview":
      return { type: "web_search_preview" };
    case "file_search":
      return {
        type: "file_search",
        vector_store_ids: tool.vectorStoreIds,
      };
    case "code_interpreter":
      return {
        type: "code_interpreter",
        container: tool.container ?? { type: "auto" },
      };
    case "mcp":
      return {
        type: "mcp",
        server_label: tool.serverLabel,
        server_url: tool.serverUrl,
        require_approval: tool.requireApproval ?? "never",
      };
    default:
      throw new Error(`Unknown research tool type: ${(tool as ResearchTool).type}`);
  }
}

/**
 * Converts raw API output items to typed ResearchOutputItem
 */
function convertOutputItem(item: ResponsesApiOutputItem): ResearchOutputItem | null {
  switch (item.type) {
    case "web_search_call":
      return {
        id: item.id ?? "",
        type: "web_search_call",
        status: (item.status as "completed" | "failed") ?? "completed",
        action: {
          type: (item.action?.type as "search" | "open_page" | "find_in_page") ?? "search",
          query: item.action?.query,
          url: item.action?.url,
        },
      } satisfies ResearchWebSearchCall;

    case "file_search_call":
      return {
        id: item.id ?? "",
        type: "file_search_call",
        status: (item.status as "completed" | "failed") ?? "completed",
        query: item.query ?? "",
        results: item.results?.map((r) => ({
          fileId: r.file_id,
          fileName: r.file_name,
          score: r.score,
        })),
      } satisfies ResearchFileSearchCall;

    case "code_interpreter_call":
      return {
        id: item.id ?? "",
        type: "code_interpreter_call",
        status: (item.status as "completed" | "failed") ?? "completed",
        code: item.code ?? "",
        output: item.output,
      } satisfies ResearchCodeInterpreterCall;

    case "mcp_tool_call":
      return {
        id: item.id ?? "",
        type: "mcp_tool_call",
        status: (item.status as "completed" | "failed") ?? "completed",
        serverLabel: item.server_label ?? "",
        toolName: item.tool_name ?? "",
        arguments: (item.arguments ?? {}) as Record<string, JsonValue>,
        result: item.result as JsonValue,
      } satisfies ResearchMcpToolCall;

    case "message":
      return {
        type: "message",
        content:
          item.content?.map((c) => ({
            type: "output_text" as const,
            text: c.text,
            annotations:
              c.annotations?.map((a) => ({
                url: a.url,
                title: a.title,
                startIndex: a.start_index,
                endIndex: a.end_index,
              })) ?? [],
          })) ?? [],
      } satisfies ResearchMessageOutput;

    default:
      // Unknown output type, skip
      return null;
  }
}

/**
 * Extracts text and annotations from the response
 */
function extractTextAndAnnotations(response: ResponsesApiResponse): {
  text: string;
  annotations: ResearchAnnotation[];
} {
  // Try output_text first (convenience field)
  if (response.output_text) {
    // Find annotations from message output items
    const annotations: ResearchAnnotation[] = [];
    if (response.output) {
      for (const item of response.output) {
        if (item.type === "message" && item.content) {
          for (const content of item.content) {
            if (content.annotations) {
              for (const ann of content.annotations) {
                annotations.push({
                  url: ann.url,
                  title: ann.title,
                  startIndex: ann.start_index,
                  endIndex: ann.end_index,
                });
              }
            }
          }
        }
      }
    }
    return { text: response.output_text, annotations };
  }

  // Fall back to extracting from message output items
  let text = "";
  const annotations: ResearchAnnotation[] = [];

  if (response.output) {
    for (const item of response.output) {
      if (item.type === "message" && item.content) {
        for (const content of item.content) {
          text += content.text;
          if (content.annotations) {
            for (const ann of content.annotations) {
              annotations.push({
                url: ann.url,
                title: ann.title,
                startIndex: ann.start_index,
                endIndex: ann.end_index,
              });
            }
          }
        }
      }
    }
  }

  return { text, annotations };
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Handles RESEARCH model requests using OpenAI's deep research models.
 *
 * Deep research models can take tens of minutes to complete tasks.
 * Use background mode for long-running tasks.
 *
 * @param runtime - The agent runtime
 * @param params - Research parameters
 * @returns Research result with text, annotations, and output items
 *
 * @example
 * ```typescript
 * const result = await handleResearch(runtime, {
 *   input: "Research the economic impact of AI on global labor markets",
 *   tools: [
 *     { type: "web_search_preview" },
 *     { type: "code_interpreter", container: { type: "auto" } }
 *   ],
 *   background: true,
 * });
 * console.log(result.text);
 * ```
 */
export async function handleResearch(
  runtime: IAgentRuntime,
  params: ResearchParams
): Promise<ResearchResult> {
  const apiKey = getApiKey(runtime);
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for deep research. Set it in your environment variables or runtime settings."
    );
  }

  const baseURL = getBaseURL(runtime);
  const modelName = params.model ?? getResearchModel(runtime);
  const timeout = getResearchTimeout(runtime);

  logger.debug(`[OpenAI] Starting deep research with model: ${modelName}`);
  logger.debug(`[OpenAI] Research input: ${params.input.substring(0, 100)}...`);

  // Validate that at least one data source tool is provided
  const dataSourceTools = params.tools?.filter(
    (t) => t.type === "web_search_preview" || t.type === "file_search" || t.type === "mcp"
  );

  if (!dataSourceTools || dataSourceTools.length === 0) {
    // Default to web search if no tools specified
    logger.debug("[OpenAI] No data source tools specified, defaulting to web_search_preview");
    params.tools = [{ type: "web_search_preview" }, ...(params.tools ?? [])];
  }

  // Build the request body for the Responses API
  const requestBody: Record<string, unknown> = {
    model: modelName,
    input: params.input,
  };

  if (params.instructions) {
    requestBody.instructions = params.instructions;
  }

  if (params.background !== undefined) {
    requestBody.background = params.background;
  }

  if (params.tools && params.tools.length > 0) {
    requestBody.tools = params.tools.map(convertToolToApi);
  }

  if (params.maxToolCalls !== undefined) {
    requestBody.max_tool_calls = params.maxToolCalls;
  }

  if (params.reasoningSummary) {
    requestBody.reasoning = { summary: params.reasoningSummary };
  }

  logger.debug(`[OpenAI] Research request body: ${JSON.stringify(requestBody, null, 2)}`);

  // Make the API request
  const response = await fetch(`${baseURL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`[OpenAI] Research request failed: ${response.status} ${errorText}`);
    throw new Error(`Deep research request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ResponsesApiResponse;

  if (data.error) {
    logger.error(`[OpenAI] Research API error: ${data.error.message}`);
    throw new Error(`Deep research error: ${data.error.message}`);
  }

  logger.debug(`[OpenAI] Research response received. Status: ${data.status ?? "completed"}`);

  // Extract text and annotations
  const { text, annotations } = extractTextAndAnnotations(data);

  // Convert output items
  const outputItems: ResearchOutputItem[] = [];
  if (data.output) {
    for (const item of data.output) {
      const converted = convertOutputItem(item);
      if (converted) {
        outputItems.push(converted);
      }
    }
  }

  const result: ResearchResult = {
    id: data.id,
    text,
    annotations,
    outputItems,
    status: data.status,
  };

  logger.info(
    `[OpenAI] Research completed. Text length: ${text.length}, Annotations: ${annotations.length}, Output items: ${outputItems.length}`
  );

  return result;
}
