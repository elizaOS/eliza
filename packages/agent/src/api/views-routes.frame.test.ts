/**
 * Sandboxed dynamic views load a framed HTML document, not the JS bundle URL.
 * These tests exercise the registry + route contract behind that document:
 * a plugin declares `framePath`, `/api/views` exposes `frameUrl`, and
 * `GET /api/views/:id/frame.html` serves the package-local HTML with traversal
 * protection.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Plugin } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

const TEST_PLUGIN = "@test/sandbox-document";
const DOCUMENT_HTML =
  "<!doctype html><title>Sandbox document</title><main>framed ok</main>";

interface CapturedRes {
  writeHead: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeCtx(
  id: string,
  method: "GET" | "HEAD" = "GET",
): {
  ctx: ViewsRouteContext;
  res: CapturedRes;
  error: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  req.headers = {};
  const res: CapturedRes = {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  const pathname = `/api/views/${encodeURIComponent(id)}/frame.html`;
  const ctx: ViewsRouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    method,
    pathname,
    url: new URL(`http://local${pathname}`),
    json: vi.fn(),
    error: vi.fn(),
    broadcastWs: vi.fn(),
  };
  return { ctx, res, error: ctx.error as ReturnType<typeof vi.fn> };
}

function bodyFrom(res: CapturedRes): string {
  const chunk = res.end.mock.calls[0]?.[0];
  if (chunk instanceof Buffer) return chunk.toString("utf8");
  if (typeof chunk === "string") return chunk;
  return "";
}

describe("GET/HEAD /api/views/:id/frame.html", () => {
  let pluginDir: string;

  beforeEach(async () => {
    clearCurrentViewState();
    pluginDir = await mkdtemp(path.join(os.tmpdir(), "eliza-view-doc-"));
    await mkdir(path.join(pluginDir, "dist", "views"), { recursive: true });
    await writeFile(
      path.join(pluginDir, "dist", "views", "sandbox.html"),
      DOCUMENT_HTML,
      "utf8",
    );
  });

  afterEach(async () => {
    clearCurrentViewState();
    unregisterPluginViews(TEST_PLUGIN);
    await rm(pluginDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exposes and serves a declared sandbox document URL", async () => {
    const plugin: Plugin = {
      name: TEST_PLUGIN,
      description: "sandbox document fixture",
      views: [
        {
          id: "sandbox-doc",
          label: "Sandbox Doc",
          bundlePath: "dist/views/bundle.js",
          framePath: "dist/views/sandbox.html",
          surface: {
            isolation: "sandboxed-iframe",
            capabilities: ["navigate", "storage"],
          },
        },
      ],
    } as Plugin;
    await registerPluginViews(plugin, pluginDir);

    const entry = listViews({ includeAllKinds: true }).find(
      (view) => view.id === "sandbox-doc",
    );
    expect(entry?.frameUrl).toMatch(
      /^\/api\/views\/sandbox-doc\/frame\.html\?v=\d+$/,
    );
    expect(entry?.available).toBe(true);

    const { ctx, res } = makeCtx("sandbox-doc");
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      }),
    );
    expect(bodyFrom(res)).toContain("framed ok");

    const { ctx: headCtx, res: headRes } = makeCtx("sandbox-doc", "HEAD");
    await expect(handleViewsRoutes(headCtx)).resolves.toBe(true);

    expect(headRes.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(DOCUMENT_HTML),
        "Cache-Control": "no-cache",
      }),
    );
    expect(headRes.end).toHaveBeenCalledWith(undefined);
  });

  it("does not serve undeclared or package-escaping document paths", async () => {
    const plugin: Plugin = {
      name: TEST_PLUGIN,
      description: "sandbox document traversal fixture",
      views: [
        {
          id: "sandbox-escape",
          label: "Sandbox Escape",
          bundlePath: "dist/views/bundle.js",
          framePath: "../outside.html",
          surface: { isolation: "sandboxed-iframe" },
        },
      ],
    } as Plugin;
    await registerPluginViews(plugin, pluginDir);

    const { ctx, res, error } = makeCtx("sandbox-escape");
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'View "sandbox-escape" has no sandbox frame document configured.',
      404,
    );
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
