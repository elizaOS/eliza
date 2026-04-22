import type http from "node:http";
import { logger } from "@elizaos/core";
import { ELIZA_CLOUD_PRIMARY_ORIGIN } from "@elizaos/shared/eliza-cloud-presets";
import type { ElizaConfig } from "../config/config.js";
import { normalizeOnboardingProviderId } from "../contracts/onboarding.js";
import type { ReadJsonBodyOptions } from "./http-helpers.js";
import {
  applyOnboardingConnectionConfig,
  createProviderSwitchConnection,
} from "./provider-switch-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderSwitchRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: { config: ElizaConfig };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  saveElizaConfig: (config: ElizaConfig) => void;
  scheduleRuntimeRestart: (reason: string) => void;
  providerSwitchInProgress: boolean;
  setProviderSwitchInProgress: (value: boolean) => void;
  restartRuntime?: (reason: string) => Promise<boolean>;
  /** When true, runtime reload is in flight — reject new switches until it settles. */
  isRuntimeRestarting?: () => boolean;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleProviderSwitchRoutes(
  ctx: ProviderSwitchRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, json, error, readJsonBody } = ctx;

  if (method === "POST" && pathname === "/api/provider/switch") {
    const body = await readJsonBody<{
      provider: string;
      apiKey?: string;
      primaryModel?: string;
    }>(req, res);
    if (!body) return true;
    if (!body.provider || typeof body.provider !== "string") {
      error(res, "Missing provider", 400);
      return true;
    }

    const normalizedProvider = normalizeOnboardingProviderId(body.provider);
    if (!normalizedProvider) {
      error(res, "Invalid provider", 400);
      return true;
    }

    if (ctx.isRuntimeRestarting?.()) {
      error(
        res,
        "Agent runtime is restarting — try again in a few seconds.",
        503,
      );
      return true;
    }

    if (ctx.providerSwitchInProgress) {
      error(res, "Provider switch already in progress", 409);
      return true;
    }
    ctx.setProviderSwitchInProgress(true);

    try {
      const trimmedApiKey =
        typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
      if (trimmedApiKey && trimmedApiKey.length > 512) {
        error(res, "API key is too long", 400);
        return true;
      }

      const config = state.config;
      let connection:
        | ReturnType<typeof createProviderSwitchConnection>
        | {
            kind: "cloud-managed";
            cloudProvider: "elizacloud";
            apiKey?: string;
          }
        | null;
      if (normalizedProvider === "elizacloud") {
        connection = {
          kind: "cloud-managed" as const,
          cloudProvider: "elizacloud" as const,
          apiKey: trimmedApiKey,
        };
        if (trimmedApiKey) {
          const cloudApiKey = trimmedApiKey;
          const cloudBaseUrl = ELIZA_CLOUD_PRIMARY_ORIGIN;
          process.env.ANTHROPIC_BASE_URL = `${cloudBaseUrl}/api/v1`;
          process.env.ANTHROPIC_API_KEY = cloudApiKey;
          process.env.OPENAI_BASE_URL = `${cloudBaseUrl}/api/v1`;
          process.env.OPENAI_API_KEY = cloudApiKey;
        }
      } else if (normalizedProvider) {
        connection = createProviderSwitchConnection({
          provider: normalizedProvider,
          apiKey: trimmedApiKey,
          primaryModel:
            typeof body.primaryModel === "string"
              ? body.primaryModel.trim()
              : undefined,
        });
      } else {
        connection = null;
      }

      if (!connection) {
        error(res, "Invalid provider", 400);
        return true;
      }

      await applyOnboardingConnectionConfig(config, connection);
      ctx.saveElizaConfig(config);
    } catch (err) {
      logger.error(
        `[api] Provider switch failed: ${err instanceof Error ? err.stack : err}`,
      );
      error(res, "Provider switch failed", 500);
      return true;
    } finally {
      ctx.setProviderSwitchInProgress(false);
    }

    try {
      const restartReason = `provider switch to ${normalizedProvider}`;
      const restarted = ctx.restartRuntime
        ? await ctx.restartRuntime(restartReason)
        : false;
      if (!restarted) {
        ctx.scheduleRuntimeRestart(restartReason);
      }

      json(res, {
        success: true,
        provider: normalizedProvider,
        restarting: restarted,
      });
    } catch (err) {
      logger.error(
        `[api] Provider switch restart failed (config was saved): ${
          err instanceof Error ? err.stack : err
        }`,
      );
      error(res, "Provider switch failed", 500);
    }
    return true;
  }

  return false;
}
