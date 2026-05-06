/**
 * n8n routes — status surface + workflow CRUD proxy + sidecar lifecycle.
 *
 * Exposes:
 *   GET    /api/n8n/status                          — mode + sidecar state
 *   POST   /api/n8n/sidecar/start                   — fire-and-forget sidecar boot
 *   GET    /api/n8n/workflows                       — list workflows
 *   POST   /api/n8n/workflows                       — create workflow
 *   POST   /api/n8n/workflows/generate              — generate + create/update workflow
 *   PUT    /api/n8n/workflows/{id}                  — update workflow
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
 * Context shape is `{ req, res, method, pathname, config, runtime, json }`.
 * The sidecar instance is read from the module-level singleton in
 * services/n8n-sidecar.ts rather than being threaded through state.
 */

import type {
  RouteHelpers,
  RouteRequestMeta,
} from "@elizaos/agent/api/route-helpers";
import { readCompatJsonBody } from "@elizaos/app-core/api/compat-route-shared";
import { isNativeServerPlatform } from "@elizaos/app-core/platform/is-native-server";
import {
  type N8nMode,
  resolveN8nMode,
} from "@elizaos/app-core/services/n8n-mode";
import type {
  N8nSidecar,
  N8nSidecarStatus,
} from "@elizaos/app-core/services/n8n-sidecar";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  applyResolutions,
  buildCatalogSnapshot,
  type CatalogLike,
  coerceClarifications,
  pruneResolvedClarifications,
} from "../lib/n8n-clarification";

export type { N8nMode } from "@elizaos/app-core/services/n8n-mode";

/**
 * Host platform for the n8n status surface. On mobile (iOS / Android) the
 * local n8n sidecar cannot run because `node:child_process` is unavailable
 * inside the Capacitor runtime. The status surface still reports state so
 * the UI can render a cloud-only view.
 */
export type N8nHostPlatform = "desktop" | "mobile";

/**
 * Result of the cloud-gateway health probe. Reflects reachability of
 * `${cloudBaseUrl}/api/v1/health` — `unknown` means we did not probe
 * (mode !== "cloud" or probe failed before HTTP resolved).
 */
export type N8nCloudHealth = "ok" | "degraded" | "unknown";

export interface N8nStatusResponse {
  mode: N8nMode;
  host: string | null;
  status: N8nSidecarStatus;
  cloudConnected: boolean;
  localEnabled: boolean;
  platform: N8nHostPlatform;
  /**
   * Cloud gateway health. Present whenever mode === "cloud"; otherwise
   * "unknown". Cached for 30s to avoid hammering the cloud on status polls.
   */
  cloudHealth: N8nCloudHealth;
  /**
   * Diagnostic fields from the local sidecar. Empty on cloud mode. Non-null
   * only when a sidecar has attempted at least one boot — these let the UI
   * show a real error panel instead of "not ready (starting)" forever.
   */
  errorMessage?: string | null;
  retries?: number;
  /** Last ~40 lines of the n8n child's stdout+stderr. */
  recentOutput?: string[];
}

export interface N8nWorkflowNodeLike {
  id?: string;
  name?: string;
  type?: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  notes?: string;
  notesInFlow?: boolean;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  description?: string;
  nodes?: N8nWorkflowNodeLike[];
  nodeCount: number;
  /** Connection graph — only present on single-workflow GET, not on list. */
  connections?: Record<
    string,
    { main?: Array<Array<{ node: string; type: "main"; index: number }>> }
  >;
}

type N8nWorkflowConnections = NonNullable<N8nWorkflow["connections"]>;

interface N8nWorkflowWriteNode {
  id?: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  color?: string;
  continueOnFail?: boolean;
  executeOnce?: boolean;
  alwaysOutputData?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: "continueErrorOutput" | "continueRegularOutput" | "stopWorkflow";
}

interface N8nWorkflowWritePayload {
  name: string;
  nodes: N8nWorkflowWriteNode[];
  connections: N8nWorkflowConnections;
  settings: Record<string, unknown>;
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
  /**
   * Override for native-platform detection. When absent, the handler
   * calls `isNativeServerPlatform()`. Tests inject a deterministic value.
   * On mobile the sidecar lifecycle is disabled — the route reports cloud
   * mode or the `"disabled"` mode without importing the sidecar module.
   */
  isNativePlatform?: boolean;
  /**
   * Override for the cached cloud-health probe. When present, the handler
   * uses this instead of running the live fetch (used by tests to assert
   * degraded / ok / unknown paths deterministically).
   */
  cloudHealthOverride?: N8nCloudHealth;
}

// ── Cloud health probe ──────────────────────────────────────────────────────
//
// Probes `${cloudBaseUrl}/api/v1/health` with a 2s timeout and caches the
// result for 30s. Any non-2xx or network failure maps to "degraded"; a 2xx
// maps to "ok". Before the first probe completes we report "unknown".

const CLOUD_HEALTH_CACHE_TTL_MS = 30_000;
const CLOUD_HEALTH_PROBE_TIMEOUT_MS = 2_000;

interface CloudHealthCacheEntry {
  health: N8nCloudHealth;
  expiresAt: number;
}

const cloudHealthCache = new Map<string, CloudHealthCacheEntry>();

/** Exported for tests; wipes the health-probe cache between cases. */
export function __resetCloudHealthCacheForTests(): void {
  cloudHealthCache.clear();
}

async function probeCloudHealth(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<N8nCloudHealth> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/health`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CLOUD_HEALTH_PROBE_TIMEOUT_MS),
    });
    return res.ok ? "ok" : "degraded";
  } catch (err) {
    logger.debug(
      `[n8n-routes] cloud health probe failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "degraded";
  }
}

async function getCloudHealth(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<N8nCloudHealth> {
  const key = normalizeBaseUrl(baseUrl);
  const now = Date.now();
  const cached = cloudHealthCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.health;
  }
  const health = await probeCloudHealth(key, fetchImpl);
  cloudHealthCache.set(key, {
    health,
    expiresAt: now + CLOUD_HEALTH_CACHE_TTL_MS,
  });
  return health;
}

/**
 * Dynamically import the sidecar module. Keeps `node:child_process` out of
 * the module graph for mobile bundles — `isNativeServerPlatform()` is true
 * on Capacitor-hosted iOS / Android, in which case the sidecar code path
 * is never reached.
 */
async function loadSidecarModule(): Promise<
  typeof import("@elizaos/app-core/services/n8n-sidecar") | null
> {
  if (isNativeServerPlatform()) {
    return null;
  }
  return await import("@elizaos/app-core/services/n8n-sidecar");
}

// Cloud base URL default — mirrors `resolveCloudApiBaseUrl()` without
// pulling the validator in (avoids an async-validation dep on a hot path).
const DEFAULT_CLOUD_API_BASE_URL = "https://api.eliza.how";

function normalizeBaseUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  const base = trimmed.length > 0 ? trimmed : DEFAULT_CLOUD_API_BASE_URL;
  return base.replace(/\/+$/, "");
}

function resolveAgentId(ctx: N8nRouteContext): string {
  if (ctx.agentId?.trim()) {
    return ctx.agentId.trim();
  }
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
  if (!n || typeof n !== "object") {
    return {};
  }
  const obj = n as Record<string, unknown>;
  return {
    ...(typeof obj.id === "string" ? { id: obj.id } : {}),
    ...(typeof obj.name === "string" ? { name: obj.name } : {}),
    ...(typeof obj.type === "string" ? { type: obj.type } : {}),
    ...(typeof obj.typeVersion === "number"
      ? { typeVersion: obj.typeVersion }
      : {}),
  };
}

/**
 * Full node sanitizer for single-workflow GET — includes position and
 * parameters (needed by the graph viewer). Credentials are still stripped.
 */
function sanitizeNodeFull(n: unknown): N8nWorkflowNodeLike {
  if (!n || typeof n !== "object") {
    return {};
  }
  const obj = n as Record<string, unknown>;
  const base = sanitizeNode(n);

  // position: n8n stores it as [x, y] on the node object
  const pos = obj.position;
  const position: [number, number] | undefined =
    Array.isArray(pos) &&
    pos.length >= 2 &&
    typeof pos[0] === "number" &&
    typeof pos[1] === "number"
      ? [pos[0], pos[1]]
      : undefined;

  // parameters: pass through as-is (no credentials inside this field)
  const parameters =
    obj.parameters && typeof obj.parameters === "object"
      ? (obj.parameters as Record<string, unknown>)
      : undefined;

  return {
    ...base,
    ...(position !== undefined ? { position } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
    ...(typeof obj.notes === "string" ? { notes: obj.notes } : {}),
    ...(typeof obj.notesInFlow === "boolean"
      ? { notesInFlow: obj.notesInFlow }
      : {}),
  };
}

/** Normalize an n8n workflow payload to our client-facing shape. */
function normalizeWorkflow(raw: unknown): N8nWorkflow | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : String(obj.id ?? "");
  const name = typeof obj.name === "string" ? obj.name : "";
  if (!id) {
    return null;
  }
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

/**
 * Full normalizer for single-workflow GET responses.
 *
 * Tradeoff: the list endpoint stays shallow (id/name/type only) to keep
 * sidebar payloads small — n8n workflows can have hundreds of nodes with
 * large parameter blobs. The single-workflow endpoint passes through
 * position, parameters, and connections so the graph viewer has everything
 * it needs without a second request.
 */
function normalizeWorkflowFull(raw: unknown): N8nWorkflow | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : String(obj.id ?? "");
  const name = typeof obj.name === "string" ? obj.name : "";
  if (!id) {
    return null;
  }
  const nodesRaw = Array.isArray(obj.nodes) ? obj.nodes : [];
  const nodes = nodesRaw.map(sanitizeNodeFull);

  // connections: n8n's connection map is a plain object keyed by source node
  // name. We pass it through as-is — it contains no credential material.
  const connections =
    obj.connections && typeof obj.connections === "object"
      ? (obj.connections as N8nWorkflow["connections"])
      : undefined;

  return {
    id,
    name,
    active: Boolean(obj.active),
    ...(typeof obj.description === "string"
      ? { description: obj.description }
      : {}),
    nodes,
    nodeCount: nodes.length,
    ...(connections !== undefined ? { connections } : {}),
  };
}

interface ProxyTarget {
  url: string;
  headers: Record<string, string>;
}

/**
 * Resolve the backend target for a workflow-CRUD call. Returns null target
 * if the n8n backend is not currently available; caller emits a 503.
 *
 * `sidecar` is passed in so the caller can either skip the sidecar module
 * import on mobile (where it is unsupported) or inject a test stub. When
 * `sidecar` is undefined, the handler treats that as "no sidecar singleton
 * yet" — identical to the old `peekN8nSidecar()` → `null` case.
 */
function resolveProxyTarget(
  ctx: N8nRouteContext,
  subpath: string,
  sidecar: N8nSidecar | null,
  native: boolean,
): {
  target: ProxyTarget | null;
  reason?: {
    message: string;
    status: N8nSidecarStatus;
  };
} {
  const { cloudConnected, localEnabled } = resolveN8nMode({
    config: ctx.config,
    runtime: ctx.runtime,
    native,
  });
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

  // Mobile has no local sidecar path — treat as disabled when cloud is not
  // authenticated so the UI gets a 503 with a clear reason rather than
  // probing a sidecar that does not exist. resolveN8nMode already applied
  // the mobile override above.
  if (!localEnabled) {
    return {
      target: null,
      reason: { message: "n8n disabled", status: "stopped" },
    };
  }

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
  if (apiKey) {
    headers["X-N8N-API-KEY"] = apiKey;
  }

  // n8n serves TWO parallel workflow APIs:
  //   /rest/workflows   — internal UI endpoint, requires JWT cookie auth.
  //   /api/v1/workflows — public API, accepts X-N8N-API-KEY.
  // We provision an X-N8N-API-KEY during boot, so the public API is the
  // only path that authenticates correctly. Hitting /rest/ was returning
  // 401 "Unauthorized" even with a valid key — that's the wrong endpoint.
  return {
    target: {
      url: `${host.replace(/\/+$/, "")}/api/v1/workflows${subpath}`,
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
  if (init.body !== null && init.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetchImpl(target.url, {
      method: init.method,
      headers,
      ...(init.body !== null && init.body !== undefined
        ? { body: init.body }
        : {}),
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
    } catch {}
  } else {
    try {
      parsed = await res.text();
    } catch {}
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Extracts a workflows array from an n8n or cloud-gateway list response.
 * n8n returns `{ data: [...] }`; our cloud gateway may return `{ workflows }`
 * or `{ data }`. We accept both.
 */
function extractWorkflowList(body: unknown): unknown[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const obj = body as Record<string, unknown>;
  if (Array.isArray(obj.workflows)) {
    return obj.workflows;
  }
  if (Array.isArray(obj.data)) {
    return obj.data;
  }
  return [];
}

function extractWorkflowSingle(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return null;
  }
  const obj = body as Record<string, unknown>;
  if (obj.data && typeof obj.data === "object") {
    return obj.data;
  }
  if (obj.workflow && typeof obj.workflow === "object") {
    return obj.workflow;
  }
  return body;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readOptionalBoolean(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = obj[key];
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Shape of the routing block we hand to the n8n workflow service so the
 * generator can target "this channel" / "back to here" without the user
 * naming an ID. Mirrors the upstream `TriggerContext` in
 * `@elizaos/plugin-n8n-workflow` — duplicated here so this route doesn't
 * import from the plugin (the host already has its own copy in the
 * runtime context provider, and the LLM ultimately reads it as a
 * `## Runtime Facts` line, not via the plugin's prompt builder).
 */
interface TriggerContext {
  source?: string;
  discord?: { channelId?: string; guildId?: string; threadId?: string };
  telegram?: { chatId?: string | number; threadId?: string | number };
  slack?: { channelId?: string; teamId?: string };
  resolvedNames?: { channel?: string; server?: string };
}

/**
 * Read the originating conversation's tail inbound message metadata and
 * derive a `TriggerContext`. Reads both the canonical
 * `metadata.discord.{channelId,guildId,messageId}` /
 * `metadata.telegram.{chatId,threadId}` blocks AND the flat
 * `discordChannelId` / `discordServerId` / `discordMessageId` fields the
 * upstream Discord plugin currently writes (pre-existing schema gap —
 * canonical wins when present, flat is the fallback so nothing today
 * breaks).
 *
 * Returns `undefined` when the conversation has no inbound platform
 * metadata or the runtime can't read memories.
 */
async function buildTriggerContextFromConversation(
  runtime: AgentRuntime | null | undefined,
  roomId: string,
): Promise<TriggerContext | undefined> {
  if (!runtime || typeof runtime.getMemories !== "function") {
    return undefined;
  }
  let memories: Array<{
    entityId?: string;
    metadata?: Record<string, unknown>;
  }>;
  try {
    memories = (await runtime.getMemories({
      roomId: roomId as never,
      tableName: "messages",
      count: 12,
    } as Parameters<typeof runtime.getMemories>[0])) as Array<{
      entityId?: string;
      metadata?: Record<string, unknown>;
    }>;
  } catch (err) {
    logger.debug?.(
      `[n8n-routes] buildTriggerContextFromConversation: getMemories threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
  if (!Array.isArray(memories) || memories.length === 0) {
    return undefined;
  }

  // Tail inbound = most recent memory whose entityId is NOT the agent.
  // `runtime.getMemories` typically returns most-recent-first; defensively
  // handle either order.
  const inbound = memories.find(
    (m) => m.entityId && m.entityId !== runtime.agentId,
  );
  if (!inbound?.metadata) {
    return undefined;
  }

  const meta = inbound.metadata as Record<string, unknown>;
  const discord = (meta.discord ?? {}) as Record<string, unknown>;
  const telegram = (meta.telegram ?? {}) as Record<string, unknown>;
  const slack = (meta.slack ?? {}) as Record<string, unknown>;

  // Canonical wins; flat fields are the legacy de-facto shape.
  const discordChannelId =
    (typeof discord.channelId === "string" ? discord.channelId : undefined) ??
    (typeof meta.discordChannelId === "string"
      ? meta.discordChannelId
      : undefined);
  const discordGuildId =
    (typeof discord.guildId === "string" ? discord.guildId : undefined) ??
    (typeof meta.discordServerId === "string"
      ? meta.discordServerId
      : undefined);
  const discordThreadId =
    typeof discord.threadId === "string" ? discord.threadId : undefined;

  // No `meta.fromId` fallback for Telegram: `fromId` is the sender's user
  // id, which equals the chat id only in private 1:1 DMs. In group chats /
  // channels the chat id is a distinct (typically negative) integer, so
  // falling back to fromId would silently route the workflow to the wrong
  // entity. Only use the canonical `metadata.telegram.chatId`. If the
  // upstream Telegram plugin hasn't populated it yet, we skip Telegram
  // routing rather than guess.
  const telegramChatId =
    typeof telegram.chatId === "string" || typeof telegram.chatId === "number"
      ? telegram.chatId
      : undefined;
  const telegramThreadId =
    typeof telegram.threadId === "string" ||
    typeof telegram.threadId === "number"
      ? (telegram.threadId as string | number)
      : undefined;

  const slackChannelId =
    typeof slack.channelId === "string" ? slack.channelId : undefined;
  const slackTeamId =
    typeof slack.teamId === "string" ? slack.teamId : undefined;

  if (discordChannelId) {
    return {
      source: "discord",
      discord: {
        ...(discordChannelId ? { channelId: discordChannelId } : {}),
        ...(discordGuildId ? { guildId: discordGuildId } : {}),
        ...(discordThreadId ? { threadId: discordThreadId } : {}),
      },
    };
  }
  if (telegramChatId !== undefined) {
    return {
      source: "telegram",
      telegram: {
        chatId: telegramChatId,
        ...(telegramThreadId !== undefined
          ? { threadId: telegramThreadId }
          : {}),
      },
    };
  }
  if (slackChannelId) {
    return {
      source: "slack",
      slack: {
        channelId: slackChannelId,
        ...(slackTeamId ? { teamId: slackTeamId } : {}),
      },
    };
  }
  return undefined;
}

function readPosition(value: unknown): [number, number] | null {
  return Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
    ? [value[0], value[1]]
    : null;
}

function readCredentials(
  value: unknown,
): Record<string, { id: string; name: string }> | undefined {
  const raw = asRecord(value);
  if (!raw) {
    return undefined;
  }

  const credentials: Record<string, { id: string; name: string }> = {};
  for (const [key, credentialValue] of Object.entries(raw)) {
    const credential = asRecord(credentialValue);
    if (!credential) {
      continue;
    }
    const id = readOptionalString(credential, "id");
    const name = readOptionalString(credential, "name");
    if (!id || !name) {
      continue;
    }
    credentials[key] = { id, name };
  }
  return Object.keys(credentials).length > 0 ? credentials : undefined;
}

function normalizeWorkflowWriteNode(
  value: unknown,
  index: number,
): N8nWorkflowWriteNode | null {
  const obj = asRecord(value);
  if (!obj) {
    return null;
  }

  const name = readOptionalString(obj, "name");
  const type = readOptionalString(obj, "type");
  if (!name || !type) {
    return null;
  }

  const position = readPosition(obj.position) ?? [index * 260, 0];
  const parameters = asRecord(obj.parameters) ?? {};
  const typeVersion = readOptionalNumber(obj, "typeVersion") ?? 1;
  const credentials = readCredentials(obj.credentials);

  return {
    ...(readOptionalString(obj, "id")
      ? { id: readOptionalString(obj, "id") }
      : {}),
    name,
    type,
    typeVersion,
    position,
    parameters,
    ...(credentials ? { credentials } : {}),
    ...(readOptionalBoolean(obj, "disabled") !== undefined
      ? { disabled: readOptionalBoolean(obj, "disabled") }
      : {}),
    ...(readOptionalString(obj, "notes")
      ? { notes: readOptionalString(obj, "notes") }
      : {}),
    ...(readOptionalBoolean(obj, "notesInFlow") !== undefined
      ? { notesInFlow: readOptionalBoolean(obj, "notesInFlow") }
      : {}),
    ...(readOptionalString(obj, "color")
      ? { color: readOptionalString(obj, "color") }
      : {}),
    ...(readOptionalBoolean(obj, "continueOnFail") !== undefined
      ? { continueOnFail: readOptionalBoolean(obj, "continueOnFail") }
      : {}),
    ...(readOptionalBoolean(obj, "executeOnce") !== undefined
      ? { executeOnce: readOptionalBoolean(obj, "executeOnce") }
      : {}),
    ...(readOptionalBoolean(obj, "alwaysOutputData") !== undefined
      ? { alwaysOutputData: readOptionalBoolean(obj, "alwaysOutputData") }
      : {}),
    ...(readOptionalBoolean(obj, "retryOnFail") !== undefined
      ? { retryOnFail: readOptionalBoolean(obj, "retryOnFail") }
      : {}),
    ...(readOptionalNumber(obj, "maxTries") !== undefined
      ? { maxTries: readOptionalNumber(obj, "maxTries") }
      : {}),
    ...(readOptionalNumber(obj, "waitBetweenTries") !== undefined
      ? { waitBetweenTries: readOptionalNumber(obj, "waitBetweenTries") }
      : {}),
    ...(obj.onError === "continueErrorOutput" ||
    obj.onError === "continueRegularOutput" ||
    obj.onError === "stopWorkflow"
      ? { onError: obj.onError }
      : {}),
  };
}

function normalizeWorkflowConnections(value: unknown): N8nWorkflowConnections {
  const raw = asRecord(value);
  if (!raw) {
    return {};
  }

  const connections: N8nWorkflowConnections = {};
  for (const [sourceName, outputValue] of Object.entries(raw)) {
    const outputMap = asRecord(outputValue);
    if (!outputMap) {
      continue;
    }
    const mainRaw = outputMap.main;
    if (!Array.isArray(mainRaw)) {
      continue;
    }
    const main = mainRaw.map((group) =>
      Array.isArray(group)
        ? group
            .map((connection) => {
              const obj = asRecord(connection);
              const node = obj ? readOptionalString(obj, "node") : undefined;
              if (!obj || !node) {
                return null;
              }
              const index = readOptionalNumber(obj, "index") ?? 0;
              return { node, type: "main" as const, index };
            })
            .filter(
              (
                connection,
              ): connection is { node: string; type: "main"; index: number } =>
                connection !== null,
            )
        : [],
    );
    connections[sourceName] = { main };
  }
  return connections;
}

function normalizeWorkflowWritePayload(body: Record<string, unknown>): {
  payload?: N8nWorkflowWritePayload;
  error?: string;
} {
  const name = readOptionalString(body, "name");
  if (!name) {
    return { error: "workflow name required" };
  }

  const nodesRaw = Array.isArray(body.nodes) ? body.nodes : [];
  const nodes = nodesRaw
    .map((node, index) => normalizeWorkflowWriteNode(node, index))
    .filter((node): node is N8nWorkflowWriteNode => node !== null);
  if (nodes.length === 0) {
    return { error: "workflow must include at least one valid node" };
  }

  return {
    payload: {
      name,
      nodes,
      connections: normalizeWorkflowConnections(body.connections),
      settings: asRecord(body.settings) ?? {},
    },
  };
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
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  if (!rest) {
    return null;
  }
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

/**
 * Resolve the sidecar singleton for this request. On mobile the sidecar
 * module is never imported; callers receive `null` and the downstream
 * resolver treats that as "no local backend available". Tests inject a
 * concrete stub via `ctx.n8nSidecar`.
 */
async function resolveSidecarForRequest(
  ctx: N8nRouteContext,
  native: boolean,
): Promise<N8nSidecar | null> {
  if (ctx.n8nSidecar !== undefined) {
    return ctx.n8nSidecar;
  }
  if (native) {
    return null;
  }
  const mod = await loadSidecarModule();
  return mod?.peekN8nSidecar() ?? null;
}

export async function handleN8nRoutes(ctx: N8nRouteContext): Promise<boolean> {
  const { method, pathname, config } = ctx;
  const native = ctx.isNativePlatform ?? isNativeServerPlatform();

  // --- Status ---------------------------------------------------------------
  if (method === "GET" && pathname === "/api/n8n/status") {
    const sidecar = await resolveSidecarForRequest(ctx, native);
    return handleStatus(ctx, sidecar, native);
  }

  // --- Sidecar start (fire-and-forget) --------------------------------------
  if (method === "POST" && pathname === "/api/n8n/sidecar/start") {
    if (native) {
      sendJson(ctx, 409, {
        error: "Local n8n not supported on mobile. Use Eliza Cloud.",
        platform: "mobile" satisfies N8nHostPlatform,
      });
      return true;
    }
    const mod = await loadSidecarModule();
    const sidecar =
      ctx.n8nSidecar ??
      mod?.getN8nSidecar({
        enabled: config.n8n?.localEnabled ?? true,
        ...(config.n8n?.version ? { version: config.n8n.version } : {}),
        ...(config.n8n?.startPort ? { startPort: config.n8n.startPort } : {}),
      });
    if (!sidecar) {
      // Desktop path with no sidecar module reachable — treat as a hard
      // failure rather than pretending the boot succeeded.
      sendJson(ctx, 500, { error: "n8n sidecar module unavailable" });
      return true;
    }
    void sidecar.start();
    sendJson(ctx, 202, { ok: true });
    return true;
  }

  // --- Workflows list -------------------------------------------------------
  if (method === "GET" && pathname === "/api/n8n/workflows") {
    const sidecar = await resolveSidecarForRequest(ctx, native);
    return handleListWorkflows(ctx, sidecar, native);
  }

  // --- Workflow generation / creation --------------------------------------
  if (method === "POST" && pathname === "/api/n8n/workflows/generate") {
    return handleGenerateWorkflow(ctx);
  }

  if (
    method === "POST" &&
    pathname === "/api/n8n/workflows/resolve-clarification"
  ) {
    return handleResolveClarification(ctx);
  }

  if (method === "POST" && pathname === "/api/n8n/workflows") {
    const sidecar = await resolveSidecarForRequest(ctx, native);
    return handleCreateWorkflow(ctx, sidecar, native);
  }

  // --- Workflow CRUD --------------------------------------------------------
  const parsed = parseWorkflowPath(pathname);
  if (parsed) {
    if (method === "POST" && parsed.action === "activate") {
      const sidecar = await resolveSidecarForRequest(ctx, native);
      return handleToggleWorkflow(ctx, parsed.id, true, sidecar, native);
    }
    if (method === "POST" && parsed.action === "deactivate") {
      const sidecar = await resolveSidecarForRequest(ctx, native);
      return handleToggleWorkflow(ctx, parsed.id, false, sidecar, native);
    }
    if (method === "GET" && parsed.action === "get") {
      const sidecar = await resolveSidecarForRequest(ctx, native);
      return handleGetWorkflow(ctx, parsed.id, sidecar, native);
    }
    if (method === "PUT" && parsed.action === "get") {
      const sidecar = await resolveSidecarForRequest(ctx, native);
      return handleUpdateWorkflow(ctx, parsed.id, sidecar, native);
    }
    if (method === "DELETE" && parsed.action === "get") {
      const sidecar = await resolveSidecarForRequest(ctx, native);
      return handleDeleteWorkflow(ctx, parsed.id, sidecar, native);
    }
  }

  return false;
}

async function handleStatus(
  ctx: N8nRouteContext,
  sidecar: N8nSidecar | null,
  native: boolean,
): Promise<boolean> {
  const { config, runtime } = ctx;

  const { mode, localEnabled, cloudConnected } = resolveN8nMode({
    config,
    runtime,
    native,
  });
  const sidecarState = sidecar?.getState();
  const status: N8nSidecarStatus = sidecarState?.status ?? "stopped";

  const host =
    mode === "local" ? (sidecarState?.host ?? config.n8n?.host ?? null) : null;

  // Cloud health — only probed when we are actually in cloud mode. The
  // probe is cached for 30s (see getCloudHealth) so rapid status polls
  // don't hammer the gateway. Tests inject cloudHealthOverride to bypass.
  let cloudHealth: N8nCloudHealth = "unknown";
  if (mode === "cloud") {
    if (ctx.cloudHealthOverride !== undefined) {
      cloudHealth = ctx.cloudHealthOverride;
    } else {
      cloudHealth = await getCloudHealth(
        config.cloud?.baseUrl ?? DEFAULT_CLOUD_API_BASE_URL,
        ctx.fetchImpl ?? fetch,
      );
    }
  }

  const payload: N8nStatusResponse = {
    mode,
    host,
    status,
    cloudConnected,
    localEnabled,
    platform: native ? "mobile" : "desktop",
    cloudHealth,
    ...(sidecarState
      ? {
          errorMessage: sidecarState.errorMessage,
          retries: sidecarState.retries,
          recentOutput: sidecarState.recentOutput,
        }
      : {}),
  };

  // Match previous behavior: 200 via ctx.json.
  ctx.json(ctx.res, payload);
  return true;
}

async function handleListWorkflows(
  ctx: N8nRouteContext,
  sidecar: N8nSidecar | null,
  native: boolean,
): Promise<boolean> {
  const resolved = resolveProxyTarget(ctx, "", sidecar, native);
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

/**
 * GET /api/n8n/workflows/:id — single-workflow fetch with full graph payload.
 *
 * Unlike the list endpoint (which stays shallow for sidebar performance),
 * this response includes node `position`, `parameters`, and the `connections`
 * map so the graph viewer can render nodes and edges without a second request.
 * Credentials are still stripped from node descriptors.
 */
async function handleGetWorkflow(
  ctx: N8nRouteContext,
  id: string,
  sidecar: N8nSidecar | null,
  native: boolean,
): Promise<boolean> {
  if (!id) {
    sendJson(ctx, 400, { error: "workflow id required" });
    return true;
  }

  const subpath = `/${encodeURIComponent(id)}`;
  const resolved = resolveProxyTarget(ctx, subpath, sidecar, native);
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

  const single = extractWorkflowSingle(upstream.body);
  const normalized = normalizeWorkflowFull(single);
  if (!normalized) {
    sendJson(ctx, 502, { error: "unexpected upstream shape" });
    return true;
  }
  sendJson(ctx, 200, normalized);
  return true;
}

async function writeWorkflow(
  ctx: N8nRouteContext,
  method: "POST" | "PUT",
  subpath: string,
  payload: N8nWorkflowWritePayload,
  sidecar: N8nSidecar | null,
  native: boolean,
): Promise<boolean> {
  const resolved = resolveProxyTarget(ctx, subpath, sidecar, native);
  if (!resolved.target) {
    sendJson(ctx, 503, {
      error: resolved.reason?.message ?? "n8n not ready",
      status: resolved.reason?.status ?? "stopped",
    });
    return true;
  }

  const upstream = await fetchTargetAsJson(ctx, resolved.target, {
    method,
    body: JSON.stringify(payload),
  });
  if (!upstream.ok) {
    propagateError(ctx, upstream);
    return true;
  }

  const single = extractWorkflowSingle(upstream.body);
  const normalized = normalizeWorkflowFull(single);
  if (!normalized) {
    sendJson(ctx, 502, { error: "unexpected upstream shape" });
    return true;
  }
  sendJson(ctx, 200, normalized);
  return true;
}

async function handleCreateWorkflow(
  ctx: N8nRouteContext,
  sidecar: N8nSidecar | null,
  native: boolean,
): Promise<boolean> {
  const body = await readCompatJsonBody(ctx.req, ctx.res);
  if (!body) {
    return true;
  }

  const { payload, error } = normalizeWorkflowWritePayload(body);
  if (!payload) {
    sendJson(ctx, 400, { error: error ?? "invalid workflow payload" });
    return true;
  }

  return writeWorkflow(ctx, "POST", "", payload, sidecar, native);
}

async function handleUpdateWorkflow(
  ctx: N8nRouteContext,
  id: string,
  sidecar: N8nSidecar | null,
  native: boolean,
): Promise<boolean> {
  if (!id) {
    sendJson(ctx, 400, { error: "workflow id required" });
    return true;
  }

  const body = await readCompatJsonBody(ctx.req, ctx.res);
  if (!body) {
    return true;
  }

  const { payload, error } = normalizeWorkflowWritePayload(body);
  if (!payload) {
    sendJson(ctx, 400, { error: error ?? "invalid workflow payload" });
    return true;
  }

  return writeWorkflow(
    ctx,
    "PUT",
    `/${encodeURIComponent(id)}`,
    payload,
    sidecar,
    native,
  );
}

interface N8nWorkflowServiceLike {
  generateWorkflowDraft?: (
    prompt: string,
    opts?: { triggerContext?: TriggerContext },
  ) => Promise<{
    id?: string;
    [k: string]: unknown;
  }>;
  deployWorkflow?: (
    workflow: Record<string, unknown>,
    userId: string,
  ) => Promise<{
    id: string;
    name: string;
    active: boolean;
    missingCredentials: Array<{ credType: string; authUrl?: string }>;
  }>;
  getWorkflow?: (id: string) => Promise<Record<string, unknown>>;
}

function getN8nWorkflowService(
  ctx: N8nRouteContext,
): N8nWorkflowServiceLike | null {
  const service = ctx.runtime?.getService?.("n8n_workflow") as
    | N8nWorkflowServiceLike
    | undefined;
  if (
    typeof service?.generateWorkflowDraft !== "function" ||
    typeof service.deployWorkflow !== "function" ||
    typeof service.getWorkflow !== "function"
  ) {
    return null;
  }
  return service;
}

function getConnectorTargetCatalog(ctx: N8nRouteContext): CatalogLike | null {
  // The runtime registers the catalog in `runtime.services` keyed by
  // `connector_target_catalog`. We use the same lookup pattern as the
  // n8n_workflow service. Falling back to null is fine — the route then
  // returns clarifications without a catalog and the UI renders free-text
  // inputs only.
  const candidate = ctx.runtime?.getService?.("connector_target_catalog") as
    | CatalogLike
    | undefined;
  if (candidate && typeof candidate.listGroups === "function") {
    return candidate;
  }
  return null;
}

async function deployAndRespond(
  ctx: N8nRouteContext,
  service: N8nWorkflowServiceLike,
  draft: Record<string, unknown>,
): Promise<void> {
  const userId = resolveAgentId(ctx);
  const deployed = await service.deployWorkflow?.(draft, userId);
  if (!deployed) {
    sendJson(ctx, 500, { error: "deployWorkflow not available" });
    return;
  }
  if (deployed.missingCredentials.length > 0) {
    sendJson(ctx, 200, {
      ...deployed,
      warning: "missing credentials",
    });
    return;
  }
  const full = await service.getWorkflow?.(deployed.id);
  sendJson(ctx, 200, full);
}

async function handleGenerateWorkflow(ctx: N8nRouteContext): Promise<boolean> {
  const body = await readCompatJsonBody(ctx.req, ctx.res);
  if (!body) {
    return true;
  }

  const prompt = readOptionalString(body, "prompt");
  if (!prompt) {
    sendJson(ctx, 400, { error: "prompt required" });
    return true;
  }

  const name = readOptionalString(body, "name");
  const workflowId = readOptionalString(body, "workflowId");
  const bridgeConversationId = readOptionalString(body, "bridgeConversationId");

  const service = getN8nWorkflowService(ctx);
  if (!service) {
    sendJson(ctx, 503, { error: "n8n workflow service unavailable" });
    return true;
  }

  const triggerContext = bridgeConversationId
    ? await buildTriggerContextFromConversation(
        ctx.runtime,
        bridgeConversationId,
      )
    : undefined;

  const draft = triggerContext
    ? await service.generateWorkflowDraft?.(prompt, { triggerContext })
    : await service.generateWorkflowDraft?.(prompt);
  if (name?.trim()) {
    (draft as Record<string, unknown>).name = name.trim();
  }
  if (workflowId) {
    (draft as Record<string, unknown>).id = workflowId;
  }

  // If the LLM emitted clarifications, short-circuit before deploy and ask
  // the host to render quick-picks. The draft is preserved verbatim so the
  // client can post it back to /resolve-clarification with the user's
  // chosen values.
  const meta = (draft as { _meta?: Record<string, unknown> })._meta;
  const rawClarifications = meta?.requiresClarification;
  const clarifications = coerceClarifications(rawClarifications);
  if (clarifications.length > 0) {
    const catalogService = getConnectorTargetCatalog(ctx);
    const catalog = catalogService
      ? await buildCatalogSnapshot(catalogService, clarifications)
      : [];
    sendJson(ctx, 200, {
      status: "needs_clarification",
      draft,
      clarifications,
      catalog,
    });
    return true;
  }

  await deployAndRespond(ctx, service, draft as Record<string, unknown>);
  return true;
}

async function handleResolveClarification(
  ctx: N8nRouteContext,
): Promise<boolean> {
  const body = await readCompatJsonBody(ctx.req, ctx.res);
  if (!body) {
    return true;
  }

  const draftRaw = (body as Record<string, unknown>).draft;
  if (!draftRaw || typeof draftRaw !== "object" || Array.isArray(draftRaw)) {
    sendJson(ctx, 400, { error: "draft required" });
    return true;
  }
  const draft = draftRaw as Record<string, unknown>;

  const resolutionsRaw = (body as Record<string, unknown>).resolutions;
  if (!Array.isArray(resolutionsRaw) || resolutionsRaw.length === 0) {
    sendJson(ctx, 400, { error: "resolutions required" });
    return true;
  }
  const resolutions = resolutionsRaw as Array<{
    paramPath?: unknown;
    value?: unknown;
  }>;

  const name = readOptionalString(body, "name");
  const workflowId = readOptionalString(body, "workflowId");

  const service = getN8nWorkflowService(ctx);
  if (!service) {
    sendJson(ctx, 503, { error: "n8n workflow service unavailable" });
    return true;
  }

  const result = applyResolutions(
    draft,
    resolutions as Array<{ paramPath: string; value: string }>,
  );
  if (!result.ok) {
    sendJson(ctx, 400, {
      error: result.error,
      paramPath: result.paramPath,
    });
    return true;
  }

  const resolvedPaths = new Set(
    resolutions
      .map((r) => r.paramPath)
      .filter((p): p is string => typeof p === "string" && p.length > 0),
  );
  const freeFormCount = resolutions.filter(
    (r) => typeof r.paramPath !== "string" || r.paramPath.length === 0,
  ).length;
  pruneResolvedClarifications(draft, resolvedPaths, freeFormCount);

  if (name?.trim()) {
    draft.name = name.trim();
  }
  if (workflowId) {
    draft.id = workflowId;
  }

  // If the LLM emitted multiple clarifications and the client only resolved
  // a subset (e.g. server first, channel pending), return the still-pending
  // clarifications so the UI can chain a second picker. Otherwise deploy.
  const meta = (draft as { _meta?: Record<string, unknown> })._meta;
  const remaining = coerceClarifications(meta?.requiresClarification);
  if (remaining.length > 0) {
    const catalogService = getConnectorTargetCatalog(ctx);
    const catalog = catalogService
      ? await buildCatalogSnapshot(catalogService, remaining)
      : [];
    sendJson(ctx, 200, {
      status: "needs_clarification",
      draft,
      clarifications: remaining,
      catalog,
    });
    return true;
  }

  await deployAndRespond(ctx, service, draft);
  return true;
}

async function handleToggleWorkflow(
  ctx: N8nRouteContext,
  id: string,
  activate: boolean,
  sidecar: N8nSidecar | null,
  native: boolean,
): Promise<boolean> {
  if (!id) {
    sendJson(ctx, 400, { error: "workflow id required" });
    return true;
  }

  const subpath = `/${encodeURIComponent(id)}/${activate ? "activate" : "deactivate"}`;
  const resolved = resolveProxyTarget(ctx, subpath, sidecar, native);
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
  sidecar: N8nSidecar | null,
  native: boolean,
): Promise<boolean> {
  if (!id) {
    sendJson(ctx, 400, { error: "workflow id required" });
    return true;
  }

  const resolved = resolveProxyTarget(
    ctx,
    `/${encodeURIComponent(id)}`,
    sidecar,
    native,
  );
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
