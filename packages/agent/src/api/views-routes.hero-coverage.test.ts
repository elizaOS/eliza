/**
 * Launcher "every view has an image" guarantee, asserted at the API layer: the
 * Launcher renders a tile for every registered view via GET /api/views/:id/hero,
 * so that route must NEVER 404 for a registered view and must ALWAYS return a
 * non-empty image — a packaged hero file (the builtin PNGs) or the deterministic
 * branded SVG fallback (`generateViewHeroSvg`). This spec enumerates the live
 * registry and proves the contract for EVERY view, mixing real-hero builtins
 * with synthetic fallback-plugin views. Companion to views-routes.hero.test.ts,
 * which checks the individual code paths (one fallback view, the builtin PNG
 * set, the 404-for-unknown-id case). Drives the handler in-process (no server).
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { logger } from "@elizaos/core";
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

// Two plugins each declaring views with NO hero file on disk. Registering them
// under process.cwd() (which has no assets/hero.* nor the declared heroImagePath)
// forces every one of these views down the generated-SVG fallback path.
const FALLBACK_PLUGIN_A = "@test/views-hero-coverage-a";
const FALLBACK_PLUGIN_B = "@test/views-hero-coverage-b";

// Ids whose hero MUST resolve to the generated SVG fallback (no packaged file).
const FALLBACK_VIEW_IDS = new Set([
  "coverage-no-hero-1",
  "coverage-no-hero-2",
  "coverage-no-hero-3",
]);

interface CapturedRes {
  writeHead: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeHeroCtx(id: string): {
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
  const error = vi.fn();
  const pathname = `/api/views/${encodeURIComponent(id)}/hero`;
  const ctx: ViewsRouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    method: "GET",
    pathname,
    url: new URL(`http://local${pathname}`),
    json: vi.fn(),
    error,
    broadcastWs: vi.fn(),
  };
  return { ctx, res, error };
}

function headersFrom(res: CapturedRes): Record<string, string | number> {
  // The hero handlers prefer writeHead(status, headers); fall back to
  // reconstructing from setHeader(name, value) calls for completeness.
  if (res.writeHead.mock.calls.length > 0) {
    return res.writeHead.mock.calls[0][1] as Record<string, string | number>;
  }
  const headers: Record<string, string | number> = {};
  for (const [name, value] of res.setHeader.mock.calls) {
    headers[name as string] = value as string | number;
  }
  return headers;
}

function statusFrom(res: CapturedRes): number | undefined {
  return res.writeHead.mock.calls[0]?.[0] as number | undefined;
}

function bodyBufferFrom(res: CapturedRes): Buffer {
  const chunk = res.end.mock.calls[0]?.[0];
  if (chunk instanceof Buffer) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  return Buffer.alloc(0);
}

describe("GET /api/views/:id/hero — every view returns an image", () => {
  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
    // Two synthetic plugins with views that have no packaged hero. process.cwd()
    // is the agent package dir, which has no assets/hero.* and none of the
    // declared heroImagePath files → every view here hits the SVG fallback.
    await registerPluginViews(
      {
        name: FALLBACK_PLUGIN_A,
        description: "Synthetic hero-coverage plugin A (no hero files).",
        views: [
          {
            id: "coverage-no-hero-1",
            label: "Coverage No Hero One",
            path: "/coverage-no-hero-1",
            icon: "Sparkles",
          },
          {
            id: "coverage-no-hero-2",
            label: "Coverage No Hero Two",
            path: "/coverage-no-hero-2",
            icon: "Box",
            // Declared but non-existent — must still fall back, not 500/404.
            heroImagePath: "assets/view-heroes/does-not-exist.png",
          },
        ],
      },
      process.cwd(),
    );
    await registerPluginViews(
      {
        name: FALLBACK_PLUGIN_B,
        description: "Synthetic hero-coverage plugin B (no hero files).",
        views: [
          {
            id: "coverage-no-hero-3",
            label: "Coverage No Hero Three",
            path: "/coverage-no-hero-3",
            icon: "Image",
          },
        ],
      },
      process.cwd(),
    );
  });

  afterEach(() => {
    clearCurrentViewState();
    unregisterPluginViews(FALLBACK_PLUGIN_A);
    unregisterPluginViews(FALLBACK_PLUGIN_B);
    vi.restoreAllMocks();
  });

  it("registers builtin views (real heroes) and fallback plugin views together", () => {
    const views = listViews({ includeAllKinds: true });
    const ids = new Set(views.map((view) => view.id));

    // Sanity: the registry holds both flavours, so the per-view loop exercises
    // the packaged-file path AND the generated-SVG fallback path.
    for (const builtin of BUILTIN_VIEWS) {
      expect(ids.has(builtin.id)).toBe(true);
    }
    for (const fallbackId of FALLBACK_VIEW_IDS) {
      expect(ids.has(fallbackId)).toBe(true);
    }
    expect(views.length).toBeGreaterThanOrEqual(
      BUILTIN_VIEWS.length + FALLBACK_VIEW_IDS.size,
    );
  });

  it("serves a non-empty image for EVERY registered view (no 404, image/* content-type)", async () => {
    const views = listViews({ includeAllKinds: true });
    expect(views.length).toBeGreaterThan(0);

    const failures: string[] = [];

    for (const view of views) {
      const { ctx, res, error } = makeHeroCtx(view.id);

      // The route resolves true for both the file and fallback branches.
      await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

      // No registered view may route through the 404 error helper.
      if (error.mock.calls.length > 0) {
        failures.push(`${view.id}: error() called (expected an image)`);
        continue;
      }

      const status = statusFrom(res);
      if (status !== 200) {
        failures.push(`${view.id}: status ${String(status)} (expected 200)`);
        continue;
      }

      const headers = headersFrom(res);
      const contentType = String(headers["Content-Type"] ?? "");
      if (!/^image\//.test(contentType)) {
        failures.push(`${view.id}: Content-Type "${contentType}" not image/*`);
        continue;
      }

      const body = bodyBufferFrom(res);
      if (body.byteLength === 0) {
        failures.push(`${view.id}: empty body`);
        continue;
      }

      const declaredLength = Number(headers["Content-Length"] ?? 0);
      if (!(declaredLength > 0)) {
        failures.push(`${view.id}: Content-Length ${String(declaredLength)}`);
        continue;
      }

      // Views without a packaged hero must serve the deterministic branded SVG.
      if (FALLBACK_VIEW_IDS.has(view.id)) {
        if (contentType !== "image/svg+xml") {
          failures.push(
            `${view.id}: fallback view served "${contentType}", expected image/svg+xml`,
          );
          continue;
        }
        if (!body.toString("utf8").includes("<svg")) {
          failures.push(`${view.id}: fallback body missing "<svg"`);
        }
      }
    }

    if (failures.length > 0) {
      logger.error(
        { src: "ViewsHeroCoverageTest", failures },
        `[ViewsHeroCoverageTest] ${failures.length} view(s) failed the hero-image guarantee`,
      );
    }
    expect(failures).toEqual([]);
  });
});
