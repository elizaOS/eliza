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
  type ActiveViewPane,
  clearActiveViewContext,
  getActiveViewContext,
  resolveVisiblePane,
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
import {
  acknowledgeViewOperation,
  appendViewOperation,
  createViewNavigationOutboxState,
  hasRetainedViewOperations,
  listPendingViewOperations,
  MAX_PENDING_VIEW_OPERATIONS,
  MAX_VIEW_OPERATION_BYTES,
  prepareViewOperation,
  type ViewNavigationOutboxState,
} from "./view-navigation-outbox.ts";
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

const VIEW_TYPES: readonly ViewType[] = ["gui", "xr", "tui"];
const VIEW_OPERATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const OUTBOX_VIEW_ACTIONS = new Set([
  "pin-tab",
  "open-window",
  "close",
  "close-all",
  "split-view",
  "tile-views",
]);

function parseViewOperationId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const operationId = value.trim();
  return VIEW_OPERATION_ID_RE.test(operationId) ? operationId : null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function serializeViewOperation(payload: ShellNavigateViewPayload): {
  fingerprint: string;
  serializedBytes: number;
} {
  const serialized = canonicalJson(payload);
  return {
    fingerprint: createHash("sha256").update(serialized).digest("hex"),
    serializedBytes: Buffer.byteLength(serialized, "utf8"),
  };
}

function hasExactView(viewId: string, viewType: ViewType): boolean {
  return getView(viewId, { viewType })?.viewType === viewType;
}

function getExactRequestedView(
  viewId: string,
  viewType: ViewType | undefined,
): ViewRegistryEntry | undefined {
  const entry = getView(viewId, { viewType });
  return viewType === undefined || entry?.viewType === viewType
    ? entry
    : undefined;
}

interface RequestedLayoutPane {
  viewId: string;
  viewType: ViewType;
}

function parseRequestedLayoutPanes(
  value: unknown,
): RequestedLayoutPane[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    return null;
  }
  const panes: RequestedLayoutPane[] = [];
  const identities = new Set<string>();
  for (const valuePane of value) {
    if (
      !valuePane ||
      typeof valuePane !== "object" ||
      Array.isArray(valuePane)
    ) {
      return null;
    }
    const rawPane = valuePane as Record<string, unknown>;
    const viewId =
      typeof rawPane.viewId === "string" ? rawPane.viewId.trim() : "";
    const viewType = parseViewTypeValue(rawPane.viewType);
    if (!viewId || !viewType || !hasExactView(viewId, viewType)) return null;
    const identity = `${viewType}:${viewId}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    panes.push({ viewId, viewType });
  }
  return panes;
}

/** Resolve a split/tile layout to exact modality-qualified pane identities. */
function resolveLayoutPanes(
  primaryViewId: string,
  primaryViewType: ViewType,
  viewIds: readonly string[],
  rawViewTypes: unknown,
  requestedPanes: readonly RequestedLayoutPane[] | undefined,
  clientId: string | null,
): ActiveViewPane[] {
  if (requestedPanes) {
    const primaryIdentity = `${primaryViewType}:${primaryViewId}`;
    const hasPrimary = requestedPanes.some(
      (pane) => `${pane.viewType}:${pane.viewId}` === primaryIdentity,
    );
    if (!hasPrimary) return [];
    return requestedPanes.map((pane) => ({
      ...pane,
      ...(clientId ? { clientId } : {}),
    }));
  }
  const hintedTypes =
    rawViewTypes &&
    typeof rawViewTypes === "object" &&
    !Array.isArray(rawViewTypes)
      ? (rawViewTypes as Record<string, unknown>)
      : {};
  const panes: ActiveViewPane[] = [];

  for (const viewId of viewIds) {
    let resolvedType: ViewType | undefined;
    if (viewId === primaryViewId) {
      resolvedType = primaryViewType;
    } else {
      const hinted = parseViewTypeValue(hintedTypes[viewId]);
      if (hinted && hasExactView(viewId, hinted)) {
        resolvedType = hinted;
      } else if (!hinted) {
        const declaredTypes = VIEW_TYPES.filter((candidate) =>
          hasExactView(viewId, candidate),
        );
        if (declaredTypes.length === 1) resolvedType = declaredTypes[0];
      }
    }
    if (!resolvedType) continue;
    panes.push({
      viewId,
      viewType: resolvedType,
      ...(clientId ? { clientId } : {}),
    });
  }
  return panes;
}

/** Hard cap on accepted element reports to bound memory + prompt growth. */
const MAX_REPORTED_VIEW_ELEMENTS = 200;
const MAX_REPORTED_ELEMENT_ID_LENGTH = 128;
const MAX_REPORTED_ELEMENT_ROLE_LENGTH = 64;
const MAX_REPORTED_ELEMENT_LABEL_LENGTH = 256;
const MAX_REPORTED_ELEMENT_VALUE_LENGTH = 1_024;

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
    if (typeof r.id !== "string") continue;
    const id = r.id.trim();
    if (id.length === 0 || id.length > MAX_REPORTED_ELEMENT_ID_LENGTH) continue;
    const role =
      typeof r.role === "string" && r.role.trim().length > 0
        ? r.role.trim().slice(0, MAX_REPORTED_ELEMENT_ROLE_LENGTH)
        : "element";
    const label =
      typeof r.label === "string" && r.label.trim().length > 0
        ? r.label.trim().slice(0, MAX_REPORTED_ELEMENT_LABEL_LENGTH)
        : id;
    const el: ActiveViewElement = {
      id,
      role,
      label,
    };
    if (typeof r.value === "string") {
      el.value = r.value.slice(0, MAX_REPORTED_ELEMENT_VALUE_LENGTH);
    }
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
let moduleBroadcastWsToClientId:
  | ((clientId: string, payload: object) => number)
  | null = null;

/** Wire the process WS broadcaster into the views module. Called once at boot. */
export function setViewsBroadcastWs(
  broadcast: ((payload: object) => void) | null,
  broadcastToClientId?: ((clientId: string, payload: object) => number) | null,
): void {
  moduleBroadcastWs = broadcast;
  moduleBroadcastWsToClientId = broadcastToClientId ?? null;
}

/** The wired process WS broadcaster, or null when none is installed. */
export function getViewsBroadcastWs(): ((payload: object) => void) | null {
  return moduleBroadcastWs;
}

/** The wired targeted broadcaster, or null when none is installed. */
export function getViewsBroadcastWsToClientId():
  | ((clientId: string, payload: object) => number)
  | null {
  return moduleBroadcastWsToClientId;
}

export interface CurrentViewState {
  viewId: string;
  viewPath: string | null;
  viewLabel: string;
  viewType: ViewType;
  action?: string;
  views?: string[];
  /** Typed pane identities retained for unambiguous routing and reconnects. */
  panes?: Array<Pick<ActiveViewPane, "viewId" | "viewType">>;
  layout?: string;
  placement?: string;
  alwaysOnTop?: boolean;
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

function sameViewPanes(
  left: CurrentViewState["panes"],
  right: CurrentViewState["panes"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (pane, index) =>
        pane.viewId === right[index]?.viewId &&
        pane.viewType === right[index]?.viewType,
    )
  );
}

/** Compare the shell destination fields that a reconnect must restore. */
function sameViewDestination(
  previous: CurrentViewState | null,
  next: Omit<CurrentViewState, "switchedAt" | "source" | "updatedAt">,
): boolean {
  return (
    previous?.viewId === next.viewId &&
    previous.viewType === next.viewType &&
    previous.viewPath === next.viewPath &&
    previous.action === next.action &&
    previous.subview === next.subview &&
    previous.layout === next.layout &&
    previous.placement === next.placement &&
    previous.alwaysOnTop === next.alwaysOnTop &&
    sameViewPanes(previous.panes, next.panes)
  );
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

const DEFAULT_VIEW_STATE_SCOPE = "__default__";
export const VIEW_SCOPE_IDLE_TTL_MS = 30 * 60_000;
export const MAX_VIEW_STATE_SCOPES = 256;
const VIEW_SCOPE_PRUNE_INTERVAL_MS = 60_000;

interface CurrentViewScopeState {
  currentView: CurrentViewState | null;
  revision: number;
  outbox: ViewNavigationOutboxState;
  lastAccessedAt: number;
}

const currentViewsByScope = new Map<string, CurrentViewScopeState>();
const connectedWebSocketViewScopes = new Set<string>();
let lastViewScopePruneAt = 0;

function viewStateScope(scopeId?: string | null): string {
  return scopeId?.trim() || DEFAULT_VIEW_STATE_SCOPE;
}

/** Reclaim REST-only scopes after their inactivity lease. */
export function pruneIdleCurrentViewScopes(now: number = Date.now()): void {
  lastViewScopePruneAt = now;
  for (const [scope, state] of currentViewsByScope) {
    if (
      scope !== DEFAULT_VIEW_STATE_SCOPE &&
      !connectedWebSocketViewScopes.has(scope) &&
      !hasRetainedViewOperations(state.outbox, now) &&
      now - state.lastAccessedAt >= VIEW_SCOPE_IDLE_TTL_MS
    ) {
      releaseCurrentViewScope(scope);
    }
  }
}

/**
 * Make room only when a new scope is about to be committed. Reads never evict
 * another client, and connected scopes are never capacity candidates.
 */
function ensureCapacityForNewViewScope(
  scopeId: string,
  now: number = Date.now(),
): boolean {
  const protectedScope = viewStateScope(scopeId);
  if (currentViewsByScope.has(protectedScope)) return true;
  pruneIdleCurrentViewScopes(now);
  if (currentViewsByScope.size < MAX_VIEW_STATE_SCOPES) return true;
  const oldest = [...currentViewsByScope.entries()]
    .filter(
      ([scope, state]) =>
        scope !== DEFAULT_VIEW_STATE_SCOPE &&
        scope !== protectedScope &&
        !connectedWebSocketViewScopes.has(scope) &&
        !hasRetainedViewOperations(state.outbox, now),
    )
    .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);
  for (const [scope] of oldest) {
    if (currentViewsByScope.size < MAX_VIEW_STATE_SCOPES) break;
    releaseCurrentViewScope(scope);
  }
  return currentViewsByScope.size < MAX_VIEW_STATE_SCOPES;
}

function currentViewScopeState(
  scopeId?: string | null,
  now: number = Date.now(),
): CurrentViewScopeState {
  if (
    now < lastViewScopePruneAt ||
    now - lastViewScopePruneAt >= VIEW_SCOPE_PRUNE_INTERVAL_MS
  ) {
    pruneIdleCurrentViewScopes(now);
  }
  const existing = currentViewsByScope.get(viewStateScope(scopeId));
  if (existing) {
    existing.lastAccessedAt = now;
    return existing;
  }
  return {
    currentView: null,
    revision: 0,
    outbox: createViewNavigationOutboxState(),
    lastAccessedAt: now,
  };
}

function storeCurrentViewScopeState(
  scopeId: string,
  state: Pick<CurrentViewScopeState, "currentView" | "revision"> & {
    outbox?: ViewNavigationOutboxState;
  },
): boolean {
  const scope = viewStateScope(scopeId);
  if (!ensureCapacityForNewViewScope(scope)) return false;
  const previous = currentViewsByScope.get(scope);
  currentViewsByScope.set(scope, {
    ...state,
    outbox:
      state.outbox ?? previous?.outbox ?? createViewNavigationOutboxState(),
    lastAccessedAt: Date.now(),
  });
  return true;
}

export function getCurrentViewState(
  scopeId?: string | null,
): CurrentViewState | null {
  return currentViewScopeState(scopeId).currentView;
}

/** Monotonic ownership token for conditional client navigation. */
export function getCurrentViewRevision(scopeId?: string | null): number {
  return currentViewScopeState(scopeId).revision;
}

/** Ordered unacknowledged shell commands for terminal and reconnect recovery. */
export function getPendingViewOperations(scopeId?: string | null) {
  return listPendingViewOperations(currentViewScopeState(scopeId).outbox);
}

function restoreActiveViewContextAfterOperationAck(
  scopeId: string,
  currentView: CurrentViewState | null,
): void {
  if (!currentView) {
    clearActiveViewContext(scopeId);
    return;
  }
  const panes = currentView.panes?.map((pane) => ({
    ...pane,
    clientId: scopeId,
  }));
  setActiveViewContext(
    {
      viewId: currentView.viewId,
      viewLabel: currentView.viewLabel,
      viewType: currentView.viewType,
      viewPath: currentView.viewPath,
      clientId: scopeId,
      ...(currentView.views ? { viewIds: currentView.views } : {}),
      ...(panes ? { panes } : {}),
      ...(currentView.layout ? { layout: currentView.layout } : {}),
      ...(currentView.placement ? { placement: currentView.placement } : {}),
      ...(currentView.switchedAt ? { switchedAt: currentView.switchedAt } : {}),
      ...(currentView.source ? { source: currentView.source } : {}),
    },
    scopeId,
  );
}

export function clearCurrentViewState(scopeId?: string | null): void {
  if (scopeId === undefined) {
    currentViewsByScope.clear();
    connectedWebSocketViewScopes.clear();
    lastViewScopePruneAt = 0;
    clearActiveViewContext();
    return;
  }
  const scope = viewStateScope(scopeId);
  const previous = currentViewScopeState(scope);
  storeCurrentViewScopeState(scope, {
    currentView: null,
    revision: previous.revision + 1,
  });
  clearActiveViewContext(scope);
}

/** Exclude a live authenticated WebSocket scope from inactivity/capacity reap. */
export function registerCurrentViewScopeWebSocket(scopeId: string): void {
  const scope = scopeId.trim();
  if (scope) connectedWebSocketViewScopes.add(scope);
}

/** Release a disconnected or expired client scope and its active-view context. */
export function releaseCurrentViewScope(scopeId: string): void {
  const scope = scopeId.trim();
  if (!scope) return;
  const state = currentViewsByScope.get(scope);
  if (state && hasRetainedViewOperations(state.outbox)) {
    connectedWebSocketViewScopes.delete(scope);
    clearActiveViewContext(scope);
    return;
  }
  currentViewsByScope.delete(scope);
  connectedWebSocketViewScopes.delete(scope);
  clearActiveViewContext(scope);
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
  /** Count live global recipients without emitting a frame. */
  broadcastWsRecipientCount?: () => number;
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
    const identity = resolveViewClientIdentity(req, null);
    if (identity.error) {
      error(res, identity.error, 400);
      return true;
    }
    const scopeId = identity.clientId;
    const currentView = getCurrentViewState(scopeId);
    json(res, {
      currentView,
      justSwitched: isViewSwitchFresh(currentView),
      revision: getCurrentViewRevision(scopeId),
      pendingOperations: getPendingViewOperations(scopeId),
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

  // ── POST /api/views/operations/:operationId/ack ─────────────────────────
  if (
    method === "POST" &&
    id === "operations" &&
    subResource.endsWith("/ack")
  ) {
    const rawOperationId = subResource.slice(0, -"/ack".length);
    let decodedOperationId: string;
    try {
      decodedOperationId = decodeURIComponent(rawOperationId);
    } catch {
      // error-policy:J3 malformed URL input is rejected as an explicit client error.
      error(res, "Malformed view operation id", 400);
      return true;
    }
    const operationId = parseViewOperationId(decodedOperationId);
    if (!operationId) {
      error(res, "Malformed view operation id", 400);
      return true;
    }
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    const expectedOperationRevision = body.expectedOperationRevision;
    if (
      typeof expectedOperationRevision !== "number" ||
      !Number.isSafeInteger(expectedOperationRevision) ||
      expectedOperationRevision <= 0
    ) {
      error(
        res,
        'Invalid "expectedOperationRevision"; expected a positive integer',
        400,
      );
      return true;
    }
    const identity = resolveViewClientIdentity(req, body);
    if (identity.error) {
      error(res, identity.error, 400);
      return true;
    }
    if (!identity.clientId) {
      error(res, "View operation acknowledgement requires a client id", 400);
      return true;
    }
    const scopeState = currentViewScopeState(identity.clientId);
    const result = acknowledgeViewOperation(
      scopeState.outbox,
      operationId,
      expectedOperationRevision,
    );
    if (result.kind === "unknown") {
      error(res, `View operation "${operationId}" not found`, 404);
      return true;
    }
    if (result.kind === "conflict") {
      error(res, `View operation "${operationId}" revision conflict`, 409);
      return true;
    }
    if (result.kind === "full") {
      error(
        res,
        "View operation acknowledgement retention is full; retry later",
        503,
      );
      return true;
    }
    if (result.kind === "acked") {
      storeCurrentViewScopeState(identity.clientId, {
        currentView: scopeState.currentView,
        revision: scopeState.revision,
        outbox: result.state,
      });
      restoreActiveViewContextAfterOperationAck(
        identity.clientId,
        scopeState.currentView,
      );
    }
    json(res, {
      ok: true,
      acked: true,
      alreadyAcked: result.kind === "already-acked",
      operationId: result.operationId,
      operationRevision: result.operationRevision,
    });
    return true;
  }

  if (method === "GET" && subResource === "") {
    const viewType = parseViewTypeParam(url.searchParams.get("viewType"));
    const entry = getExactRequestedView(id, viewType);
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
    const entry = getExactRequestedView(id, viewType);
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
    const entry = getExactRequestedView(id, viewType);
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
    const entry = getExactRequestedView(id, viewType);
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
    const entry = getExactRequestedView(id, viewType);
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
  // Sends a shell:navigate:view event to the owning client scope.
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
  //   viewTypes: object    — optional view-id -> modality hints for layout panes
  //   layout: string       — split/tile layout hint: horizontal, vertical, grid
  //   placement: string    — optional split placement hint: left/right/top/bottom
  //   path: string         — override the navigation path
  //   alwaysOnTop: boolean — for open-window, ask the shell to keep it above normal windows
  //   payload: unknown     — opaque deep-link state consumed by the target view
  //   expectedRevision: number — compare-and-set token for agent navigation
  //   rehydrate: true      — restore client-owned state without an event echo
  if (method === "POST" && subResource === "navigate") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    const identity = resolveViewClientIdentity(req, body);
    if (identity.error) {
      error(res, identity.error, 400);
      return true;
    }
    const requestedClientId = identity.clientId;
    const scopeId = requestedClientId ?? DEFAULT_VIEW_STATE_SCOPE;
    const initialScopeState = currentViewScopeState(scopeId);
    let currentViewState = initialScopeState.currentView;
    let currentViewRevision = initialScopeState.revision;
    const previousActiveViewContext = getActiveViewContext(scopeId);
    const viewType =
      parseViewTypeValue(body.viewType) ??
      parseViewTypeParam(url.searchParams.get("viewType"));
    const rawExpectedRevision = body?.expectedRevision;
    if (
      rawExpectedRevision !== undefined &&
      (typeof rawExpectedRevision !== "number" ||
        !Number.isSafeInteger(rawExpectedRevision) ||
        rawExpectedRevision < 0)
    ) {
      error(
        res,
        'Invalid "expectedRevision"; expected a non-negative integer',
        400,
      );
      return true;
    }
    const isShellRehydrate = body.rehydrate === true;
    const reportedSource =
      body.source === "user" || isShellRehydrate ? "user" : "agent";
    const deliveryOwner = body.deliveryOwner;
    if (deliveryOwner !== undefined && deliveryOwner !== "outbox") {
      error(res, 'Invalid "deliveryOwner"; expected "outbox"', 400);
      return true;
    }
    const operationId = parseViewOperationId(body.operationId);
    if (operationId === null) {
      error(res, "Malformed view operation id", 400);
      return true;
    }
    const usesOutbox = deliveryOwner === "outbox";
    if (usesOutbox && !operationId) {
      error(res, 'Missing "operationId" for outbox-owned navigation', 400);
      return true;
    }
    if (!usesOutbox && operationId !== undefined) {
      error(res, '"operationId" requires deliveryOwner="outbox"', 400);
      return true;
    }
    if (usesOutbox && reportedSource !== "agent") {
      error(res, "Only agent-owned navigation may use the outbox", 400);
      return true;
    }
    if (usesOutbox && id.length > 128) {
      error(res, "Outbox view id exceeds the 128-character limit", 400);
      return true;
    }
    if (reportedSource === "agent" && rawExpectedRevision === undefined) {
      error(res, 'Missing "expectedRevision" for agent-owned navigation', 400);
      return true;
    }
    if (reportedSource === "user" && !requestedClientId) {
      error(
        res,
        "User-owned navigation and rehydration require X-ElizaOS-Client-Id",
        400,
      );
      return true;
    }
    if (isShellRehydrate && rawExpectedRevision === undefined) {
      error(res, 'Missing "expectedRevision" for shell rehydration', 400);
      return true;
    }
    if (reportedSource === "agent" && !requestedClientId) {
      error(res, "Agent-owned navigation requires X-ElizaOS-Client-Id", 400);
      return true;
    }
    const entry = getExactRequestedView(id, viewType);
    if (viewType !== undefined && getView(id) && !entry) {
      error(res, `View "${id}" does not support viewType "${viewType}"`, 404);
      return true;
    }
    const resolvedViewType = entry?.viewType ?? viewType ?? "gui";
    // Allow navigating to synthetic IDs (like __view-manager__) even when not
    // in the registry — they route to built-in shell tabs.
    const viewPath =
      (typeof body?.path === "string" ? body.path : null) ??
      entry?.path ??
      (id === "__view-manager__" ? "/apps" : null);
    const viewLabel = entry?.label ?? id;
    const action = typeof body?.action === "string" ? body.action : undefined;
    if (
      usesOutbox &&
      action !== undefined &&
      !OUTBOX_VIEW_ACTIONS.has(action)
    ) {
      error(res, `Unsupported outbox view action "${action}"`, 400);
      return true;
    }
    // `source` distinguishes an agent-initiated switch (the default) from a user
    // manually clicking a tab/tile/slash-command, which the client *reports* with
    // `source: "user"`. A user-reported switch must NOT re-broadcast
    // the shell navigation WS event (the client already navigated locally) — that would
    // echo back and re-navigate. It still records state + emits VIEW_SWITCHED.
    const subview =
      typeof body?.subview === "string" && body.subview.trim().length > 0
        ? body.subview.trim()
        : typeof body?.section === "string" && body.section.trim().length > 0
          ? body.section.trim()
          : undefined;
    const alwaysOnTop = body?.alwaysOnTop === true;
    const requestedLayoutViews = Array.isArray(body.views)
      ? body.views.flatMap((value) => {
          if (typeof value !== "string") return [];
          const normalized = value.trim();
          return normalized ? [normalized] : [];
        })
      : undefined;
    if (
      usesOutbox &&
      body.views !== undefined &&
      (!Array.isArray(body.views) ||
        body.views.length === 0 ||
        body.views.length > 16 ||
        body.views.some(
          (value) =>
            typeof value !== "string" ||
            value.trim().length === 0 ||
            value.trim().length > 128,
        ))
    ) {
      error(res, "Malformed outbox navigation views", 400);
      return true;
    }
    const requestedLayoutPanes = parseRequestedLayoutPanes(body.panes);
    if (requestedLayoutPanes === null) {
      error(
        res,
        'Invalid "panes"; expected exact registered viewId/viewType pairs',
        400,
      );
      return true;
    }
    const layoutViews = requestedLayoutPanes
      ? requestedLayoutPanes.map((pane) => pane.viewId)
      : requestedLayoutViews && requestedLayoutViews.length > 0
        ? [...new Set([id, ...requestedLayoutViews])]
        : undefined;
    const layoutPanes = layoutViews
      ? resolveLayoutPanes(
          id,
          resolvedViewType,
          layoutViews,
          body.viewTypes,
          requestedLayoutPanes,
          requestedClientId,
        )
      : undefined;
    if (layoutViews && layoutPanes?.length !== layoutViews.length) {
      const resolvedPaneIds = new Set(
        layoutPanes?.map(({ viewId }) => viewId) ?? [],
      );
      const unresolvedViewIds = layoutViews.filter(
        (viewId) => !resolvedPaneIds.has(viewId),
      );
      error(
        res,
        `Cannot resolve an exact view type for layout pane${unresolvedViewIds.length === 1 ? "" : "s"}: ${unresolvedViewIds.join(", ")}. Supply a valid viewTypes hint for every ambiguous pane.`,
        400,
      );
      return true;
    }
    const layoutStatePanes = layoutPanes?.map(({ viewId, viewType }) => ({
      viewId,
      viewType,
    }));
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
    const isCloseNavigation = action === "close" || action === "close-all";

    if (
      usesOutbox &&
      ((action === "close-all" && id !== "__all__") ||
        ((action === "split-view" || action === "tile-views") &&
          !layoutStatePanes))
    ) {
      error(res, "Malformed outbox navigation topology", 400);
      return true;
    }

    // Validate any surviving pane before capacity changes or shell delivery.
    // The commit path repeats the lookup only to materialize the next state.
    if (isCloseNavigation && action !== "close-all" && id !== "__all__") {
      const visiblePanes =
        currentViewState?.panes ??
        (currentViewState
          ? [
              {
                viewId: currentViewState.viewId,
                viewType: currentViewState.viewType,
              },
            ]
          : []);
      const remainingPanes = visiblePanes.filter(
        (pane) => !(pane.viewId === id && pane.viewType === resolvedViewType),
      );
      const closesVisiblePane = remainingPanes.length !== visiblePanes.length;
      if (closesVisiblePane && remainingPanes.length > 0) {
        const focusedPane =
          remainingPanes.find(
            (pane) =>
              pane.viewId === currentViewState?.viewId &&
              pane.viewType === currentViewState.viewType,
          ) ?? remainingPanes[0];
        if (!getExactRequestedView(focusedPane.viewId, focusedPane.viewType)) {
          error(
            res,
            `Cannot retain remaining view "${focusedPane.viewId}" after closing "${id}"`,
            409,
          );
          return true;
        }
      }
    }

    const navigatePayload: ShellNavigateViewPayload = {
      ...(usesOutbox ? { deliveryOwner: "outbox" as const } : {}),
      viewId: id,
      viewPath,
      viewLabel,
      viewType: resolvedViewType,
      source: reportedSource,
      ...(action ? { action } : {}),
      ...(subview ? { subview } : {}),
      ...(alwaysOnTop ? { alwaysOnTop } : {}),
      ...(layoutStatePanes ? { panes: layoutStatePanes } : {}),
      ...layoutPayload,
      ...deepLinkPayload,
    };
    const serializedOperation = usesOutbox
      ? serializeViewOperation(navigatePayload)
      : undefined;
    let preparedOutboxState = initialScopeState.outbox;
    if (usesOutbox && operationId && serializedOperation) {
      const prepared = prepareViewOperation(
        initialScopeState.outbox,
        operationId,
        serializedOperation.fingerprint,
        serializedOperation.serializedBytes,
      );
      if (prepared.kind === "retry" || prepared.kind === "acknowledged-retry") {
        json(res, {
          ok: true,
          accepted: true,
          delivery:
            prepared.kind === "acknowledged-retry" ? "client-owned" : "pending",
          acknowledged: prepared.kind === "acknowledged-retry",
          ...prepared.operation,
        });
        return true;
      }
      if (prepared.kind === "conflict") {
        error(
          res,
          `View operation "${operationId}" conflicts with an existing operation`,
          409,
        );
        return true;
      }
      if (prepared.kind === "too-large") {
        error(
          res,
          `View operation exceeds the ${MAX_VIEW_OPERATION_BYTES}-byte limit`,
          413,
        );
        return true;
      }
      if (prepared.kind === "full") {
        error(
          res,
          `View operation outbox is full (${MAX_PENDING_VIEW_OPERATIONS} unacknowledged operations)`,
          503,
        );
        return true;
      }
      preparedOutboxState = prepared.state;
    }
    if (
      (reportedSource === "agent" || isShellRehydrate) &&
      typeof rawExpectedRevision === "number" &&
      rawExpectedRevision !== currentViewRevision
    ) {
      json(
        res,
        {
          ok: false,
          conflict: true,
          currentView: currentViewState,
          revision: currentViewRevision,
        },
        409,
      );
      return true;
    }
    if (!ensureCapacityForNewViewScope(scopeId)) {
      error(
        res,
        "View state capacity is occupied by connected clients; retry after a client disconnects",
        503,
      );
      return true;
    }
    let delivery: "client-owned" | "delivered" | "pending" =
      reportedSource === "user" ? "client-owned" : "pending";

    logger.info(
      { src: "ViewsRoutes", viewId: id, viewPath, action, subview },
      `[ViewsRoutes] Navigate to view "${id}"${action ? ` (action=${action})` : ""}${subview ? ` (subview=${subview})` : ""}`,
    );

    if (isCloseNavigation) {
      const closesEveryView = action === "close-all" || id === "__all__";
      const visiblePanes =
        currentViewState?.panes ??
        (currentViewState
          ? [
              {
                viewId: currentViewState.viewId,
                viewType: currentViewState.viewType,
              },
            ]
          : []);
      const remainingPanes = closesEveryView
        ? []
        : visiblePanes.filter(
            (pane) =>
              !(pane.viewId === id && pane.viewType === resolvedViewType),
          );
      const closesVisibleView = remainingPanes.length !== visiblePanes.length;
      const remainingViewIds = remainingPanes.map((pane) => pane.viewId);

      if (!closesEveryView && !closesVisibleView) {
        currentViewRevision = getCurrentViewRevision(scopeId);
      } else if (remainingViewIds.length === 0) {
        clearCurrentViewState(scopeId);
        currentViewState = null;
        currentViewRevision = getCurrentViewRevision(scopeId);
      } else {
        const focusedPane =
          remainingPanes.find(
            (pane) =>
              pane.viewId === currentViewState?.viewId &&
              pane.viewType === currentViewState.viewType,
          ) ?? remainingPanes[0];
        const focusedEntry = getExactRequestedView(
          focusedPane.viewId,
          focusedPane.viewType,
        );
        if (!focusedEntry) {
          error(
            res,
            `Cannot retain remaining view "${focusedPane.viewId}" after closing "${id}"`,
            409,
          );
          return true;
        }
        const remainingActivePanes = remainingPanes.map((pane) => {
          const mounted = resolveVisiblePane(
            pane.viewId,
            previousActiveViewContext,
            pane.viewType,
          );
          return {
            ...pane,
            ...(mounted?.clientId
              ? { clientId: mounted.clientId }
              : requestedClientId
                ? { clientId: requestedClientId }
                : {}),
            ...(mounted?.elements ? { elements: mounted.elements } : {}),
          };
        });
        const focusedMountedPane = resolveVisiblePane(
          focusedPane.viewId,
          previousActiveViewContext,
          focusedPane.viewType,
        );
        const now = new Date().toISOString();
        const remainsLayout = remainingPanes.length > 1;
        currentViewState = {
          viewId: focusedEntry.id,
          viewPath: focusedEntry.path ?? null,
          viewLabel: focusedEntry.label,
          viewType: focusedEntry.viewType,
          ...(remainsLayout && currentViewState?.action
            ? { action: currentViewState.action }
            : {}),
          ...(remainsLayout ? { views: remainingViewIds } : {}),
          ...(remainsLayout ? { panes: remainingPanes } : {}),
          ...(remainsLayout && currentViewState?.layout
            ? { layout: currentViewState.layout }
            : {}),
          ...(remainsLayout && currentViewState?.placement
            ? { placement: currentViewState.placement }
            : {}),
          switchedAt: now,
          source: reportedSource,
          updatedAt: now,
        };
        currentViewRevision += 1;
        storeCurrentViewScopeState(scopeId, {
          currentView: currentViewState,
          revision: currentViewRevision,
        });
        setActiveViewContext(
          {
            viewId: focusedEntry.id,
            viewLabel: focusedEntry.label,
            viewType: focusedEntry.viewType,
            viewPath: focusedEntry.path ?? null,
            ...(requestedClientId ? { clientId: requestedClientId } : {}),
            ...(remainsLayout ? { viewIds: remainingViewIds } : {}),
            ...(remainsLayout && remainingActivePanes.length
              ? { panes: remainingActivePanes }
              : {}),
            ...(focusedMountedPane?.elements
              ? { elements: focusedMountedPane.elements }
              : {}),
            ...(remainsLayout && currentViewState.layout
              ? { layout: currentViewState.layout }
              : {}),
            ...(remainsLayout && currentViewState.placement
              ? { placement: currentViewState.placement }
              : {}),
            switchedAt: now,
            source: reportedSource,
          },
          scopeId,
        );
      }
    } else {
      const now = new Date().toISOString();
      const source = reportedSource;
      // Stamp `switchedAt` only when the exact view identity changes; a
      // re-navigate to the same id and modality must not re-trigger an
      // acknowledgement.
      const previousViewId = currentViewState?.viewId ?? null;
      const nextDestination = {
        viewId: id,
        viewPath,
        viewLabel,
        viewType: resolvedViewType,
        ...(action ? { action } : {}),
        ...(subview ? { subview } : {}),
        ...(alwaysOnTop ? { alwaysOnTop } : {}),
        ...layoutPayload,
        ...(layoutStatePanes ? { panes: layoutStatePanes } : {}),
      } satisfies Omit<CurrentViewState, "switchedAt" | "source" | "updatedAt">;
      const destinationChanged = !sameViewDestination(
        currentViewState,
        nextDestination,
      );
      const primaryViewChanged =
        previousViewId !== id ||
        currentViewState?.viewType !== resolvedViewType;
      const switchedAt = destinationChanged
        ? now
        : (currentViewState?.switchedAt ?? now);
      currentViewState = {
        ...nextDestination,
        switchedAt,
        source,
        updatedAt: now,
      };
      currentViewRevision += 1;
      storeCurrentViewScopeState(scopeId, {
        currentView: currentViewState,
        revision: currentViewRevision,
      });
      const previousFocusedPane = resolveVisiblePane(
        id,
        previousActiveViewContext,
        resolvedViewType,
      );
      const activeLayoutPanes = layoutPanes?.map((pane) => {
        const mounted = resolveVisiblePane(
          pane.viewId,
          previousActiveViewContext,
          pane.viewType,
        );
        return {
          ...pane,
          ...(mounted?.clientId && !pane.clientId
            ? { clientId: mounted.clientId }
            : {}),
          ...(mounted?.elements ? { elements: mounted.elements } : {}),
        };
      });
      // Publish to the prompt-optimization layer so the planner upweights this
      // view's scoped actions while it is on screen.
      setActiveViewContext(
        {
          viewId: id,
          viewLabel,
          viewType: resolvedViewType,
          viewPath,
          ...(requestedClientId ? { clientId: requestedClientId } : {}),
          ...(layoutViews ? { viewIds: layoutViews } : {}),
          ...(activeLayoutPanes ? { panes: activeLayoutPanes } : {}),
          ...(previousFocusedPane?.elements
            ? { elements: previousFocusedPane.elements }
            : {}),
          ...(layout ? { layout } : {}),
          ...(placement ? { placement } : {}),
          // Carry freshness so Stage-1 can acknowledge a just-happened switch (#8788).
          ...(switchedAt ? { switchedAt } : {}),
          ...(source ? { source } : {}),
        },
        scopeId,
      );
      // Emit the first-class VIEW_SWITCHED interaction event (#8792) so a
      // proactive decider can comment. Only on a real change (no spam on
      // re-navigates), and fire-and-forget so it never blocks the response.
      if (primaryViewChanged && ctx.runtime && !isShellRehydrate) {
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

    // An accepted outbox command needs its own positive current-state revision
    // even when the destination is already absent (for example, a repeated
    // close). The renderer uses that revision to reject malformed envelopes,
    // while operationRevision independently preserves edge ordering.
    if (usesOutbox && currentViewRevision === initialScopeState.revision) {
      currentViewRevision += 1;
      storeCurrentViewScopeState(scopeId, {
        currentView: currentViewState,
        revision: currentViewRevision,
      });
    }

    let pendingOperation:
      | ReturnType<typeof listPendingViewOperations>[number]
      | undefined;
    if (usesOutbox && operationId && serializedOperation) {
      const appended = appendViewOperation(preparedOutboxState, {
        operationId,
        fingerprint: serializedOperation.fingerprint,
        serializedBytes: serializedOperation.serializedBytes,
        revision: currentViewRevision,
        payload: navigatePayload,
      });
      pendingOperation = appended.operation;
      storeCurrentViewScopeState(scopeId, {
        currentView: currentViewState,
        revision: currentViewRevision,
        outbox: appended.state,
      });
    }

    if (reportedSource === "agent") {
      const frame = createShellNavigateViewWsFrame(
        pendingOperation ?? {
          ...navigatePayload,
          revision: currentViewRevision,
        },
      );
      ctx.broadcastWsToClientId?.(scopeId, frame);
      // Socket send only enqueues bytes. Renderer acknowledgement is the sole
      // proof of application, so agent navigation remains pending here.
      delivery = "pending";
    }

    json(res, {
      ok: true,
      accepted: true,
      delivery,
      ...(pendingOperation
        ? {
            deliveryOwner: "outbox",
            operationId: pendingOperation.operationId,
            operationRevision: pendingOperation.operationRevision,
          }
        : {}),
      viewId: id,
      viewPath,
      viewType: resolvedViewType,
      ...(action ? { action } : {}),
      ...(subview ? { subview } : {}),
      ...(alwaysOnTop ? { alwaysOnTop } : {}),
      ...(layoutStatePanes ? { panes: layoutStatePanes } : {}),
      ...layoutPayload,
      ...deepLinkPayload,
      revision: currentViewRevision,
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
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    const identity = resolveViewClientIdentity(req, body);
    if (identity.error) {
      error(res, identity.error, 400);
      return true;
    }
    const elements = normalizeActiveViewElements(body.elements);
    const clientId = identity.clientId;
    const viewType =
      parseViewTypeValue(body.viewType) ??
      parseViewTypeParam(url.searchParams.get("viewType"));
    const accepted = setActiveViewElements(
      id,
      elements,
      clientId,
      viewType,
      clientId ?? DEFAULT_VIEW_STATE_SCOPE,
    );
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
    const identity = resolveViewClientIdentity(req, body);
    if (identity.error) {
      error(res, identity.error, 400);
      return true;
    }

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
    const entry = getExactRequestedView(id, viewType);
    if (!entry) {
      error(res, `View "${id}" not found`, 404);
      return true;
    }

    // Resolve the element from the active-view snapshot for context (the planner
    // reports it via /:id/elements). Only used when this view is the foreground
    // active view; absent otherwise — the click still dispatches by id.
    const requestClientId = identity.clientId;
    const active = getActiveViewContext(requestClientId);
    const element = resolveVisiblePane(
      id,
      active,
      entry.viewType,
    )?.elements?.find((candidate) => candidate.id === elementId);

    const capability = STANDARD_CAPABILITIES.CLICK_ELEMENT;
    const params: Record<string, unknown> = { elementId, id: elementId };

    logger.info(
      { src: "ViewsRoutes", viewId: id, elementId, capability },
      `[ViewsRoutes] Activate element "${elementId}" on view "${id}"`,
    );

    const dispatch = await dispatchViewInteract(entry, id, capability, params, {
      broadcastWs: ctx.broadcastWs,
      broadcastWsToClientId: ctx.broadcastWsToClientId,
      clientId: resolveTargetViewClientId(id, entry.viewType, requestClientId),
      runtime: ctx.runtime ?? undefined,
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
    const identity = resolveViewClientIdentity(req, body);
    if (identity.error) {
      error(res, identity.error, 400);
      return true;
    }

    const viewType =
      parseViewTypeValue(body.viewType) ??
      parseViewTypeParam(url.searchParams.get("viewType"));
    const entry = getExactRequestedView(id, viewType);
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
        const clientId = identity.clientId;
        const result = await entry.serverInteract(capability, params, {
          runtime: ctx.runtime ?? undefined,
          clientId: clientId ?? undefined,
        });
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
    const targetClientId = resolveTargetViewClientId(
      id,
      entry.viewType,
      identity.clientId,
    );
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
  runtime?: IAgentRuntime;
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
      const result = await entry.serverInteract(capability, params, {
        runtime: transport.runtime,
        clientId: transport.clientId ?? undefined,
      });
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

interface ResolvedViewClientIdentity {
  clientId: string | null;
  error?: string;
}

function resolveViewClientIdentity(
  req: Pick<http.IncomingMessage, "headers">,
  body: Record<string, unknown> | null | undefined,
): ResolvedViewClientIdentity {
  const headers = req.headers ?? {};
  const rawPrimary = firstHeaderValue(headers["x-elizaos-client-id"]);
  const rawLegacy = firstHeaderValue(headers["x-eliza-client-id"]);
  const primary = normalizeWsClientId(rawPrimary);
  const legacy = normalizeWsClientId(rawLegacy);
  if (rawPrimary !== null && !primary) {
    return { clientId: null, error: "Invalid X-ElizaOS-Client-Id header" };
  }
  if (rawLegacy !== null && !legacy) {
    return { clientId: null, error: "Invalid X-Eliza-Client-Id header" };
  }
  if (primary && legacy && primary !== legacy) {
    return { clientId: null, error: "View client-id headers must match" };
  }

  const rawBodyClientId = body?.clientId;
  const bodyClientId = normalizeWsClientId(rawBodyClientId);
  if (rawBodyClientId !== undefined && !bodyClientId) {
    return { clientId: null, error: "Invalid clientId in request body" };
  }
  const headerClientId = primary ?? legacy;
  if (headerClientId && bodyClientId && headerClientId !== bodyClientId) {
    return {
      clientId: null,
      error: "Header and body view client ids must match",
    };
  }
  if (!headerClientId && bodyClientId) {
    return {
      clientId: null,
      error: "Provide clientId through X-ElizaOS-Client-Id",
    };
  }
  return { clientId: headerClientId ?? null };
}

function resolveTargetViewClientId(
  viewId: string,
  viewType: ViewType,
  explicit: string | null,
): string | null {
  const active = getActiveViewContext(explicit ?? DEFAULT_VIEW_STATE_SCOPE);
  const mountedOwner =
    resolveVisiblePane(viewId, active, viewType)?.clientId ?? null;
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
