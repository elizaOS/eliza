/**
 * Vercel AI Gateway provider adapter.
 *
 * Cloud's lower-level inference routes expect an OpenAI-compatible `Response`
 * object. Vercel AI Gateway uses the AI SDK protocol, so this adapter bridges
 * the two shapes while keeping the provider behind the same `AIProvider`
 * interface as OpenRouter/OpenAI/Groq.
 */

import { createGatewayProvider, type GatewayProvider } from "@ai-sdk/gateway";
import {
  embed,
  embedMany,
  generateText,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
} from "ai";
import type {
  AIProvider,
  OpenAIChatRequest,
  OpenAIEmbeddingsRequest,
  ProviderHttpError,
  ProviderRequestOptions,
} from "./types";

type GatewayChatMessage = OpenAIChatRequest["messages"][number];
type GatewayModelMetadata = Awaited<
  ReturnType<GatewayProvider["getAvailableModels"]>
>["models"][number];

export class VercelAIGatewayProvider implements AIProvider {
  name = "gateway";
  private gateway: GatewayProvider;

  constructor(apiKey: string, baseURL?: string) {
    if (!apiKey) {
      throw new Error("AI Gateway API key is required");
    }

    this.gateway = createGatewayProvider({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  async chatCompletions(
    request: OpenAIChatRequest,
    options?: ProviderRequestOptions,
  ): Promise<Response> {
    const output = request.response_format ? toGatewayOutput(request.response_format) : undefined;
    const common: Record<string, unknown> = {
      model: this.gateway(request.model as never),
      messages: toModelMessages(request.messages),
      allowSystemInMessages: true,
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.top_p != null ? { topP: request.top_p } : {}),
      ...(request.stop != null
        ? { stopSequences: Array.isArray(request.stop) ? request.stop : [request.stop] }
        : {}),
      ...(request.max_tokens != null ? { maxOutputTokens: request.max_tokens } : {}),
      ...(request.tools ? { tools: toGatewayTools(request.tools) } : {}),
      ...(request.tool_choice ? { toolChoice: toGatewayToolChoice(request.tool_choice) } : {}),
      ...(output ? { output } : {}),
      ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
      ...(options?.signal ? { abortSignal: options.signal } : {}),
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
    };

    if (request.stream) {
      return this.streamChatCompletions(request.model, common);
    }

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText(common as Parameters<typeof generateText>[0]);
    } catch (error) {
      throw toProviderHttpError(error);
    }
    const responseId = responseIdFor("chatcmpl");

    return Response.json({
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.text || null,
            ...(result.toolCalls?.length
              ? {
                  tool_calls: result.toolCalls.map((toolCall) => ({
                    id: toolCall.toolCallId,
                    type: "function",
                    function: {
                      name: toolCall.toolName,
                      arguments: toOpenAIArguments(toolCall.input),
                    },
                  })),
                }
              : {}),
          },
          finish_reason: mapFinishReason(result.finishReason),
        },
      ],
      usage: toOpenAIUsage(result.usage),
    });
  }

  async embeddings(request: OpenAIEmbeddingsRequest): Promise<Response> {
    const values = Array.isArray(request.input) ? request.input : [request.input];
    const model = this.gateway.embeddingModel(request.model as never);

    if (values.length === 1) {
      const result = await embed({
        model,
        value: values[0],
        ...(request.dimensions != null
          ? { providerOptions: { gateway: { dimensions: request.dimensions } } }
          : {}),
      });

      return Response.json({
        object: "list",
        data: [{ object: "embedding", embedding: result.embedding, index: 0 }],
        model: request.model,
        usage: {
          prompt_tokens: result.usage.tokens,
          total_tokens: result.usage.tokens,
        },
      });
    }

    const result = await embedMany({
      model,
      values,
      ...(request.dimensions != null
        ? { providerOptions: { gateway: { dimensions: request.dimensions } } }
        : {}),
    });

    return Response.json({
      object: "list",
      data: result.embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding,
        index,
      })),
      model: request.model,
      usage: {
        prompt_tokens: result.usage.tokens,
        total_tokens: result.usage.tokens,
      },
    });
  }

  async listModels(): Promise<Response> {
    const metadata = await this.gateway.getAvailableModels();
    return Response.json({
      object: "list",
      data: metadata.models.map((model: GatewayModelMetadata) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: model.id.split("/")[0] || "gateway",
        name: model.name,
        description: model.description ?? undefined,
        pricing: model.pricing ?? undefined,
      })),
    });
  }

  async getModel(modelId: string): Promise<Response> {
    const metadata = await this.gateway.getAvailableModels();
    const model = metadata.models.find(
      (candidate: GatewayModelMetadata) => candidate.id === modelId,
    );
    if (!model) {
      return Response.json(
        {
          error: {
            message: `Model not found: ${modelId}`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        { status: 404 },
      );
    }

    return Response.json({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.id.split("/")[0] || "gateway",
      name: model.name,
      description: model.description ?? undefined,
      pricing: model.pricing ?? undefined,
    });
  }

  private streamChatCompletions(model: string, common: Record<string, unknown>): Response {
    const result = streamText(common as Parameters<typeof streamText>[0]);
    const encoder = new TextEncoder();
    const responseId = responseIdFor("chatcmpl");

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const toolCallIndexes = new Map<string, number>();
          let nextToolCallIndex = 0;
          for await (const part of result.fullStream as AsyncIterable<any>) {
            if (part.type === "text-delta") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: part.text },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                ),
              );
              continue;
            }

            if (part.type === "tool-input-start") {
              const index = nextToolCallIndex++;
              toolCallIndexes.set(part.id, index);
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index,
                              id: part.id,
                              type: "function",
                              function: { name: part.toolName, arguments: "" },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                ),
              );
              continue;
            }

            if (part.type === "tool-input-delta") {
              const index = toolCallIndexes.get(part.id) ?? 0;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [{ index, function: { arguments: part.delta } }],
                        },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                ),
              );
              continue;
            }

            if (part.type === "tool-call") {
              const index = toolCallIndexes.get(part.toolCallId) ?? nextToolCallIndex++;
              toolCallIndexes.set(part.toolCallId, index);
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index,
                              id: part.toolCallId,
                              type: "function",
                              function: {
                                name: part.toolName,
                                arguments: toOpenAIArguments(part.input),
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                ),
              );
              continue;
            }

            if (part.type === "error") {
              throw part.error;
            }
          }

          const [usage, finishReason] = await Promise.all([
            Promise.resolve(result.usage).catch(() => undefined),
            Promise.resolve(result.finishReason).catch(() => undefined),
          ]);

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: mapFinishReason(finishReason),
                  },
                ],
                ...(usage ? { usage: toOpenAIUsage(usage) } : {}),
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toOpenAIArguments(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

function toModelMessages(messages: GatewayChatMessage[]): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        toolNames.set(toolCall.id, toolCall.function.name);
      }
    }
  }

  for (const message of messages) {
    if (message.role === "tool") {
      modelMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.tool_call_id ?? crypto.randomUUID(),
            toolName: toolNames.get(message.tool_call_id ?? "") ?? "unknown_tool",
            output: { type: "text", value: contentToText(message.content) },
          },
        ],
      } as ModelMessage);
      continue;
    }

    if (message.role === "assistant") {
      const text = contentToText(message.content);
      const parts = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...(message.tool_calls ?? []).map((toolCall) => ({
          type: "tool-call" as const,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        })),
      ];
      modelMessages.push({
        role: "assistant",
        content: parts.length > 0 ? parts : [{ type: "text", text: "" }],
      } as ModelMessage);
      continue;
    }

    modelMessages.push({
      role: message.role,
      content: contentToText(message.content),
      ...(message.name ? { name: message.name } : {}),
    } as ModelMessage);
  }

  return modelMessages;
}

function contentToText(content: GatewayChatMessage["content"]): string {
  if (typeof content === "string") return content;

  return content
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") return part.text;
      return JSON.stringify(part);
    })
    .join("\n");
}

function toGatewayTools(tools: NonNullable<OpenAIChatRequest["tools"]>) {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.function.name,
      {
        ...(tool.function.description ? { description: tool.function.description } : {}),
        inputSchema: jsonSchema(tool.function.parameters ?? { type: "object" }),
        outputSchema: jsonSchema({ type: "object", additionalProperties: true }),
      },
    ]),
  );
}

function toGatewayToolChoice(
  toolChoice: NonNullable<OpenAIChatRequest["tool_choice"]>,
): "auto" | "none" | "required" | { type: "tool"; toolName: string } {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  return { type: "tool", toolName: toolChoice.function.name };
}

function toGatewayOutput(responseFormat: NonNullable<OpenAIChatRequest["response_format"]>) {
  if (responseFormat.type === "text") {
    return undefined;
  }
  return {
    name: "object",
    responseFormat: Promise.resolve({
      type: "json" as const,
      schema: { type: "object", additionalProperties: true },
    }),
    async parseCompleteOutput({ text }: { text: string }) {
      return JSON.parse(text);
    },
    async parsePartialOutput({ text }: { text: string }) {
      try {
        return { partial: JSON.parse(text) };
      } catch {
        return undefined;
      }
    },
    createElementStreamTransform() {
      return undefined;
    },
  };
}

export const __nativeToolingTestHooks = {
  toModelMessages,
  toGatewayTools,
  toGatewayToolChoice,
  toGatewayOutput,
};

function toOpenAIUsage(usage: LanguageModelUsage | undefined) {
  const promptTokens = usage?.inputTokens ?? 0;
  const completionTokens = usage?.outputTokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage?.totalTokens ?? promptTokens + completionTokens,
  };
}

function mapFinishReason(reason: unknown) {
  if (reason === "length") return "length";
  if (reason === "tool-calls") return "tool_calls";
  if (reason === "content-filter") return "content_filter";
  return "stop";
}

function responseIdFor(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;
}

function toProviderHttpError(error: unknown): ProviderHttpError {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("insufficient funds") ||
    normalized.includes("insufficient credits") ||
    (normalized.includes("credits") && normalized.includes("top up"))
  ) {
    return {
      status: 402,
      error: {
        message,
        type: "insufficient_quota",
        code: "gateway_insufficient_credits",
      },
    };
  }

  if (normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return {
      status: 429,
      error: {
        message,
        type: "rate_limit_error",
        code: "gateway_rate_limited",
      },
    };
  }

  if (normalized.includes("not found") || normalized.includes("model")) {
    return {
      status: 404,
      error: {
        message,
        type: "invalid_request_error",
        code: "gateway_model_not_found",
      },
    };
  }

  return {
    status: 503,
    error: {
      message,
      type: "api_error",
      code: "gateway_provider_error",
    },
  };
}
