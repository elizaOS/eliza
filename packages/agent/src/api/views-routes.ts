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
 *   GET  /api/views/:id/frame.html     — sandboxed iframe document (HTML)
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
  EventType,
  type IAgentRuntime,
  logger,
  type RouteRequestMeta,
  type ViewType,
} from "@elizaos/core";
import {
  createShellNavigateViewWsFrame,
  type RouteHelpers,
  readJsonBody,
  type ShellNavigateViewPayload,
} from "@elizaos/shared";
import {
  AGENT_SURFACE_CAPABILITY_IDS,
  STANDARD_CAPABILITIES,
} from "@elizaos/shared/views/view-interact-protocol";
import {
  type ActiveViewElement,
  clearActiveViewContext,
  getActiveViewContext,
  setActiveViewContext,
  setActiveViewElements,
} from "../runtime/view-action-affinity.ts";
import {
  parseHostExternalSpecifiers,
  wrapBundleAsHostExternalFactory,
} from "./dynamic-view-host-external.mjs";
import {
  PendingRequestMap,
  type ViewInteractResult,
} from "./pending-request-map.ts";
import {
  detectClientPlatform,
  isDynamicLoadingAllowed,
} from "./platform-detect.ts";
import { normalizeWsClientId } from "./server-helpers-auth.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";
import {
  findHeroOnDisk,
  generateViewHeroSvg,
  getBundleDiskPath,
  getFrameDiskPath,
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
      role:
        typeof r.role === "string" && r.role.length > 0 ? r.role : "element",
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
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
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

/**
 * Capabilities accepted on any view without a matching declaration in
 * `entry.capabilities` — the protocol's standard caps (get-state / refresh /
 * focus-element / get-text / click-element / fill-input) plus the agent-surface
 * caps the shell registry handles generically (list-elements / agent-click /
 * agent-fill / …). Derived from the single canonical `@elizaos/shared`
 * view-interact protocol source so the route never drifts from what the frontend
 * actually dispatches. (#8798, #12408)
 */
const STANDARD_CAPABILITY_IDS: ReadonlySet<string> = new Set<string>([
  ...Object.values(STANDARD_CAPABILITIES),
  ...AGENT_SURFACE_CAPABILITY_IDS,
]);

const READ_ONLY_VIEW_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  STANDARD_CAPABILITIES.GET_STATE,
  STANDARD_CAPABILITIES.GET_TEXT,
  "list-elements",
  "describe-element",
  "get-focus",
  "get-agent-state",
]);

function isSurfaceBrokeredCapability(capability: string): boolean {
  return (
    STANDARD_CAPABILITY_IDS.has(capability) ||
    AGENT_SURFACE_CAPABILITY_IDS.has(capability)
  );
}

function isReadOnlyViewCapability(capability: string): boolean {
  return READ_ONLY_VIEW_CAPABILITIES.has(capability);
}

function viewManifestAllowsCapability(
  entry: ViewRegistryEntry,
  capability: string,
): boolean {
  if (!isSurfaceBrokeredCapability(capability)) return true;
  if (isReadOnlyViewCapability(capability)) return true;
  return entry.surface?.capabilities?.includes("agent-surface") === true;
}

function capabilityDeniedMessage(viewId: string, capability: string): string {
  return (
    `View "${viewId}" is not granted capability "${capability}" ` +
    "(its surface manifest does not grant `agent-surface`)"
  );
}

/** Module-level map of pending interact requests awaiting a frontend result. */
const pendingInteractRequests = new PendingRequestMap();

/**
 * Module-level WS broadcaster, wired once by server.ts at boot. Lets code that
 * runs outside an HTTP request — notably the view-scoped action handler, which
 * fires from the planner loop, not a `/interact` request — dispatch a
 * `view:interact` frame to mounted shells through the SAME path the route uses.
 * Null until wired (or in headless test/CI); dispatch degrades to a route-error
 * result rather than silently succeeding when it is unset.
 */
let moduleBroadcastWs: ((payload: object) => void) | null = null;

/** Wire the process WS broadcaster into the views module. Called once at boot. */
export function setViewsBroadcastWs(
  broadcast: ((payload: object) => void) | null,
): void {
  moduleBroadcastWs = broadcast;
}

/** The wired process WS broadcaster, or null when none is installed. */
export function getViewsBroadcastWs(): ((payload: object) => void) | null {
  return moduleBroadcastWs;
}

export interface CurrentViewState {
  viewId: string;
  viewPath: string | null;
  viewLabel: string;
  viewType: ViewType;
  action?: string;
  views?: string[];
  layout?: string;
  placement?: string;
  /**
   * Sub-section the view is focused on, when the view has addressable
   * sub-sections (Settings = its section id, e.g. "voice"). Carried so the
   * `current_view` provider can report the open subview and the agent can
   * deep-link one via the VIEWS action `subview` param.
   */
  subview?: string;
  /**
   * ISO timestamp of the navigate that *switched* into this view (distinct from
   * `updatedAt`, which also moves on same-view re-stamps). Read by the
   * `current_view` acknowledgement provider to know a switch *just happened*.
   */
  switchedAt?: string;
  /** Who initiated the switch: the agent (default) or the user clicking the UI. */
  source?: "agent" | "user";
  updatedAt: string;
}

/**
 * A view switch is treated as "just happened" for this long after navigate, so
 * the acknowledgement provider only references it on the turn(s) immediately
 * following the switch and never re-acknowledges a stale switch forever.
 */
export const VIEW_SWITCH_FRESH_MS = 15_000;

/** True when `state` reflects a switch within {@link VIEW_SWITCH_FRESH_MS}. */
export function isViewSwitchFresh(
  state: CurrentViewState | null,
  now: number = Date.now(),
): boolean {
  if (!state?.switchedAt) return false;
  const t = Date.parse(state.switchedAt);
  if (Number.isNaN(t)) return false;
  return now - t <= VIEW_SWITCH_FRESH_MS;
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
  /** Broadcast a payload only to WebSocket clients bound to one client id. */
  broadcastWsToClientId?: (clientId: string, payload: object) => number;
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
    const platform = detectClientPlatform(req);
    const dynamicAllowed = isDynamicLoadingAllowed(platform);
    const viewType = parseViewTypeParam(url.searchParams.get("viewType"));
    // Return every view (all four kinds) with its `viewKind` so the client can
    // apply the user's Settings toggles + build defaults itself. The server has
    // no way to know whether it is talking to a dev build or which kinds the
    // user enabled, so kind-gating is a client responsibility.
    const allViews = listViews({ includeAllKinds: true, viewType });
    // On restricted platforms (iOS/Android store builds), only surface views
    // without dynamic bundle/frame URLs (already in-process).
    const filtered = dynamicAllowed
      ? allViews
      : allViews.filter((v) => !v.bundleUrl && !v.frameUrl);
    // Annotate each entry with `builtin: true` when it comes from the shell.
    const views = filtered.map((v) => ({
      ...v,
      builtin: v.pluginName === "@elizaos/builtin",
    }));
    json(res, { views });
    return true;
  }

  // ── GET /api/views/current ───────────────────────────────────────────────
  // `justSwitched` is a turn-scoped signal (distinct from the always-present
  // current view): true only briefly after a navigate so the `current_view`
  // provider can phrase the just-happened switch as an acknowledgement.
  if (method === "GET" && pathname === `${PREFIX}/current`) {
    json(res, {
      currentView: currentViewState,
      justSwitched: isViewSwitchFresh(currentViewState),
    });
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
        wrapBundleAsHostExternalFactory(
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

  // ── GET/HEAD /api/views/:id/frame.html ───────────────────────────────────
  if ((method === "GET" || method === "HEAD") && subResource === "frame.html") {
    const clientPlatform = detectClientPlatform(req);
    if (!isDynamicLoadingAllowed(clientPlatform)) {
      error(
        res,
        "Dynamic view frame loading is not permitted on this platform.",
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

    const framePath = getFrameDiskPath(entry);
    if (!framePath) {
      error(
        res,
        `View "${id}" has no frame path configured. Build or declare the sandboxed frame document first.`,
        404,
      );
      return true;
    }

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(framePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        error(
          res,
          `Frame document not built for view "${id}". Build the plugin frame document first.`,
          404,
        );
      } else {
        logger.error(
          { src: "ViewsRoutes", viewId: id, framePath, err },
          `[ViewsRoutes] Failed to stat frame document for view "${id}"`,
        );
        error(res, `Failed to read frame document for view "${id}"`, 500);
      }
      return true;
    }

    if (!stat.isFile()) {
      error(res, `Frame document not built for view "${id}".`, 404);
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
      data = method === "HEAD" ? Buffer.alloc(0) : await fs.readFile(framePath);
    } catch (err) {
      logger.error(
        { src: "ViewsRoutes", viewId: id, framePath, err },
        `[ViewsRoutes] Failed to read frame document for view "${id}"`,
      );
      error(res, `Failed to read frame document for view "${id}"`, 500);
      return true;
    }

    const vParam = url.searchParams.get("v");
    const contentHashMatch = entry.frameHash && vParam === entry.frameHash;
    const cacheControl = contentHashMatch
      ? "public, max-age=31536000, immutable"
      : "no-cache";
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
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": stat.size,
        "Cache-Control": cacheControl,
        "X-Content-Type-Options": "nosniff",
        ETag: etag,
      });
    } else if (typeof raw.setHeader === "function") {
      raw.setHeader("Content-Type", "text/html; charset=utf-8");
      raw.setHeader("Content-Length", stat.size);
      raw.setHeader("Cache-Control", cacheControl);
      raw.setHeader("X-Content-Type-Options", "nosniff");
      raw.setHeader("ETag", etag);
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
    !["hero", "navigate", "interact", "elements", "activate"].includes(
      subResource,
    )
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
        // Fall through to generated fallback image.
        return sendGeneratedHero(res, entry.label, entry.icon);
      }
      return streamHeroImage(res, data, resolved.contentType, req, stat);
    }

    // No image found — send a generated SVG fallback.
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
  //   action: "close"      — tells the shell to close/hide the target view
  //   action: "close-all"  — tells the shell to close/hide all open views
  //   action: "split-view" — asks the shell to split multiple views
  //   action: "tile-views" — asks the shell to tile multiple views
  //   views: string[]      — view ids participating in split/tile actions
  //   layout: string       — split/tile layout hint: horizontal, vertical, grid
  //   placement: string    — optional split placement hint: left/right/top/bottom
  //   path: string         — override the navigation path
  //   alwaysOnTop: boolean — for open-window, ask the shell to keep it above normal windows
  //   payload: unknown     — opaque deep-link state consumed by the target view
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
    // `source` distinguishes an agent-initiated switch (the default) from a user
    // manually clicking a tab/tile/slash-command, which the client *reports* with
    // `source: "user"`. A user-reported switch must NOT re-broadcast
    // the shell navigation WS event (the client already navigated locally) — that would
    // echo back and re-navigate. It still records state + emits VIEW_SWITCHED.
    const reportedSource = body?.source === "user" ? "user" : "agent";
    const subview =
      typeof body?.subview === "string" && body.subview.trim().length > 0
        ? body.subview.trim()
        : typeof body?.section === "string" && body.section.trim().length > 0
          ? body.section.trim()
          : undefined;
    const alwaysOnTop = body?.alwaysOnTop === true;
    const layoutViews = Array.isArray(body?.views)
      ? body.views.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : undefined;
    const layout =
      typeof body?.layout === "string" && body.layout.trim().length > 0
        ? body.layout.trim()
        : undefined;
    const placement =
      typeof body?.placement === "string" && body.placement.trim().length > 0
        ? body.placement.trim()
        : undefined;
    const payload =
      body && Object.hasOwn(body, "payload") ? body.payload : undefined;
    const layoutPayload = {
      ...(layoutViews && layoutViews.length > 0 ? { views: layoutViews } : {}),
      ...(layout ? { layout } : {}),
      ...(placement ? { placement } : {}),
    };
    const deepLinkPayload = payload !== undefined ? { payload } : {};

    logger.info(
      { src: "ViewsRoutes", viewId: id, viewPath, action, subview },
      `[ViewsRoutes] Navigate to view "${id}"${action ? ` (action=${action})` : ""}${subview ? ` (subview=${subview})` : ""}`,
    );

    const resolvedViewType = entry?.viewType ?? viewType ?? "gui";
    // Closing a view must NOT stamp it (or the synthetic "__all__" close-all id)
    // as the active view: that left the planner upweighting a dismissed view's
    // scoped actions and made "what view am I on" report a closed view forever.
    // Clear the active-view context on close instead; the next real navigation
    // re-stamps it.
    const isCloseNavigation = action === "close" || action === "close-all";
    if (isCloseNavigation) {
      clearCurrentViewState();
    } else {
      const now = new Date().toISOString();
      const source = reportedSource;
      // Stamp `switchedAt` only when the view actually changes; a re-navigate to
      // the same view should not re-trigger an acknowledgement.
      const previousViewId = currentViewState?.viewId ?? null;
      const viewChanged = previousViewId !== id;
      const switchedAt = viewChanged
        ? now
        : (currentViewState?.switchedAt ?? now);
      currentViewState = {
        viewId: id,
        viewPath,
        viewLabel,
        viewType: resolvedViewType,
        ...(action ? { action } : {}),
        ...(subview ? { subview } : {}),
        ...(alwaysOnTop ? { alwaysOnTop } : {}),
        ...layoutPayload,
        switchedAt,
        source,
        updatedAt: now,
      };
      // Publish to the prompt-optimization layer so the planner upweights this
      // view's scoped actions while it is on screen.
      setActiveViewContext({
        viewId: id,
        viewLabel,
        viewType: resolvedViewType,
        viewPath,
        // Carry freshness so Stage-1 can acknowledge a just-happened switch (#8788).
        ...(switchedAt ? { switchedAt } : {}),
        ...(source ? { source } : {}),
      });
      // Emit the first-class VIEW_SWITCHED interaction event (#8792) so a
      // proactive decider can comment. Only on a real change (no spam on
      // re-navigates), and fire-and-forget so it never blocks the response.
      if (viewChanged && ctx.runtime) {
        void ctx.runtime
          .emitEvent(EventType.VIEW_SWITCHED, {
            runtime: ctx.runtime,
            source: `view-navigate:${source}`,
            viewId: id,
            viewLabel,
            viewPath,
            viewType: resolvedViewType,
            previousViewId,
            initiatedBy: source,
            // Resolve the view's declared anticipatory intent + purpose so the
            // proactive judge can produce a scoped greeting (#13587). Absent for
            // intent-less/developer views → judge falls back to label-only.
            ...(entry?.anticipatoryIntent
              ? { anticipatoryIntent: entry.anticipatoryIntent }
              : {}),
            ...(entry?.description ? { viewPurpose: entry.description } : {}),
          })
          .catch((err) => {
            logger.debug(
              { src: "ViewsRoutes", err },
              "[ViewsRoutes] VIEW_SWITCHED emit failed",
            );
          });
      }
    }

    // Skip the echo for user-reported switches (the client already navigated).
    if (reportedSource !== "user") {
      const navigatePayload: ShellNavigateViewPayload = {
        viewId: id,
        viewPath,
        viewLabel,
        viewType: resolvedViewType,
        ...(action ? { action } : {}),
        ...(subview ? { subview } : {}),
        ...(alwaysOnTop ? { alwaysOnTop } : {}),
        ...layoutPayload,
        ...deepLinkPayload,
      };
      ctx.broadcastWs?.(createShellNavigateViewWsFrame(navigatePayload));
    }

    json(res, {
      ok: true,
      viewId: id,
      viewPath,
      viewType: resolvedViewType,
      ...(action ? { action } : {}),
      ...(subview ? { subview } : {}),
      ...(alwaysOnTop ? { alwaysOnTop } : {}),
      ...layoutPayload,
      ...deepLinkPayload,
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
    const clientId = resolveViewInteractClientId(req, body);
    const accepted = setActiveViewElements(id, elements, clientId);
    json(res, { ok: true, viewId: id, accepted, count: elements.length });
    return true;
  }

  // ── POST /api/views/:id/activate ─────────────────────────────────────────
  // Activate one addressable control in a view by its element id (for spatial
  // views, the focused button's agent id). This is the adapter path for
  // "a focused view button was pressed" -> agent dispatch.
  //
  // Contract:
  //   body: { elementId: string }
  //   - The element is resolved against the active-view element snapshot
  //     (reported via POST /:id/elements) for observability/context — absent
  //     when no snapshot was reported, which is fine.
  //   - The activation is dispatched as the STANDARD `click-element` capability
  //     through the exact same interact path as POST /:id/interact (a
  //     `serverInteract` handler when present, else a frontend round-trip),
  //     reusing the established CLICK_ELEMENT semantics rather than inventing a
  //     new dispatch.
  //   response: { ok, viewId, elementId, element?, dispatch: <interact result> }
  if (method === "POST" && subResource === "activate") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const elementId =
      typeof body.elementId === "string" && body.elementId.length > 0
        ? body.elementId
        : null;
    if (!elementId) {
      error(res, "Missing elementId in activate body", 400);
      return true;
    }

    const viewType =
      parseViewTypeValue(body.viewType) ??
      parseViewTypeParam(url.searchParams.get("viewType"));
    const entry = getView(id, { viewType });
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }

    // Resolve the element from the active-view snapshot for context (the planner
    // reports it via /:id/elements). Only used when this view is the foreground
    // active view; absent otherwise — the click still dispatches by id.
    const active = getActiveViewContext();
    const element =
      active?.viewId === id
        ? active.elements?.find((el) => el.id === elementId)
        : undefined;

    const capability = STANDARD_CAPABILITIES.CLICK_ELEMENT;
    const params: Record<string, unknown> = { elementId, id: elementId };

    logger.info(
      { src: "ViewsRoutes", viewId: id, elementId, capability },
      `[ViewsRoutes] Activate element "${elementId}" on view "${id}"`,
    );

    const dispatch = await dispatchViewInteract(entry, id, capability, params, {
      broadcastWs: ctx.broadcastWs,
      broadcastWsToClientId: ctx.broadcastWsToClientId,
      clientId: resolveTargetViewClientId(id, req, body),
    });

    json(res, {
      ok: dispatch.success,
      viewId: id,
      elementId,
      ...(element ? { element } : {}),
      dispatch,
    });
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

    if (!viewManifestAllowsCapability(entry, capability)) {
      error(res, capabilityDeniedMessage(id, capability), 403);
      return true;
    }

    if (typeof entry.serverInteract === "function") {
      try {
        const result = await entry.serverInteract(capability, params);
        ctx.broadcastWs?.({
          type: "view:event",
          viewEventType: `view:${id}:updated`,
          payload: { viewId: id, capability },
        });
        json(res, {
          requestId,
          success: resultSuccess(result),
          result,
        });
      } catch (err) {
        logger.warn(
          { src: "ViewsRoutes", viewId: id, capability, requestId, err },
          `[ViewsRoutes] Server interaction failed for view "${id}"`,
        );
        json(res, {
          requestId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          result: {
            success: false,
            text: `Cannot invoke capability "${capability}" on view "${id}": ${
              err instanceof Error ? err.message : String(err)
            }.`,
          },
        });
      }
      return true;
    }

    // Register the pending slot before broadcasting — avoids a race where the
    // frontend responds before we start waiting.
    const targetClientId = resolveTargetViewClientId(id, req, body);
    const frame = {
      type: "view:interact",
      viewId: id,
      viewType: entry.viewType,
      capability,
      params,
      requestId,
    };

    if (!targetClientId) {
      json(res, {
        requestId,
        success: false,
        error:
          "Missing client id for frontend view interaction. Provide X-ElizaOS-Client-Id or clientId.",
      });
      return true;
    }

    if (typeof ctx.broadcastWsToClientId !== "function") {
      json(res, {
        requestId,
        success: false,
        error: "Targeted view interaction delivery is unavailable.",
      });
      return true;
    }

    // Register the pending slot before sending — avoids a race where the
    // frontend responds before we start waiting.
    const resultPromise = pendingInteractRequests.waitFor(requestId, timeoutMs);
    const delivered = ctx.broadcastWsToClientId(targetClientId, frame);
    if (delivered <= 0) {
      pendingInteractRequests.resolve(requestId, {
        requestId,
        success: false,
        error: `No connected view client "${targetClientId}" is available for "${id}".`,
      });
    }

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

/**
 * Result of dispatching a capability to a view — the union of the two interact
 * paths (a `serverInteract` handler, or a frontend `view:interact` round-trip).
 */
export interface ViewInteractDispatchResult {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface ViewInteractTransport {
  broadcastWs?: (payload: object) => void;
  broadcastWsToClientId?: (clientId: string, payload: object) => number;
  clientId?: string | null;
}

/**
 * Dispatch a capability to a view, reusing the established interact semantics:
 * a `serverInteract` handler when the view declares one, else a frontend
 * `view:interact` WebSocket round-trip resolved via the pending-request map.
 * Shared by POST /:id/activate (CLICK_ELEMENT) and the view-scoped action
 * handler (view-scoped-actions.ts) so neither re-implements the dispatch.
 */
export async function dispatchViewInteract(
  entry: ViewRegistryEntry,
  viewId: string,
  capability: string,
  params: Record<string, unknown>,
  transport: ViewInteractTransport,
  timeoutMs = 5_000,
): Promise<ViewInteractDispatchResult> {
  const requestId = randomUUID();

  if (!viewManifestAllowsCapability(entry, capability)) {
    return {
      requestId,
      success: false,
      error: capabilityDeniedMessage(viewId, capability),
    };
  }

  if (typeof entry.serverInteract === "function") {
    try {
      const result = await entry.serverInteract(capability, params);
      transport.broadcastWs?.({
        type: "view:event",
        viewEventType: `view:${viewId}:updated`,
        payload: { viewId, capability },
      });
      return { requestId, success: resultSuccess(result), result };
    } catch (err) {
      logger.warn(
        { src: "ViewsRoutes", viewId, capability, requestId, err },
        `[ViewsRoutes] Server interaction failed for view "${viewId}"`,
      );
      return {
        requestId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!transport.clientId) {
    return {
      requestId,
      success: false,
      error:
        "Missing client id for frontend view interaction. Provide X-ElizaOS-Client-Id or clientId.",
    };
  }
  if (typeof transport.broadcastWsToClientId !== "function") {
    return {
      requestId,
      success: false,
      error: "Targeted view interaction delivery is unavailable.",
    };
  }

  const resultPromise = pendingInteractRequests.waitFor(requestId, timeoutMs);
  const delivered = transport.broadcastWsToClientId(transport.clientId, {
    type: "view:interact",
    viewId,
    viewType: entry.viewType,
    capability,
    params,
    requestId,
  });
  if (delivered <= 0) {
    pendingInteractRequests.resolve(requestId, {
      requestId,
      success: false,
      error: `No connected view client "${transport.clientId}" is available for "${viewId}".`,
    });
  }
  try {
    const result = (await resultPromise) as ViewInteractResult;
    return {
      requestId,
      success: result.success,
      result: result.result,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (err) {
    logger.warn(
      { src: "ViewsRoutes", viewId, capability, requestId, err },
      `[ViewsRoutes] Interact timed out for view "${viewId}"`,
    );
    return {
      requestId,
      success: false,
      error: `View "${viewId}" did not respond to capability "${capability}" within ${timeoutMs}ms`,
    };
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function resolveViewInteractClientId(
  req: Pick<http.IncomingMessage, "headers">,
  body: Record<string, unknown> | null | undefined,
): string | null {
  return (
    normalizeWsClientId(firstHeaderValue(req.headers["x-elizaos-client-id"])) ??
    normalizeWsClientId(firstHeaderValue(req.headers["x-eliza-client-id"])) ??
    normalizeWsClientId(body?.clientId)
  );
}

function resolveTargetViewClientId(
  viewId: string,
  req: Pick<http.IncomingMessage, "headers">,
  body: Record<string, unknown> | null | undefined,
): string | null {
  const explicit = resolveViewInteractClientId(req, body);
  const active = getActiveViewContext();
  const mountedOwner =
    active?.viewId === viewId ? (active.clientId ?? null) : null;
  if (!mountedOwner) return explicit;
  return !explicit || explicit === mountedOwner ? mountedOwner : null;
}

function resultSuccess(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return true;
  }
  const success = (result as Record<string, unknown>).success;
  return typeof success === "boolean" ? success : true;
}

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
