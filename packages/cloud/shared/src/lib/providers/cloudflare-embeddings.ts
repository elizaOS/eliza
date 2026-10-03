/** Serves the canonical BGE CLS representation through Workers AI with the shared source-tail policy. */
import { ElizaError } from "@elizaos/core";
import { APICallError, type EmbeddingModel } from "ai";
import { z } from "zod";
import { createBgeEmbeddingModel } from "./bge-embeddings";

const resultSchema = z.object({ data: z.array(z.array(z.number().finite()).length(384)) });
const responseSchema = z.object({ success: z.literal(true), result: resultSchema });

/** The Workers AI binding surface used here; responses are validated at the provider boundary. */
export interface CloudflareEmbeddingBinding {
  run(
    model: "@cf/baai/bge-small-en-v1.5",
    input: { text: string[]; pooling: "cls" },
  ): Promise<unknown>;
}

const cloudflareIdentity = { provider: "cloudflare", modelId: "@cf/baai/bge-small-en-v1.5" };

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
  }, cloudflareIdentity);
}

/** Runs on the request's native AI binding without a separate REST credential. */
export function createCloudflareBindingEmbeddingModel(binding: CloudflareEmbeddingBinding) {
  return createBgeEmbeddingModel(async (values, signal) => {
    signal?.throwIfAborted();
    // AI.run has no documented abort parameter. Await accepted work rather than
    // racing it against cancellation and hiding the provider's outcome.
    return binding.run("@cf/baai/bge-small-en-v1.5", { text: values, pooling: "cls" });
  }, cloudflareIdentity);
}
