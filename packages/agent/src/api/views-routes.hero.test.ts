/**
 * Exercises the GET /api/views/:id/hero image route: packaged PNG heroes for
 * builtin views, a generated image/svg+xml fallback for plugin views with no hero
 * asset, and a 404 through the error helper for unknown ids. In-process route
 * calls against a mock ServerResponse that captures writeHead/setHeader/end — no
 * HTTP server, no runtime, no LLM.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_VIEWS } from "./builtin-views.ts";
import {
  listViews,
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

// Unit test for GET /api/views/:id/hero (views-routes.ts ~L710). The route
// streams image bytes directly via res.writeHead/setHeader/end — NOT the `json`
// helper. So the mock res here captures writeHead/setHeader/end directly.

const TEST_PLUGIN = "@test/views-hero";

interface CapturedRes {
  writeHead: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeHeroCtx(id: string): {
  ctx: ViewsRouteContext;
  res: CapturedRes;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  req.headers = {};
  // sendGeneratedHero prefers writeHead; include setHeader so either code path
  // is observable, and end captures the streamed body.
  const res: CapturedRes = {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  const json = vi.fn();
  const error = vi.fn();
  const pathname = `/api/views/${encodeURIComponent(id)}/hero`;
  const ctx: ViewsRouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    method: "GET",
    pathname,
    url: new URL(`http://local${pathname}`),
    json,
    error,
    broadcastWs: vi.fn(),
  };
  return { ctx, res, json, error };
}

function headersFrom(res: CapturedRes): Record<string, string | number> {
  // writeHead(status, headers) is the primary path.
  if (res.writeHead.mock.calls.length > 0) {
    return res.writeHead.mock.calls[0][1] as Record<string, string | number>;
  }
  // Fallback: reconstruct from setHeader(name, value) calls.
  const headers: Record<string, string | number> = {};
  for (const [name, value] of res.setHeader.mock.calls) {
    headers[name as string] = value as string | number;
  }
  return headers;
}

function bodyFrom(res: CapturedRes): string {
  const chunk = res.end.mock.calls[0]?.[0];
  if (chunk instanceof Buffer) return chunk.toString("utf8");
  if (typeof chunk === "string") return chunk;
  return "";
}

function bodyBufferFrom(res: CapturedRes): Buffer {
  const chunk = res.end.mock.calls[0]?.[0];
  if (chunk instanceof Buffer) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  return Buffer.alloc(0);
}

describe("GET /api/views/:id/hero", () => {
  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "Synthetic hero test plugin.",
        views: [
          {
            id: "no-hero",
            label: "No Hero View",
            path: "/no-hero",
            icon: "Sparkles",
          },
        ],
      },
      // process.cwd() has no assets/hero.* file → forces the SVG fallback.
      process.cwd(),
    );
  });

  afterEach(() => {
    clearCurrentViewState();
    unregisterPluginViews(TEST_PLUGIN);
    vi.restoreAllMocks();
  });

  it("serves a generated image/svg+xml fallback for a plugin view with no hero file", async () => {
    const { ctx, res } = makeHeroCtx("no-hero");

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(res.writeHead).toHaveBeenCalledTimes(1);
    const [status, headers] = res.writeHead.mock.calls[0];
    expect(status).toBe(200);
    expect(headers["Content-Type"]).toBe("image/svg+xml");
    expect(headers["Content-Length"]).toBeGreaterThan(0);

    const body = bodyFrom(res);
    expect(body).toContain("<svg");
    expect(body).toContain("No Hero View");
  });

  it("marks every builtin view as having a real hero image", () => {
    const builtinViews = listViews({ includeAllKinds: true }).filter(
      (view) => view.pluginName === "@elizaos/builtin",
    );

    expect(builtinViews).toHaveLength(BUILTIN_VIEWS.length);
    for (const view of builtinViews) {
      expect(view.hasHeroImage).toBe(true);
      expect(view.heroImageUrl).toBe(
        `/api/views/${encodeURIComponent(view.id)}/hero`,
      );
    }
  });

  it("serves packaged PNG heroes for every builtin view", async () => {
    for (const view of BUILTIN_VIEWS) {
      const { ctx, res } = makeHeroCtx(view.id);

      await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

      const headers = headersFrom(res);
      expect(headers["Content-Type"]).toBe("image/png");
      expect(headers["Content-Length"]).toBeGreaterThan(0);
      expect(bodyBufferFrom(res).subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    }
  });

  it("404s through the error helper for an unregistered view id", async () => {
    const { ctx, res, error } = makeHeroCtx("does-not-exist");

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'View "does-not-exist" not found',
      404,
    );
    // No body should have been streamed for the not-found case.
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
