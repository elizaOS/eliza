/**
 * Zerollama text path — native `POST /api/chat` (no AI SDK / ollama-ai-provider-v2).
 *
 * Mirrors the return contracts of `models/text.ts` (string | GenerateTextResult |
 * TextStreamResult) so core's `useModel` / v5 planner parsers stay unchanged.
 */

import type {
  GenerateTextParams,
  GenerateTextResult,
  IAgentRuntime,
  ModelTypeName,
  TextStreamResult,
} from "@elizaos/core";
import {
  assertModelOutputComplete,
  buildCanonicalSystemPrompt,
  dropDuplicateLeadingSystemMessage,
  logger,
  ModelType,
  renderChatMessagesForPrompt,
  resolveEffectiveSystemPrompt,
} from "@elizaos/core";
import { normalizeNativeMessages, normalizeNativeTools } from "../utils/ai-sdk-wire";
import { isOllamaStructuredOutputDisabled } from "../utils/config";
import { emitModelUsed, estimateUsage, normalizeTokenUsage } from "../utils/modelUsage";
import {
  buildZerollamaChatBody,
  extractFormatFromResponseSchema,
  toZerollamaChatMessages,
  toZerollamaTools,
  zerollamaChatComplete,
  zerollamaChatStream,
} from "../utils/zerollama-native";

type GenerateTextParamsWithNativeOptions = Omit<GenerateTextParams, "responseSchema"> & {
  messages?: unknown[];
  tools?: unknown;
  toolChoice?: unknown;
  responseSchema?: unknown;
};

type NativeTextModelResult = string & GenerateTextResult;

function isPlannerModelType(modelType: ModelTypeName): boolean {
  return modelType === ModelType.RESPONSE_HANDLER || modelType === ModelType.ACTION_PLANNER;
}

export async function handleZerollamaText(args: {
  runtime: IAgentRuntime;
  modelType: ModelTypeName;
  model: string;
  baseURL: string;
  fetchImpl: typeof fetch;
  params: GenerateTextParams;
}): Promise<string | TextStreamResult> {
  const { runtime, modelType, model, baseURL, fetchImpl, params } = args;
  const extended = params as GenerateTextParamsWithNativeOptions;
  const { prompt, temperature = 0.7, frequencyPenalty, presencePenalty } = params;
  const maxTokens = params.omitMaxTokens ? undefined : params.maxTokens;

  const tools = normalizeNativeTools(extended.tools);
  const system = resolveEffectiveSystemPrompt({
    params,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });

  let responseSchema: unknown = extended.responseSchema;
  if (isOllamaStructuredOutputDisabled(runtime) && responseSchema) {
    logger.debug(
      "[Ollama/zerollama] OLLAMA_DISABLE_STRUCTURED_OUTPUT is set — ignoring responseSchema"
    );
    responseSchema = undefined;
  }
  if (tools && responseSchema) {
    logger.debug(
      "[Ollama/zerollama] tools and responseSchema both present — omitting structured format"
    );
    responseSchema = undefined;
  }

  const wireRaw = dropDuplicateLeadingSystemMessage(
    extended.messages as Parameters<typeof dropDuplicateLeadingSystemMessage>[0],
    system
  );
  const normalizedMessages = normalizeNativeMessages(wireRaw);
  const hasChatMessages = Array.isArray(normalizedMessages) && normalizedMessages.length > 0;

  const renderedPrompt = hasChatMessages
    ? ""
    : (renderChatMessagesForPrompt(params.messages, {
        ...(system ? { omitDuplicateSystem: system } : {}),
      }) ??
      prompt ??
      "");

  const messages = toZerollamaChatMessages({
    messages: hasChatMessages ? normalizedMessages : null,
    system: hasChatMessages ? null : system,
    prompt: hasChatMessages ? null : renderedPrompt,
  });

  const ollamaTools = toZerollamaTools(tools);
  const format = responseSchema ? extractFormatFromResponseSchema(responseSchema) : undefined;

  const shouldReturnNative = Boolean(
    hasChatMessages || tools || extended.toolChoice || format !== undefined
  );

  const promptForEstimate = hasChatMessages ? JSON.stringify(normalizedMessages) : renderedPrompt;

  const resolvedApiBase = baseURL.endsWith("/api")
    ? baseURL.slice(0, -4)
    : baseURL.replace(/\/+$/, "");

  const body = buildZerollamaChatBody({
    model,
    messages,
    stream: Boolean(params.stream),
    temperature,
    topP: params.topP,
    maxTokens,
    frequencyPenalty,
    presencePenalty,
    tools: ollamaTools,
    format,
  });

  logger.log(`[Ollama/zerollama] Using ${modelType} model: ${model}`);

  if (params.stream && (tools || (!extended.toolChoice && !format))) {
    const plannerToolArgsOnly = Boolean(tools && isPlannerModelType(modelType));
    const streamResult = zerollamaChatStream({
      apiBase: resolvedApiBase,
      body,
      fetchImpl,
      promptForEstimate,
      modelName: model,
      plannerToolArgsOnly,
      signal: params.signal,
    });

    const usagePromise = Promise.resolve(streamResult.usage).then(async (usage) => {
      // error-policy:J5 the text promise's failure is also surfaced by the
      // native textStream; this telemetry observer alone may use no text.
      const text = await streamResult.text.catch(() => "");
      const resolved = normalizeTokenUsage(usage) ?? estimateUsage(promptForEstimate, text);
      if (resolved) emitModelUsed(runtime, modelType, model, resolved);
      return resolved;
    });
    const finishReasonPromise = Promise.resolve(streamResult.finishReason).then((finishReason) => {
      assertModelOutputComplete({
        finishReason,
        provider: "zerollama",
        model,
      });
      return finishReason;
    });
    void finishReasonPromise.catch(() => undefined);
    const textPromise = Promise.all([Promise.resolve(streamResult.text), finishReasonPromise]).then(
      ([text]) => text
    );
    void textPromise.catch(() => undefined);

    async function* textStreamWithUsage(): AsyncIterable<string> {
      for await (const chunk of streamResult.textStream) {
        yield chunk;
      }
      await finishReasonPromise;
      // error-policy:J7 usage emission must not turn a completed stream into a
      // failed model response, but diagnostics remain observable.
      await usagePromise.catch((error) => {
        logger.warn({ error, model }, "[Ollama/zerollama] Stream usage unavailable");
        runtime.reportError("plugin-zerollama.native-stream-usage", error, {
          model,
          modelType,
        });
      });
    }

    return {
      textStream: textStreamWithUsage(),
      text: textPromise,
      usage: usagePromise,
      finishReason: finishReasonPromise,
      ...(streamResult.toolCalls ? { toolCalls: streamResult.toolCalls } : {}),
    };
  }

  const result = await zerollamaChatComplete({
    apiBase: resolvedApiBase,
    body,
    fetchImpl,
    promptForEstimate,
    modelName: model,
    signal: params.signal,
  });

  assertModelOutputComplete({
    finishReason: result.finishReason,
    provider: "zerollama",
    model,
  });

  const usage = normalizeTokenUsage(result.usage) ?? estimateUsage(promptForEstimate, result.text);
  emitModelUsed(runtime, modelType, model, usage);

  if (shouldReturnNative) {
    if (format !== undefined && (!result.toolCalls || result.toolCalls.length === 0)) {
      const trimmed = result.text.trim();
      if (!trimmed) {
        throw new Error("[Ollama/zerollama] Structured generation returned no text");
      }
      return trimmed;
    }
    const payload: GenerateTextResult = {
      text: result.text,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
      usage,
      providerMetadata: result.providerMetadata,
    };
    return payload as NativeTextModelResult;
  }

  return result.text;
}
