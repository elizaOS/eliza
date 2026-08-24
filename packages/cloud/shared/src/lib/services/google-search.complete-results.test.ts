/** Proves grounded search results are complete unless the caller explicitly requests a page size. */
import { describe, expect, it } from "vitest";
import {
  buildSearchResults,
  type GroundedSearchResponse,
} from "./google-search-results";

function responseWithChunks(count: number): GroundedSearchResponse {
  return {
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: Array.from({ length: count }, (_, index) => ({
            web: {
              uri: `https://example.com/${index}`,
              title: `Result ${index}`,
            },
          })),
        },
      },
    ],
  };
}

describe("buildSearchResults", () => {
  it("returns every provider grounding result when no page size was requested", () => {
    const results = buildSearchResults(responseWithChunks(12));
    expect(results).toHaveLength(12);
    expect(results.at(-1)?.url).toBe("https://example.com/11");
  });

  it("honors an explicit caller-requested result count", () => {
    expect(buildSearchResults(responseWithChunks(12), 7)).toHaveLength(7);
  });
});
