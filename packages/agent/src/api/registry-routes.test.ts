/**
 * Unit tests for `handleRegistryRoutes` path encoding validation and registry lookup.
 * Deterministic: asserts malformed percent-escapes fail closed with 400 Bad Request
 * per Error Policy J3, and valid percent-encoded plugin names are correctly decoded.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  handleRegistryRoutes,
  type RegistryRouteContext,
} from "./registry-routes";

function createRegistryContext(
  method: string,
  pathname: string,
  overrides: Partial<RegistryRouteContext> = {},
): {
  ctx: RegistryRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  getRegistryPlugin: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const req = { method, url: pathname } as http.IncomingMessage;
  const end = vi.fn();
  const res = {
    setHeader: vi.fn(),
    end,
  } as unknown as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const getRegistryPlugin = vi.fn().mockResolvedValue({
    name: "@elizaos/plugin-test",
    description: "test plugin",
  });

  const ctx: RegistryRouteContext = {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    json,
    error,
    getPluginManager: () => ({
      refreshRegistry: vi.fn().mockResolvedValue(new Map()),
      listInstalledPlugins: vi.fn().mockResolvedValue([]),
      getRegistryPlugin,
      searchRegistry: vi.fn().mockResolvedValue([]),
    }),
    getLoadedPluginNames: () => [],
    getBundledPluginIds: () => new Set(),
    classifyRegistryPluginRelease: () => ({ status: "compatible" }),
    ...overrides,
  };

  return { ctx, json, error, getRegistryPlugin, end };
}

describe("handleRegistryRoutes path encoding validation", () => {
  it("rejects malformed percent-encoding on GET /api/registry/plugins/:name with 400", async () => {
    const { ctx, end, error, getRegistryPlugin } = createRegistryContext(
      "GET",
      "/api/registry/plugins/%",
    );

    const handled = await handleRegistryRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ error: "Invalid plugin name: malformed URL encoding" }),
    );
    expect(error).not.toHaveBeenCalled();
    expect(getRegistryPlugin).not.toHaveBeenCalled();
  });

  it("decodes valid percent-encoded plugin name on GET /api/registry/plugins/:name", async () => {
    const { ctx, json, getRegistryPlugin } = createRegistryContext(
      "GET",
      "/api/registry/plugins/%40elizaos%2Fplugin-test",
    );

    const handled = await handleRegistryRoutes(ctx);

    expect(handled).toBe(true);
    expect(getRegistryPlugin).toHaveBeenCalledWith("@elizaos/plugin-test");
    expect(json).toHaveBeenCalledWith(ctx.res, {
      plugin: {
        name: "@elizaos/plugin-test",
        description: "test plugin",
      },
    });
  });

  it.each([
    "%2F",
    "%5C",
    ".",
    "..",
    "%00",
    "%20",
    "%252F",
    "UPPER",
    "a".repeat(215),
  ])("rejects non-canonical decoded plugin name %s", async (encodedName) => {
    const { ctx, error, getRegistryPlugin } = createRegistryContext(
      "GET",
      `/api/registry/plugins/${encodedName}`,
    );

    await expect(handleRegistryRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(ctx.res, "Invalid plugin name", 400);
    expect(getRegistryPlugin).not.toHaveBeenCalled();
  });
});
