/**
 * HTTP route handlers for the View Registry API.
 *
 * Mounted on the agent's HTTP server. Serves view metadata, compiled bundles,
 * and hero images contributed by plugins via `Plugin.views`.
 *
 * Routes:
 *   GET  /api/views                    — list all registered views (JSON)
 *   GET  /api/views/platform-info      — platform detection info (JSON)
 *   GET  /api/views/search?q=&limit=   — hybrid keyword+semantic ranked search (JSON)
 *   GET  /api/views/:id                — single view metadata (JSON)
 *   GET  /api/views/:id/bundle.js      — compiled view bundle (JS)
 *   GET  /api/views/:id/<asset>        — compiled bundle chunk/asset
 *   GET  /api/views/:id/hero           — hero image (image/*)
 *   POST /api/views/:id/navigate       — broadcast shell navigation event (JSON)
 *   POST /api/views/:id/elements       — report the view's addressable element snapshot
 *   POST /api/views/:id/interact       — agent-view interaction (capability dispatch)
 *   POST /api/views/interact-result    — frontend result callback (resolves pending interact)
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type http from "node:http";
import path from "node:path";

import {
  type IAgentRuntime,
  logger,
  type RouteRequestMeta,
  type ViewType,
} from "@elizaos/core";
import { type RouteHelpers, readJsonBody } from "@elizaos/shared";
import {
  type ActiveViewElement,
  clearActiveViewContext,
  setActiveViewContext,
  setActiveViewElements,
} from "../runtime/view-action-affinity.ts";
import {
  PendingRequestMap,
  type ViewInteractResult,
} from "./pending-request-map.ts";
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
import { viewSearchIndex } from "./views-search-index.ts";

function parseViewTypeParam(value: string | null): ViewType | undefined {
  return value === "gui" || value === "tui" || value === "xr"
    ? (value as ViewType)
    : undefined;
}

function parseViewTypeValue(value: unknown): ViewType | undefined {
  return value === "gui" || value === "tui" || value === "xr"
    ? (value as ViewType)
    : undefined;
}

/** Hard cap on accepted element reports to bound memory + prompt growth. */
const MAX_REPORTED_VIEW_ELEMENTS = 200;

/**
 * Validate + normalize an untrusted element-snapshot body into the strict
 * ActiveViewElement[] shape. Drops malformed entries (no string id) rather than
 * throwing — a partial snapshot is still useful to the planner.
 */
function normalizeActiveViewElements(raw: unknown): ActiveViewElement[] {
  if (!Array.isArray(raw)) return [];
  const out: ActiveViewElement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) continue;
    const el: ActiveViewElement = {
      id: r.id,
      role: typeof r.role === "string" && r.role.length > 0 ? r.role : "element",
      label: typeof r.label === "string" && r.label.length > 0 ? r.label : r.id,
    };
    if (typeof r.value === "string") el.value = r.value;
    if (r.focused === true) el.focused = true;
    out.push(el);
    if (out.length >= MAX_REPORTED_VIEW_ELEMENTS) break;
  }
  return out;
}

function contentTypeForViewAsset(assetPath: string): string {
  const ext = path.extname(assetPath).toLowerCase();
  switch (ext) {
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function convertNamedImportsToDestructuring(namedImports: string): string {
  return namedImports
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s+as\s+/u, ": "))
    .join(", ");
}

function buildHostExternalImportReplacement(
  importClause: string,
  specifier: string,
  index: number,
): string {
  const moduleVar = `__eliza_dynamic_view_host_external_${index}`;
  const lines = [
    `const ${moduleVar} = await globalThis.__ELIZA_DYNAMIC_VIEW_IMPORT__(${JSON.stringify(specifier)});`,
  ];
  const trimmed = importClause.trim();
  if (trimmed.startsWith("* as ")) {
    lines.push(`const ${trimmed.slice("* as ".length).trim()} = ${moduleVar};`);
    return lines.join("\n");
  }

  const namedMatch = trimmed.match(/^\{([\s\S]*)\}$/u);
  if (namedMatch) {
    lines.push(
      `const { ${convertNamedImportsToDestructuring(namedMatch[1])} } = ${moduleVar};`,
    );
    return lines.join("\n");
  }

  const defaultAndNamedMatch = trimmed.match(/^([^,]+),\s*\{([\s\S]*)\}$/u);
  if (defaultAndNamedMatch) {
    lines.push(
      `const ${defaultAndNamedMatch[1].trim()} = ${moduleVar}.default ?? ${moduleVar};`,
    );
    lines.push(
      `const { ${convertNamedImportsToDestructuring(defaultAndNamedMatch[2])} } = ${moduleVar};`,
    );
    return lines.join("\n");
  }

  lines.push(`const ${trimmed} = ${moduleVar}.default ?? ${moduleVar};`);
  return lines.join("\n");
}

function rewriteHostExternalImports(
  source: string,
  specifiers: readonly string[],
): string {
  if (specifiers.length === 0) return source;
  const specifierPattern = specifiers
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const fromImportPattern = new RegExp(
    `import\\s+([^;]*?)\\s+from\\s+["'](${specifierPattern})["'];?`,
    "gu",
  );
  const sideEffectPattern = new RegExp(
    `import\\s+["'](${specifierPattern})["'];?`,
    "gu",
  );
  let replacementIndex = 0;

  return source
    .replace(fromImportPattern, (_match, importClause, specifier) =>
      buildHostExternalImportReplacement(
        String(importClause),
        String(specifier),
        replacementIndex++,
      ),
    )
    .replace(
      sideEffectPattern,
      (_match, specifier) =>
        `await globalThis.__ELIZA_DYNAMIC_VIEW_IMPORT__(${JSON.stringify(String(specifier))});`,
    );
}

function parseHostExternalSpecifiers(url: URL): string[] {
  if (url.searchParams.get("hostExternalRuntime") !== "1") return [];
  return (url.searchParams.get("hostExternalSpecifiers") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Standard capabilities every view supports even without an `interact` export. */
const STANDARD_CAPABILITY_IDS = new Set([
  "get-state",
  "refresh",
  "focus-element",
  "get-text",
  "click-element",
  "fill-input",
]);

/** Module-level map of pending interact requests awaiting a frontend result. */
const pendingInteractRequests = new PendingRequestMap();

export interface CurrentViewState {
  viewId: string;
  viewPath: string | null;
  viewLabel: string;
  viewType: ViewType;
  action?: string;
  updatedAt: string;
}

let currentViewState: CurrentViewState | null = null;

export function getCurrentViewState(): CurrentViewState | null {
  return currentViewState;
}

export function clearCurrentViewState(): void {
  currentViewState = null;
  clearActiveViewContext();
}

/**
 * Resolve a pending interact request from a WS `view:interact:result` message.
 * Called by the WebSocket message handler in server.ts.
 */
export function resolveViewInteractResult(result: ViewInteractResult): void {
  pendingInteractRequests.resolve(result.requestId, result);
}

export interface ViewsRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  url: URL;
  developerMode?: boolean;
  /** Broadcast an arbitrary payload to all connected WebSocket clients. */
  broadcastWs?: (payload: object) => void;
  /** Agent runtime — used by the semantic search endpoint. */
  runtime?: IAgentRuntime | null;
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

  // ── GET /api/views/search?q=<query>&limit=<n> ─────────────────────────────
  // Hybrid keyword + semantic search over registered views.
  if (method === "GET" && pathname === `${PREFIX}/search`) {
    const query = url.searchParams.get("q") ?? "";
    const limitParam = url.searchParams.get("limit");
    const topK = limitParam
      ? Math.min(Math.max(parseInt(limitParam, 10) || 5, 1), 20)
      : 5;

    if (!query.trim()) {
      json(res, { results: [], query });
      return true;
    }

    const viewType = parseViewTypeParam(url.searchParams.get("viewType"));
    const allViews = listViews({
      developerMode: ctx.developerMode ?? false,
      viewType,
    });
    const q = query.trim().toLowerCase();

    // Keyword scoring (40% weight).
    const viewScoreKey = (entry: { id: string; viewType?: string }) =>
      `${entry.viewType ?? "gui"}:${entry.id}`;
    const keywordMap = new Map<string, number>();
    for (const v of allViews) {
      let score = 0;
      const label = v.label.toLowerCase();
      if (label === q) score = 100;
      else if (label.includes(q)) score = 80;
      else if ((v.tags ?? []).some((t) => t.toLowerCase() === q)) score = 60;
      else if ((v.description ?? "").toLowerCase().includes(q)) score = 40;
      keywordMap.set(viewScoreKey(v), score);
    }

    // Semantic scoring (60% weight) — falls back gracefully when unavailable.
    const semanticMap = new Map<string, number>();
    if (ctx.runtime) {
      try {
        const semResults = await viewSearchIndex.search(
          query,
          ctx.runtime,
          topK * 2,
        );
        for (const { viewId, viewType, score } of semResults) {
          // Cosine similarity in [−1, 1]; normalise to [0, 100].
          semanticMap.set(
            `${viewType ?? "gui"}:${viewId}`,
            ((score + 1) / 2) * 100,
          );
        }
      } catch (err) {
        logger.debug(
          { src: "ViewsRoutes", err },
          "[ViewsRoutes] Semantic search unavailable — using keyword only",
        );
      }
    }

    const combined = allViews.map((v) => {
      const key = viewScoreKey(v);
      const kw = keywordMap.get(key) ?? 0;
      const sem = semanticMap.get(key) ?? 0;
      return { view: v, score: kw * 0.4 + sem * 0.6 };
    });

    const results = combined
      .filter((r) => r.score > 5)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ view, score }) => ({ ...view, _score: Math.round(score) }));

    json(res, { results, query, semanticEnabled: ctx.runtime != null });
    return true;
  }

  // ── GET /api/views ────────────────────────────────────────────────────────
  if (method === "GET" && (pathname === PREFIX || pathname === `${PREFIX}/`)) {
    const developerMode =
      ctx.developerMode ?? url.searchParams.get("developerMode") === "true";
    const platform = detectClientPlatform(req);
    const dynamicAllowed = isDynamicLoadingAllowed(platform);
    const viewType = parseViewTypeParam(url.searchParams.get("viewType"));
    const allViews = listViews({ developerMode, viewType });
    // On restricted platforms (iOS/Android store builds), only surface views
    // without a dynamic bundle URL (already in-process).
    const filtered = dynamicAllowed
      ? allViews
      : allViews.filter((v) => !v.bundleUrl);
    // Annotate each entry with `builtin: true` when it comes from the shell.
    const views = filtered.map((v) => ({
      ...v,
      builtin: v.pluginName === "@elizaos/builtin",
    }));
    json(res, { views });
    return true;
  }

  // ── GET /api/views/current ───────────────────────────────────────────────
  if (method === "GET" && pathname === `${PREFIX}/current`) {
    json(res, { currentView: currentViewState });
    return true;
  }

  // ── POST /api/views/events/broadcast ─────────────────────────────────────
  // Pushes a view event to all connected frontend tabs via WebSocket.
  if (method === "POST" && pathname === `${PREFIX}/events/broadcast`) {
    if (typeof (req as { on?: unknown }).on !== "function") {
      error(res, "Missing JSON body for view event broadcast", 400);
      return true;
    }

    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) {
      return true;
    }
    const type = typeof body.type === "string" ? body.type : null;
    if (!type) {
      error(res, 'Missing required field "type"', 400);
      return true;
    }
    const payload =
      body.payload !== null &&
      typeof body.payload === "object" &&
      !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};

    ctx.broadcastWs?.({ type: "view:event", viewEventType: type, payload });

    logger.info(
      { src: "ViewsRoutes", viewEventType: type },
      `[ViewsRoutes] Broadcast view event "${type}"`,
    );

    json(res, { ok: true, type, payload });
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
    const viewType = parseViewTypeParam(url.searchParams.get("viewType"));
    const entry = getView(id, { viewType });
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }
    json(res, entry);
    return true;
  }

  // ── GET/HEAD /api/views/:id/bundle.js ─────────────────────────────────────
  if ((method === "GET" || method === "HEAD") && subResource === "bundle.js") {
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

    const viewType = parseViewTypeParam(url.searchParams.get("viewType"));
    const entry = getView(id, { viewType });
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

    // Stat the file first so we can compute an ETag and support 304 responses.
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(bundlePath);
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
          `[ViewsRoutes] Failed to stat bundle for view "${id}"`,
        );
        error(res, `Failed to read bundle for view "${id}"`, 500);
      }
      return true;
    }

    // ETag derived from mtime + size — fast to compute, no need to read the
    // full file, and stable across restarts for unchanged content.
    const etagRaw = `${stat.mtimeMs}-${stat.size}`;
    const etag = `"${createHash("sha256").update(etagRaw).digest("hex").slice(0, 16)}"`;
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch === etag) {
      const raw304 = res as {
        writeHead?: (status: number, headers: Record<string, string>) => void;
        end?: () => void;
      };
      if (typeof raw304.writeHead === "function") {
        raw304.writeHead(304, {});
      }
      raw304.end?.();
      return true;
    }

    const hostExternalSpecifiers = parseHostExternalSpecifiers(url);
    let data: Buffer;
    try {
      data =
        method === "HEAD" ? Buffer.alloc(0) : await fs.readFile(bundlePath);
    } catch (err) {
      logger.error(
        { src: "ViewsRoutes", viewId: id, bundlePath, err },
        `[ViewsRoutes] Failed to read bundle for view "${id}"`,
      );
      error(res, `Failed to read bundle for view "${id}"`, 500);
      return true;
    }

    // When the request carries a ?v= param that matches the entry's content
    // hash, the URL is fully versioned — serve with a year-long immutable cache.
    // Otherwise always revalidate via ETag so clients pick up updates promptly.
    const vParam = url.searchParams.get("v");
    const contentHashMatch = entry.bundleHash && vParam === entry.bundleHash;
    const cacheControl = contentHashMatch
      ? "public, max-age=31536000, immutable"
      : "no-cache";

    // SRI informational header — sha256 of the raw bundle bytes.
    const contentHash =
      method === "HEAD"
        ? null
        : createHash("sha256").update(data).digest("base64");

    if (hostExternalSpecifiers.length > 0 && method !== "HEAD") {
      data = Buffer.from(
        rewriteHostExternalImports(
          data.toString("utf8"),
          hostExternalSpecifiers,
        ),
        "utf8",
      );
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
        "Content-Type": "application/javascript; charset=utf-8",
        "Content-Length": data.byteLength,
        "Cache-Control":
          hostExternalSpecifiers.length > 0 ? "no-store" : cacheControl,
        ETag: etag,
        ...(contentHash ? { "X-Content-Hash": `sha256-${contentHash}` } : {}),
      });
    } else if (typeof raw.setHeader === "function") {
      raw.setHeader("Content-Type", "application/javascript; charset=utf-8");
      raw.setHeader("Content-Length", data.byteLength);
      raw.setHeader(
        "Cache-Control",
        hostExternalSpecifiers.length > 0 ? "no-store" : cacheControl,
      );
      raw.setHeader("ETag", etag);
      if (contentHash) {
        raw.setHeader("X-Content-Hash", `sha256-${contentHash}`);
      }
    }
    raw.end?.(method === "HEAD" ? undefined : data);
    return true;
  }

  // ── GET /api/views/:id/<asset> ───────────────────────────────────────────
  // Vite/Rollup view bundles can emit relative chunk imports such as
  // `./chunk-abc.js`. Browser module resolution turns those into
  // `/api/views/:id/chunk-abc.js`, so serve files beside the root bundle.
  if (
    (method === "GET" || method === "HEAD") &&
    subResource !== "" &&
    !["hero", "navigate", "interact"].includes(subResource)
  ) {
    const clientPlatform = detectClientPlatform(req);
    if (!isDynamicLoadingAllowed(clientPlatform)) {
      error(
        res,
        "Dynamic view asset loading is not permitted on this platform.",
        403,
      );
      return true;
    }

    const viewType = parseViewTypeParam(url.searchParams.get("viewType"));
    const entry = getView(id, { viewType });
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

    const bundleDir = path.dirname(bundlePath);
    const decodedSubResource = decodeURIComponent(subResource);
    const assetPath = path.resolve(bundleDir, decodedSubResource);
    const relative = path.relative(bundleDir, assetPath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative === ""
    ) {
      error(res, "Malformed view asset path", 400);
      return true;
    }

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(assetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        error(res, `View asset "${decodedSubResource}" not found`, 404);
      } else {
        logger.error(
          { src: "ViewsRoutes", viewId: id, assetPath, err },
          `[ViewsRoutes] Failed to stat asset "${decodedSubResource}" for view "${id}"`,
        );
        error(res, `Failed to read asset for view "${id}"`, 500);
      }
      return true;
    }

    if (!stat.isFile()) {
      error(res, `View asset "${decodedSubResource}" not found`, 404);
      return true;
    }

    const etagRaw = `${stat.mtimeMs}-${stat.size}`;
    const etag = `"${createHash("sha256").update(etagRaw).digest("hex").slice(0, 16)}"`;
    if (req.headers["if-none-match"] === etag) {
      const raw304 = res as {
        writeHead?: (status: number, headers: Record<string, string>) => void;
        end?: () => void;
      };
      raw304.writeHead?.(304, {});
      raw304.end?.();
      return true;
    }

    let data: Buffer;
    try {
      data = method === "HEAD" ? Buffer.alloc(0) : await fs.readFile(assetPath);
    } catch (err) {
      logger.error(
        { src: "ViewsRoutes", viewId: id, assetPath, err },
        `[ViewsRoutes] Failed to read asset "${decodedSubResource}" for view "${id}"`,
      );
      error(res, `Failed to read asset for view "${id}"`, 500);
      return true;
    }

    const raw = res as {
      writeHead?: (
        status: number,
        headers: Record<string, string | number>,
      ) => void;
      end?: (chunk?: unknown) => void;
    };
    raw.writeHead?.(200, {
      "Content-Type": contentTypeForViewAsset(assetPath),
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      ETag: etag,
    });
    raw.end?.(method === "HEAD" ? undefined : data);
    return true;
  }

  // ── GET /api/views/:id/hero ───────────────────────────────────────────────
  if (method === "GET" && subResource === "hero") {
    const viewType = parseViewTypeParam(url.searchParams.get("viewType"));
    const entry = getView(id, { viewType });
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }

    const resolved = await findHeroOnDisk(entry);
    if (resolved) {
      let stat: import("node:fs").Stats | null = null;
      let data: Buffer;
      try {
        [stat, data] = await Promise.all([
          fs.stat(resolved.absolutePath).catch(() => null),
          fs.readFile(resolved.absolutePath),
        ]);
      } catch {
        // Fall through to generated placeholder.
        return sendGeneratedHero(res, entry.label, entry.icon);
      }
      return streamHeroImage(res, data, resolved.contentType, req, stat);
    }

    // No image found — send an SVG placeholder.
    return sendGeneratedHero(res, entry.label, entry.icon);
  }

  // ── POST /api/views/:id/navigate ─────────────────────────────────────────
  // Broadcasts a shell:navigate:view WebSocket event to all connected clients.
  // The frontend's startup-phase-hydrate WS handler dispatches eliza:navigate:view
  // on window when it receives this message, which App.tsx handles.
  //
  // Optional body fields:
  //   action: "pin-tab"    — tells the shell to add to desktop tab bar
  //   action: "open-window" — tells the shell to open in a new Electrobun window
  //   path: string         — override the navigation path
  //   alwaysOnTop: boolean — for open-window, ask the shell to keep it above normal windows
  if (method === "POST" && subResource === "navigate") {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    const viewType =
      parseViewTypeValue(body?.viewType) ??
      parseViewTypeParam(url.searchParams.get("viewType"));
    const entry = getView(id, { viewType });
    // Allow navigating to synthetic IDs (like __view-manager__) even when not
    // in the registry — they route to built-in shell tabs.
    const viewPath =
      (typeof body?.path === "string" ? body.path : null) ??
      entry?.path ??
      (id === "__view-manager__" ? "/apps" : null);
    const viewLabel = entry?.label ?? id;
    const action = typeof body?.action === "string" ? body.action : undefined;
    const alwaysOnTop = body?.alwaysOnTop === true;

    logger.info(
      { src: "ViewsRoutes", viewId: id, viewPath, action },
      `[ViewsRoutes] Navigate to view "${id}"${action ? ` (action=${action})` : ""}`,
    );

    const resolvedViewType = entry?.viewType ?? viewType ?? "gui";
    currentViewState = {
      viewId: id,
      viewPath,
      viewLabel,
      viewType: resolvedViewType,
      ...(action ? { action } : {}),
      ...(alwaysOnTop ? { alwaysOnTop } : {}),
      updatedAt: new Date().toISOString(),
    };
    // Publish to the prompt-optimization layer so the planner upweights this
    // view's scoped actions while it is on screen.
    setActiveViewContext({
      viewId: id,
      viewLabel,
      viewType: resolvedViewType,
      viewPath,
    });

    ctx.broadcastWs?.({
      type: "shell:navigate:view",
      viewId: id,
      viewPath,
      viewLabel,
      viewType: resolvedViewType,
      ...(action ? { action } : {}),
      ...(alwaysOnTop ? { alwaysOnTop } : {}),
    });

    json(res, {
      ok: true,
      viewId: id,
      viewPath,
      viewType: resolvedViewType,
      ...(action ? { action } : {}),
      ...(alwaysOnTop ? { alwaysOnTop } : {}),
    });
    return true;
  }

  // ── POST /api/views/:id/elements ─────────────────────────────────────────
  // The shell's agent-surface registry reports this view's addressable element
  // snapshot (id/role/label/value/focused) so the planner's "# Active View"
  // block can list elements and act on them by id without a list-elements
  // round-trip. Gated server-side on `id` matching the active (navigated-to)
  // view via setActiveViewElements, so a background/stale surface can't
  // overwrite the foreground view's elements (accepted=false when it doesn't
  // match — the report is simply dropped).
  if (method === "POST" && subResource === "elements") {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    const elements = normalizeActiveViewElements(body?.elements);
    const accepted = setActiveViewElements(id, elements);
    json(res, { ok: true, viewId: id, accepted, count: elements.length });
    return true;
  }

  // ── POST /api/views/interact-result ──────────────────────────────────────
  // Called by the frontend over HTTP (or proxied from WS) when a view has
  // finished handling an interact request.  Resolves the pending promise so
  // the agent's interact handler can return the result.
  if (method === "POST" && id === "interact-result" && subResource === "") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true; // readJsonBody already sent the error response

    const requestId =
      typeof body.requestId === "string" ? body.requestId : null;
    if (!requestId) {
      error(res, "Missing requestId in interact-result body", 400);
      return true;
    }

    const result: ViewInteractResult = {
      requestId,
      success: body.success === true,
      result: body.result,
      error: typeof body.error === "string" ? body.error : undefined,
    };

    pendingInteractRequests.resolve(requestId, result);
    json(res, { ok: true });
    return true;
  }

  // ── POST /api/views/:id/interact ──────────────────────────────────────────
  if (method === "POST" && subResource === "interact") {
    if (typeof (req as { on?: unknown }).on !== "function") {
      error(res, "Missing JSON body for view interaction", 400);
      return true;
    }

    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const viewType =
      parseViewTypeValue(body.viewType) ??
      parseViewTypeParam(url.searchParams.get("viewType"));
    const entry = getView(id, { viewType });
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }

    const capability =
      typeof body.capability === "string" ? body.capability : null;
    if (!capability) {
      error(res, "Missing capability in interact body", 400);
      return true;
    }

    // Validate capability against the view's declared capabilities.
    // Standard capabilities are always accepted.
    if (
      entry.capabilities?.length &&
      !STANDARD_CAPABILITY_IDS.has(capability)
    ) {
      const declared = entry.capabilities.some((c) => c.id === capability);
      if (!declared) {
        error(
          res,
          `Capability "${capability}" is not declared for view "${id}"`,
          400,
        );
        return true;
      }
    }

    const params =
      body.params !== undefined &&
      body.params !== null &&
      typeof body.params === "object" &&
      !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : undefined;

    const timeoutMs =
      typeof body.timeoutMs === "number" && body.timeoutMs > 0
        ? body.timeoutMs
        : 5_000;

    const requestId = randomUUID();

    logger.info(
      { src: "ViewsRoutes", viewId: id, capability, requestId },
      `[ViewsRoutes] Interact with view "${id}" capability="${capability}"`,
    );

    // Register the pending slot before broadcasting — avoids a race where the
    // frontend responds before we start waiting.
    const resultPromise = pendingInteractRequests.waitFor(requestId, timeoutMs);

    ctx.broadcastWs?.({
      type: "view:interact",
      viewId: id,
      viewType: entry.viewType,
      capability,
      params,
      requestId,
    });

    try {
      const result = await resultPromise;
      json(res, result);
    } catch (err) {
      logger.warn(
        { src: "ViewsRoutes", viewId: id, requestId, err },
        `[ViewsRoutes] Interact timed out for view "${id}"`,
      );
      error(
        res,
        `View "${id}" did not respond to capability "${capability}" within ${timeoutMs}ms`,
        504,
      );
    }
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
  req: http.IncomingMessage,
  stat: import("node:fs").Stats | null,
): true {
  // Build an ETag from mtime + size when stat is available.
  const etag = stat
    ? `"${createHash("sha256").update(`${stat.mtimeMs}-${stat.size}`).digest("hex").slice(0, 16)}"`
    : undefined;

  if (etag && req.headers["if-none-match"] === etag) {
    const raw304 = res as {
      writeHead?: (status: number, headers: Record<string, string>) => void;
      end?: () => void;
    };
    if (typeof raw304.writeHead === "function") {
      raw304.writeHead(304, {});
    }
    raw304.end?.();
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
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Content-Length": data.byteLength,
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
  };
  if (etag) headers.ETag = etag;

  if (typeof raw.writeHead === "function") {
    raw.writeHead(200, headers);
  } else if (typeof raw.setHeader === "function") {
    for (const [k, v] of Object.entries(headers)) {
      raw.setHeader(k, v);
    }
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
