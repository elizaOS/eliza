import { describe, test, expect, vi } from "vitest";
import {
  createMockIncomingMessage,
  createMockHttpResponse,
} from "../../src/test-support/test-helpers";
import { handleModelsRoutes } from "../../src/api/models-routes";
import type { ModelsRouteContext } from "../../src/api/models-routes";

function buildCtx(
  method: string,
  pathname: string,
  overrides?: Partial<ModelsRouteContext>,
): ModelsRouteContext & { getStatus: () => number; getJson: () => unknown } {
  const { res, getStatus, getJson } = createMockHttpResponse();
  const urlString = `http://localhost:2138${pathname}`;
  const req = createMockIncomingMessage({ method, url: pathname });
  const ctx = {
    req,
    res,
    method,
    pathname,
    url: new URL(urlString),
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    providerCachePath: vi.fn((provider: string) => `/tmp/cache/${provider}.json`),
    getOrFetchProvider: vi.fn(async (provider: string) => [
      { id: `${provider}/model-a`, name: "Model A" },
    ]),
    getOrFetchAllProviders: vi.fn(async () => ({
      openai: [{ id: "openai/gpt-4", name: "GPT-4" }],
      anthropic: [{ id: "anthropic/claude", name: "Claude" }],
    })),
    resolveModelsCacheDir: vi.fn(() => "/tmp/models-cache"),
    pathExists: vi.fn(() => false),
    readDir: vi.fn(() => []),
    unlinkFile: vi.fn(),
    joinPath: vi.fn((left: string, right: string) => `${left}/${right}`),
    ...overrides,
  } as ModelsRouteContext & {
    getStatus: () => number;
    getJson: () => unknown;
  };
  (ctx as any).getStatus = getStatus;
  (ctx as any).getJson = getJson;
  return ctx;
}

describe("models-routes", () => {
  describe("GET /api/models", () => {
    test("returns all providers when no specific provider requested", async () => {
      const ctx = buildCtx("GET", "/api/models");
      const handled = await handleModelsRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      expect(ctx.getOrFetchAllProviders).toHaveBeenCalledWith(false);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.providers).toBeDefined();
      expect(payload.providers.openai).toHaveLength(1);
      expect(payload.providers.anthropic).toHaveLength(1);
    });

    test("returns specific provider when provider param is set", async () => {
      const ctx = buildCtx("GET", "/api/models?provider=openai", {
        url: new URL("http://localhost:2138/api/models?provider=openai"),
      });
      ctx.pathname = "/api/models";
      const handled = await handleModelsRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      expect(ctx.getOrFetchProvider).toHaveBeenCalledWith("openai", false);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.provider).toBe("openai");
      expect(payload.models).toBeDefined();
    });

    test("passes force=true when refresh param is set", async () => {
      const ctx = buildCtx("GET", "/api/models?refresh=true", {
        url: new URL("http://localhost:2138/api/models?refresh=true"),
      });
      ctx.pathname = "/api/models";
      const handled = await handleModelsRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.getOrFetchAllProviders).toHaveBeenCalledWith(true);
    });

    test("clears cache files when refresh=true and cache dir exists", async () => {
      const ctx = buildCtx("GET", "/api/models?refresh=true", {
        url: new URL("http://localhost:2138/api/models?refresh=true"),
        pathExists: vi.fn(() => true),
        readDir: vi.fn(() => ["openai.json", "anthropic.json", "readme.txt"]),
      });
      ctx.pathname = "/api/models";
      const handled = await handleModelsRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.unlinkFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const ctx = buildCtx("GET", "/api/other");
      expect(await handleModelsRoutes(ctx)).toBe(false);
    });

    test("POST to /api/models returns false (wrong method)", async () => {
      const ctx = buildCtx("POST", "/api/models");
      expect(await handleModelsRoutes(ctx)).toBe(false);
    });
  });
});
