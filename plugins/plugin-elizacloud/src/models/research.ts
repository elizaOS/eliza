/** Research model handler — calls /responses for deep-research models. */

import type {
  IAgentRuntime,
  ResearchAnnotation,
  ResearchOutputItem,
  ResearchParams,
  ResearchResult,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { getResearchModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { createCloudApiClient } from "../utils/sdk-client";

interface ResponsesAPIOutput {
  id: string;
  status: string;
  output: Array<{
    type: string;
    id?: string;
    status?: string;
    content?: Array<{
      type: string;
      text?: string;
      annotations?: Array<{
        type: string;
        url?: string;
        title?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
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
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

type ResponsesAPIInput =
  | string
  | Array<{
      role: "user" | "system" | "assistant";
      content: Array<{
        type: "input_text";
        text: string;
      }>;
    }>;

function normalizeInput(input: ResearchParams["input"]): ResponsesAPIInput {
  if (typeof input !== "string") {
    return input as ResponsesAPIInput;
  }

  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: input,
        },
      ],
    },
  ];
}

function buildResearchApiError(status: number, errorText: string): Error {
  try {
    const parsed = JSON.parse(errorText) as {
      error?: { message?: string; param?: string; code?: string };
    };
    const message = parsed.error?.message;
    const param = parsed.error?.param;
    if (param === "tools.0.type" && message?.includes('expected "function"')) {
      return new Error(
        `Research API error: ${status} Eliza Cloud /responses rejected deep-research tool types; the provider currently only accepts function tools on this route`
      );
    }
  } catch {
    // Fall through to the raw error text.
  }

  return new Error(`Research API error: ${status} ${errorText}`);
}

function parseAnnotations(
  raw: Array<{
    type: string;
    url?: string;
    title?: string;
    start_index?: number;
    end_index?: number;
  }>
): ResearchAnnotation[] {
  return raw
    .filter((a) => a.url !== undefined)
    .map((a) => ({
      url: a.url as string,
      title: a.title ?? "",
      startIndex: a.start_index ?? 0,
      endIndex: a.end_index ?? 0,
    }));
}

function parseOutputItems(raw: ResponsesAPIOutput["output"]): ResearchOutputItem[] {
  const items: ResearchOutputItem[] = [];

  for (const item of raw) {
    switch (item.type) {
      case "web_search_call":
        items.push({
          id: item.id ?? "",
          type: "web_search_call",
          status: (item.status as "completed" | "failed") ?? "completed",
          action: {
            type: (item.action?.type as "search" | "open_page" | "find_in_page") ?? "search",
            query: item.action?.query,
            url: item.action?.url,
          },
        });
        break;
      case "file_search_call":
        items.push({
          id: item.id ?? "",
          type: "file_search_call",
          status: (item.status as "completed" | "failed") ?? "completed",
          query: item.query ?? "",
          results: item.results?.map((r) => ({
            fileId: r.file_id,
            fileName: r.file_name,
            score: r.score,
          })),
        });
        break;
      case "code_interpreter_call":
        items.push({
          id: item.id ?? "",
          type: "code_interpreter_call",
          status: (item.status as "completed" | "failed") ?? "completed",
          code: item.code ?? "",
          output: item.output,
        });
        break;
      case "mcp_tool_call":
        items.push({
          id: item.id ?? "",
          type: "mcp_tool_call",
          status: (item.status as "completed" | "failed") ?? "completed",
          serverLabel: item.server_label ?? "",
          toolName: item.tool_name ?? "",
          arguments: (item.arguments ?? {}) as Record<string, import("@elizaos/core").JsonValue>,
          result: item.result as import("@elizaos/core").JsonValue | undefined,
        });
        break;
      case "message": {
        const content = item.content ?? [];
        items.push({
          type: "message",
          content: content
            .filter((c) => c.type === "output_text")
            .map((c) => ({
              type: "output_text" as const,
              text: c.text ?? "",
              annotations: parseAnnotations(c.annotations ?? []),
            })),
        });
        break;
      }
    }
  }

  return items;
}

export async function handleResearch(
  runtime: IAgentRuntime,
  params: ResearchParams
): Promise<ResearchResult> {
  const modelName = params.model ?? getResearchModel(runtime);
  logger.log(`[ELIZAOS_CLOUD] Using RESEARCH model: ${modelName}`);

  const tools = params.tools ?? [{ type: "web_search_preview" }];

  const requestBody: Record<string, unknown> = {
    model: modelName,
    input: normalizeInput(params.input),
    tools: tools,
  };

  if (params.instructions) {
    requestBody.instructions = params.instructions;
  }
  if (params.background !== undefined) {
    requestBody.background = params.background;
  }
  if (params.maxToolCalls !== undefined) {
    requestBody.max_tool_calls = params.maxToolCalls;
  }
  if (params.reasoningSummary) {
    requestBody.reasoning = { summary: params.reasoningSummary };
  }

  const response = await createCloudApiClient(runtime).requestRaw("POST", "/responses", {
    json: requestBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw buildResearchApiError(response.status, errorText);
  }

  const data = (await response.json()) as ResponsesAPIOutput;

  if (data.usage) {
    emitModelUsageEvent(runtime, ModelType.RESEARCH, params.input, {
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      totalTokens: data.usage.total_tokens,
    });
  }

  const outputItems = parseOutputItems(data.output);

  // Extract final text and annotations from the last message output
  let text = "";
  const annotations: ResearchAnnotation[] = [];

  for (const item of outputItems) {
    if (item.type === "message") {
      for (const content of item.content) {
        if (content.type === "output_text") {
          text += content.text;
          annotations.push(...content.annotations);
        }
      }
    }
  }

  return {
    id: data.id,
    text,
    annotations,
    outputItems,
    status: data.status as ResearchResult["status"],
  };
}
