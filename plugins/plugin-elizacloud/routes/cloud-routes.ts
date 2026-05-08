import type http from "node:http";
import {
  type CloudRouteState as AutonomousCloudRouteState,
  handleCloudRoute as handleAutonomousCloudRoute,
} from "./cloud-routes-autonomous.js";
import { applyCanonicalOnboardingConfig } from "@elizaos/agent/api/provider-switch-config";
import {
  normalizeCloudSiteUrl,
} from "../cloud/base-url.js";
import type { CloudManager } from "../cloud/cloud-manager.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import { type ElizaConfig, saveElizaConfig } from "@elizaos/agent/config";
import { createIntegrationTelemetrySpan } from "@elizaos/agent/diagnostics/integration-observability";
import { type AgentRuntime, logger } from "@elizaos/core";
import {
  isCloudInferenceSelectedInConfig,
  migrateLegacyRuntimeConfig,
} from "@elizaos/shared";
import { sendJson, sendJsonError } from "@elizaos/app-core/api/response";
import { isTimeoutError } from "@elizaos/app-core/utils/errors";
import {
  clearCloudAuthService,
  disconnectUnifiedCloudConnection,
  getCloudAuth,
  type RuntimeCloudLike,
} from "../lib/cloud-connection";
import {
  clearCloudSecrets,
  scrubCloudSecretsFromEnv,
} from "../lib/cloud-secrets";

export interface CloudRouteState {
  config: ElizaConfig;
  cloudManager: CloudManager | null;
  /** The running agent runtime — needed to persist cloud credentials to the DB. */
  runtime: AgentRuntime | null;
  services?: Partial<CloudRouteServices>;
}

export interface CloudRouteServices {
  applyCanonicalOnboardingConfig: typeof applyCanonicalOnboardingConfig;
  createIntegrationTelemetrySpan: typeof createIntegrationTelemetrySpan;
  handleAutonomousCloudRoute: typeof handleAutonomousCloudRoute;
  normalizeCloudSiteUrl: typeof normalizeCloudSiteUrl;
  saveElizaConfig: typeof saveElizaConfig;
  validateCloudBaseUrl: typeof validateCloudBaseUrl;
}

type CloudRuntimeSecrets = Record<string, string | number | boolean>;
type ReplaceableCloudManager = NonNullable<CloudRouteState["cloudManager"]> & {
  replaceApiKey?: (apiKey: string) => Promise<void>;
};
type StartableCloudRelayService = {
  startRelayLoopIfReady?: () => boolean | Promise<boolean>;
};
type RelayStatusService = {
  getSessionInfo?: () => {
    sessionId: string | null;
    organizationId: string | null;
    userId: string | null;
    agentName: string | null;
    platform: string | null;
    lastSeenAt: string | null;
    status: "idle" | "registered" | "polling" | "error" | "stopped";
  };
};

const CLOUD_LOGIN_POLL_TIMEOUT_MS = 10_000;
const DEFAULT_CLOUD_ROUTE_SERVICES: CloudRouteServices = {
  applyCanonicalOnboardingConfig,
  createIntegrationTelemetrySpan,
  handleAutonomousCloudRoute,
  normalizeCloudSiteUrl,
  saveElizaConfig,
  validateCloudBaseUrl,
};

async function readRouteJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const preParsed = (req as http.IncomingMessage & { body?: unknown }).body;
  if (
    preParsed &&
    typeof preParsed === "object" &&
    !Array.isArray(preParsed)
  ) {
    return preParsed as Record<string, unknown>;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }

  const parsed = JSON.parse(rawBody) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSON body");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Monotonic counter incremented on every `POST /api/cloud/disconnect`.
 *
 * WHY: We must not persist a stale "authenticated" poll after the user
 * disconnects mid-flight. The previous guard (`cloud.enabled === false`)
 * also matched **first-time** cloud (never enabled), so successful logins
 * were discarded. Comparing epoch before/after the poll preserves the race
 * fix without blocking legitimate first connect.
 */
let cloudDisconnectEpoch = 0;

type TelemetrySpan = {
  success: (meta?: Record<string, unknown>) => void;
  failure: (meta?: Record<string, unknown>) => void;
};

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function createNoopTelemetrySpan(): TelemetrySpan {
  return {
    success: () => {},
    failure: () => {},
  };
}

function getTelemetrySpan(meta: {
  boundary: "cloud";
  operation: string;
  timeoutMs: number;
  services: CloudRouteServices;
}): TelemetrySpan {
  return (
    meta.services.createIntegrationTelemetrySpan(meta) ??
    createNoopTelemetrySpan()
  );
}

async function fetchCloudLoginStatus(
  sessionId: string,
  baseUrl: string,
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(CLOUD_LOGIN_POLL_TIMEOUT_MS),
    },
  );
}

async function persistCloudLoginStatus(args: {
  apiKey: string;
  organizationId?: string;
  services: CloudRouteServices;
  state: CloudRouteState;
  userId?: string;
  /**
   * From GET `/api/cloud/login/status`: epoch captured before `fetch` so a
   * disconnect during the poll invalidates this result. Omitted for POST
   * `/api/cloud/login/persist` (direct client push) — no race window.
   */
  epochAtPollStart?: number;
}): Promise<void> {
  if (
    args.epochAtPollStart !== undefined &&
    args.epochAtPollStart !== cloudDisconnectEpoch
  ) {
    logger.warn(
      "[cloud-login] Skipping login persist: a disconnect occurred while the login poll was in-flight",
    );
    return;
  }

  migrateLegacyRuntimeConfig(args.state.config as Record<string, unknown>);
  const runtime = args.state.runtime as RuntimeCloudLike | null;
  const cloudAuth = getCloudAuth(runtime);
  await clearCloudAuthService(cloudAuth);

  const cloud = { ...(args.state.config.cloud ?? {}) } as Record<
    string,
    unknown
  >;

  cloud.apiKey = args.apiKey;
  const cloudInferenceSelected = isCloudInferenceSelectedInConfig(
    args.state.config as Record<string, unknown>,
  );

  args.state.config.cloud = cloud as ElizaConfig["cloud"];
  args.services.applyCanonicalOnboardingConfig(args.state.config, {
    linkedAccounts: {
      elizacloud: {
        status: "linked",
        source: "api-key",
      },
    },
  });
  migrateLegacyRuntimeConfig(args.state.config as Record<string, unknown>);

  try {
    args.services.saveElizaConfig(args.state.config);
    logger.info("[cloud-login] Saved cloud API key to config file");
    logger.warn(
      "[cloud-login] Cloud API key is stored in cleartext in ~/.eliza/eliza.json. " +
        "Ensure this file has restrictive permissions (chmod 600).",
    );
  } catch (saveErr) {
    logger.error(
      `[cloud-login] Failed to save cloud API key to config: ${
        saveErr instanceof Error ? saveErr.message : String(saveErr)
      }`,
    );
  }

  clearCloudSecrets();
  process.env.ELIZAOS_CLOUD_API_KEY = args.apiKey;
  if (cloudInferenceSelected) {
    process.env.ELIZAOS_CLOUD_ENABLED = "true";
  } else {
    delete process.env.ELIZAOS_CLOUD_ENABLED;
  }
  scrubCloudSecretsFromEnv();

  const cloudManager = args.state
    .cloudManager as ReplaceableCloudManager | null;
  if (cloudManager && typeof cloudManager.replaceApiKey === "function") {
    await cloudManager.replaceApiKey(args.apiKey);
  } else if (
    cloudManager &&
    !cloudManager.getClient() &&
    typeof cloudManager.init === "function"
  ) {
    await cloudManager.init();
  }

  if (typeof cloudAuth?.authenticateWithApiKey === "function") {
    cloudAuth.authenticateWithApiKey({
      apiKey: args.apiKey,
      organizationId: args.organizationId,
      userId: args.userId,
    });
  }
  const relayService = (runtime?.getService("CLOUD_MANAGED_GATEWAY_RELAY") ??
    runtime?.getService("cloud-managed-gateway-relay") ??
    runtime?.getService(
      "cloudManagedGatewayRelay",
    )) as StartableCloudRelayService | null;
  if (typeof relayService?.startRelayLoopIfReady === "function") {
    await relayService.startRelayLoopIfReady();
  }

  if (!runtime || typeof runtime.updateAgent !== "function") {
    return;
  }

  try {
    const nextSecrets: CloudRuntimeSecrets = {
      ...(runtime.character.secrets ?? {}),
      ELIZAOS_CLOUD_API_KEY: args.apiKey,
    };
    if (args.userId) {
      nextSecrets.ELIZA_CLOUD_USER_ID = args.userId;
      nextSecrets.ELIZAOS_CLOUD_USER_ID = args.userId;
    } else {
      delete nextSecrets.ELIZA_CLOUD_USER_ID;
      delete nextSecrets.ELIZAOS_CLOUD_USER_ID;
    }
    if (args.organizationId) {
      nextSecrets.ELIZA_CLOUD_ORGANIZATION_ID = args.organizationId;
      nextSecrets.ELIZAOS_CLOUD_ORG_ID = args.organizationId;
    } else {
      delete nextSecrets.ELIZA_CLOUD_ORGANIZATION_ID;
      delete nextSecrets.ELIZAOS_CLOUD_ORG_ID;
    }
    if (cloudInferenceSelected) {
      nextSecrets.ELIZAOS_CLOUD_ENABLED = "true";
    } else {
      delete nextSecrets.ELIZAOS_CLOUD_ENABLED;
    }
    runtime.character.secrets = nextSecrets;
    if (typeof runtime.setSetting === "function") {
      runtime.setSetting("ELIZA_CLOUD_USER_ID", args.userId ?? null);
      runtime.setSetting("ELIZAOS_CLOUD_USER_ID", args.userId ?? null);
      runtime.setSetting(
        "ELIZA_CLOUD_ORGANIZATION_ID",
        args.organizationId ?? null,
      );
      runtime.setSetting("ELIZAOS_CLOUD_ORG_ID", args.organizationId ?? null);
    }
    await runtime.updateAgent(runtime.agentId, {
      secrets: { ...nextSecrets },
    });
  } catch (err) {
    // Non-fatal: config/sealed secret persistence is enough for login continuity.
    logger.warn(
      `[cloud-routes] Failed to persist cloud secrets to agent DB: ${String(
        err,
      )}`,
    );
  }
}

function getCloudRouteServices(state: CloudRouteState): CloudRouteServices {
  return {
    ...DEFAULT_CLOUD_ROUTE_SERVICES,
    ...state.services,
  };
}

function toAutonomousState(
  state: CloudRouteState,
  services: CloudRouteServices,
): AutonomousCloudRouteState {
  return {
    ...state,
    saveConfig: () => services.saveElizaConfig(state.config),
    createTelemetrySpan: services.createIntegrationTelemetrySpan,
  };
}

export async function handleCloudRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudRouteState,
): Promise<boolean> {
  const services = getCloudRouteServices(state);

  if (method === "GET" && pathname === "/api/cloud/relay-status") {
    const relayService = (state.runtime?.getService(
      "CLOUD_MANAGED_GATEWAY_RELAY",
    ) ??
      state.runtime?.getService("cloud-managed-gateway-relay") ??
      state.runtime?.getService(
        "cloudManagedGatewayRelay",
      )) as RelayStatusService | null;

    if (typeof relayService?.getSessionInfo !== "function") {
      sendJson(res, 200, {
        available: false,
        status: "not_registered",
        reason:
          "Gateway relay service not active. Connect to Eliza Cloud in Settings to enable instance routing.",
      });
      return true;
    }

    try {
      sendJson(res, 200, {
        available: true,
        ...relayService.getSessionInfo(),
      });
    } catch (error) {
      sendJson(res, 200, {
        available: false,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/cloud/disconnect") {
    // Invalidate any in-flight login poll (see persistCloudLoginStatus).
    cloudDisconnectEpoch++;
    try {
      await disconnectUnifiedCloudConnection({
        cloudManager: state.cloudManager,
        config: state.config,
        runtime: state.runtime,
        saveConfig: services.saveElizaConfig,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[cloud/disconnect] failed: ${message}`);
      sendJson(res, 500, { ok: false, error: message });
      return true;
    }
    sendJson(res, 200, { ok: true, status: "disconnected" });
    return true;
  }

  // Direct-auth persistence: the frontend authenticated directly with Eliza
  // Cloud (bypassing the backend's login/status handler) and needs to push
  // the API key to the backend so billing/compat routes can authenticate.
  if (method === "POST" && pathname === "/api/cloud/login/persist") {
    try {
      const body = await readRouteJsonBody(req);
      if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        sendJson(res, 400, { ok: false, error: "apiKey is required" });
        return true;
      }
      await persistCloudLoginStatus({
        apiKey: body.apiKey.trim(),
        organizationId:
          typeof body.organizationId === "string"
            ? body.organizationId.trim()
            : undefined,
        services,
        state,
        userId:
          typeof body.userId === "string" ? body.userId.trim() : undefined,
      });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[cloud/login/persist] Failed: ${msg}`);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/cloud/login/status")) {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendJsonError(res, 400, "sessionId query parameter is required");
      return true;
    }

    const baseUrl = services.normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
    const urlError = await services.validateCloudBaseUrl(baseUrl);
    if (urlError) {
      sendJsonError(res, 400, urlError);
      return true;
    }

    const epochBeforePoll = cloudDisconnectEpoch;

    const loginPollSpan = getTelemetrySpan({
      boundary: "cloud",
      operation: "login_poll_status",
      services,
      timeoutMs: CLOUD_LOGIN_POLL_TIMEOUT_MS,
    });

    let pollRes: Response;
    try {
      pollRes = await fetchCloudLoginStatus(sessionId, baseUrl);
    } catch (fetchErr) {
      if (isTimeoutError(fetchErr)) {
        loginPollSpan.failure({ error: fetchErr, statusCode: 504 });
        sendJson(res, 504, {
          status: "error",
          error: "Eliza Cloud status request timed out",
        });
        return true;
      }

      loginPollSpan.failure({ error: fetchErr, statusCode: 502 });
      sendJson(res, 502, {
        status: "error",
        error: "Failed to reach Eliza Cloud",
      });
      return true;
    }

    if (isRedirectResponse(pollRes)) {
      loginPollSpan.failure({
        statusCode: pollRes.status,
        errorKind: "redirect_response",
      });
      sendJson(res, 502, {
        status: "error",
        error:
          "Eliza Cloud status request was redirected; redirects are not allowed",
      });
      return true;
    }

    if (!pollRes.ok) {
      loginPollSpan.failure({
        statusCode: pollRes.status,
        errorKind: "http_error",
      });
      sendJson(
        res,
        200,
        pollRes.status === 404
          ? { status: "expired", error: "Session not found or expired" }
          : {
              status: "error",
              error: `Eliza Cloud returned HTTP ${pollRes.status}`,
            },
      );
      return true;
    }

    let data: {
      apiKey?: unknown;
      keyPrefix?: unknown;
      organizationId?: unknown;
      status?: unknown;
      userId?: unknown;
    };
    try {
      data = (await pollRes.json()) as {
        apiKey?: unknown;
        keyPrefix?: unknown;
        organizationId?: unknown;
        status?: unknown;
        userId?: unknown;
      };
    } catch (parseErr) {
      loginPollSpan.failure({ error: parseErr, statusCode: pollRes.status });
      sendJson(res, 502, {
        status: "error",
        error: "Eliza Cloud returned invalid JSON",
      });
      return true;
    }

    loginPollSpan.success({ statusCode: pollRes.status });

    if (data.status === "authenticated" && typeof data.apiKey === "string") {
      await persistCloudLoginStatus({
        apiKey: data.apiKey,
        organizationId:
          typeof data.organizationId === "string"
            ? data.organizationId
            : undefined,
        services,
        state,
        epochAtPollStart: epochBeforePoll,
        userId: typeof data.userId === "string" ? data.userId : undefined,
      });
      sendJson(res, 200, {
        status: "authenticated",
        keyPrefix:
          typeof data.keyPrefix === "string" ? data.keyPrefix : undefined,
        organizationId:
          typeof data.organizationId === "string"
            ? data.organizationId
            : undefined,
        userId: typeof data.userId === "string" ? data.userId : undefined,
      });
      return true;
    }

    sendJson(res, 200, {
      status: typeof data.status === "string" ? data.status : "error",
    });
    return true;
  }

  const result = await services.handleAutonomousCloudRoute(
    req,
    res,
    pathname,
    method,
    toAutonomousState(state, services),
  );

  // The upstream handler writes secrets to process.env — scrub them
  // immediately so they don't leak to child processes or env dumps.
  scrubCloudSecretsFromEnv();

  return result;
}
