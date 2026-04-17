import type http from "node:http";
import {
  type CloudRouteState as AutonomousCloudRouteState,
  handleCloudRoute as handleAutonomousCloudRoute,
} from "@elizaos/agent/api/cloud-routes";
import { applyCanonicalOnboardingConfig } from "@elizaos/agent/api/provider-switch-config";
import { normalizeCloudSiteUrl } from "@elizaos/agent/cloud/base-url";
import type { CloudManager } from "@elizaos/agent/cloud/cloud-manager";
import { validateCloudBaseUrl } from "@elizaos/agent/cloud/validate-url";
import type { ElizaConfig } from "@elizaos/agent/config/config";
import { saveElizaConfig } from "@elizaos/agent/config/config";
import { createIntegrationTelemetrySpan } from "@elizaos/agent/diagnostics/integration-observability";
import { type AgentRuntime, logger } from "@elizaos/core";
import {
  isCloudInferenceSelectedInConfig,
  migrateLegacyRuntimeConfig,
} from "@elizaos/shared/contracts/onboarding";
import { isTimeoutError } from "../utils/errors";
import {
  disconnectUnifiedCloudConnection,
  type RuntimeCloudLike,
} from "./cloud-connection";
import { clearCloudSecrets, scrubCloudSecretsFromEnv } from "./cloud-secrets";
import { sendJson, sendJsonError } from "./response";

export interface CloudRouteState {
  config: ElizaConfig;
  cloudManager: CloudManager | null;
  /** The running agent runtime — needed to persist cloud credentials to the DB. */
  runtime: AgentRuntime | null;
}

type CloudRuntimeSecrets = Record<string, string | number | boolean>;

const CLOUD_LOGIN_POLL_TIMEOUT_MS = 10_000;

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
}): TelemetrySpan {
  return createIntegrationTelemetrySpan(meta) ?? createNoopTelemetrySpan();
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
  state: CloudRouteState;
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
  const cloud = { ...(args.state.config.cloud ?? {}) } as Record<
    string,
    unknown
  >;

  cloud.apiKey = args.apiKey;
  const cloudInferenceSelected = isCloudInferenceSelectedInConfig(
    args.state.config as Record<string, unknown>,
  );

  args.state.config.cloud = cloud as ElizaConfig["cloud"];
  applyCanonicalOnboardingConfig(args.state.config, {
    linkedAccounts: {
      elizacloud: {
        status: "linked",
        source: "api-key",
      },
    },
  });
  migrateLegacyRuntimeConfig(args.state.config as Record<string, unknown>);

  try {
    saveElizaConfig(args.state.config);
    logger.info("[cloud-login] Saved cloud API key to config file");
    logger.warn(
      "[cloud-login] Cloud API key is stored in cleartext in ~/.eliza/eliza.json. " +
        "Ensure this file has restrictive permissions (chmod 600).",
    );
  } catch (saveErr) {
    logger.error(
      `[cloud-login] Failed to save cloud API key to config: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
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

  if (
    args.state.cloudManager &&
    !args.state.cloudManager.getClient() &&
    typeof args.state.cloudManager.init === "function"
  ) {
    await args.state.cloudManager.init();
  }

  const runtime = args.state.runtime as RuntimeCloudLike | null;
  if (!runtime || typeof runtime.updateAgent !== "function") {
    return;
  }

  try {
    const nextSecrets: CloudRuntimeSecrets = {
      ...(runtime.character.secrets ?? {}),
      ELIZAOS_CLOUD_API_KEY: args.apiKey,
    };
    if (cloudInferenceSelected) {
      nextSecrets.ELIZAOS_CLOUD_ENABLED = "true";
    } else {
      delete nextSecrets.ELIZAOS_CLOUD_ENABLED;
    }
    runtime.character.secrets = nextSecrets;
    await runtime.updateAgent(runtime.agentId, {
      secrets: { ...nextSecrets },
    });
  } catch (err) {
    // Non-fatal: config/sealed secret persistence is enough for login continuity.
    logger.warn(
      `[cloud-routes] Failed to persist cloud secrets to agent DB: ${String(err)}`,
    );
  }
}

function toAutonomousState(state: CloudRouteState): AutonomousCloudRouteState {
  return {
    ...state,
    saveConfig: saveElizaConfig,
    createTelemetrySpan: createIntegrationTelemetrySpan,
  };
}

export async function handleCloudRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudRouteState,
): Promise<boolean> {
  if (method === "POST" && pathname === "/api/cloud/disconnect") {
    // Invalidate any in-flight login poll (see persistCloudLoginStatus).
    cloudDisconnectEpoch++;
    try {
      await disconnectUnifiedCloudConnection({
        cloudManager: state.cloudManager,
        config: state.config,
        runtime: state.runtime,
        saveConfig: saveElizaConfig,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[cloud/disconnect] failed", err);
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
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        apiKey?: unknown;
      };
      if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        sendJson(res, 400, { ok: false, error: "apiKey is required" });
        return true;
      }
      await persistCloudLoginStatus({ apiKey: body.apiKey.trim(), state });
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

    const baseUrl = normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
    const urlError = await validateCloudBaseUrl(baseUrl);
    if (urlError) {
      sendJsonError(res, 400, urlError);
      return true;
    }

    const epochBeforePoll = cloudDisconnectEpoch;

    const loginPollSpan = getTelemetrySpan({
      boundary: "cloud",
      operation: "login_poll_status",
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
      status?: unknown;
    };
    try {
      data = (await pollRes.json()) as {
        apiKey?: unknown;
        keyPrefix?: unknown;
        status?: unknown;
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
        state,
        epochAtPollStart: epochBeforePoll,
      });
      sendJson(res, 200, {
        status: "authenticated",
        keyPrefix:
          typeof data.keyPrefix === "string" ? data.keyPrefix : undefined,
      });
      return true;
    }

    sendJson(res, 200, {
      status: typeof data.status === "string" ? data.status : "error",
    });
    return true;
  }

  const result = await handleAutonomousCloudRoute(
    req,
    res,
    pathname,
    method,
    toAutonomousState(state),
  );

  // The upstream handler writes secrets to process.env — scrub them
  // immediately so they don't leak to child processes or env dumps.
  scrubCloudSecretsFromEnv();

  return result;
}
