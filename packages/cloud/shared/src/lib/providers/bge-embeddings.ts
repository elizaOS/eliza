/** Applies the canonical BGE input, vector identity, normalization and batch accounting contract to backend transports. */
import { BGE_SMALL_VECTOR_SPACE, ElizaError } from "@elizaos/common";
import { prepareBgeEmbeddingInput } from "@elizaos/shared/local-inference/bge-input";
import type { EmbeddingModel } from "ai";
import { z } from "zod";

const resultSchema = z.object({ data: z.array(z.array(z.number().finite()).length(384)) });
type BatchTransport = (values: string[], signal?: AbortSignal) => Promise<unknown>;

export function validateBgeInput(text: string): number {
  return prepareBgeEmbeddingInput(text).tokenIds.length;
}

export function createBgeEmbeddingModel(
  transport: BatchTransport,
  identity: { provider: string; modelId: string },
): EmbeddingModel & { embeddingSpace: string } {
  return {
    embeddingSpace: BGE_SMALL_VECTOR_SPACE,
    specificationVersion: "v3",
    ...identity,
    maxEmbeddingsPerCall: Infinity,
    supportsParallelCalls: true,
    async doEmbed({ values, abortSignal }) {
      // Prepare every source before dispatch so an invalid tail cannot partially send a batch.
      const prepared = values.map((text) => prepareBgeEmbeddingInput(text));
      const tokens = prepared.reduce((sum, input) => sum + input.tokenIds.length, 0);
      const embeddings: number[][] = [];
      for (let offset = 0; offset < values.length; offset += 100) {
        const batch = prepared.slice(offset, offset + 100).map((input) => input.text);
        let result: unknown;
        try {
          abortSignal?.throwIfAborted();
          result = await transport(batch, abortSignal);
        } catch (error) {
          // error-policy:J1 Preserve accepted-prefix accounting and prevent SDK replay.
          if (embeddings.length > 0) {
            throw new ElizaError(
              "BGE provider accepted an earlier batch before this request failed; do not replay the completed prefix",
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
          throw new ElizaError("BGE provider returned an invalid or incomplete embedding batch", {
            code: "EMBEDDING_PROVIDER_RESPONSE_INVALID",
          });
        }
        embeddings.push(
          ...parsed.data.data.map((vector) => {
            const norm = Math.hypot(...vector);
            if (!Number.isFinite(norm) || norm === 0) {
              throw new ElizaError("BGE provider returned an unusable embedding vector", {
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
