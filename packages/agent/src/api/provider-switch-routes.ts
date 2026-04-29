import type http from "node:http";
import { logger } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.js";
import { normalizeOnboardingProviderId } from "../contracts/onboarding.js";
import type {
  ProviderSwitchIntent,
  RuntimeOperationManager,
} from "../runtime/operations/index.js";
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
  /**
   * Legacy single-flight gate — kept on the context type for now because
   * other call sites still set it. This route no longer reads or writes
   * the flag; the runtime operation repo's active-op slot is the gate.
   */
  providerSwitchInProgress: boolean;
  setProviderSwitchInProgress: (value: boolean) => void;
  runtimeOperationManager: RuntimeOperationManager;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

function readIdempotencyKey(
  headers: http.IncomingHttpHeaders,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "idempotency-key") continue;
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find(
        (v) => typeof v === "string" && v.trim().length > 0,
      );
      if (first) return first.trim();
    }
  }
  return undefined;
}

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

    const trimmedApiKey =
      typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
    if (trimmedApiKey && trimmedApiKey.length > 512) {
      error(res, "API key is too long", 400);
      return true;
    }

    try {
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
          const cloudBaseUrl = "https://www.elizacloud.ai";
          process.env.ANTHROPIC_BASE_URL = `${cloudBaseUrl}/api/v1`;
          process.env.ANTHROPIC_API_KEY = cloudApiKey;
          process.env.OPENAI_BASE_URL = `${cloudBaseUrl}/api/v1`;
          process.env.OPENAI_API_KEY = cloudApiKey;
        }
      } else {
        connection = createProviderSwitchConnection({
          provider: normalizedProvider,
          apiKey: trimmedApiKey,
          primaryModel:
            typeof body.primaryModel === "string"
              ? body.primaryModel.trim()
              : undefined,
        });
      }

      if (!connection) {
        error(res, "Invalid provider", 400);
        return true;
      }

      await applyOnboardingConnectionConfig(config, connection);
      ctx.saveElizaConfig(config);

      const intent: ProviderSwitchIntent = {
        kind: "provider-switch",
        provider: normalizedProvider,
        apiKey: trimmedApiKey,
        primaryModel:
          typeof body.primaryModel === "string"
            ? body.primaryModel.trim()
            : undefined,
      };
      const idempotencyKey = readIdempotencyKey(req.headers);

      const outcome = await ctx.runtimeOperationManager.start({
        intent,
        idempotencyKey,
      });

      if (outcome.kind === "accepted") {
        logger.info(
          `[api] Provider switch accepted: provider=${normalizedProvider} op=${outcome.operation.id}`,
        );
        json(
          res,
          {
            success: true,
            provider: normalizedProvider,
            restarting: true,
            operationId: outcome.operation.id,
          },
          202,
        );
        return true;
      }

      if (outcome.kind === "deduped") {
        const op = outcome.operation;
        logger.info(
          `[api] Provider switch deduped: provider=${normalizedProvider} op=${op.id} status=${op.status}`,
        );
        json(res, {
          success: true,
          provider: normalizedProvider,
          restarting: op.status === "running" || op.status === "pending",
          operationId: op.id,
          deduped: true,
        });
        return true;
      }

      // outcome.kind === "rejected-busy"
      json(
        res,
        {
          error: "Provider switch already in progress",
          activeOperationId: outcome.activeOperationId,
        },
        409,
      );
      return true;
    } catch (err) {
      logger.error(
        `[api] Provider switch failed: ${err instanceof Error ? err.stack : err}`,
      );
      error(res, "Provider switch failed", 500);
    }
    return true;
  }

  return false;
}
