/**
 * Exercises hero delivery through the real runtime registry and route handler:
 * exact packaged PNG bytes, generated SVG fallbacks, and unknown-view rejection.
 * Temporary plugin assets make file delivery independent of checkout artwork.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AgentRuntime, createCharacter } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeRuntimeViewRegistry,
  listViews,
  registerBuiltinViews,
  registerPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

let runtime: AgentRuntime;
let hostKey: object;
let pluginDirectory: string;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/B8AAAAASUVORK5CYII=",
  "base64",
);

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
    runtime,
    callerAuthorization: { ok: true, role: "OWNER" },
    hostKey,
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
    runtime = new AgentRuntime({
      character: createCharacter({ name: "View route" }),
      enableAutonomy: false,
    });
    hostKey = {};
    pluginDirectory = mkdtempSync(join(tmpdir(), "agent-hero-"));
    writeFileSync(join(pluginDirectory, "packaged.png"), png);
    registerBuiltinViews(runtime);
    clearCurrentViewState(runtime);
    await registerPluginViews(
      runtime,
      {
        name: TEST_PLUGIN,
        description: "Synthetic hero test plugin.",
        views: [
          {
            id: "packaged-hero",
            label: "Packaged Hero",
            path: "/packaged",
            heroImagePath: "packaged.png",
          },
          {
            id: "missing-hero",
            label: "Missing Hero View",
            path: "/missing",
            heroImagePath: "missing.png",
          },
          {
            id: "no-hero",
            label: "No Hero View",
            path: "/no-hero",
            icon: "Sparkles",
          },
        ],
      },
      { pluginDir: pluginDirectory },
    );
  });

  afterEach(() => {
    clearCurrentViewState(runtime);
    closeRuntimeViewRegistry(runtime);
    vi.restoreAllMocks();
    rmSync(pluginDirectory, { recursive: true, force: true });
  });

  it.each([
    ["no-hero", "No Hero View"],
    ["missing-hero", "Missing Hero View"],
  ])("serves an SVG fallback for %s", async (id, label) => {
    const { ctx, res } = makeHeroCtx(id);

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(res.writeHead).toHaveBeenCalledTimes(1);
    const [status, headers] = res.writeHead.mock.calls[0];
    expect(status).toBe(200);
    expect(headers["Content-Type"]).toBe("image/svg+xml");
    expect(headers["Content-Length"]).toBeGreaterThan(0);

    const body = bodyFrom(res);
    expect(body).toContain("<svg");
    expect(body).toContain(label);
  });

  it("serves packaged PNG bytes without rewriting them", async () => {
    const { ctx, res, error } = makeHeroCtx("packaged-hero");
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    expect(headersFrom(res)["Content-Type"]).toBe("image/png");
    expect(headersFrom(res)["Content-Length"]).toBe(png.length);
    expect(bodyBufferFrom(res)).toEqual(png);
    expect(
      listViews(runtime).find((view) => view.id === "packaged-hero")
        ?.hasHeroImage,
    ).toBe(true);
    expect(
      listViews(runtime).find((view) => view.id === "missing-hero")
        ?.hasHeroImage,
    ).toBe(false);
  });

  it("serves a nonempty image for every registered builtin and plugin view", async () => {
    const views = listViews(runtime, { includeAllKinds: true });
    expect(views.length).toBeGreaterThan(3);
    for (const view of views) {
      const { ctx, res, error } = makeHeroCtx(view.id);
      await expect(handleViewsRoutes(ctx), view.id).resolves.toBe(true);
      expect(error, view.id).not.toHaveBeenCalled();
      expect(res.writeHead.mock.calls[0][0], view.id).toBe(200);
      const headers = headersFrom(res);
      expect(headers["Content-Type"], view.id).toMatch(/^image\//);
      const body = bodyBufferFrom(res);
      expect(body.byteLength, view.id).toBeGreaterThan(0);
      expect(headers["Content-Length"], view.id).toBe(body.byteLength);
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
