/** Hosted search reuses the bounded Parallel transport shared by Node and Workers. */
import { ElizaError } from "@elizaos/core";
import {
  type KeylessWebSearchProvider,
  searchKeylessWeb,
} from "@elizaos/plugin-web-search/keyless-web-search";

export interface KeylessSearchResult {
  answer: string;
  provider: KeylessWebSearchProvider;
}

export async function executeKeylessMcpSearch(query: string): Promise<KeylessSearchResult> {
  const result = await searchKeylessWeb(query);
  if (!result) {
    throw new ElizaError("Keyless web search failed: Parallel returned no usable result", {
      code: "WEB_SEARCH_UNAVAILABLE",
    });
  }
  return { answer: result.text, provider: result.provider };
}
