import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  isCloudInferenceSelectedInConfig,
  migrateLegacyRuntimeConfig,
} from "@elizaos/shared/contracts/onboarding";
import { normalizeCloudSiteUrl } from "../cloud/base-url.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import {
  readJsonBody as parseJsonBody,
  sendJson,
  sendJsonError,
} from "./http-helpers.js";
import { applyCanonicalOnboardingConfig } from "./provider-switch-config.js";

export interface CloudConfigLike {
  cloud?: {
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
  };
}

interface CloudClientLike {
  listAgents: () => Promise<unknown>;
  createAgent: (args: {
    agentName: string;
    agentConfig?: Record<string, unknown>;
    environmentVars?: Record<string, string>;
  }) => Promise<unknown>;
  deleteAgent: (agentId: string) => Promise<unknown>;
}

interface ConnectedCloudAgentLike {
  agentName: string;
}

interface CloudManagerLike {
  init?: () => Promise<void>;
  getClient: () => CloudClientLike | null;
  connect: (agentId: string) => Promise<ConnectedCloudAgentLike>;
  disconnect: () => Promise<void>;
  getStatus: () => unknown;
  getActiveAgentId: () => string | null;
}

interface RuntimeLike {
  agentId: string;
  character: {
    secrets?: Record<string, string | number | boolean>;
  };
  updateAgent: (
    agentId: string,
    update: {
      secrets: Record<string, string | number | boolean>;
    },
  ) => Promise<unknown>;
}

interface IntegrationTelemetrySpanLike {
  success: (args?: { statusCode?: number }) => void;
  failure: (args?: {
    statusCode?: number;
    error?: unknown;
    errorKind?: string;
  }) => void;
}

type CreateTelemetrySpanLike = (meta: {
  boundary: "cloud";
  operation: string;
  timeoutMs?: number;
}) => IntegrationTelemetrySpanLike;

export interface CloudRouteState {
  config: CloudConfigLike;
  cloudManager: CloudManagerLike | null;
  runtime: RuntimeLike | null;
  saveConfig?: (config: CloudConfigLike) => void;
  createTelemetrySpan?: CreateTelemetrySpanLike;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLOUD_LOGIN_CREATE_TIMEOUT_MS = 10_000;
const CLOUD_LOGIN_POLL_TIMEOUT_MS = 10_000;

function extractAgentId(pathname: string): string | null {
  const id = pathname.split("/")[4];
  return id && UUID_RE.test(id) ? id : null;
}

async function readJsonBody<T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | null> {
  return parseJsonBody(req, res, {
    maxBytes: 1_048_576,
    tooLargeMessage: "Request body too large",
    destroyOnTooLarge: true,
  });
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const message = error.message.toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}

function createNoopTelemetrySpan(): IntegrationTelemetrySpanLike {
  return {
    success: () => {},
    failure: () => {},
  };
}

function getTelemetrySpan(
  state: CloudRouteState,
  meta: {
    boundary: "cloud";
    operation: string;
    timeoutMs?: number;
  },
): IntegrationTelemetrySpanLike {
  return state.createTelemetrySpan?.(meta) ?? createNoopTelemetrySpan();
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(input, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function handleCloudRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudRouteState,
): Promise<boolean> {
  if (method === "POST" && pathname === "/api/cloud/login") {
    const baseUrl = normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
    const urlError = await validateCloudBaseUrl(baseUrl);
    if (urlError) {
      sendJsonError(res, urlError);
      return true;
    }
    const sessionId = crypto.randomUUID();
    const loginCreateSpan = getTelemetrySpan(state, {
      boundary: "cloud",
      operation: "login_create_session",
      timeoutMs: CLOUD_LOGIN_CREATE_TIMEOUT_MS,
    });

    let createRes: Response;
    try {
      createRes = await fetchWithTimeout(
        `${baseUrl}/api/auth/cli-session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        },
        CLOUD_LOGIN_CREATE_TIMEOUT_MS,
      );
    } catch (err) {
      if (isTimeoutError(err)) {
        loginCreateSpan.failure({ error: err, statusCode: 504 });
        sendJsonError(res, "Eliza Cloud login request timed out", 504);
        return true;
      }
      loginCreateSpan.failure({ error: err, statusCode: 502 });
      sendJsonError(res, "Failed to reach Eliza Cloud", 502);
      return true;
    }

    if (isRedirectResponse(createRes)) {
      loginCreateSpan.failure({
        statusCode: createRes.status,
        errorKind: "redirect_response",
      });
      sendJsonError(
        res,
        "Eliza Cloud login request was redirected; redirects are not allowed",
        502,
      );
      return true;
    }

    if (!createRes.ok) {
      loginCreateSpan.failure({
        statusCode: createRes.status,
        errorKind: "http_error",
      });
      sendJsonError(res, "Failed to create auth session with Eliza Cloud", 502);
      return true;
    }

    loginCreateSpan.success({ statusCode: createRes.status });
    sendJson(res, {
      ok: true,
      sessionId,
      browserUrl: `${baseUrl}/auth/cli-login?session=${encodeURIComponent(sessionId)}`,
    });
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/cloud/login/status")) {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendJsonError(res, "sessionId query parameter is required");
      return true;
    }

    const baseUrl = normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
    const urlError = await validateCloudBaseUrl(baseUrl);
    if (urlError) {
      sendJsonError(res, urlError);
      return true;
    }
    const loginPollSpan = getTelemetrySpan(state, {
      boundary: "cloud",
      operation: "login_poll_status",
      timeoutMs: CLOUD_LOGIN_POLL_TIMEOUT_MS,
    });
    let pollRes: Response;
    try {
      pollRes = await fetchWithTimeout(
        `${baseUrl}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
        {},
        CLOUD_LOGIN_POLL_TIMEOUT_MS,
      );
    } catch (err) {
      if (isTimeoutError(err)) {
        loginPollSpan.failure({ error: err, statusCode: 504 });
        sendJson(
          res,
          {
            status: "error",
            error: "Eliza Cloud status request timed out",
          },
          504,
        );
        return true;
      }
      loginPollSpan.failure({ error: err, statusCode: 502 });
      sendJson(
        res,
        {
          status: "error",
          error: "Failed to reach Eliza Cloud",
        },
        502,
      );
      return true;
    }

    if (isRedirectResponse(pollRes)) {
      loginPollSpan.failure({
        statusCode: pollRes.status,
        errorKind: "redirect_response",
      });
      sendJson(
        res,
        {
          status: "error",
          error:
            "Eliza Cloud status request was redirected; redirects are not allowed",
        },
        502,
      );
      return true;
    }

    if (!pollRes.ok) {
      loginPollSpan.failure({
        statusCode: pollRes.status,
        errorKind: "http_error",
      });
      sendJson(
        res,
        pollRes.status === 404
          ? { status: "expired", error: "Session not found or expired" }
          : {
              status: "error",
              error: `Eliza Cloud returned HTTP ${pollRes.status}`,
            },
      );
      return true;
    }

    let data: { status: string; apiKey?: string; keyPrefix?: string };
    try {
      data = (await pollRes.json()) as {
        status: string;
        apiKey?: string;
        keyPrefix?: string;
      };
    } catch (parseErr) {
      loginPollSpan.failure({ error: parseErr, statusCode: pollRes.status });
      sendJson(
        res,
        { status: "error", error: "Eliza Cloud returned invalid JSON" },
        502,
      );
      return true;
    }
    loginPollSpan.success({ statusCode: pollRes.status });

    if (data.status === "authenticated" && data.apiKey) {
      migrateLegacyRuntimeConfig(state.config as Record<string, unknown>);
      const cloud = (state.config.cloud ?? {}) as NonNullable<
        CloudConfigLike["cloud"]
      >;
      cloud.apiKey = data.apiKey;
      (state.config as Record<string, unknown>).cloud = cloud;
      applyCanonicalOnboardingConfig(state.config as never, {
        linkedAccounts: {
          elizacloud: {
            status: "linked",
            source: "api-key",
          },
        },
      });
      const cloudInferenceSelected = isCloudInferenceSelectedInConfig(
        state.config as Record<string, unknown>,
      );
      migrateLegacyRuntimeConfig(state.config as Record<string, unknown>);
      try {
        if (state.saveConfig) {
          state.saveConfig(state.config);
        } else {
          logger.warn(
            "[cloud-login] saveConfig not available — config not persisted",
          );
        }
        logger.info("[cloud-login] API key saved to config file");
      } catch (saveErr) {
        logger.error(`[cloud-login] Failed to save config: ${String(saveErr)}`);
        sendJson(
          res,
          { status: "error", error: "Authenticated but failed to save config" },
          500,
        );
        return true;
      }

      process.env.ELIZAOS_CLOUD_API_KEY = data.apiKey;
      if (cloudInferenceSelected) {
        process.env.ELIZAOS_CLOUD_ENABLED = "true";
      } else {
        delete process.env.ELIZAOS_CLOUD_ENABLED;
      }

      if (state.runtime) {
        if (!state.runtime.character.secrets) {
          state.runtime.character.secrets = {};
        }
        const secrets = state.runtime.character.secrets as Record<
          string,
          string
        >;
        secrets.ELIZAOS_CLOUD_API_KEY = data.apiKey;
        if (cloudInferenceSelected) {
          secrets.ELIZAOS_CLOUD_ENABLED = "true";
        } else {
          delete secrets.ELIZAOS_CLOUD_ENABLED;
        }

        await state.runtime.updateAgent(state.runtime.agentId, {
          secrets: { ...secrets },
        });
        logger.info("[cloud-login] API key persisted to agent DB record");
      }

      if (
        state.cloudManager &&
        !state.cloudManager.getClient() &&
        typeof state.cloudManager.init === "function"
      ) {
        await state.cloudManager.init();
      }

      sendJson(res, { status: "authenticated", keyPrefix: data.keyPrefix });
    } else {
      sendJson(res, { status: data.status });
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/cloud/agents") {
    const client = state.cloudManager?.getClient();
    if (!client) {
      sendJsonError(res, "Not connected to Eliza Cloud", 401);
      return true;
    }
    sendJson(res, { ok: true, agents: await client.listAgents() });
    return true;
  }

  if (method === "POST" && pathname === "/api/cloud/agents") {
    const client = state.cloudManager?.getClient();
    if (!client) {
      sendJsonError(res, "Not connected to Eliza Cloud", 401);
      return true;
    }

    const body = await readJsonBody<{
      agentName?: string;
      agentConfig?: Record<string, unknown>;
      environmentVars?: Record<string, string>;
    }>(req, res);
    if (!body) return true;

    if (!body.agentName?.trim()) {
      sendJsonError(res, "agentName is required");
      return true;
    }

    let agent: unknown;
    try {
      agent = await client.createAgent({
        agentName: body.agentName,
        agentConfig: body.agentConfig,
        environmentVars: body.environmentVars,
      });
    } catch (err) {
      logger.error(`[cloud] createAgent failed: ${String(err)}`);
      sendJson(
        res,
        { ok: false, error: `Cloud createAgent failed: ${String(err)}` },
        502,
      );
      return true;
    }
    sendJson(res, { ok: true, agent }, 201);
    return true;
  }

  if (
    method === "POST" &&
    pathname.startsWith("/api/cloud/agents/") &&
    pathname.endsWith("/provision")
  ) {
    const agentId = extractAgentId(pathname);
    if (!agentId || !state.cloudManager) {
      sendJsonError(res, "Invalid agent ID or cloud not connected", 400);
      return true;
    }
    let proxy: { agentName?: string };
    try {
      proxy = await state.cloudManager.connect(agentId);
    } catch (err) {
      logger.error(`[cloud] provision/connect failed: ${String(err)}`);
      sendJson(
        res,
        { ok: false, error: `Cloud provision failed: ${String(err)}` },
        502,
      );
      return true;
    }
    sendJson(res, {
      ok: true,
      agentId,
      agentName: proxy.agentName,
      status: state.cloudManager.getStatus(),
    });
    return true;
  }

  if (
    method === "POST" &&
    pathname.startsWith("/api/cloud/agents/") &&
    pathname.endsWith("/shutdown")
  ) {
    const agentId = extractAgentId(pathname);
    if (!agentId || !state.cloudManager) {
      sendJsonError(res, "Invalid agent ID or cloud not connected", 400);
      return true;
    }
    const client = state.cloudManager.getClient();
    if (!client) {
      sendJsonError(res, "Not connected to Eliza Cloud", 401);
      return true;
    }
    try {
      if (state.cloudManager.getActiveAgentId() === agentId) {
        await state.cloudManager.disconnect();
      }
      await client.deleteAgent(agentId);
    } catch (err) {
      logger.error(`[cloud] shutdown/deleteAgent failed: ${String(err)}`);
      sendJson(
        res,
        { ok: false, error: `Cloud shutdown failed: ${String(err)}` },
        502,
      );
      return true;
    }
    sendJson(res, { ok: true, agentId, status: "stopped" });
    return true;
  }

  if (
    method === "POST" &&
    pathname.startsWith("/api/cloud/agents/") &&
    pathname.endsWith("/connect")
  ) {
    const agentId = extractAgentId(pathname);
    if (!agentId || !state.cloudManager) {
      sendJsonError(res, "Invalid agent ID or cloud not connected", 400);
      return true;
    }
    let proxy: { agentName?: string };
    try {
      if (state.cloudManager.getActiveAgentId()) {
        await state.cloudManager.disconnect();
      }
      proxy = await state.cloudManager.connect(agentId);
    } catch (err) {
      logger.error(`[cloud] connect failed: ${String(err)}`);
      sendJson(
        res,
        { ok: false, error: `Cloud connect failed: ${String(err)}` },
        502,
      );
      return true;
    }
    sendJson(res, {
      ok: true,
      agentId,
      agentName: proxy.agentName,
      status: state.cloudManager.getStatus(),
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/cloud/disconnect") {
    if (state.cloudManager) {
      await state.cloudManager.disconnect();
    }
    const cloud = (state.config.cloud ?? {}) as NonNullable<
      CloudConfigLike["cloud"]
    >;
    delete cloud.apiKey;
    (state.config as Record<string, unknown>).cloud = cloud;
    applyCanonicalOnboardingConfig(state.config as never, {
      deploymentTarget: { runtime: "local" },
      linkedAccounts: {
        elizacloud: {
          status: "unlinked",
          source: "api-key",
        },
      },
      clearRoutes: ["llmText", "tts", "media", "embeddings", "rpc"],
    });
    migrateLegacyRuntimeConfig(state.config as Record<string, unknown>);

    try {
      if (state.saveConfig) {
        state.saveConfig(state.config);
      } else {
        logger.warn(
          "[cloud-disconnect] saveConfig not available — config not persisted",
        );
      }
    } catch (saveErr) {
      logger.error(
        `[cloud-disconnect] Failed to save config: ${String(saveErr)}`,
      );
      sendJson(
        res,
        { ok: false, error: "Disconnected but failed to save config" },
        500,
      );
      return true;
    }

    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_ENABLED;

    if (state.runtime) {
      if (!state.runtime.character.secrets) {
        state.runtime.character.secrets = {};
      }
      const secrets = state.runtime.character.secrets as Record<
        string,
        string | number | boolean
      >;
      delete secrets.ELIZAOS_CLOUD_API_KEY;
      delete secrets.ELIZAOS_CLOUD_ENABLED;
      await state.runtime.updateAgent(state.runtime.agentId, {
        secrets: { ...secrets },
      });
    }

    sendJson(res, { ok: true, status: "disconnected" });
    return true;
  }

  return false;
}
