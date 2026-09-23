/** Serves canonical BGE through TEI only after verifying the endpoint's loaded model and pooling. */
import { ElizaError } from "@elizaos/common";
import { APICallError } from "ai";
import { z } from "zod";
import { createBgeEmbeddingModel } from "./bge-embeddings";

const infoSchema = z.object({
  model_id: z.literal("BAAI/bge-small-en-v1.5"),
  model_sha: z.string().nullable().optional(),
  model_type: z.object({ embedding: z.object({ pooling: z.literal("cls") }) }),
  max_input_length: z.literal(512),
});
const revision = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";

export function createTeiEmbeddingModel(baseUrl: string, apiKey: string) {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return createBgeEmbeddingModel(
    async (values, signal) => {
      const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const infoResponse = await fetch(`${root}/info`, { headers, signal });
      if (!infoResponse.ok) {
        throw new APICallError({
          message: `TEI identity check failed with HTTP ${infoResponse.status}`,
          url: `${root}/info`,
          requestBodyValues: {},
          statusCode: infoResponse.status,
          responseHeaders: Object.fromEntries(infoResponse.headers.entries()),
        });
      }
      const info = infoSchema.safeParse(await infoResponse.json());
      // Some TEI builds omit model_sha. Deployment must pin the revision there;
      // when advertised, it must agree rather than silently naming another space.
      if (!info.success || (info.data.model_sha && info.data.model_sha !== revision)) {
        throw new ElizaError(
          "TEI must serve pinned BGE-small-en-v1.5 with CLS pooling and a 512-token context",
          {
            code: "EMBEDDING_PROVIDER_IDENTITY_MISMATCH",
          },
        );
      }
      const response = await fetch(`${root}/embed`, {
        method: "POST",
        headers,
        body: JSON.stringify({ inputs: values, normalize: true, truncate: false }),
        signal,
      });
      if (!response.ok) {
        throw new APICallError({
          message: `TEI embedding request failed with HTTP ${response.status}`,
          url: `${root}/embed`,
          requestBodyValues: { model: "bge-small-en-v1.5" },
          statusCode: response.status,
          responseHeaders: Object.fromEntries(response.headers.entries()),
        });
      }
      return { data: await response.json() };
    },
    { provider: "selfhosted", modelId: "bge-small-en-v1.5" },
  );
}
