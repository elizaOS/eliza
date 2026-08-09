/**
 * Normalizes Ollama token accounting and emits the shared MODEL_USED event for
 * successful text and embedding calls, estimating only when usage is absent.
 */
import type { EventPayload, IAgentRuntime, ModelTypeName, TokenUsage } from "@elizaos/core";
import { EventType, logger } from "@elizaos/core";

type ProviderUsage = Partial<TokenUsage> & {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type OllamaTokenUsage = TokenUsage & { estimated?: boolean };

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeTokenUsage(usage: unknown): OllamaTokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const row = usage as ProviderUsage;
  const promptTokens = finiteNonNegative(row.promptTokens ?? row.inputTokens);
  const completionTokens = finiteNonNegative(row.completionTokens ?? row.outputTokens);
  const totalTokens = finiteNonNegative(row.totalTokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: totalTokens ?? prompt + completion,
  };
}

function estimateTokenCount(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

export function estimateUsage(prompt: string, response: unknown): OllamaTokenUsage {
  let responseText: string;
  if (typeof response === "string") {
    responseText = response;
  } else {
    try {
      responseText = JSON.stringify(response);
    } catch (error) {
      // error-policy:J3 diagnostic estimation accepts arbitrary provider
      // output; an unserializable value is represented explicitly as text.
      responseText = `[unserializable response: ${error instanceof Error ? error.message : String(error)}]`;
    }
  }
  const promptTokens = estimateTokenCount(prompt);
  const completionTokens = estimateTokenCount(responseText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

export function estimateEmbeddingUsage(text: string): OllamaTokenUsage {
  const promptTokens = estimateTokenCount(text);
  return {
    promptTokens,
    completionTokens: 0,
    totalTokens: promptTokens,
    estimated: true,
  };
}

export function emitModelUsed(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  model: string,
  usage: OllamaTokenUsage
): void {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("MODEL_USED requires the concrete Ollama model name");
  }
  const emission = runtime.emitEvent(
    EventType.MODEL_USED as string,
    {
      runtime,
      source: "ollama",
      provider: "ollama",
      type,
      model: normalizedModel,
      modelName: normalizedModel,
      tokens: {
        prompt: usage.promptTokens,
        completion: usage.completionTokens,
        total: usage.totalTokens,
        ...(usage.estimated ? { estimated: true } : {}),
      },
      ...(usage.estimated ? { usageEstimated: true } : {}),
    } as EventPayload
  );
  void Promise.resolve(emission).catch((error) => {
    // error-policy:J7 usage telemetry must not turn a successful model call
    // into a failure; report it through the runtime diagnostics channel.
    logger.warn(
      `[Ollama] MODEL_USED emission failed: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.reportError("plugin-zerollama.model-usage", error, {
      type,
      model: normalizedModel,
    });
  });
}
