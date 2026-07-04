/**
 * Exercises the GET /api/views/search keyword-scoring path with no runtime
 * attached, so ranking is fully deterministic (semantic weight 0): exact-label
 * beats a partial match, exact-tag matches, empty/whitespace queries short-circuit
 * to no results, limit clamps to [1,20], and viewType filters to tui views. No
 * embeddings, PGLite, or LLM.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

// Unit test for GET /api/views/search (views-routes.ts ~L292). With no runtime
// the route falls back to keyword-only scoring (40% weight, semantic 0), so the
// rankings here are fully deterministic — no embeddings, no PGLite, no LLM.
//
// Keyword scores (route): exact label == 100, label.includes == 80, exact tag
// == 60, description.includes == 40. The combined score is `kw * 0.4`, and the
// route drops anything with score <= 5 then slices to `topK`.

const TEST_PLUGIN = "@test/views-search";

function makeSearchCtx(search: string): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  // GET → no body; Readable.from([]) mirrors an empty inbound request stream.
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const pathname = "/api/views/search";
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: "GET",
    pathname,
    url: new URL(`http://local${pathname}${search}`),
    json,
    error,
    broadcastWs: vi.fn(),
    // Intentionally NO runtime — forces keyword-only scoring.
  };
  return { ctx, json, error };
}

interface SearchResult {
  id: string;
  label: string;
  viewType: string;
  _score: number;
}

function resultsFrom(json: ReturnType<typeof vi.fn>): SearchResult[] {
  const payload = json.mock.calls[0]?.[1] as
    | { results?: SearchResult[] }
    | undefined;
  return payload?.results ?? [];
}

describe("GET /api/views/search keyword scoring", () => {
  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "Synthetic search test plugin.",
        views: [
          {
            id: "wallet",
            label: "Wallet",
            path: "/wallet",
            description: "Track balances and transactions.",
            tags: ["money", "crypto"],
          },
          {
            id: "wallet-history",
            // Label only *includes* "wallet" → weaker than the exact "Wallet".
            label: "Wallet History Ledger",
            path: "/wallet-history",
            description: "Past wallet transfers.",
            tags: ["money", "history"],
          },
          {
            id: "tui-wallet",
            label: "Wallet Terminal",
            path: "/tui/wallet",
            viewType: "tui",
            description: "Terminal wallet view.",
            tags: ["money", "tui"],
          },
        ],
      },
      process.cwd(),
    );
  });

  afterEach(() => {
    clearCurrentViewState();
    unregisterPluginViews(TEST_PLUGIN);
    vi.restoreAllMocks();
  });

  it("returns matching views ranked, with exact-label beating a weaker match", async () => {
    const { ctx, json } = makeSearchCtx("?q=wallet");

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    // Route shape: json(res, { results, query, semanticEnabled }).
    expect(json).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0][1] as {
      results: SearchResult[];
      query: string;
      semanticEnabled: boolean;
    };
    expect(payload.query).toBe("wallet");
    // No runtime was passed → semantic search is disabled.
    expect(payload.semanticEnabled).toBe(false);

    const results = payload.results;
    const ids = results.map((r) => r.id);
    expect(ids).toContain("wallet");
    expect(ids).toContain("wallet-history");

    // Exact label "Wallet" (score 100) ranks above "Wallet History Ledger"
    // (label.includes → score 80).
    const exact = results.find((r) => r.id === "wallet");
    const partial = results.find((r) => r.id === "wallet-history");
    expect(exact).toBeDefined();
    expect(partial).toBeDefined();
    expect((exact as SearchResult)._score).toBeGreaterThan(
      (partial as SearchResult)._score,
    );
    expect(results[0].id).toBe("wallet");
  });

  it("matches on an exact tag when no label/description hit applies", async () => {
    const { ctx, json } = makeSearchCtx("?q=crypto");

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    const ids = resultsFrom(json).map((r) => r.id);
    // "crypto" is an exact tag on the "wallet" view only (score 60).
    expect(ids).toContain("wallet");
  });

  it("returns an empty result set for an empty query without scanning", async () => {
    const { ctx, json } = makeSearchCtx("?q=");

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    // Early return path: json(res, { results: [], query }).
    expect(json).toHaveBeenCalledWith(ctx.res, { results: [], query: "" });
  });

  it("returns an empty result set for a whitespace-only query", async () => {
    const { ctx, json } = makeSearchCtx("?q=%20%20");

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    const payload = json.mock.calls[0][1] as {
      results: SearchResult[];
      query: string;
    };
    expect(payload.results).toEqual([]);
    // The raw (un-trimmed) query is echoed back.
    expect(payload.query).toBe("  ");
  });

  it("clamps limit to the [1,20] window and never exceeds it", async () => {
    // A default (gui) search matches two plugin views — "wallet" and
    // "wallet-history" (the third, "tui-wallet", is a tui declaration and is
    // excluded unless viewType=tui). Builtin views don't match "wallet".
    // Asking for limit=1 must clamp the result count to exactly 1.
    const { ctx: ctxLow, json: jsonLow } = makeSearchCtx("?q=wallet&limit=1");
    await expect(handleViewsRoutes(ctxLow)).resolves.toBe(true);
    expect(resultsFrom(jsonLow)).toHaveLength(1);

    // A huge limit is clamped to the ceiling of 20; with 2 gui matches we still
    // get both (the clamp prevents over-fetching, it does not invent rows).
    const { ctx: ctxHigh, json: jsonHigh } = makeSearchCtx(
      "?q=wallet&limit=999",
    );
    await expect(handleViewsRoutes(ctxHigh)).resolves.toBe(true);
    const high = resultsFrom(jsonHigh);
    expect(high.length).toBeLessThanOrEqual(20);
    expect(high.length).toBe(2);
  });

  it("filters to tui views when viewType=tui is requested", async () => {
    const { ctx, json } = makeSearchCtx("?q=wallet&viewType=tui");

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    const results = resultsFrom(json);
    // The tui-only declaration must surface with its tui viewType.
    const tui = results.find((r) => r.id === "tui-wallet");
    expect(tui).toBeDefined();
    expect((tui as SearchResult).viewType).toBe("tui");
  });
});
