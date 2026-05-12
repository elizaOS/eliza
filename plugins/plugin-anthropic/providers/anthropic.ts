import { createAnthropic } from "@ai-sdk/anthropic";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getApiKeyOptional, getAuthMode, getBaseURL, isBrowser } from "../utils/config";
import {
  clearTokenCache,
  getClaudeOAuthToken,
  getClaudeOAuthTokenAsync,
  reportClaudeOAuthInvalid,
  reportClaudeOAuthRateLimited,
} from "../utils/credential-store";

type FetchPreconnect = (
  url: string | URL,
  options?: {
    dns?: boolean;
    tcp?: boolean;
    http?: boolean;
    https?: boolean;
  }
) => void;

type FetchWithOptionalPreconnect = typeof fetch & {
  preconnect?: FetchPreconnect;
};

/**
 * Create a fetch wrapper that injects OAuth Bearer auth headers
 * and retries once on 401 (re-reading token from credential store).
 */
function createOAuthFetch(innerFetch?: FetchWithOptionalPreconnect): typeof fetch {
  const baseFetch = innerFetch ?? fetch;
  const baseFetchWithExtensions = baseFetch as FetchWithOptionalPreconnect;

  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const token = await getClaudeOAuthTokenAsync();
      const headers = new Headers(init?.headers);
      headers.delete("x-api-key");
      headers.set("Authorization", `Bearer ${token.accessToken}`);
      const existingBeta = headers.get("anthropic-beta");
      headers.set("anthropic-beta", [existingBeta, "oauth-2025-04-20"].filter(Boolean).join(", "));

      const response = await baseFetchWithExtensions(input, {
        ...init,
        headers,
      });

      const util5h = response.headers.get("anthropic-ratelimit-unified-5h-utilization");
      const util7d = response.headers.get("anthropic-ratelimit-unified-7d-utilization");
      const status5h = response.headers.get("anthropic-ratelimit-unified-5h-status");
      if (util5h) {
        const pct5h = (parseFloat(util5h) * 100).toFixed(1);
        const pct7d = util7d ? (parseFloat(util7d) * 100).toFixed(1) : "?";
        const emoji = response.status === 429 ? "🚫" : "📊";
        logger.debug(`[Anthropic OAuth] ${emoji} Quota: 5h=${pct5h}% (${status5h}) | 7d=${pct7d}%`);
      }

      if (response.status === 429) {
        const resetTs = response.headers.get("anthropic-ratelimit-unified-5h-reset");
        const resetMs = resetTs ? parseInt(resetTs, 10) * 1000 : Date.now() + 60_000;
        const resetIn = Math.ceil((resetMs - Date.now()) / 60000);
        logger.warn(`[Anthropic OAuth] Rate limited! Reset in ~${resetIn} minutes.`);
        if (token.accountId) {
          reportClaudeOAuthRateLimited(token.accountId, resetMs, "429 unified");
          await response.body?.cancel();
          const fallback = await getClaudeOAuthTokenAsync({
            exclude: [token.accountId],
          });
          if (fallback.accessToken !== token.accessToken) {
            headers.set("Authorization", `Bearer ${fallback.accessToken}`);
            return baseFetchWithExtensions(input, { ...init, headers });
          }
        }
      }

      if (response.status === 401) {
        await response.body?.cancel();
        if (token.accountId) {
          reportClaudeOAuthInvalid(token.accountId, "401 from Anthropic");
          const fallback = await getClaudeOAuthTokenAsync({
            exclude: [token.accountId],
          });
          headers.set("Authorization", `Bearer ${fallback.accessToken}`);
        } else {
          clearTokenCache();
          const freshToken = getClaudeOAuthToken();
          headers.set("Authorization", `Bearer ${freshToken.accessToken}`);
        }
        return baseFetchWithExtensions(input, { ...init, headers });
      }

      return response;
    },
    {
      preconnect: (url: string | URL, options?: Parameters<FetchPreconnect>[1]) => {
        if (typeof baseFetchWithExtensions.preconnect === "function") {
          baseFetchWithExtensions.preconnect(url, options);
        }
      },
    }
  ) satisfies typeof fetch;
}

function getApiKeyOrPlaceholder(runtime: IAgentRuntime, useOAuth: boolean): string | undefined {
  if (useOAuth) return "oauth-placeholder";
  return isBrowser() ? undefined : (getApiKeyOptional(runtime) ?? undefined);
}

export function createAnthropicClient(runtime: IAgentRuntime) {
  const useOAuth = getAuthMode(runtime) === "oauth";

  return createAnthropic({
    apiKey: getApiKeyOrPlaceholder(runtime, useOAuth),
    baseURL: getBaseURL(runtime),
    ...(useOAuth ? { fetch: createOAuthFetch() } : {}),
  });
}

export function createAnthropicClientWithTopPSupport(runtime: IAgentRuntime) {
  const useOAuth = getAuthMode(runtime) === "oauth";

  const topPFetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init && typeof init.body === "string") {
        const body: Record<string, unknown> = JSON.parse(init.body);

        const hasTopP = Object.hasOwn(body, "top_p") && body.top_p != null;
        const hasZeroTemp = Object.hasOwn(body, "temperature") && body.temperature === 0;

        if (hasTopP && hasZeroTemp) {
          delete body.temperature;
          init.body = JSON.stringify(body);
        }
      }
      return fetch(input, init);
    },
    {
      preconnect: (url: string | URL, options?: Parameters<FetchPreconnect>[1]) => {
        const baseFetch = fetch as FetchWithOptionalPreconnect;
        if (typeof baseFetch.preconnect === "function") {
          baseFetch.preconnect(url, options);
        }
      },
    }
  ) satisfies typeof fetch;

  const finalFetch = useOAuth ? createOAuthFetch(topPFetch) : topPFetch;

  return createAnthropic({
    apiKey: getApiKeyOrPlaceholder(runtime, useOAuth),
    baseURL: getBaseURL(runtime),
    fetch: finalFetch,
  });
}
