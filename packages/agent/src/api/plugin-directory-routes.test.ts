/**
 * Unit coverage for `handlePluginDirectoryRoutes` — the POST
 * `/api/plugins/load-from-directory` handler. Deterministic: the directory-load
 * helper, runtime, and WS broadcast are vi.fn stubs, asserting route gating
 * (absolute-path requirement, local-code-execution policy) and the
 * plugin_reloaded broadcast after a successful hot load.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handlePluginDirectoryRoutes } from "./plugin-directory-routes.ts";

function makeCtx(
  body: Record<string, unknown>,
  overrides: Partial<Parameters<typeof handlePluginDirectoryRoutes>[0]> = {},
): {
  ctx: Parameters<typeof handlePluginDirectoryRoutes>[0];
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
  loadPluginFromDirectory: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const loadPluginFromDirectory = vi
    .fn()
    .mockResolvedValue({ pluginName: "hot-view-plugin" });
  const ctx = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/plugins/load-from-directory",
    state: {
      runtime: { id: "runtime" } as never,
      broadcastWs,
    },
    readJsonBody: vi.fn().mockResolvedValue(body),
    json,
    error,
    isLocalCodeExecutionAllowed: () => true,
    loadPluginFromDirectory,
    ...overrides,
  } satisfies Parameters<typeof handlePluginDirectoryRoutes>[0];
  return { ctx, json, error, broadcastWs, loadPluginFromDirectory };
}

describe("handlePluginDirectoryRoutes", () => {
  it("ignores unrelated routes", async () => {
    const { ctx } = makeCtx({}, { pathname: "/api/other" });

    await expect(handlePluginDirectoryRoutes(ctx)).resolves.toBe(false);
  });

  it("broadcasts plugin_reloaded after a live load succeeds", async () => {
    const directory = "/tmp/eliza-plugin-hot-reload";
    const { ctx, json, broadcastWs, loadPluginFromDirectory } = makeCtx({
      directory,
    });

    await expect(handlePluginDirectoryRoutes(ctx)).resolves.toBe(true);

    expect(loadPluginFromDirectory).toHaveBeenCalledWith({
      runtime: ctx.state.runtime,
      directory,
    });
    expect(broadcastWs).toHaveBeenCalledWith({
      type: "view:event",
      viewEventType: "plugin_reloaded",
      payload: {
        pluginName: "hot-view-plugin",
        directory,
        source: "plugins.load-from-directory",
      },
    });
    expect(json).toHaveBeenCalledWith(ctx.res, {
      ok: true,
      pluginName: "hot-view-plugin",
    });
  });

  it("rejects non-absolute plugin directories before loading", async () => {
    const { ctx, error, loadPluginFromDirectory, broadcastWs } = makeCtx({
      directory: "relative/plugin",
    });

    await expect(handlePluginDirectoryRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "'directory' must be an absolute path",
      400,
    );
    expect(loadPluginFromDirectory).not.toHaveBeenCalled();
    expect(broadcastWs).not.toHaveBeenCalled();
  });

  it("blocks local plugin loading when the runtime policy disallows it", async () => {
    const { ctx, error, loadPluginFromDirectory } = makeCtx(
      { directory: "/tmp/eliza-plugin" },
      {
        isLocalCodeExecutionAllowed: () => false,
        buildStoreVariantBlockedMessage: (feature) => `${feature} blocked`,
      },
    );

    await expect(handlePluginDirectoryRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Local plugin loading blocked",
      403,
    );
    expect(loadPluginFromDirectory).not.toHaveBeenCalled();
  });
});
