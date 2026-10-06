/** Hosted search reuses the bounded Parallel transport shared by Node and Workers. */
import { ElizaError } from "@elizaos/core";
import {
  isKeylessWebSearchUnavailableError,
  type KeylessWebSearchProvider,
  searchKeylessWeb,
} from "@elizaos/plugin-web-search";

export interface KeylessSearchResult {
  answer: string;
  provider: KeylessWebSearchProvider;
}

/**
 * Resolves an empty answer for a successful zero-hit search. A provider
 * failure throws `WEB_SEARCH_UNAVAILABLE` so it never reads as "no results".
 */
export async function executeKeylessMcpSearch(query: string): Promise<KeylessSearchResult> {
  try {
    const result = await searchKeylessWeb(query);
    return { answer: result?.text ?? "", provider: "parallel" };
  } catch (error) {
    if (!isKeylessWebSearchUnavailableError(error)) throw error;
    // error-policy:J2 keep the typed provider outcome and retry timing.
    throw new ElizaError("Keyless web search failed: Parallel is unavailable", {
      code: "WEB_SEARCH_UNAVAILABLE",
      cause: error,
      context: {
        provider: error.provider,
        reason: error.reason,
        ...(error.status !== undefined ? { status: error.status } : {}),
      },
      ...(error.retryAfterMs !== undefined ? { retryAt: Date.now() + error.retryAfterMs } : {}),
      severity: "ephemeral",
    });
  }
}
