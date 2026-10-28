/** Uses the same canonical embedding provider for Shared recall reads and writes. */
import { BGE_SMALL_VECTOR_SPACE, ElizaError, identifyEmbeddingVector } from "@elizaos/core";
import { getTextEmbeddingModel } from "../../providers/language-model";
import { getCloudAwareEnv } from "../../runtime/cloud-bindings";
import { SHARED_RECALL_EMBED_TIMEOUT_MS, SHARED_RECALL_EMBEDDING_MODEL } from "./shared-recall";

export function sharedRecallEnabled(): boolean {
  return getCloudAwareEnv().SHARED_RECALL_ENABLED === "true";
}

export async function embedSharedRecallTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0 || texts.some((text) => !text.trim())) {
    throw new ElizaError("Shared recall rejected blank embedding input", {
      code: "SHARED_RECALL_EMBEDDING_EMPTY_TEXT",
      severity: "fatal",
    });
  }
  const model = getTextEmbeddingModel(SHARED_RECALL_EMBEDDING_MODEL);
  if (
    typeof model !== "object" ||
    model === null ||
    !("embeddingSpace" in model) ||
    model.embeddingSpace !== BGE_SMALL_VECTOR_SPACE
  ) {
    throw new ElizaError("Shared recall requires the canonical BGE representation", {
      code: "EMBEDDING_SPACE_MISMATCH",
      context: { expected: BGE_SMALL_VECTOR_SPACE },
    });
  }
  // Direct dispatch preserves the provider adapter's accepted-prefix accounting:
  // no SDK retries and no retry on another backend after an uncertain outcome.
  const result = await model.doEmbed({
    values: texts,
    abortSignal: AbortSignal.timeout(SHARED_RECALL_EMBED_TIMEOUT_MS),
  });
  return result.embeddings.map((vector) => identifyEmbeddingVector(vector, BGE_SMALL_VECTOR_SPACE));
}
