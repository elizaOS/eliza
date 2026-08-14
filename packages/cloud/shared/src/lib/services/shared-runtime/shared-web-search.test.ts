/** Verifies explicit Shared search routing, authoritative metering, and typed receipts. */

import { describe, expect, test } from "bun:test";
import {
  executeMeteredSharedWebSearch,
  resolveSharedWebSearchQuery,
  SharedWebSearchRateLimitError,
  webSearchActionResult,
} from "./shared-web-search";

describe("Shared web search", () => {
  test.each([
    "search the web for current Cloudflare Workers limits",
    "look up the latest elizaOS release online",
    "find public sources on durable objects on the internet",
    "latest news about AI agents",
  ])("routes an explicit public-information request: %s", (message) => {
    expect(resolveSharedWebSearchQuery(message)).toBe(message);
  });

  test.each([
    "explain how web search works",
    "do not search the web",
    "search my files for invoices",
    "write a search function in TypeScript",
    "open the browser and log in",
    "what is a web search index",
  ])("does not over-route discussion or device actions: %s", (message) => {
    expect(resolveSharedWebSearchQuery(message)).toBeNull();
  });

  test("meters before provider dispatch and returns provider identity", async () => {
    const order: string[] = [];
    const result = await executeMeteredSharedWebSearch(
      { organizationId: "org-1", query: "search the web for elizaOS" },
      {
        enforceRateLimit: async (organizationId, endpoint) => {
          order.push(`meter:${organizationId}:${endpoint}`);
          return null;
        },
        executeSearch: async (query, maxResults) => {
          order.push(`search:${query}:${maxResults}`);
          return { answer: "result", provider: "parallel" };
        },
      },
    );

    expect(order).toEqual(["meter:org-1:strict", "search:search the web for elizaOS:6"]);
    expect(webSearchActionResult(result)).toMatchObject({
      actionName: "WEB_SEARCH",
      success: true,
      values: { provider: "parallel", metered: true, currentExecutionTier: "shared" },
    });
  });

  test("never dispatches search after the meter denies", async () => {
    let searched = false;
    await expect(
      executeMeteredSharedWebSearch(
        { organizationId: "org-1", query: "latest news" },
        {
          enforceRateLimit: async () =>
            new Response(null, { status: 429, headers: { "Retry-After": "17" } }),
          executeSearch: async () => {
            searched = true;
            return { answer: "unexpected", provider: "exa" };
          },
        },
      ),
    ).rejects.toEqual(
      new SharedWebSearchRateLimitError("Shared web search rate limit exceeded", 17),
    );
    expect(searched).toBe(false);
  });
});
