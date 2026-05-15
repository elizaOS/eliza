/**
 * HTTP route handlers for the View Registry API.
 *
 * Mounted on the agent's HTTP server. Serves view metadata, compiled bundles,
 * and hero images contributed by plugins via `Plugin.views`.
 *
 * Routes:
 *   GET  /api/views                    — list all registered views (JSON)
 *   GET  /api/views/platform-info      — platform detection info (JSON)
 *   GET  /api/views/:id                — single view metadata (JSON)
 *   GET  /api/views/:id/bundle.js      — compiled view bundle (JS)
 *   GET  /api/views/:id/hero           — hero image (image/*)
 *   POST /api/views/:id/navigate       — broadcast shell navigation event (JSON)
 *   POST /api/views/:id/interact       — reserved for agent-view interaction
 */

import { promises as fs } from "node:fs";
import type http from "node:http";

import { logger, type RouteRequestMeta } from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/shared";
import {
  detectClientPlatform,
  isDynamicLoadingAllowed,
} from "./platform-detect.ts";
import {
  findHeroOnDisk,
  generateViewHeroSvg,
  getBundleDiskPath,
  getView,
  listViews,
} from "./views-registry.ts";

export interface ViewsRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  url: URL;
  developerMode?: boolean;
  /** Broadcast an arbitrary payload to all connected WebSocket clients. */
  broadcastWs?: (payload: object) => void;
}

const PREFIX = "/api/views";

export async function handleViewsRoutes(
  ctx: ViewsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, url, json, error } = ctx;

  if (!pathname.startsWith(PREFIX)) return false;

  // ── GET /api/views/platform-info ─────────────────────────────────────────
  if (method === "GET" && pathname === `${PREFIX}/platform-info`) {
    const platform = detectClientPlatform(req);
    const dynamicLoadingAllowed = isDynamicLoadingAllowed(platform);
    json(res, {
      platform,
      dynamicLoadingAllowed,
      prebuiltOnly: !dynamicLoadingAllowed,
    });
    return true;
  }

  // ── GET /api/views ────────────────────────────────────────────────────────
  if (method === "GET" && (pathname === PREFIX || pathname === `${PREFIX}/`)) {
    const developerMode =
      ctx.developerMode ?? url.searchParams.get("developerMode") === "true";
    const platform = detectClientPlatform(req);
    const dynamicAllowed = isDynamicLoadingAllowed(platform);
    const allViews = listViews({ developerMode });
    // On restricted platforms (iOS/Android store builds), only surface views
    // without a dynamic bundle URL (already in-process).
    const views = dynamicAllowed
      ? allViews
      : allViews.filter((v) => !v.bundleUrl);
    json(res, { views });
    return true;
  }

  const afterPrefix = pathname.slice(PREFIX.length + 1); // strip /api/views/
  if (!afterPrefix) return false;

  const slashIndex = afterPrefix.indexOf("/");
  const rawId =
    slashIndex === -1 ? afterPrefix : afterPrefix.slice(0, slashIndex);
  const subResource =
    slashIndex === -1 ? "" : afterPrefix.slice(slashIndex + 1);

  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    error(res, "Malformed view id", 400);
    return true;
  }
  if (!id) return false;

  if (method === "GET" && subResource === "") {
    const entry = getView(id);
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }
    json(res, entry);
    return true;
  }

  // ── GET /api/views/:id/bundle.js ──────────────────────────────────────────
  if (method === "GET" && subResource === "bundle.js") {
    // Block dynamic bundle delivery on restricted platforms (iOS/Android store).
    const clientPlatform = detectClientPlatform(req);
    if (!isDynamicLoadingAllowed(clientPlatform)) {
      error(
        res,
        "Dynamic view bundle loading is not permitted on this platform.",
        403,
      );
      return true;
    }

    const entry = getView(id);
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }

    const bundlePath = getBundleDiskPath(entry);
    if (!bundlePath) {
      error(
        res,
        `View "${id}" has no bundle path configured. Build the plugin bundle first.`,
        404,
      );
      return true;
    }

    let data: Buffer;
    try {
      data = await fs.readFile(bundlePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        error(
          res,
          `Bundle not built for view "${id}". Run the plugin's build step to generate dist/views/bundle.js.`,
          404,
        );
      } else {
        logger.error(
          { src: "ViewsRoutes", viewId: id, bundlePath, err },
          `[ViewsRoutes] Failed to read bundle for view "${id}"`,
        );
        error(res, `Failed to read bundle for view "${id}"`, 500);
      }
      return true;
    }

    const raw = res as {
      writeHead?: (
        status: number,
        headers: Record<string, string | number>,
      ) => void;
      setHeader?: (name: string, value: string | number) => void;
      end?: (chunk?: unknown) => void;
    };

    if (typeof raw.writeHead === "function") {
      raw.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": data.byteLength,
        "Cache-Control": "no-cache",
      });
    } else if (typeof raw.setHeader === "function") {
      raw.setHeader("Content-Type", "application/javascript");
      raw.setHeader("Content-Length", data.byteLength);
      raw.setHeader("Cache-Control", "no-cache");
    }
    raw.end?.(data);
    return true;
  }

  // ── GET /api/views/:id/hero ───────────────────────────────────────────────
  if (method === "GET" && subResource === "hero") {
    const entry = getView(id);
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }

    const resolved = await findHeroOnDisk(entry);
    if (resolved) {
      let data: Buffer;
      try {
        data = await fs.readFile(resolved.absolutePath);
      } catch {
        // Fall through to generated placeholder.
        return sendGeneratedHero(res, entry.label, entry.icon);
      }
      return streamHeroImage(res, data, resolved.contentType);
    }

    // No image found — send an SVG placeholder.
    return sendGeneratedHero(res, entry.label, entry.icon);
  }

  // ── POST /api/views/:id/navigate ─────────────────────────────────────────
  // Broadcasts a shell:navigate:view WebSocket event to all connected clients.
  // The frontend's startup-phase-hydrate WS handler dispatches eliza:navigate:view
  // on window when it receives this message, which App.tsx handles.
  if (method === "POST" && subResource === "navigate") {
    const entry = getView(id);
    // Allow navigating to synthetic IDs (like __view-manager__) even when not
    // in the registry — they route to built-in shell tabs.
    const viewPath =
      entry?.path ?? (id === "__view-manager__" ? "/apps" : null);
    const viewLabel = entry?.label ?? id;

    logger.info(
      { src: "ViewsRoutes", viewId: id, viewPath },
      `[ViewsRoutes] Navigate to view "${id}"`,
    );

    ctx.broadcastWs?.({
      type: "shell:navigate:view",
      viewId: id,
      viewPath,
      viewLabel,
    });

    json(res, { ok: true, viewId: id, viewPath });
    return true;
  }

  // ── POST /api/views/:id/interact ──────────────────────────────────────────
  if (method === "POST" && subResource === "interact") {
    const entry = getView(id);
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }
    // Agent-view interaction is reserved for a future capability layer.
    error(res, `View interaction is not yet implemented for "${id}"`, 501);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function streamHeroImage(
  res: http.ServerResponse,
  data: Buffer,
  contentType: string,
): true {
  const raw = res as {
    writeHead?: (
      status: number,
      headers: Record<string, string | number>,
    ) => void;
    setHeader?: (name: string, value: string | number) => void;
    end?: (chunk?: unknown) => void;
  };
  if (typeof raw.writeHead === "function") {
    raw.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": data.byteLength,
      "Cache-Control": "public, max-age=300",
    });
  } else if (typeof raw.setHeader === "function") {
    raw.setHeader("Content-Type", contentType);
    raw.setHeader("Content-Length", data.byteLength);
    raw.setHeader("Cache-Control", "public, max-age=300");
  }
  raw.end?.(data);
  return true;
}

function sendGeneratedHero(
  res: http.ServerResponse,
  label: string,
  icon?: string,
): true {
  const svg = generateViewHeroSvg(label, icon);
  const data = Buffer.from(svg, "utf8");
  const raw = res as {
    writeHead?: (
      status: number,
      headers: Record<string, string | number>,
    ) => void;
    setHeader?: (name: string, value: string | number) => void;
    end?: (chunk?: unknown) => void;
  };
  if (typeof raw.writeHead === "function") {
    raw.writeHead(200, {
      "Content-Type": "image/svg+xml",
      "Content-Length": data.byteLength,
      "Cache-Control": "public, max-age=300",
    });
  } else if (typeof raw.setHeader === "function") {
    raw.setHeader("Content-Type", "image/svg+xml");
    raw.setHeader("Content-Length", data.byteLength);
    raw.setHeader("Cache-Control", "public, max-age=300");
  }
  raw.end?.(data);
  return true;
}
