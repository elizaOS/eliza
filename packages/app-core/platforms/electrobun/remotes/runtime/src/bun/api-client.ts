/** Implements Electrobun runtime remote api client ts boundaries for desktop app-core. */
import { createApiBridgeError, isApiBridgeError } from "./errors.ts";
import type {
  AgentMessageParams,
  AgentMessageResult,
  AgentSummary,
  ApiDiscoveryResult,
  ConversationSummary,
  RuntimeHealthAttempt,
  RuntimeHealthResult,
} from "./protocol.ts";
import {
  clearRuntimeApiDiscoveryCache,
  discoverRuntimeApiRoutes,
  findAvailableRoute,
} from "./route-discovery.ts";

const HEALTH_PATHS = ["/api/dev/stack", "/api/status", "/api/health"] as const;
const DEFAULT_TIMEOUT_MS = 1500;
const API_REQUEST_TIMEOUT_MS = 2500;

function joinApiPath(apiBase: string, path: string): string {
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  return `${base}${path}`;
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function errorMessage(error: Error): string {
  return error.message.length > 0 ? error.message : error.name;
}

async function fetchProbe(
  apiBase: string,
  path: string,
  timeoutMs: number,
): Promise<{ attempt: RuntimeHealthAttempt; body: string | null }> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(joinApiPath(apiBase, path), {
      signal: controller.signal,
    });
    const body = (await response.text()).slice(0, 4000);
    return {
      attempt: {
        path,
        ok: response.ok,
        status: response.status,
        elapsedMs: elapsedSince(startedAt),
        error: response.ok ? null : `HTTP ${response.status}`,
      },
      body,
    };
  } catch (error) {
    const message =
      error instanceof Error ? errorMessage(error) : "Health probe failed";
    return {
      attempt: {
        path,
        ok: false,
        status: null,
        elapsedMs: elapsedSince(startedAt),
        error: message,
      },
      body: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeRuntimeApi(
  apiBase: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RuntimeHealthResult> {
  const startedAt = performance.now();
  const attempts: RuntimeHealthAttempt[] = [];

  for (const path of HEALTH_PATHS) {
    const result = await fetchProbe(apiBase, path, timeoutMs);
    attempts.push(result.attempt);
    if (result.attempt.ok && result.attempt.status !== null) {
      return {
        ok: true,
        apiBase,
        path,
        status: result.attempt.status,
        elapsedMs: elapsedSince(startedAt),
        body: result.body ?? "",
        attempts,
      };
    }
  }

  const lastAttempt = attempts[attempts.length - 1];
  return {
    ok: false,
    apiBase,
    path: null,
    status: null,
    elapsedMs: elapsedSince(startedAt),
    error: lastAttempt?.error ?? "Runtime API did not respond",
    attempts,
  };
}

type ApiClientOptions = {
  getApiBase: () => string | null;
  getAuthToken?: () => string | null;
};

type RequestMethod = "GET" | "POST";

type ApiRequestOptions = {
  method?: RequestMethod;
  path: string;
  body?: unknown;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function rawArray(value: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function metadataWithout(
  record: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) metadata[key] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeAgent(value: unknown): AgentSummary | null {
  if (!isRecord(value)) return null;
  const id =
    asString(value.id) ?? asString(value.agentId) ?? asString(value.uuid);
  if (id === undefined) return null;
  return {
    id,
    ...(asString(value.name) ? { name: asString(value.name) } : {}),
    ...(asString(value.status) ? { status: asString(value.status) } : {}),
    ...(metadataWithout(value, ["id", "agentId", "uuid", "name", "status"])
      ? {
          metadata: metadataWithout(value, [
            "id",
            "agentId",
            "uuid",
            "name",
            "status",
          ]),
        }
      : {}),
  };
}

function normalizeConversation(value: unknown): ConversationSummary | null {
  if (!isRecord(value)) return null;
  const id =
    asString(value.id) ??
    asString(value.conversationId) ??
    asString(value.uuid);
  if (id === undefined) return null;
  return {
    id,
    ...(asString(value.title) ? { title: asString(value.title) } : {}),
    ...(asString(value.agentId) ? { agentId: asString(value.agentId) } : {}),
    ...(asString(value.updatedAt)
      ? { updatedAt: asString(value.updatedAt) }
      : {}),
    ...(metadataWithout(value, [
      "id",
      "conversationId",
      "uuid",
      "title",
      "agentId",
      "updatedAt",
    ])
      ? {
          metadata: metadataWithout(value, [
            "id",
            "conversationId",
            "uuid",
            "title",
            "agentId",
            "updatedAt",
          ]),
        }
      : {}),
  };
}

function textFromResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return (
    asString(value.text) ??
    asString(value.message) ??
    asString(value.reply) ??
    asString(value.response)
  );
}

function idFromResponse(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = asString(value[key]);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function appendSearchParams(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const url = new URL(path, "http://runtime.local");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function resolveAuthToken(options: ApiClientOptions): string | null {
  const configured = options.getAuthToken?.();
  if (
    configured !== undefined &&
    configured !== null &&
    configured.trim().length > 0
  ) {
    return configured.trim();
  }
  const envToken =
    process.env.ELIZA_RUNTIME_API_TOKEN ?? process.env.ELIZA_API_TOKEN ?? null;
  return envToken !== null && envToken.trim().length > 0
    ? envToken.trim()
    : null;
}

export class ElizaRuntimeApiClient {
  private discovery: ApiDiscoveryResult | null = null;
  private readonly getApiBase: () => string | null;
  private readonly getAuthToken?: () => string | null;

  constructor(options: ApiClientOptions) {
    this.getApiBase = options.getApiBase;
    this.getAuthToken = options.getAuthToken;
  }

  async discover(refresh = true): Promise<ApiDiscoveryResult> {
    if (refresh) clearRuntimeApiDiscoveryCache();
    const result = await discoverRuntimeApiRoutes({
      apiBase: this.requireApiBase(),
      refresh,
    });
    this.discovery = result;
    return result;
  }

  async status(): Promise<unknown> {
    const route = await this.resolveRoute([
      "status.devStack",
      "status.status",
      "status.health",
    ]);
    return this.requestJson({ path: route.path });
  }

  async listAgents(): Promise<AgentSummary[]> {
    const route = await this.resolveRoute([
      "agents.api",
      "agents.root",
      "agents.runtime",
    ]);
    const raw = await this.requestJson({ path: route.path });
    const array = rawArray(raw, ["agents", "data", "items"]);
    if (array === null) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "Agent list response did not contain an agent array.",
        method: "GET",
        path: route.path,
        details: raw,
      });
    }
    return array.map(normalizeAgent).filter((agent) => agent !== null);
  }

  async getAgent(agentId: string): Promise<unknown> {
    const encoded = encodeURIComponent(agentId);
    const paths = [
      `/api/agents/${encoded}`,
      `/agents/${encoded}`,
      `/api/runtime/agents/${encoded}`,
    ];
    for (const path of paths) {
      try {
        return await this.requestJson({ path });
      } catch (error) {
        if (!this.isRouteMiss(error)) throw error;
      }
    }
    const agents = await this.listAgents();
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (agent !== undefined) return agent;
    throw createApiBridgeError({
      code: "ROUTE_UNAVAILABLE",
      message: `No compatible agent detail route is available for ${agentId}.`,
      method: "GET",
      path: "/api/agents/:agentId",
    });
  }

  async sendMessage(params: AgentMessageParams): Promise<AgentMessageResult> {
    const text = params.text.trim();
    if (text.length === 0) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "agent.message requires non-empty text.",
        method: "POST",
      });
    }
    const conversationId =
      params.conversationId ??
      (await this.createConversation(text, params.agentId));
    const path = `/api/conversations/${encodeURIComponent(conversationId)}/messages`;
    const raw = await this.requestJson({
      method: "POST",
      path,
      body: {
        text,
        source: "elizalaunch",
        ...(params.agentId !== undefined || params.attachments
          ? {
              metadata: {
                ...(params.agentId === undefined
                  ? {}
                  : { agentId: params.agentId }),
                ...(params.attachments
                  ? { attachments: params.attachments }
                  : {}),
              },
            }
          : {}),
      },
    });
    return {
      ok: true,
      conversationId,
      ...(idFromResponse(raw, ["messageId", "id"]) !== undefined
        ? { messageId: idFromResponse(raw, ["messageId", "id"]) }
        : {}),
      ...(textFromResponse(raw) !== undefined
        ? { text: textFromResponse(raw) }
        : {}),
      raw,
    };
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const route = await this.resolveRoute([
      "conversations.api",
      "conversations.root",
    ]);
    const raw = await this.requestJson({ path: route.path });
    const array = rawArray(raw, ["conversations", "data", "items"]);
    if (array === null) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message:
          "Conversation list response did not contain a conversation array.",
        method: "GET",
        path: route.path,
        details: raw,
      });
    }
    return array
      .map(normalizeConversation)
      .filter((conversation) => conversation !== null);
  }

  async getConversation(conversationId: string): Promise<unknown> {
    const encoded = encodeURIComponent(conversationId);
    const paths = [
      `/api/conversations/${encoded}`,
      `/api/conversations/${encoded}/messages`,
      `/conversations/${encoded}`,
    ];
    for (const path of paths) {
      try {
        return await this.requestJson({ path });
      } catch (error) {
        if (!this.isRouteMiss(error)) throw error;
      }
    }
    throw createApiBridgeError({
      code: "ROUTE_UNAVAILABLE",
      message: `No compatible conversation detail route is available for ${conversationId}.`,
      method: "GET",
      path: "/api/conversations/:conversationId",
    });
  }

  async listPlugins(): Promise<unknown[]> {
    const route = await this.resolveRoute(["plugins.api", "plugins.root"]);
    const raw = await this.requestJson({ path: route.path });
    const array = rawArray(raw, ["plugins", "data", "items"]);
    if (array === null) return [raw];
    return array;
  }

  async searchMemory(params: {
    query: string;
    limit?: number;
    agentId?: string;
  }): Promise<unknown> {
    const query = params.query.trim();
    if (query.length === 0) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "memory.search requires a non-empty query.",
      });
    }
    const postRoutes = [
      "/api/memory/search",
      "/api/memories/search",
      "/memory/search",
    ];
    for (const path of postRoutes) {
      try {
        return await this.requestJson({
          method: "POST",
          path,
          body: {
            query,
            ...(params.limit === undefined ? {} : { limit: params.limit }),
            ...(params.agentId === undefined
              ? {}
              : { agentId: params.agentId }),
          },
        });
      } catch (error) {
        if (!this.isRouteMiss(error)) throw error;
      }
    }
    return this.requestJson({
      path: appendSearchParams("/api/memory/search", {
        q: query,
        limit: params.limit,
        agentId: params.agentId,
      }),
    });
  }

  async getConfig(): Promise<unknown> {
    return this.requestJson({ path: "/api/config" });
  }

  private requireApiBase(): string {
    const apiBase = this.getApiBase();
    if (apiBase === null || apiBase.trim().length === 0) {
      throw createApiBridgeError({
        code: "API_BASE_MISSING",
        message: "Runtime API base is not configured.",
      });
    }
    return apiBase.trim();
  }

  private async resolveRoute(names: string[]): Promise<{ path: string }> {
    if (this.discovery === null) {
      this.discovery = await discoverRuntimeApiRoutes({
        apiBase: this.requireApiBase(),
        refresh: false,
      });
    }
    const route = findAvailableRoute(this.discovery, names);
    if (route !== null) return { path: route.path };
    throw createApiBridgeError({
      code: "ROUTE_UNAVAILABLE",
      message: `No compatible route is available for ${names.join(", ")}.`,
      details: this.discovery.routes.filter((candidate) =>
        names.includes(candidate.name),
      ),
    });
  }

  private async requestJson(options: ApiRequestOptions): Promise<unknown> {
    const method = options.method ?? "GET";
    const apiBase = this.requireApiBase();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? API_REQUEST_TIMEOUT_MS,
    );
    try {
      const headers = new Headers({ Accept: "application/json" });
      const token = resolveAuthToken({
        getApiBase: this.getApiBase,
        getAuthToken: this.getAuthToken,
      });
      if (token !== null) headers.set("Authorization", `Bearer ${token}`);
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (options.body !== undefined) {
        headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(joinApiPath(apiBase, options.path), init);
      const text = await response.text();
      if (!response.ok) {
        throw createApiBridgeError({
          code:
            response.status === 404 || response.status === 405
              ? "ROUTE_UNAVAILABLE"
              : "REQUEST_FAILED",
          message: `Runtime API request failed with HTTP ${response.status}.`,
          method,
          path: options.path,
          status: response.status,
          details: text.slice(0, 2000),
        });
      }
      if (text.trim().length === 0) return { ok: true };
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw createApiBridgeError({
          code: "DECODE_FAILED",
          message: "Runtime API response was not valid JSON.",
          method,
          path: options.path,
          status: response.status,
          details: text.slice(0, 2000),
        });
      }
    } catch (error) {
      if (this.isBridgeError(error)) throw error;
      const message =
        error instanceof Error
          ? errorMessage(error)
          : "Runtime API request failed";
      throw createApiBridgeError({
        code: "REQUEST_FAILED",
        message,
        method,
        path: options.path,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async createConversation(
    text: string,
    agentId?: string,
  ): Promise<string> {
    const raw = await this.requestJson({
      method: "POST",
      path: "/api/conversations",
      body: {
        title: text
          .replace(/\s+/g, " ")
          .trim()
          .split(" ")
          .slice(0, 5)
          .join(" "),
        ...(agentId === undefined
          ? {}
          : { metadata: { source: "elizalaunch", agentId } }),
      },
    });
    const id =
      idFromResponse(raw, ["conversationId", "id"]) ??
      (isRecord(raw) && isRecord(raw.conversation)
        ? idFromResponse(raw.conversation, ["id", "conversationId"])
        : undefined);
    if (id === undefined) {
      throw createApiBridgeError({
        code: "DECODE_FAILED",
        message: "Conversation creation response did not include an id.",
        method: "POST",
        path: "/api/conversations",
        details: raw,
      });
    }
    return id;
  }

  private isBridgeError(error: unknown): boolean {
    return isApiBridgeError(error);
  }

  private isRouteMiss(error: unknown): boolean {
    return isRecord(error) && error.code === "ROUTE_UNAVAILABLE";
  }
}
