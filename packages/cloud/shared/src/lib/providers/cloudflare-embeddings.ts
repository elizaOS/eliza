/** Serves the canonical BGE CLS representation through Workers AI without truncating input. */
import { BGE_SMALL_VECTOR_SPACE, ElizaError } from "@elizaos/core";
import { Tokenizer } from "@huggingface/tokenizers";
import { APICallError, type EmbeddingModel } from "ai";
import { z } from "zod";
import tokenizerJson from "./bge/tokenizer.json";
import tokenizerConfig from "./bge/tokenizer_config.json";

const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
const resultSchema = z.object({ data: z.array(z.array(z.number().finite()).length(384)) });
const responseSchema = z.object({ success: z.literal(true), result: resultSchema });

/** The Workers AI binding surface used here; responses are validated at the provider boundary. */
export interface CloudflareEmbeddingBinding {
  run(
    model: "@cf/baai/bge-small-en-v1.5",
    input: { text: string[]; pooling: "cls" },
  ): Promise<unknown>;
}

type BatchTransport = (values: string[], signal?: AbortSignal) => Promise<unknown>;

export function validateBgeInput(text: string): number {
  const count = tokenizer.encode(text).ids.length;
  if (count > 512) {
    throw new ElizaError(
      `Embedding input has ${count} tokens; BGE-small supports 512. Split the source into explicit, lossless chunks before embedding.`,
      { code: "EMBEDDING_INPUT_TOO_LARGE", context: { tokenCount: count, contextLimit: 512 } },
    );
  }
  return count;
}

export function createCloudflareEmbeddingModel(
  accountId: string,
  apiToken: string,
): EmbeddingModel & { embeddingSpace: string } {
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !apiToken.trim()) {
    throw new ElizaError("Configure a valid Cloudflare account and Workers AI token", {
      code: "EMBEDDING_PROVIDER_CONFIGURATION_INVALID",
    });
  }
  return createBgeEmbeddingModel(async (values, signal) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-small-en-v1.5`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: values, pooling: "cls" }),
        signal,
      },
    );
    if (!response.ok) {
      throw new APICallError({
        message: `Cloudflare embedding request failed with HTTP ${response.status}`,
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-small-en-v1.5`,
        requestBodyValues: { model: "@cf/baai/bge-small-en-v1.5" },
        statusCode: response.status,
        responseHeaders: Object.fromEntries(response.headers.entries()),
      });
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ElizaError("Cloudflare returned an invalid embedding response", {
        code: "EMBEDDING_PROVIDER_RESPONSE_INVALID",
      });
    }
    return parsed.data.result;
  });
}

/** Runs on the request's native AI binding without a separate REST credential. */
export function createCloudflareBindingEmbeddingModel(binding: CloudflareEmbeddingBinding) {
  return createBgeEmbeddingModel(async (values, signal) => {
    signal?.throwIfAborted();
    // AI.run has no documented abort parameter. Await accepted work rather than
    // racing it against cancellation and hiding the provider's outcome.
    return binding.run("@cf/baai/bge-small-en-v1.5", { text: values, pooling: "cls" });
  });
}

function createBgeEmbeddingModel(
  transport: BatchTransport,
): EmbeddingModel & { embeddingSpace: string } {
  return {
    embeddingSpace: BGE_SMALL_VECTOR_SPACE,
    specificationVersion: "v3",
    provider: "cloudflare",
    modelId: "@cf/baai/bge-small-en-v1.5",
    maxEmbeddingsPerCall: Infinity,
    supportsParallelCalls: true,
    async doEmbed({ values, abortSignal }) {
      // Validate the whole batch before issuing any request or returning any vectors.
      const tokens = values.reduce((sum, text) => sum + validateBgeInput(text), 0);
      const embeddings: number[][] = [];
      for (let offset = 0; offset < values.length; offset += 100) {
        const batch = values.slice(offset, offset + 100);
        let result: unknown;
        try {
          abortSignal?.throwIfAborted();
          result = await transport(batch, abortSignal);
        } catch (error) {
          // error-policy:J1 Preserve accepted-prefix accounting and prevent SDK replay.
          if (embeddings.length > 0) {
            throw new ElizaError(
              "Cloudflare accepted an earlier batch before this request failed; do not replay the completed prefix",
              {
                code: "EMBEDDING_BATCH_PARTIALLY_ACCEPTED",
                context: { acceptedValues: embeddings.length },
                cause: error,
              },
            );
          }
          throw error;
        }
        const parsed = resultSchema.safeParse(result);
        if (!parsed.success || parsed.data.data.length !== batch.length) {
          throw new ElizaError("Cloudflare returned an invalid or incomplete embedding batch", {
            code: "EMBEDDING_PROVIDER_RESPONSE_INVALID",
          });
        }
        embeddings.push(
          ...parsed.data.data.map((vector) => {
            const norm = Math.hypot(...vector);
            if (!Number.isFinite(norm) || norm === 0) {
              throw new ElizaError("Cloudflare returned an unusable embedding vector", {
                code: "EMBEDDING_VECTOR_INVALID",
              });
            }
            return vector.map((value) => value / norm);
          }),
        );
      }
      return { embeddings, usage: { tokens }, warnings: [] };
    },
  };
}
