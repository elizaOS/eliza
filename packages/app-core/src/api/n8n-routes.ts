/**
 * n8n routes — status surface + workflow CRUD proxy + sidecar lifecycle.
 *
 * Exposes:
 *   GET    /api/n8n/status                          — mode + sidecar state
 *   POST   /api/n8n/sidecar/start                   — fire-and-forget sidecar boot
 *   GET    /api/n8n/workflows                       — list workflows
 *   POST   /api/n8n/workflows/{id}/activate         — activate workflow
 *   POST   /api/n8n/workflows/{id}/deactivate       — deactivate workflow
 *   DELETE /api/n8n/workflows/{id}                  — delete workflow
 *
 * Status is the only read-only surface. The workflow CRUD handlers proxy
 * to the actual n8n backend:
 *   - Cloud mode  → `${cloudBaseUrl}/api/v1/agents/${agentId}/n8n/workflows/...`
 *                   with `Authorization: Bearer ${cloud.apiKey}`
 *   - Local mode  → `${sidecar.host}/rest/workflows/...`
 *                   with `X-N8N-API-KEY: ${sidecar.getApiKey()}` (n8n native)
 *   - Disabled / sidecar not ready → 503 `{ error, status }`
 *
 * The provisioned API key is never returned to the UI.
 *
 * Context shape matches other app-core compat routes
 * (cloud-status-routes.ts): `{ req, res, method, pathname, config, runtime,
 * json }`. The sidecar instance is read from the module-level singleton in
 * services/n8n-sidecar.ts rather than being threaded through state.
 */

import type { RouteHelpers, RouteRequestMeta } from "@elizaos/agent/api";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  getN8nSidecar,
  type N8nSidecar,
  type N8nSidecarStatus,
  peekN8nSidecar,
} from "../services/n8n-sidecar";

export type N8nMode = "cloud" | "local" | "disabled";

export interface N8nStatusResponse {
  mode: N8nMode;
  host: string | null;
  status: N8nSidecarStatus;
  cloudConnected: boolean;
  localEnabled: boolean;
}

export interface N8nWorkflowNodeLike {
  id?: string;
  name?: string;
  type?: string;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  description?: string;
  nodes?: N8nWorkflowNodeLike[];
  nodeCount: number;
}

/**
 * Minimal shape of the relevant config slice. Narrow read-only view so this
 * route does not take a hard dependency on the full ElizaConfig type landing
 * here. `n8n` maps 1:1 to the canonical N8nConfig fields used by the sidecar.
 */
export interface N8nRoutesConfigLike {
  cloud?: {
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
  };
  n8n?: {
    localEnabled?: boolean;
    host?: string | null;
    enabled?: boolean;
    version?: string;
    startPort?: number;
    apiKey?: string;
    status?: N8nSidecarStatus;
  };
}

// Back-compat aliases for the previous module export names.
export type N8nStatusConfigLike = N8nRoutesConfigLike;
export type N8nStatusRouteContext = N8nRouteContext;

export interface N8nRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json"> {
  config: N8nRoutesConfigLike;
  runtime: AgentRuntime | null;
  /**
   * Optional sidecar override. When absent, the handler reads the
   * module-level singleton via `peekN8nSidecar()`. Tests inject a stub.
   */
  n8nSidecar?: N8nSidecar | null;
  /**
   * Optional fetch override for tests / future proxy interception.
   * Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional agent id override. Otherwise pulled from `runtime.agentId`
   * or character id. Used in the cloud-mode proxy URL.
   */
  agentId?: string;
}

interface CloudAuthLike {
  isAuthenticated: () => boolean;
}

// Cloud base URL default — mirrors `resolveCloudApiBaseUrl()` without
// pulling the validator in (avoids an async-validation dep on a hot path).
const DEFAULT_CLOUD_API_BASE_URL = "https://api.eliza.how";

function normalizeBaseUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  const base = trimmed.length > 0 ? trimmed : DEFAULT_CLOUD_API_BASE_URL;
  return base.replace(/\/+$/, "");
}

function isCloudConnected(
  config: N8nRoutesConfigLike,
  runtime: AgentRuntime | null,
): boolean {
  if (!config.cloud?.enabled) return false;
  const auth = runtime
    ? (runtime.getService("CLOUD_AUTH") as unknown as CloudAuthLike | null)
    : null;
  if (auth?.isAuthenticated?.()) return true;
  // API-key fallback — matches cloud-status-routes semantics.
  return Boolean(config.cloud.apiKey?.trim());
}

function resolveAgentId(ctx: N8nRouteContext): string {
  if (ctx.agentId?.trim()) return ctx.agentId.trim();
  const runtimeAny = ctx.runtime as unknown as {
    agentId?: string;
    character?: { id?: string };
  } | null;
  return (
    runtimeAny?.agentId ??
    runtimeAny?.character?.id ??
    "00000000-0000-0000-0000-000000000000"
  );
}

function sendJson(
  ctx: Pick<N8nRouteContext, "res" | "json">,
  status: number,
  body: unknown,
): void {
  // The compat `json` helper signature in app-core is
  // `(res, body, status?) => void`; status defaults to 200 upstream.
  const json = ctx.json as unknown as (
    res: typeof ctx.res,
    body: unknown,
    status?: number,
  ) => void;
  json(ctx.res, body, status);
}

/** Strip any credential material from node descriptors before forwarding. */
function sanitizeNode(n: unknown): N8nWorkflowNodeLike {
  if (!n || typeof n !== "object") return {};
  const obj = n as Record<string, unknown>;
  return {
    ...(typeof obj.id === "string" ? { id: obj.id } : {}),
    ...(typeof obj.name === "string" ? { name: obj.name } : {}),
    ...(typeof obj.type === "string" ? { type: obj.type } : {}),
  };
}

/** Normalize an n8n workflow payload to our client-facing shape. */
function normalizeWorkflow(raw: unknown): N8nWorkflow | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : String(obj.id ?? "");
  const name = typeof obj.name === "string" ? obj.name : "";
  if (!id) return null;
  const nodesRaw = Array.isArray(obj.nodes) ? obj.nodes : [];
  const nodes = nodesRaw.map(sanitizeNode);
  return {
    id,
    name,
    active: Boolean(obj.active),
    ...(typeof obj.description === "string"
      ? { description: obj.description }
      : {}),
    nodes,
    nodeCount: nodes.length,
  };
}

interface ProxyTarget {
  url: string;
  headers: Record<string, string>;
}

/**
 * Resolve the backend target for a workflow-CRUD call. Returns null target
 * if the n8n backend is not currently available; caller emits a 503.
 */
function resolveProxyTarget(
  ctx: N8nRouteContext,
  subpath: string,
): {
  target: ProxyTarget | null;
  reason?: {
    message: string;
    status: N8nSidecarStatus;
  };
} {
  const cloudConnected = isCloudConnected(ctx.config, ctx.runtime);
  if (cloudConnected) {
    const apiKey = ctx.config.cloud?.apiKey?.trim();
    if (!apiKey) {
      return {
        target: null,
        reason: { message: "cloud api key missing", status: "error" },
      };
    }
    const baseUrl = normalizeBaseUrl(ctx.config.cloud?.baseUrl);
    const agentId = resolveAgentId(ctx);
    const url = `${baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/n8n/workflows${subpath}`;
    return {
      target: {
        url,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
    };
  }

  const localEnabled = ctx.config.n8n?.localEnabled ?? true;
  if (!localEnabled) {
    return {
      target: null,
      reason: { message: "n8n disabled", status: "stopped" },
    };
  }

  const sidecar =
    ctx.n8nSidecar === undefined ? peekN8nSidecar() : ctx.n8nSidecar;
  const sidecarState = sidecar?.getState();
  const status: N8nSidecarStatus = sidecarState?.status ?? "stopped";

  if (status !== "ready") {
    return {
      target: null,
      reason: { message: `n8n not ready (${status})`, status },
    };
  }

  const host = sidecarState?.host ?? ctx.config.n8n?.host ?? null;
  if (!host) {
    return {
      target: null,
      reason: { message: "n8n host unknown", status: "error" },
    };
  }

  const apiKey = sidecar?.getApiKey() ?? ctx.config.n8n?.apiKey ?? null;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) headers["X-N8N-API-KEY"] = apiKey;

  return {
    target: {
      url: `${host.replace(/\/+$/, "")}/rest/workflows${subpath}`,
      headers,
    },
  };
}

async function fetchTargetAsJson(
  ctx: N8nRouteContext,
  target: ProxyTarget,
  init: { method: string; body?: string },
): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
}> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...target.headers };
  if (init.body != null) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetchImpl(target.url, {
      method: init.method,
      headers,
      ...(init.body != null ? { body: init.body } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[n8n-routes] proxy fetch failed: ${message}`);
    return { ok: false, status: 502, body: { error: message } };
  }

  let parsed: unknown = null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
  } else {
    try {
      parsed = await res.text();
    } catch {
      parsed = null;
    }
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Extracts a workflows array from an n8n or cloud-gateway list response.
 * n8n returns `{ data: [...] }`; our cloud gateway may return `{ workflows }`
 * or `{ data }`. We accept both.
 */
function extractWorkflowList(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  if (Array.isArray(obj.workflows)) return obj.workflows;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function extractWorkflowSingle(body: unknown): unknown {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (obj.data && typeof obj.data === "object") return obj.data;
  if (obj.workflow && typeof obj.workflow === "object") return obj.workflow;
  return body;
}

function propagateError(
  ctx: N8nRouteContext,
  upstream: { status: number; body: unknown },
): void {
  const status =
    upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
  let message = `upstream responded with ${upstream.status}`;
  if (upstream.body && typeof upstream.body === "object") {
    const b = upstream.body as Record<string, unknown>;
    const candidate = b.error ?? b.message;
    if (typeof candidate === "string" && candidate.length > 0) {
      message = candidate;
    }
  } else if (typeof upstream.body === "string" && upstream.body.length > 0) {
    message = upstream.body;
  }
  sendJson(ctx, status, { error: message });
}

/**
 * Parse `/api/n8n/workflows/{id}[/activate|/deactivate]` into (id, action).
 * Returns null if pathname doesn't match.
 */
function parseWorkflowPath(
  pathname: string,
): { id: string; action: "get" | "activate" | "deactivate" } | null {
  const prefix = "/api/n8n/workflows/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest) return null;
  const parts = rest.split("/").filter(Boolean);
  if (parts.length === 1) {
    return { id: decodeURIComponent(parts[0] ?? ""), action: "get" };
  }
  if (parts.length === 2) {
    const action = parts[1];
    if (action === "activate" || action === "deactivate") {
      return { id: decodeURIComponent(parts[0] ?? ""), action };
    }
  }
  return null;
}

export async function handleN8nRoutes(ctx: N8nRouteContext): Promise<boolean> {
  const { method, pathname, config } = ctx;

  // --- Status ---------------------------------------------------------------
  if (method === "GET" && pathname === "/api/n8n/status") {
    return handleStatus(ctx);
  }

  // --- Sidecar start (fire-and-forget) --------------------------------------
  if (method === "POST" && pathname === "/api/n8n/sidecar/start") {
    const sidecar =
      ctx.n8nSidecar ??
      getN8nSidecar({
        enabled: config.n8n?.localEnabled ?? true,
        ...(config.n8n?.version ? { version: config.n8n.version } : {}),
        ...(config.n8n?.startPort ? { startPort: config.n8n.startPort } : {}),
      });
    void sidecar.start();
    sendJson(ctx, 202, { ok: true });
    return true;
  }

  // --- Workflows list -------------------------------------------------------
  if (method === "GET" && pathname === "/api/n8n/workflows") {
    return handleListWorkflows(ctx);
  }

  // --- Workflow CRUD --------------------------------------------------------
  const parsed = parseWorkflowPath(pathname);
  if (parsed) {
    if (method === "POST" && parsed.action === "activate") {
      return handleToggleWorkflow(ctx, parsed.id, true);
    }
    if (method === "POST" && parsed.action === "deactivate") {
      return handleToggleWorkflow(ctx, parsed.id, false);
    }
    if (method === "DELETE" && parsed.action === "get") {
      return handleDeleteWorkflow(ctx, parsed.id);
    }
  }

  return false;
}

// Backwards-compat named export so the old import symbol still works for any
// out-of-tree caller that imports it. Prefer `handleN8nRoutes` in new code.
export const handleN8nStatusRoutes = handleN8nRoutes;

async function handleStatus(ctx: N8nRouteContext): Promise<boolean> {
  const { config, runtime } = ctx;
  const sidecar =
    ctx.n8nSidecar === undefined ? peekN8nSidecar() : ctx.n8nSidecar;

  const cloudConnected = isCloudConnected(config, runtime);
  const localEnabled = config.n8n?.localEnabled ?? true;
  const sidecarState = sidecar?.getState();
  const status: N8nSidecarStatus = sidecarState?.status ?? "stopped";

  let mode: N8nMode;
  if (cloudConnected) {
    mode = "cloud";
  } else if (localEnabled) {
    mode = "local";
  } else {
    mode = "disabled";
  }

  const host =
    mode === "local" ? (sidecarState?.host ?? config.n8n?.host ?? null) : null;

  const payload: N8nStatusResponse = {
    mode,
    host,
    status,
    cloudConnected,
    localEnabled,
  };

  // Match previous behavior: 200 via ctx.json.
  ctx.json(ctx.res, payload);
  return true;
}

async function handleListWorkflows(ctx: N8nRouteContext): Promise<boolean> {
  const resolved = resolveProxyTarget(ctx, "");
  if (!resolved.target) {
    sendJson(ctx, 503, {
      error: resolved.reason?.message ?? "n8n not ready",
      status: resolved.reason?.status ?? "stopped",
    });
    return true;
  }

  const upstream = await fetchTargetAsJson(ctx, resolved.target, {
    method: "GET",
  });
  if (!upstream.ok) {
    propagateError(ctx, upstream);
    return true;
  }

  const list = extractWorkflowList(upstream.body);
  const workflows = list
    .map(normalizeWorkflow)
    .filter((w): w is N8nWorkflow => w !== null);

  sendJson(ctx, 200, { workflows });
  return true;
}

async function handleToggleWorkflow(
  ctx: N8nRouteContext,
  id: string,
  activate: boolean,
): Promise<boolean> {
  if (!id) {
    sendJson(ctx, 400, { error: "workflow id required" });
    return true;
  }

  const subpath = `/${encodeURIComponent(id)}/${activate ? "activate" : "deactivate"}`;
  const resolved = resolveProxyTarget(ctx, subpath);
  if (!resolved.target) {
    sendJson(ctx, 503, {
      error: resolved.reason?.message ?? "n8n not ready",
      status: resolved.reason?.status ?? "stopped",
    });
    return true;
  }

  const upstream = await fetchTargetAsJson(ctx, resolved.target, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!upstream.ok) {
    propagateError(ctx, upstream);
    return true;
  }

  const single = extractWorkflowSingle(upstream.body);
  const normalized = normalizeWorkflow(single);
  if (!normalized) {
    // Upstream returned 2xx with an unrecognized shape — synthesize a
    // minimal response so the UI can still toggle optimistic state.
    sendJson(ctx, 200, {
      id,
      name: "",
      active: activate,
      nodes: [],
      nodeCount: 0,
    } satisfies N8nWorkflow);
    return true;
  }
  sendJson(ctx, 200, normalized);
  return true;
}

async function handleDeleteWorkflow(
  ctx: N8nRouteContext,
  id: string,
): Promise<boolean> {
  if (!id) {
    sendJson(ctx, 400, { error: "workflow id required" });
    return true;
  }

  const resolved = resolveProxyTarget(ctx, `/${encodeURIComponent(id)}`);
  if (!resolved.target) {
    sendJson(ctx, 503, {
      error: resolved.reason?.message ?? "n8n not ready",
      status: resolved.reason?.status ?? "stopped",
    });
    return true;
  }

  const upstream = await fetchTargetAsJson(ctx, resolved.target, {
    method: "DELETE",
  });
  if (!upstream.ok) {
    propagateError(ctx, upstream);
    return true;
  }

  sendJson(ctx, 200, { ok: true });
  return true;
}
