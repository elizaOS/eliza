/**
 * Exercises GET /api/views/search ranking when two views score identically.
 * No runtime is attached, so scoring is keyword-only and fully deterministic;
 * the assertion is that the route's comparator imposes a total order instead of
 * echoing registration order. Real registry, no embeddings, no LLM.
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

const TEST_PLUGIN = "@test/views-search-ordering";

interface SearchResult {
  id: string;
  label: string;
  _score: number;
}

function makeSearchCtx(search: string): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const pathname = "/api/views/search";
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: "GET",
    pathname,
    url: new URL(`http://local${pathname}${search}`),
    json,
    error: vi.fn(),
    broadcastWs: vi.fn(),
    // Intentionally NO runtime — forces keyword-only scoring.
  };
  return { ctx, json };
}

describe("GET /api/views/search tie ordering", () => {
  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "Synthetic search ordering plugin.",
        views: [
          // Both labels merely *include* the query, so the two views score
          // identically. Their labels order them opposite to their ids, and
          // the registry hands the route label order — so a comparator that
          // returns 0 for the tie emits the higher id first.
          {
            id: "zebra-vault",
            label: "Apple Vault",
            path: "/zebra-vault",
            description: "Storage view.",
            tags: [],
          },
          {
            id: "apple-vault",
            label: "Zebra Vault",
            path: "/apple-vault",
            description: "Storage view.",
            tags: [],
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

  it("orders equally scored views by id rather than registration order", async () => {
    const { ctx, json } = makeSearchCtx("?q=vault");

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    const payload = json.mock.calls[0][1] as { results: SearchResult[] };
    const tied = payload.results.filter((result) =>
      result.id.endsWith("-vault"),
    );
    expect(tied.map((result) => result.id)).toEqual([
      "apple-vault",
      "zebra-vault",
    ]);
    // Guards the premise: the ordering above is a tie-break, not a score gap.
    expect(tied[0]._score).toBe(tied[1]._score);
  });
});
