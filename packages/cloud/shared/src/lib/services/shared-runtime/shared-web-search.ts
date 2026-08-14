/**
 * Adds explicit, server-metered web search to personal Shared chat. Search is
 * intentionally narrower than browser control: it retrieves bounded public
 * information but never opens a session, signs in, clicks, or mutates a site.
 */

import type { KeylessSearchResult } from "../../eliza/plugin-web-search/src/services/keyless-search";
import { executeKeylessMcpSearch } from "../../eliza/plugin-web-search/src/services/keyless-search";
import { enforceOrgRateLimit } from "../../middleware/rate-limit";

const EXPLICIT_WEB_SEARCH =
  /\b(?:search|look\s*up|find)\b[\s\S]{0,48}\b(?:web|internet|online|public\s+sources?)\b|\b(?:search|look\s*up)\s+(?:the\s+)?(?:web|internet)\b/i;
const CURRENT_INFORMATION =
  /\b(?:latest|current|today(?:'s)?|recent|this\s+week)\b[\s\S]{0,48}\b(?:news|updates?|information|reports?|results?|status)\b/i;
const NON_SEARCH_CONTEXT =
  /^(?:please\s+)?(?:do\s+not|don't|dont|never|explain|describe|define|translate|how\s+(?:do|would|can|to)|what\s+(?:is|are|would)|if\s+(?:i|we|you)|before\s+you)\b/i;

export interface SharedWebSearchContext extends KeylessSearchResult {
  query: string;
  metered: true;
}

export class SharedWebSearchRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SharedWebSearchRateLimitError";
  }
}

export interface SharedWebSearchDependencies {
  enforceRateLimit: typeof enforceOrgRateLimit;
  executeSearch: typeof executeKeylessMcpSearch;
}

interface SharedWebSearchExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const DEFAULT_DEPENDENCIES: SharedWebSearchDependencies = {
  enforceRateLimit: enforceOrgRateLimit,
  executeSearch: executeKeylessMcpSearch,
};

export function resolveSharedWebSearchQuery(message: string | undefined): string | null {
  const text = (message ?? "").trim();
  if (!text || NON_SEARCH_CONTEXT.test(text)) return null;
  return EXPLICIT_WEB_SEARCH.test(text) || CURRENT_INFORMATION.test(text) ? text : null;
}

/** Consume the organization's strict request meter before contacting a provider. */
export async function executeMeteredSharedWebSearch(
  input: {
    organizationId: string;
    query: string;
    executionCtx?: SharedWebSearchExecutionContext;
  },
  dependencies: SharedWebSearchDependencies = DEFAULT_DEPENDENCIES,
): Promise<SharedWebSearchContext> {
  const denied = await dependencies.enforceRateLimit(input.organizationId, "strict", {
    cacheOnly: Boolean(input.executionCtx),
    executionCtx: input.executionCtx,
  });
  if (denied) {
    const retryAfter = Number.parseInt(denied.headers.get("Retry-After") ?? "", 10);
    throw new SharedWebSearchRateLimitError(
      denied.status === 429
        ? "Shared web search rate limit exceeded"
        : "Shared web search meter is temporarily unavailable",
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  const result = await dependencies.executeSearch(input.query, 6);
  return { query: input.query, metered: true, ...result };
}

export function webSearchActionResult(search: SharedWebSearchContext): {
  actionName: "WEB_SEARCH";
  success: true;
  text: string;
  values: {
    provider: "parallel" | "exa";
    metered: true;
    currentExecutionTier: "shared";
    source: "agent";
  };
} {
  return {
    actionName: "WEB_SEARCH",
    success: true,
    text: "Searched public web sources.",
    values: {
      provider: search.provider,
      metered: true,
      currentExecutionTier: "shared",
      source: "agent",
    },
  };
}
