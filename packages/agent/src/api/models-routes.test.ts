/**
 * Unit tests for GET /api/models: both response shapes (all-providers and
 * ?provider=) carry the additive `catalog` field alongside the unchanged
 * provider-cache payload. Deterministic — cache fetchers and the catalog
 * builder are injected.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "./model-catalog";
import { handleModelsRoutes } from "./models-routes";

const fakeCatalog: ModelCatalog = {
  providers: {
    codex: [
      {
        id: "gpt-5.6-terra",
        display: "GPT-5.6-Terra",
        efforts: ["low"],
        roles: ["coding"],
      },
    ],
  },
};

function makeCtx(urlPath: string) {
  const json = vi.fn();
  const ctx = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "GET",
    pathname: "/api/models",
    url: new URL(`http://localhost${urlPath}`),
    json,
    providerCachePath: (provider: string) => `/tmp/${provider}.json`,
    getOrFetchProvider: vi.fn(async () => [{ id: "m1" }]),
    getOrFetchAllProviders: vi.fn(async () => ({ openai: [{ id: "m1" }] })),
    resolveModelsCacheDir: () => "/tmp",
    pathExists: () => false,
    readDir: () => [],
    unlinkFile: () => {},
    joinPath: (a: string, b: string) => `${a}/${b}`,
    buildCatalog: () => fakeCatalog,
  };
  return { ctx, json };
}

describe("handleModelsRoutes catalog field", () => {
  it("attaches the catalog to the all-providers response", async () => {
    const { ctx, json } = makeCtx("/api/models");
    await expect(handleModelsRoutes(ctx as never)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      providers: { openai: [{ id: "m1" }] },
      catalog: fakeCatalog,
    });
  });

  it("attaches the catalog to the single-provider response", async () => {
    const { ctx, json } = makeCtx("/api/models?provider=openai");
    await expect(handleModelsRoutes(ctx as never)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      provider: "openai",
      models: [{ id: "m1" }],
      catalog: fakeCatalog,
    });
  });

  it("serves catalogOnly without touching any provider fetcher", async () => {
    const { ctx, json } = makeCtx("/api/models?catalogOnly=1");
    await expect(handleModelsRoutes(ctx as never)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      providers: {},
      catalog: fakeCatalog,
    });
    // The whole point: no provider fan-out (it takes tens of seconds cold).
    expect(ctx.getOrFetchAllProviders).not.toHaveBeenCalled();
    expect(ctx.getOrFetchProvider).not.toHaveBeenCalled();
  });

  it("declines non-matching routes", async () => {
    const { ctx } = makeCtx("/api/models");
    ctx.pathname = "/api/models/config";
    await expect(handleModelsRoutes(ctx as never)).resolves.toBe(false);
  });
});
