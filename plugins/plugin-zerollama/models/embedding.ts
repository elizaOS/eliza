/**
 * Embeddings via Ollama / zerollama.
 *
 * Stock Ollama keeps the AI SDK `embed` + `ollama-ai-provider-v2` path. Zerollama
 * uses native `POST /api/embed` so we never send AI SDK wire aliases that its
 * strict schema rejects on other routes (and so embedding stays on the documented
 * EmbedRequest shape).
 *
 * Inputs that exceed the embedding model's advertised context fail explicitly;
 * no prefix is silently substituted for the requested embedding.
 */
import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType, toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { type EmbeddingModel, embed } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

import { getBaseURL, getEmbeddingModel, getSetting } from "../utils/config";
import { resolveEmbedMaxChars, validateEmbedInput } from "../utils/embed-context";
import { isZerollamaFlavor, resolveOllamaHostFlavor } from "../utils/host-flavor";
import { emitModelUsed, estimateEmbeddingUsage, normalizeTokenUsage } from "../utils/modelUsage";
import { resolveOllamaFetch } from "../utils/ollama-chat-compat-fetch";
import { zerollamaEmbed, zerollamaEmbedMany } from "../utils/zerollama-native";
import { ensureModelAvailable } from "./availability";

const INIT_PROBE_TEXT = "dimension probe";

function extractText(
  params: TextEmbeddingParams | string | null | { texts?: string[] }
): string | string[] | null {
  if (params === null) {
    return null;
  }
  if (typeof params === "string") {
    return params;
  }
  if (typeof params === "object" && params !== null) {
    const row = params as { text?: unknown; texts?: unknown };
    if (typeof row.text === "string") {
      return row.text;
    }
    // Document / batch callers sometimes hit TEXT_EMBEDDING with `{ texts }`
    // instead of TEXT_EMBEDDING_BATCH — accept and let the native client embed
    // the array in one /api/embed round-trip.
    if (Array.isArray(row.texts) && row.texts.every((item) => typeof item === "string")) {
      return row.texts as string[];
    }
  }
  throw new Error(
    "Invalid input format for embedding: expected string, { text: string }, or { texts: string[] }"
  );
}

export async function handleTextEmbedding(
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null
): Promise<number[]> {
  const text = extractText(params);
  const isInitProbe = text === null;
  const signal = typeof params === "object" && params !== null ? params.signal : undefined;

  if (!isInitProbe) {
    const empty =
      typeof text === "string"
        ? !text.trim()
        : text.length === 0 || text.every((item) => !item.trim());
    if (empty) {
      throw new Error("Cannot generate embedding for empty text");
    }
  }

  try {
    const baseURL = getBaseURL(runtime);
    const customFetch = resolveOllamaFetch(runtime);
    const modelName = getEmbeddingModel(runtime);
    await ensureModelAvailable(modelName, baseURL, customFetch, signal);

    const apiBase = baseURL.endsWith("/api") ? baseURL.slice(0, -4) : baseURL;
    const maxChars = await resolveEmbedMaxChars({
      apiBase,
      model: modelName,
      fetchImpl: customFetch,
      envMaxChars: getSetting(runtime, "OLLAMA_EMBED_MAX_CHARS"),
    });
    const embeddingText = validateEmbedInput(isInitProbe ? INIT_PROBE_TEXT : text, maxChars);

    const flavor = await resolveOllamaHostFlavor(baseURL, customFetch);
    const runZerollama = async (value: string | string[]): Promise<number[]> => {
      if (Array.isArray(value)) {
        const vectors = await zerollamaEmbedMany({
          apiBase,
          model: modelName,
          input: value,
          fetchImpl: customFetch,
          signal,
        });
        if (!isInitProbe) {
          emitModelUsed(
            runtime,
            ModelType.TEXT_EMBEDDING,
            modelName,
            estimateEmbeddingUsage(value.join("\n"))
          );
        }
        return vectors as unknown as number[];
      }
      const embedding = await zerollamaEmbed({
        apiBase,
        model: modelName,
        input: value,
        fetchImpl: customFetch,
        signal,
      });
      if (!isInitProbe) {
        emitModelUsed(runtime, ModelType.TEXT_EMBEDDING, modelName, estimateEmbeddingUsage(value));
      }
      return embedding;
    };

    const runStock = async (value: string | string[]): Promise<number[]> => {
      const ollama = createOllama({
        fetch: customFetch,
        baseURL,
      });
      const embedValue = Array.isArray(value) ? value.join("\n") : value;
      const { embedding, usage } = await embed({
        model: ollama.embedding(modelName) as EmbeddingModel,
        value: embedValue,
        ...(signal ? { abortSignal: signal } : {}),
      });
      if (!isInitProbe) {
        emitModelUsed(
          runtime,
          ModelType.TEXT_EMBEDDING,
          modelName,
          normalizeTokenUsage(usage) ?? estimateEmbeddingUsage(embedValue)
        );
      }
      return embedding;
    };

    const runOnce = isZerollamaFlavor(flavor) ? runZerollama : runStock;
    if (isZerollamaFlavor(flavor)) {
      logger.log(`[Ollama/zerollama] Using TEXT_EMBEDDING model: ${modelName}`);
    } else {
      logger.log(`[Ollama] Using TEXT_EMBEDDING model: ${modelName}`);
    }

    return await runOnce(embeddingText);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — log then rethrow. Fabricating a
    // zero/empty embedding on failure would silently poison the vector store and
    // degrade RAG with no signal (see #9324). Recall callers fail open to keyword
    // search on the throw.
    const detail =
      error instanceof Error &&
      "responseBody" in error &&
      typeof (error as { responseBody?: unknown }).responseBody === "string"
        ? {
            message: error.message,
            responseBody: truncateWellFormed(
              toWellFormedUnicode((error as { responseBody: string }).responseBody),
              400
            ),
          }
        : error;
    logger.error({ error: detail }, "Error in TEXT_EMBEDDING model");
    throw error instanceof Error ? error : new Error(String(error));
  }
}
