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
 *   GET/HEAD /api/views/:id/installations/:lease/:type/:kind/:file — published view assets
 *   GET  /api/views/:id/hero           — hero image (image/*)
 *   POST /api/views/:id/navigate       — deliver a shell navigation event (JSON)
 *   POST /api/views/:id/elements       — report the view's addressable element snapshot
 *   POST /api/views/:id/interact       — agent-view interaction (capability dispatch)
 *   POST /api/views/interact-result    — frontend result callback (resolves pending interact)
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type http from "node:http";

import {
  ElizaError,
  EventType,
  type IAgentRuntime,
  logger,
  type RoleGateRole,
  satisfiesRoleGate,
  type ViewType,
} from "@elizaos/core";
import {
  createShellNavigateViewWsFrame,
  normalizeCompletedActionHandoffId,
  parseClampedInteger,
  type RouteHelpers,
  readJsonBody,
  type ShellNavigateViewPayload,
} from "@elizaos/shared";
import type { RouteRequestMeta } from "@elizaos/shared/api/route-helpers";
import {
  AGENT_SURFACE_CAPABILITY_IDS,
  STANDARD_CAPABILITIES,
} from "@elizaos/shared/views/view-interact-protocol";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import {
  type ActiveViewElement,
  clearActiveViewContext,
  getActiveViewContext,
  setActiveViewContext,
  setActiveViewElements,
} from "../runtime/view-action-affinity.ts";
import {
  createViewClientStore,
  getViewClientScope,
  type ViewClientScope,
} from "../runtime/view-client-context.ts";
import type { ViewInteractResult } from "./pending-request-map.ts";
import {
  detectClientPlatform,
  isDynamicLoadingAllowed,
} from "./platform-detect.ts";
import { normalizeWsClientId } from "./server-helpers-auth.ts";
import { handleViewAssetRequest } from "./view-asset-routes.ts";
import { assertRuntimeViewEntry } from "./view-installations.ts";
import {
  type RendererViewInteractResult,
  viewInteractionHost,
} from "./view-interaction-host.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";
import {
  findHeroOnDisk,
  generateViewHeroSvg,
  getView,
  listViews,
} from "./views-registry.ts";
import { getViewSearchIndex } from "./views-search-index.ts";

const VIEW_TYPE_ERROR = "viewType must be one of: gui, tui, xr";

/**
 * Parse the view-catalog `viewType` query. Omitted/empty keeps the historical
 * GUI default (`listViews` / `getView` treat undefined as gui). A known
 * modality selects that catalog. Any other token used to fall through to that
 * same GUI catalog, so `viewType=GUI` or `viewType=web` silently served GUI
 * views.
 */
export function parseViewTypeParam(
  value: string | null,
):
  | { ok: true; viewType: ViewType | undefined }
  | { ok: false; message: string } {
  if (value === null || value === "") return { ok: true, viewType: undefined };
  if (value === "gui" || value === "tui" || value === "xr") {
    return { ok: true, viewType: value };
  }
  return { ok: false, message: VIEW_TYPE_ERROR };
}

export function parseViewTypeValue(
  value: unknown,
):
  | { ok: true; viewType: ViewType | undefined }
  | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, viewType: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, message: VIEW_TYPE_ERROR };
  }
  return parseViewTypeParam(value);
}

function resolveViewTypeQuery(
  raw: string | null,
  res: http.ServerResponse,
  error: ViewsRouteContext["error"],
): { reject: true } | { viewType: ViewType | undefined } {
  const parsed = parseViewTypeParam(raw);
  if (!parsed.ok) {
    error(res, parsed.message, 400);
    return { reject: true };
  }
  return { viewType: parsed.viewType };
}

function resolveViewTypePair(
  bodyValue: unknown,
  queryRaw: string | null,
  res: http.ServerResponse,
  error: ViewsRouteContext["error"],
): { reject: true } | { viewType: ViewType | undefined } {
  const fromBody = parseViewTypeValue(bodyValue);
  if (!fromBody.ok) {
    error(res, fromBody.message, 400);
    return { reject: true };
  }
  const fromQuery = parseViewTypeParam(queryRaw);
  if (!fromQuery.ok) {
    error(res, fromQuery.message, 400);
    return { reject: true };
  }
  return { viewType: fromBody.viewType ?? fromQuery.viewType };
}

function normalizedViewPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const withoutQuery = value.trim().split(/[?#]/, 1)[0];
  if (!withoutQuery) return null;
  const rooted = withoutQuery.startsWith("/")
    ? withoutQuery
    : `/${withoutQuery}`;
  return rooted.length > 1 && rooted.endsWith("/")
    ? rooted.slice(0, -1)
    : rooted;
}

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
    if (typeof r.visible === "boolean") el.visible = r.visible;
    out.push(el);
  }
  return out;
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

function viewManifestAllowsAgentAuthority(
  entry: ViewRegistryEntry,
  capability: string,
): boolean {
  return (
    entry.capabilities?.find((declared) => declared.id === capability)
      ?.authority !== "human"
  );
}

function capabilityAuthorityDeniedMessage(
  viewId: string,
  capability: string,
): string {
  return `Capability "${capability}" on view "${viewId}" requires direct human interaction`;
}

function capabilityDeniedMessage(viewId: string, capability: string): string {
  return (
    `View "${viewId}" is not granted capability "${capability}" ` +
    "(its surface manifest does not grant `agent-surface`)"
  );
}

export {
  getViewsBroadcastWs,
  getViewsBroadcastWsToClientId,
  setViewsBroadcastWs,
} from "./view-interaction-host.ts";

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

const currentViews = createViewClientStore<CurrentViewState>();

export function getCurrentViewState(
  runtime: IAgentRuntime,
  scope: ViewClientScope | undefined = getViewClientScope(),
): CurrentViewState | null {
  return currentViews.get(runtime, scope);
}

export function clearCurrentViewState(
  runtime: IAgentRuntime,
  scope: ViewClientScope | undefined = getViewClientScope(),
): void {
  currentViews.delete(runtime, scope);
  clearActiveViewContext(runtime, scope);
}
function clientScope(
  hostKey: object,
  clientId: string | null,
): ViewClientScope | undefined {
  return clientId ? { hostKey, clientId } : undefined;
}

/**
 * Resolve a pending interact request from a WS `view:interact:result` message.
 * Called by the WebSocket message handler in server.ts.
 */
export function resolveViewInteractResult(
  runtime: IAgentRuntime,
  hostKey: object,
  clientId: string,
  result: RendererViewInteractResult,
): void {
  viewInteractionHost(runtime, hostKey).resolve(clientId, result);
}

export interface ViewsRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  url: URL;
  hostKey: object;
  developerMode?: boolean;
  /** Broadcast an arbitrary payload to all connected WebSocket clients. */
  broadcastWs?: (payload: object) => void;
  /** Broadcast a payload only to WebSocket clients bound to one client id. */
  broadcastWsToClientId?: (clientId: string, payload: object) => number;
  /** Agent runtime — used by the semantic search endpoint. */
  runtime?: IAgentRuntime | null;
  callerAuthorization?: AgentHttpRequestAuthorization;
}

function callerRoles(ctx: ViewsRouteContext): RoleGateRole[] {
  return ctx.callerAuthorization?.ok ? [ctx.callerAuthorization.role] : [];
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

  if (!ctx.runtime) {
    error(res, "View operations require an active runtime", 503);
    return true;
  }
  const viewRuntime = ctx.runtime;
  let currentViewState = getCurrentViewState(
    viewRuntime,
    clientScope(ctx.hostKey, resolveViewInteractClientId(req, undefined)),
  );

  // ── GET /api/views/search?q=<query>&limit=<n> ─────────────────────────────
  // Hybrid keyword + semantic search over registered views.
  if (method === "GET" && pathname === `${PREFIX}/search`) {
    const query = url.searchParams.get("q") ?? "";
    const limitParam = url.searchParams.get("limit");
    const topK = parseClampedInteger(limitParam, {
      min: 1,
      max: 20,
      fallback: 5,
    });

    const parsedSearchViewType = resolveViewTypeQuery(
      url.searchParams.get("viewType"),
      res,
      error,
    );
    if ("reject" in parsedSearchViewType) return true;

    if (!query.trim()) {
      json(res, { results: [], query });
      return true;
    }

    const viewType = parsedSearchViewType.viewType;
    const allViews = listViews(viewRuntime, {
      developerMode: ctx.developerMode ?? false,
      viewType,
    }).filter((view) => satisfiesRoleGate(callerRoles(ctx), view.roleGate));
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
        const semResults = await getViewSearchIndex(viewRuntime).search(
          query,
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
      .sort((a, b) => {
        const bScore =
          typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
        const aScore =
          typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
        return (
          bScore - aScore ||
          String(a.view.id ?? "").localeCompare(String(b.view.id ?? ""))
        );
      })
      .slice(0, topK)
      .map(({ view, score }) => ({ ...view, _score: Math.round(score) }));

    json(res, { results, query, semanticEnabled: semanticMap.size > 0 });
    return true;
  }

  // ── GET /api/views ────────────────────────────────────────────────────────
  if (method === "GET" && (pathname === PREFIX || pathname === `${PREFIX}/`)) {
    const platform = detectClientPlatform(req);
    const dynamicAllowed = isDynamicLoadingAllowed(platform);
    const parsedListViewType = resolveViewTypeQuery(
      url.searchParams.get("viewType"),
      res,
      error,
    );
    if ("reject" in parsedListViewType) return true;
    const viewType = parsedListViewType.viewType;
    // Return every view (all four kinds) with its `viewKind` so the client can
    // apply the user's Settings toggles + build defaults itself. The server has
    // no way to know whether it is talking to a dev build or which kinds the
    // user enabled, so kind-gating is a client responsibility.
    const allViews = listViews(viewRuntime, {
      includeAllKinds: true,
      viewType,
    }).filter((view) => satisfiesRoleGate(callerRoles(ctx), view.roleGate));
    // Native renderers need installation metadata for their signed counterpart.
    // Withhold executable URLs; the bundle/frame/asset routes still reject loading.
    const filtered = dynamicAllowed
      ? allViews
      : allViews.map((view) =>
          view.bundleUrl || view.frameUrl
            ? {
                ...view,
                bundleUrl: undefined,
                frameUrl: undefined,
                bundleUrlVersioned: undefined,
                frameUrlVersioned: undefined,
                available: false,
                metadataOnly: true,
              }
            : view,
        );
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
    const parsedDetailViewType = resolveViewTypeQuery(
      url.searchParams.get("viewType"),
      res,
      error,
    );
    if ("reject" in parsedDetailViewType) return true;
    const viewType = parsedDetailViewType.viewType;
    const entry = getView(viewRuntime, id, { viewType });
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }
    if (!satisfiesRoleGate(callerRoles(ctx), entry.roleGate)) {
      error(res, `View "${id}" is not available to this caller`, 403);
      return true;
    }
    json(res, entry);
    return true;
  }

  if (
    (method === "GET" || method === "HEAD") &&
    subResource !== "" &&
    !["hero", "navigate", "interact", "elements", "activate"].includes(
      subResource,
    )
  ) {
    return handleViewAssetRequest(ctx, viewRuntime, id, subResource, (entry) =>
      satisfiesRoleGate(callerRoles(ctx), entry.roleGate),
    );
  }

  // ── GET /api/views/:id/hero ───────────────────────────────────────────────
  if (method === "GET" && subResource === "hero") {
    const parsedHeroViewType = resolveViewTypeQuery(
      url.searchParams.get("viewType"),
      res,
      error,
    );
    if ("reject" in parsedHeroViewType) return true;
    const viewType = parsedHeroViewType.viewType;
    const entry = getView(viewRuntime, id, { viewType });
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }

    if (!satisfiesRoleGate(callerRoles(ctx), entry.roleGate)) {
      error(res, "Insufficient role for this view", 403);
      return true;
    }
    const resolved = await findHeroOnDisk(entry);
    let data: Buffer | null = null;
    if (resolved) {
      try {
        data = await fs.readFile(resolved.absolutePath);
      } catch (cause) {
        // error-policy:J4 A decorative file removed after lookup uses the designed generated fallback.
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    // Both disk and generated images belong to the selected installation.
    // Recheck after I/O before returning bytes or a conditional 304 response.
    try {
      assertRuntimeViewEntry(viewRuntime, entry);
    } catch (cause) {
      // error-policy:J1 Return a typed installation failure at the HTTP boundary.
      if (!(cause instanceof ElizaError)) throw cause;
      error(res, "View installation changed; reload the catalog", 409);
      return true;
    }
    if (!satisfiesRoleGate(callerRoles(ctx), entry.roleGate)) {
      error(res, "Insufficient role for this view", 403);
      return true;
    }
    return data && resolved
      ? streamHeroImage(res, data, resolved.contentType, req)
      : sendGeneratedHero(res, entry.label, entry.icon);
  }

  // ── POST /api/views/:id/navigate ─────────────────────────────────────────
  // Broadcasts a shell:navigate:view WebSocket event to connected clients unless
  // the caller owns a narrower delivery channel. Realtime voice returns the
  // validated VIEWS result through its originating WebSocket session; normal app
  // chat keeps the completed stream action result as its fallback and may also
  // best-effort target the live originating renderer. A global echo from either
  // path would navigate unrelated browsers and devices.
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
  //   delivery: "originating-client" — realtime caller navigates its own client
  //   delivery: "completed-action" — app chat navigates from its stream result
  //   completedActionHandoffId: string — renderer-observed transport dedupe key
  if (method === "POST" && subResource === "navigate") {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    const parsedNavigateViewType = resolveViewTypePair(
      body?.viewType,
      url.searchParams.get("viewType"),
      res,
      error,
    );
    if ("reject" in parsedNavigateViewType) return true;
    const viewType = parsedNavigateViewType.viewType;
    const entry = getView(viewRuntime, id, { viewType });
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
    const callerOwnedDelivery =
      body?.delivery === "originating-client" ||
      body?.delivery === "completed-action";
    const originatingClientId = resolveViewInteractClientId(req, body);
    const scope = clientScope(ctx.hostKey, originatingClientId);
    currentViewState = getCurrentViewState(viewRuntime, scope);
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
    // Caller-owned delivery is private renderer state. Recording it in the
    // process-global current-view/provider context would leak one client's
    // deep link to other clients and leave ghost state when its socket is stale.
    // The targeted frame or completed action is the only commit edge for it.
    const commitCurrentViewState = (committedViewPath: string | null) => {
      if (isCloseNavigation) {
        clearCurrentViewState(viewRuntime, scope);
        return;
      }
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
        viewPath: committedViewPath,
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
      currentViews.set(viewRuntime, currentViewState, scope);
      // Publish to the prompt-optimization layer so the planner upweights this
      // view's scoped actions while it is on screen.
      setActiveViewContext(
        viewRuntime,
        {
          hostKey: ctx.hostKey,
          viewId: id,
          viewLabel,
          viewType: resolvedViewType,
          installationId: entry?.installationId,
          viewPath: committedViewPath,
          // Carry freshness so Stage-1 can acknowledge a just-happened switch (#8788).
          ...(switchedAt ? { switchedAt } : {}),
          ...(source ? { source } : {}),
          ...(originatingClientId ? { clientId: originatingClientId } : {}),
        },
        scope,
      );
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
            viewPath: committedViewPath,
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
    };
    const committedViewPath = callerOwnedDelivery
      ? (entry?.path ?? null)
      : viewPath;
    // completed-action has a caller-scoped terminal fallback, so sanitized
    // canonical state can commit immediately. Voice/originating-client has no
    // fallback and commits only after its targeted renderer accepts delivery.
    if (body?.delivery !== "originating-client") {
      commitCurrentViewState(committedViewPath);
    }

    // A voice turn may need to interact with this view before its terminal
    // control-channel handoff. When its renderer is known, deliver through the
    // existing targeted channel now. Never broadcast caller-owned navigation.
    // App chat normally has the completed action as a reliable fallback, but when
    // its originating renderer still has a live WebSocket, deliver there now:
    // the navigate frame is emitted before the action callback can claim
    // "Opened …". Supporting renderers deduplicate this frame against the
    // caller-scoped terminal handoff by id after one path is actually handled.
    const shouldTargetCompletedAction =
      body?.delivery === "completed-action" && Boolean(originatingClientId);
    const completedActionHandoffId = shouldTargetCompletedAction
      ? normalizeCompletedActionHandoffId(body?.completedActionHandoffId)
      : undefined;
    let completedActionDelivered = false;
    let originatingClientDelivered = false;
    if (
      reportedSource !== "user" &&
      (!callerOwnedDelivery ||
        shouldTargetCompletedAction ||
        (body?.delivery === "originating-client" &&
          Boolean(originatingClientId)))
    ) {
      const navigatePayload: ShellNavigateViewPayload = {
        viewId: id,
        viewPath,
        viewLabel,
        viewType: resolvedViewType,
        source: reportedSource,
        ...(action ? { action } : {}),
        ...(subview ? { subview } : {}),
        ...(alwaysOnTop ? { alwaysOnTop } : {}),
        ...layoutPayload,
        ...deepLinkPayload,
        ...(completedActionHandoffId ? { completedActionHandoffId } : {}),
      };
      const frame = createShellNavigateViewWsFrame(navigatePayload);
      if (originatingClientId) {
        let delivered: number | undefined;
        if (shouldTargetCompletedAction) {
          try {
            delivered = ctx.broadcastWsToClientId?.(originatingClientId, frame);
          } catch (err) {
            // error-policy:J4 the terminal completed-action result remains the
            // visible, caller-scoped navigation fallback when this optional
            // early WebSocket optimization fails unexpectedly.
            logger.warn(
              { src: "ViewsRoutes", err, viewId: id },
              "[ViewsRoutes] Early completed-action navigation delivery failed",
            );
          }
        } else {
          delivered = ctx.broadcastWsToClientId?.(originatingClientId, frame);
        }
        completedActionDelivered =
          shouldTargetCompletedAction &&
          typeof delivered === "number" &&
          delivered > 0;
        if (
          !shouldTargetCompletedAction &&
          (delivered === undefined || delivered <= 0)
        ) {
          error(
            res,
            `No connected view client "${originatingClientId}" is available for "${id}".`,
            409,
          );
          return true;
        }
        originatingClientDelivered =
          !shouldTargetCompletedAction &&
          typeof delivered === "number" &&
          delivered > 0;
      } else {
        ctx.broadcastWs?.(frame);
      }
    }

    if (body?.delivery === "originating-client" && originatingClientDelivered) {
      commitCurrentViewState(committedViewPath);
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
      ...(shouldTargetCompletedAction ? { completedActionDelivered } : {}),
      ...(completedActionHandoffId ? { completedActionHandoffId } : {}),
    });
    return true;
  }

  // ── POST /api/views/:id/elements ─────────────────────────────────────────
  // The shell's agent-surface registry reports this view's addressable element
  // snapshot (id/role/label/value/focused) so the planner's "# Active View"
  // block can list elements and act on them by id without a list-elements
  // round-trip. A normal report is gated on `id` matching the active view. If
  // the backend restarted and therefore owns no view state, a report may
  // restore it only when the browser's current path matches the registered
  // path; retained/background views cannot claim the foreground this way.
  if (method === "POST" && subResource === "elements") {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    if (!body) return true;
    const parsedElementsViewType = resolveViewTypePair(
      body.viewType,
      url.searchParams.get("viewType"),
      res,
      error,
    );
    if ("reject" in parsedElementsViewType) return true;
    const entry = getView(viewRuntime, id, {
      viewType: parsedElementsViewType.viewType,
    });
    const clientId = resolveViewInteractClientId(req, body);
    if (
      !clientId ||
      !entry ||
      entry.viewType !== (parsedElementsViewType.viewType ?? "gui") ||
      body.installationId !== entry.installationId ||
      !satisfiesRoleGate(callerRoles(ctx), entry.roleGate)
    ) {
      error(
        res,
        "Element report does not belong to the current view installation",
        409,
      );
      return true;
    }
    const elements = normalizeActiveViewElements(body.elements);
    const scope = clientScope(ctx.hostKey, clientId);
    currentViewState = getCurrentViewState(viewRuntime, scope);
    let accepted = setActiveViewElements(viewRuntime, entry, elements, scope);
    if (
      !accepted &&
      currentViewState === null &&
      getActiveViewContext(viewRuntime, scope) === null
    ) {
      const reportedPath = normalizedViewPath(body?.viewPath);
      const registeredPath = normalizedViewPath(entry?.path);
      if (entry && reportedPath && reportedPath === registeredPath) {
        const now = new Date().toISOString();
        currentViewState = {
          viewId: id,
          viewPath: entry.path ?? null,
          viewLabel: entry.label,
          viewType: entry.viewType,
          updatedAt: now,
        };
        currentViews.set(viewRuntime, currentViewState, scope);
        setActiveViewContext(
          viewRuntime,
          {
            hostKey: ctx.hostKey,
            viewId: id,
            viewPath: entry.path ?? null,
            viewLabel: entry.label,
            viewType: entry.viewType,
            installationId: entry.installationId,
            elements,
            ...(clientId ? { clientId } : {}),
          },
          scope,
        );
        accepted = true;
      }
    }
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

    const parsedActivateViewType = resolveViewTypePair(
      body.viewType,
      url.searchParams.get("viewType"),
      res,
      error,
    );
    if ("reject" in parsedActivateViewType) return true;
    const viewType = parsedActivateViewType.viewType;
    const entry = getView(viewRuntime, id, { viewType });
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }
    const boundaryRoles = callerRoles(ctx);
    if (!satisfiesRoleGate(boundaryRoles, entry.roleGate)) {
      error(res, `View "${id}" is not available to this caller`, 403);
      return true;
    }

    // Resolve the element from the active-view snapshot for context (the planner
    // reports it via /:id/elements). Only used when this view is the foreground
    // active view; absent otherwise — the click still dispatches by id.
    const active = getActiveViewContext(
      viewRuntime,
      clientScope(ctx.hostKey, resolveViewInteractClientId(req, body)),
    );
    const element =
      active?.viewId === id &&
      active.viewType === entry.viewType &&
      active.installationId === entry.installationId
        ? active.elements?.find((el) => el.id === elementId)
        : undefined;

    const capability = STANDARD_CAPABILITIES.CLICK_ELEMENT;
    const params: Record<string, unknown> = { elementId, id: elementId };

    logger.info(
      { src: "ViewsRoutes", viewId: id, elementId, capability },
      `[ViewsRoutes] Activate element "${elementId}" on view "${id}"`,
    );

    const dispatch = await dispatchViewInteract(entry, id, capability, params, {
      hostKey: ctx.hostKey,
      broadcastWs: ctx.broadcastWs,
      broadcastWsToClientId: ctx.broadcastWsToClientId,
      clientId: resolveTargetViewClientId(
        viewRuntime,
        ctx.hostKey,
        id,
        req,
        body,
      ),
      runtime: viewRuntime,
      userRoles: boundaryRoles,
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

  // Execution is claimed at the owning host before any renderer effect.
  if (method === "POST" && id === "interact-claim" && subResource === "") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    const clientId = resolveViewInteractClientId(req, body);
    if (
      !clientId ||
      typeof body.requestId !== "string" ||
      typeof body.viewId !== "string" ||
      typeof body.viewType !== "string" ||
      typeof body.installationId !== "string"
    ) {
      error(res, "Missing view interaction binding", 400);
      return true;
    }
    const claimId = viewInteractionHost(viewRuntime, ctx.hostKey).claim(
      clientId,
      {
        requestId: body.requestId,
        viewId: body.viewId,
        viewType: body.viewType,
        installationId: body.installationId,
      },
      callerRoles(ctx),
    );
    if (!claimId) {
      error(
        res,
        "View interaction is no longer available to this renderer",
        409,
      );
      return true;
    }
    json(res, { claimId });
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

    const result: RendererViewInteractResult = {
      requestId,
      viewId: typeof body.viewId === "string" ? body.viewId : undefined,
      viewType: typeof body.viewType === "string" ? body.viewType : undefined,
      installationId:
        typeof body.installationId === "string"
          ? body.installationId
          : undefined,
      claimId: typeof body.claimId === "string" ? body.claimId : undefined,
      success: body.success === true,
      result: body.result,
      error: typeof body.error === "string" ? body.error : undefined,
    };

    const clientId = resolveViewInteractClientId(req, body);
    if (!clientId) {
      error(res, "Missing client id for view interaction result", 400);
      return true;
    }
    viewInteractionHost(viewRuntime, ctx.hostKey).resolve(clientId, result);
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

    const parsedInteractViewType = resolveViewTypePair(
      body.viewType,
      url.searchParams.get("viewType"),
      res,
      error,
    );
    if ("reject" in parsedInteractViewType) return true;
    const viewType = parsedInteractViewType.viewType;
    const entry = getView(viewRuntime, id, { viewType });
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }
    if (!satisfiesRoleGate(callerRoles(ctx), entry.roleGate)) {
      error(res, `View "${id}" is not available to this caller`, 403);
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

    logger.info(
      { src: "ViewsRoutes", viewId: id, capability },
      `[ViewsRoutes] Interact with view "${id}" capability="${capability}"`,
    );

    if (!viewManifestAllowsCapability(entry, capability)) {
      error(res, capabilityDeniedMessage(id, capability), 403);
      return true;
    }
    if (!viewManifestAllowsAgentAuthority(entry, capability)) {
      error(res, capabilityAuthorityDeniedMessage(id, capability), 403);
      return true;
    }

    const targetClientId = resolveTargetViewClientId(
      viewRuntime,
      ctx.hostKey,
      id,
      req,
      body,
    );
    const dispatch = await dispatchViewInteract(
      entry,
      id,
      capability,
      params,
      {
        hostKey: ctx.hostKey,
        broadcastWs: ctx.broadcastWs,
        broadcastWsToClientId: ctx.broadcastWsToClientId,
        clientId: targetClientId,
        runtime: viewRuntime,
        userRoles: callerRoles(ctx),
      },
      timeoutMs,
    );
    if (!dispatch.success && dispatch.failureKind === "timeout") {
      error(
        res,
        `View "${id}" did not respond to capability "${capability}" within ${timeoutMs}ms`,
        504,
      );
    } else {
      json(res, dispatch);
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
  failureKind?: "timeout" | "revoked" | "unavailable" | "unknown";
}

const VIEW_INTERACTION_FAILURE_CODES: Readonly<
  Record<string, NonNullable<ViewInteractDispatchResult["failureKind"]>>
> = {
  PENDING_REQUEST_TIMEOUT: "timeout",
  VIEW_HOST_CLOSED: "unavailable",
  VIEW_INSTALLATION_INVALID: "revoked",
  VIEW_REGISTRY_CLOSED: "revoked",
};
function interactionFailureKind(
  error: unknown,
): NonNullable<ViewInteractDispatchResult["failureKind"]> {
  return error instanceof ElizaError
    ? (VIEW_INTERACTION_FAILURE_CODES[error.code] ?? "unknown")
    : "unknown";
}

interface ViewInteractTransport {
  hostKey?: object;
  broadcastWs?: (payload: object) => void;
  broadcastWsToClientId?: (clientId: string, payload: object) => number;
  clientId?: string | null;
  runtime: IAgentRuntime;
  userRoles?: readonly RoleGateRole[];
}

/**
 * Dispatch a capability to a view, reusing the established interact semantics.
 * Standard and agent-surface capabilities prefer a mounted caller-targeted
 * frontend because those controls live in the rendered DOM. Nonstandard
 * declared capabilities prefer `serverInteract`. A mixed view falls back to
 * `serverInteract` when no targeted client is mounted, preserving headless
 * callers without sending mutating controls to every connected shell.
 * Shared by POST /:id/activate (CLICK_ELEMENT) and the view-scoped action
 * handler (view-scoped-actions.ts) so neither re-implements the dispatch.
 */
export async function dispatchViewInteract(
  entry: ViewRegistryEntry,
  viewId: string,
  capability: string,
  params: Record<string, unknown> | undefined,
  transport: ViewInteractTransport,
  timeoutMs = 5_000,
): Promise<ViewInteractDispatchResult> {
  const requestId = randomUUID();
  assertRuntimeViewEntry(transport.runtime, entry);
  if (transport.hostKey)
    viewInteractionHost(transport.runtime, transport.hostKey);

  if (!satisfiesRoleGate(transport.userRoles, entry.roleGate)) {
    return {
      requestId,
      success: false,
      error: `View "${viewId}" is not available to this caller`,
    };
  }

  if (!viewManifestAllowsCapability(entry, capability)) {
    return {
      requestId,
      success: false,
      error: capabilityDeniedMessage(viewId, capability),
    };
  }

  if (!viewManifestAllowsAgentAuthority(entry, capability)) {
    return {
      requestId,
      success: false,
      error: capabilityAuthorityDeniedMessage(viewId, capability),
    };
  }

  const hasServerInteract = typeof entry.serverInteract === "function";
  const preferFrontend =
    !hasServerInteract || isSurfaceBrokeredCapability(capability);
  if (
    preferFrontend &&
    transport.clientId &&
    typeof transport.broadcastWsToClientId === "function"
  ) {
    if (!transport.hostKey)
      throw new Error("Mounted view dispatch requires an owning HTTP host");
    const host = viewInteractionHost(transport.runtime, transport.hostKey);
    const resultPromise = host.waitFor(
      requestId,
      transport.clientId,
      entry,
      timeoutMs,
    );
    const frame = {
      type: "view:interact",
      installationId: entry.installationId,
      viewId,
      viewType: entry.viewType,
      capability,
      params,
      requestId,
    };
    let delivered = 0;
    try {
      delivered = transport.broadcastWsToClientId(transport.clientId, frame);
      if (!Number.isSafeInteger(delivered) || delivered < 0)
        throw new Error("Invalid delivery count");
    } catch (err) {
      // error-policy:J4 delivery may have happened before the transport threw;
      // report an unknown outcome and never replay through the server handler.
      logger.warn(
        { src: "ViewsRoutes", viewId, capability, requestId, err },
        `[ViewsRoutes] Targeted interaction delivery failed for view "${viewId}"`,
      );
      host.cancel(
        requestId,
        new ElizaError("Renderer delivery outcome is unknown", {
          code: "VIEW_DELIVERY_UNKNOWN",
        }),
      );
      // error-policy:J4 consume this locally canceled waiter after reporting its cause.
      await resultPromise.catch(() => undefined);
      return {
        requestId,
        success: false,
        failureKind: "unknown",
        error:
          "Renderer delivery outcome is unknown; do not replay the operation.",
      };
    }
    if (delivered > 0) {
      try {
        const result = (await resultPromise) as ViewInteractResult;
        assertRuntimeViewEntry(transport.runtime, entry);
        return {
          requestId,
          success: result.success,
          result: result.result,
          ...(result.error ? { error: result.error } : {}),
        };
      } catch (err) {
        logger.warn(
          { src: "ViewsRoutes", viewId, capability, requestId, err },
          `[ViewsRoutes] Interaction outcome unavailable for view "${viewId}"`,
        );
        return {
          requestId,
          success: false,
          error:
            err instanceof Error
              ? err.message
              : "View interaction outcome is unknown",
          failureKind: interactionFailureKind(err),
        };
      }
    }

    const unavailable = `No connected view client "${transport.clientId}" is available for "${viewId}".`;
    host.cancel(
      requestId,
      new ElizaError(unavailable, { code: "VIEW_CLIENT_UNAVAILABLE" }),
    );
    // error-policy:J4 zero delivery is proven; retire the unclaimed waiter before fallback.
    await resultPromise.catch(() => undefined);
    if (!hasServerInteract)
      return { requestId, success: false, error: unavailable };
  }

  if (typeof entry.serverInteract === "function") {
    let invoked = false;
    try {
      assertRuntimeViewEntry(transport.runtime, entry);
      if (transport.hostKey)
        viewInteractionHost(transport.runtime, transport.hostKey);
      invoked = true;
      const result = await entry.serverInteract(capability, params, {
        runtime: transport.runtime,
      });
      assertRuntimeViewEntry(transport.runtime, entry);
      if (transport.hostKey)
        viewInteractionHost(transport.runtime, transport.hostKey);
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
        failureKind: invoked ? "unknown" : interactionFailureKind(err),
        error: err instanceof Error ? err.message : String(err),
        result: {
          success: false,
          text: `${invoked ? "Unknown outcome for" : "Cannot invoke"} capability "${capability}" on view "${viewId}": ${
            err instanceof Error ? err.message : String(err)
          }.`,
        },
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
  return {
    requestId,
    success: false,
    error: "Targeted view interaction delivery is unavailable.",
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function resolveViewInteractClientId(
  req: Pick<http.IncomingMessage, "headers">,
  body: Record<string, unknown> | null | undefined,
): string | null {
  const headers = req.headers ?? {};
  return (
    normalizeWsClientId(firstHeaderValue(headers["x-elizaos-client-id"])) ??
    normalizeWsClientId(firstHeaderValue(headers["x-eliza-client-id"])) ??
    normalizeWsClientId(body?.clientId)
  );
}

function resolveTargetViewClientId(
  runtime: IAgentRuntime,
  hostKey: object,
  viewId: string,
  req: Pick<http.IncomingMessage, "headers">,
  body: Record<string, unknown> | null | undefined,
): string | null {
  const explicit = resolveViewInteractClientId(req, body);
  const active = getActiveViewContext(runtime, clientScope(hostKey, explicit));
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
): true {
  const etag = `"${createHash("sha256").update(data).digest("hex")}"`;

  if (etag && req.headers["if-none-match"] === etag) {
    const raw304 = res as {
      writeHead?: (status: number, headers: Record<string, string>) => void;
      end?: () => void;
    };
    if (typeof raw304.writeHead === "function") {
      raw304.writeHead(304, {
        ETag: etag,
        "Cache-Control": "private, no-cache",
      });
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
    "Cache-Control": "private, no-cache",
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
      "Cache-Control": "private, no-cache",
    });
  } else if (typeof raw.setHeader === "function") {
    raw.setHeader("Content-Type", "image/svg+xml");
    raw.setHeader("Content-Length", data.byteLength);
    raw.setHeader("Cache-Control", "private, no-cache");
  }
  raw.end?.(data);
  return true;
}
