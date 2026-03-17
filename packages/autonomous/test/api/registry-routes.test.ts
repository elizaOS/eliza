import { describe, expect, test, vi } from "vitest";
import type { RegistryRouteContext } from "../../src/api/registry-routes";
import { handleRegistryRoutes } from "../../src/api/registry-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

function buildCtx(
  method: string,
  pathname: string,
  overrides?: Partial<RegistryRouteContext>,
): RegistryRouteContext & { getStatus: () => number; getJson: () => unknown } {
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
    error: vi.fn((r, msg, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: msg }));
    }),
    getPluginManager: () => ({
      refreshRegistry: vi.fn(async () => new Map()),
      listInstalledPlugins: vi.fn(async () => []),
      getRegistryPlugin: vi.fn(async () => null),
      searchRegistry: vi.fn(async () => []),
    }),
    getLoadedPluginNames: () => [],
    getBundledPluginIds: () => new Set<string>(),
    classifyRegistryPluginRelease: () => "compatible",
    getStatus,
    getJson,
    ...overrides,
  } as RegistryRouteContext & {
    getStatus: () => number;
    getJson: () => unknown;
  };
  return ctx;
}

describe("registry-routes", () => {
  describe("GET /api/registry/plugins", () => {
    test("returns empty plugin list from empty registry", async () => {
      const ctx = buildCtx("GET", "/api/registry/plugins");
      const handled = await handleRegistryRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.count).toBe(0);
      expect(payload.plugins).toEqual([]);
    });

    test("returns plugins with installed/loaded/bundled flags", async () => {
      const registry = new Map([
        [
          "@elizaos/plugin-foo",
          { name: "@elizaos/plugin-foo", kind: "plugin" },
        ],
      ]);
      const pluginManager = {
        refreshRegistry: vi.fn(async () => registry),
        listInstalledPlugins: vi.fn(async () => [
          { name: "@elizaos/plugin-foo", version: "1.0.0" },
        ]),
        getRegistryPlugin: vi.fn(async () => null),
        searchRegistry: vi.fn(async () => []),
      };
      const ctx = buildCtx("GET", "/api/registry/plugins", {
        getPluginManager: () => pluginManager,
        getLoadedPluginNames: () => ["@elizaos/plugin-foo"],
        getBundledPluginIds: () => new Set(["foo"]),
      });
      const handled = await handleRegistryRoutes(ctx);
      expect(handled).toBe(true);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.count).toBe(1);
      expect(payload.plugins[0].installed).toBe(true);
      expect(payload.plugins[0].loaded).toBe(true);
      expect(payload.plugins[0].bundled).toBe(true);
    });

    test("returns 502 when registry refresh throws", async () => {
      const pluginManager = {
        refreshRegistry: vi.fn(async () => {
          throw new Error("network error");
        }),
        listInstalledPlugins: vi.fn(async () => []),
        getRegistryPlugin: vi.fn(async () => null),
        searchRegistry: vi.fn(async () => []),
      };
      const ctx = buildCtx("GET", "/api/registry/plugins", {
        getPluginManager: () => pluginManager,
      });
      const handled = await handleRegistryRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(502);
      expect(args[1]).toContain("network error");
    });
  });

  describe("GET /api/registry/search", () => {
    test("returns 400 when query parameter is empty", async () => {
      const ctx = buildCtx("GET", "/api/registry/search");
      const handled = await handleRegistryRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalledOnce();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(400);
      expect(args[1]).toContain("'q' is required");
    });

    test("returns results when query is provided", async () => {
      const searchResults = [{ name: "@elizaos/plugin-foo" }];
      const pluginManager = {
        refreshRegistry: vi.fn(async () => new Map()),
        listInstalledPlugins: vi.fn(async () => []),
        getRegistryPlugin: vi.fn(async () => null),
        searchRegistry: vi.fn(async () => searchResults),
      };
      const ctx = buildCtx("GET", "/api/registry/search?q=foo", {
        getPluginManager: () => pluginManager,
        url: new URL("http://localhost:2138/api/registry/search?q=foo"),
      });
      ctx.pathname = "/api/registry/search";
      const handled = await handleRegistryRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.query).toBe("foo");
      expect(payload.count).toBe(1);
      expect(payload.results).toEqual(searchResults);
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const ctx = buildCtx("GET", "/api/other");
      expect(await handleRegistryRoutes(ctx)).toBe(false);
    });

    test("POST to /api/registry/plugins returns false (wrong method)", async () => {
      const ctx = buildCtx("POST", "/api/registry/plugins");
      expect(await handleRegistryRoutes(ctx)).toBe(false);
    });
  });
});
