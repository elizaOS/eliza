/**
 * The marketplace query filter runs in this process, so a search pages the
 * public Registry. This pins the page bound: a query that matches nothing must
 * answer with an empty, marked result instead of spending the request budget.
 */
import { afterEach, describe, expect, it } from "vitest";
import { searchMcpMarketplace } from "../src/mcp-marketplace";

const CATALOG_PAGES = 100;
const PAGE_ENTRIES = 50;
const realFetch = globalThis.fetch;

function registryPage(page: number, matchingName?: string) {
  return {
    servers: Array.from({ length: PAGE_ENTRIES }, (_, entry) => ({
      server: {
        name:
          entry === 0 && page === 2 && matchingName
            ? matchingName
            : `vendor${page}/server-${entry}`,
        description: "Fixture entry",
        version: "1.0.0",
      },
      _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
    })),
    metadata: page < CATALOG_PAGES ? { nextCursor: `cursor-${page + 1}` } : {},
  };
}

/** Serves a catalog that is longer than the walk may scan, and counts the reads. */
function stubCatalog(matchingName?: string) {
  let reads = 0;
  globalThis.fetch = (async () => {
    reads += 1;
    return new Response(JSON.stringify(registryPage(reads, matchingName)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => reads;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("marketplace catalog walk", () => {
  it("stops at the page bound and reports a truncated scan", async () => {
    const reads = stubCatalog();
    const result = await searchMcpMarketplace("absent-tool", 5);
    expect(result.results).toEqual([]);
    expect(reads()).toBe(20);
    expect(result.truncated).toBe(true);
  });

  it("keeps the matches the scanned pages hold", async () => {
    const reads = stubCatalog("vendor2/absent-tool");
    const result = await searchMcpMarketplace("absent-tool", 1);
    expect(result.results.map((item) => item.name)).toEqual(["vendor2/absent-tool"]);
    expect(reads()).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("reads one page when the caller sends no query", async () => {
    const reads = stubCatalog();
    const result = await searchMcpMarketplace(undefined, 5);
    expect(result.results).toHaveLength(5);
    expect(reads()).toBe(1);
    expect(result.truncated).toBe(false);
  });
});
