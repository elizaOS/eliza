/**
 * `createOpenAIClient`: builds the `@ai-sdk/openai` provider bound to the
 * runtime's resolved base URL and key. In proxy mode with no key it uses a
 * placeholder key (auth is injected upstream); otherwise a missing key throws.
 */
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { type IAgentRuntime, logger } from "@elizaos/core";
import { getApiKey, getBaseURL, isProxyMode } from "../utils/config";

const PROXY_API_KEY = "sk-proxy";
let httpAttemptId = 0;

export function createOpenAIClient(runtime: IAgentRuntime): OpenAIProvider {
  const baseURL = getBaseURL(runtime);
  const apiKey = getApiKey(runtime) || (isProxyMode(runtime) ? PROXY_API_KEY : undefined);

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required. Set it in your environment variables or runtime settings."
    );
  }

  return createOpenAI({
    apiKey,
    baseURL,
    // Observe each actual HTTP attempt, including retries inside the AI SDK.
    // Model-call latency alone cannot distinguish retry waits from inference.
    // Never log request bodies, credentials, query strings, or response text.
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const attempt = ++httpAttemptId;
        const startedAt = performance.now();
        const host = new URL(baseURL).hostname;
        logger.debug(`[OpenAI] HTTP attempt=${attempt} host=${host} started`);
        try {
          const response = await globalThis.fetch(input, init);
          const headersMs = Math.round(performance.now() - startedAt);
          const retryAfterSeconds = Number(response.headers.get("retry-after"));
          const retryAfter =
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
              ? ` retryAfterSeconds=${retryAfterSeconds}`
              : "";
          const message = `[OpenAI] HTTP attempt=${attempt} host=${host} status=${response.status} headersMs=${headersMs}${retryAfter}`;
          if (response.ok) logger.debug(message);
          else logger.warn(message);
          return response;
        } catch (error) {
          logger.warn(
            `[OpenAI] HTTP attempt=${attempt} host=${host} failedAfterMs=${Math.round(performance.now() - startedAt)}`
          );
          throw error;
        }
      },
      { preconnect: globalThis.fetch.preconnect }
    ),
  });
}
