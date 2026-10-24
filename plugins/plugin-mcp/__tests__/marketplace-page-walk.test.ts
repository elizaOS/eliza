/**
 * The marketplace query filter runs in this process, so a search pages the
 * public Registry. This pins the page bound: a query that matches nothing must
 * answer with an empty, marked result instead of spending the request budget.
 * It also pins the walk budget: a page that stalls must end at the scan share
 * and keep the matches from the pages that already completed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getMcpServerDetails, searchMcpMarketplace } from "../src/mcp-marketplace";

const CATALOG_PAGES = 100;
const PAGE_ENTRIES = 50;
const TIMEOUT_MS = 400;
const SCAN_SHARE_MS = TIMEOUT_MS * 0.6;
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

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Holds every request until its signal aborts, and records when that happens. */
function stubHeldPage(onAbort: (info: { at: number; reason: unknown }) => void) {
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        onAbort({ at: Date.now(), reason: signal?.reason });
        reject(signal?.reason ?? new Error("registry page aborted"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
}

/** Serves one matching page with a next cursor, then holds the second page. */
function stubHeldSecondPage(onAbort: (info: { at: number; reason: unknown }) => void) {
  let reads = 0;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    reads += 1;
    if (reads === 1) {
      return Promise.resolve(
        jsonResponse({
          servers: [
            {
              server: {
                name: "vendor1/matched-tool",
                description: "Fixture entry",
                version: "1.0.0",
              },
              _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
            },
          ],
          metadata: { nextCursor: "cursor-2" },
        })
      );
    }
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        onAbort({ at: Date.now(), reason: signal?.reason });
        reject(signal?.reason ?? new Error("registry page aborted"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
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

describe("marketplace walk budget", () => {
  it("ends a held page at the scan share and keeps the earlier match", async () => {
    const aborts: Array<{ at: number; reason: unknown }> = [];
    const reads = stubHeldSecondPage((info) => aborts.push(info));
    const startedAt = Date.now();

    const result = await searchMcpMarketplace("matched-tool", 5, { timeoutMs: TIMEOUT_MS });
    const elapsed = Date.now() - startedAt;

    expect(reads()).toBe(2);
    expect(result.results.map((item) => item.name)).toEqual(["vendor1/matched-tool"]);
    expect(result.truncated).toBe(true);
    // The held page ends at the scan share, not at the request timeout.
    expect(aborts).toHaveLength(1);
    expect(aborts[0].at - startedAt).toBeGreaterThanOrEqual(SCAN_SHARE_MS - 40);
    expect(aborts[0].at - startedAt).toBeLessThan(TIMEOUT_MS);
    // The walk never spends the full request timeout.
    expect(elapsed).toBeLessThan(TIMEOUT_MS);
  });

  it("keeps caller cancellation a typed error", async () => {
    stubHeldSecondPage(() => {});
    const caller = new AbortController();
    const pending = searchMcpMarketplace("matched-tool", 5, {
      timeoutMs: 5_000,
      signal: caller.signal,
    });
    setTimeout(() => caller.abort(new Error("caller stopped the search")), 20);

    await expect(pending).rejects.toMatchObject({
      name: "McpMarketplaceError",
      code: "aborted",
    });
  });

  it("keeps the request timeout a typed error when no page completes", async () => {
    const aborts: Array<{ at: number; reason: unknown }> = [];
    stubHeldPage((info) => aborts.push(info));

    await expect(
      searchMcpMarketplace("matched-tool", 5, { timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ name: "McpMarketplaceError", code: "timeout" });
    expect(aborts).toHaveLength(1);
  });

  it("keeps the request timeout a typed error for a details lookup", async () => {
    stubHeldPage(() => {});

    await expect(
      getMcpServerDetails("vendor1/matched-tool", { timeoutMs: 150 })
    ).rejects.toMatchObject({ name: "McpMarketplaceError", code: "timeout" });
  });
});
