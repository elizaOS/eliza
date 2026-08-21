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

  it("accepts the refresh=true boolean identity for catalogOnly", async () => {
    const { ctx, json } = makeCtx("/api/models?catalogOnly=true");
    await expect(handleModelsRoutes(ctx as never)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      providers: {},
      catalog: fakeCatalog,
    });
    expect(ctx.getOrFetchAllProviders).not.toHaveBeenCalled();
    expect(ctx.getOrFetchProvider).not.toHaveBeenCalled();
  });

  it("accepts the catalogOnly=1 boolean identity for refresh", async () => {
    const unlinkFile = vi.fn();
    const { ctx, json } = makeCtx("/api/models?provider=openai&refresh=1");
    ctx.unlinkFile = unlinkFile;
    await expect(handleModelsRoutes(ctx as never)).resolves.toBe(true);
    expect(unlinkFile).toHaveBeenCalledWith("/tmp/openai.json");
    expect(ctx.getOrFetchProvider).toHaveBeenCalledWith("openai", true);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      provider: "openai",
      models: [{ id: "m1" }],
      catalog: fakeCatalog,
    });
  });

  it("rejects non-boolean catalogOnly and refresh before any provider fetch", async () => {
    for (const query of [
      "catalogOnly=truee",
      "catalogOnly=1e2",
      "catalogOnly=yesplease",
      "refresh=truee",
      "refresh=1e2",
      "refresh=12px",
      "catalogOnly=1&refresh=1e2",
    ]) {
      const { ctx, json } = makeCtx(`/api/models?${query}`);
      await expect(handleModelsRoutes(ctx as never)).resolves.toBe(true);
      expect(json, query).toHaveBeenCalledWith(
        ctx.res,
        { error: expect.stringMatching(/must be a boolean/) },
        400,
      );
      expect(ctx.getOrFetchAllProviders, query).not.toHaveBeenCalled();
      expect(ctx.getOrFetchProvider, query).not.toHaveBeenCalled();
    }
  });

  it("rejects traversal-shaped provider ids before any cache path is built (W1-024)", async () => {
    for (const provider of [
      "../eliza",
      "../../etc/passwd",
      "..\\eliza",
      "a/b",
      "openai.json",
      "OPENAI",
      "open ai",
    ]) {
      const unlinkFile = vi.fn();
      const { ctx, json } = makeCtx(
        `/api/models?provider=${encodeURIComponent(provider)}&refresh=true`,
      );
      ctx.unlinkFile = unlinkFile;
      await expect(handleModelsRoutes(ctx as never)).resolves.toBe(true);
      expect(json, provider).toHaveBeenCalledWith(
        ctx.res,
        { error: "Invalid provider id" },
        400,
      );
      expect(unlinkFile, provider).not.toHaveBeenCalled();
      expect(ctx.getOrFetchProvider, provider).not.toHaveBeenCalled();
      expect(ctx.getOrFetchAllProviders, provider).not.toHaveBeenCalled();
    }
  });

  it("declines non-matching routes", async () => {
    const { ctx } = makeCtx("/api/models");
    ctx.pathname = "/api/models/config";
    await expect(handleModelsRoutes(ctx as never)).resolves.toBe(false);
  });
});
