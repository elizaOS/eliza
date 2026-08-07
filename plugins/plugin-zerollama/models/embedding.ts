/**
 * Embeddings via Ollama / zerollama.
 *
 * Stock Ollama keeps the AI SDK `embed` + `ollama-ai-provider-v2` path. Zerollama
 * uses native `POST /api/embed` so we never send AI SDK wire aliases that its
 * strict schema rejects on other routes (and so embedding stays on the documented
 * EmbedRequest shape).
 *
 * Input length is capped to the embedding model's advertised context (probed
 * from `/api/tags`) — embeddinggemma's 2048 window rejects English prose well
 * below the old ~32k soft char cap, and zerollama returns 400 rather than
 * truncating further.
 */
import type { IAgentRuntime, TextEmbeddingParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { type EmbeddingModel, embed } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

import { getBaseURL, getEmbeddingModel, getSetting } from "../utils/config";
import {
  isEmbedContextOverflow,
  resolveEmbedMaxChars,
  truncateEmbedInput,
} from "../utils/embed-context";
import { isZerollamaFlavor, resolveOllamaHostFlavor } from "../utils/host-flavor";
import { emitModelUsed, estimateEmbeddingUsage, normalizeTokenUsage } from "../utils/modelUsage";
import { resolveOllamaFetch } from "../utils/ollama-chat-compat-fetch";
import { zerollamaEmbed, zerollamaEmbedMany } from "../utils/zerollama-native";
import { ensureModelAvailable } from "./availability";

const INIT_PROBE_TEXT = "dimension probe";
const MAX_OVERFLOW_RETRIES = 3;

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

function longestInputChars(input: string | string[]): number {
  return typeof input === "string"
    ? input.length
    : input.reduce((max, text) => Math.max(max, text.length), 0);
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
    let maxChars = await resolveEmbedMaxChars({
      apiBase,
      model: modelName,
      fetchImpl: customFetch,
      envMaxChars: getSetting(runtime, "OLLAMA_EMBED_MAX_CHARS"),
    });
    let embeddingText = truncateEmbedInput(isInitProbe ? INIT_PROBE_TEXT : text, maxChars);

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

    for (let attempt = 0; attempt <= MAX_OVERFLOW_RETRIES; attempt++) {
      try {
        return await runOnce(embeddingText);
      } catch (error) {
        // error-policy:J3 a recognized provider context-overflow response
        // sanitizes the explicit input size and retries; all other errors throw.
        if (!isEmbedContextOverflow(error) || attempt === MAX_OVERFLOW_RETRIES) {
          throw error;
        }
        const current = longestInputChars(embeddingText);
        const nextCap = Math.max(256, Math.floor(current / 2));
        if (nextCap >= current) {
          throw error;
        }
        logger.warn(
          `[Ollama] Embedding rejected as over-context (${current} chars); retrying at ${nextCap}`
        );
        maxChars = nextCap;
        embeddingText = truncateEmbedInput(isInitProbe ? INIT_PROBE_TEXT : text, maxChars);
      }
    }

    throw new Error("Embedding failed after context-overflow retries");
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
            responseBody: (error as { responseBody: string }).responseBody.slice(0, 400),
          }
        : error;
    logger.error({ error: detail }, "Error in TEXT_EMBEDDING model");
    throw error instanceof Error ? error : new Error(String(error));
  }
}
