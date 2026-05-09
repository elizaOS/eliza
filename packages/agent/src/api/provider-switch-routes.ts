import type http from "node:http";
import { logger } from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import { normalizeOnboardingProviderId } from "@elizaos/shared";
import type { SecretsManager } from "@elizaos/vault";
import type { ElizaConfig } from "../config/config.ts";
import {
  defaultSecretsManager,
  type ProviderSwitchIntent,
  persistProviderApiKey,
  type RuntimeOperationManager,
} from "../runtime/operations/index.ts";
import {
  applyOnboardingConnectionConfig,
  createProviderSwitchConnection,
} from "./provider-switch-config.ts";

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
  runtimeOperationManager: RuntimeOperationManager;
  /**
   * Vault-backed secrets manager. Tests inject; production resolves to the
   * OS-keychain default. The route writes the API key here BEFORE
   * constructing the intent so the secret never lands on disk in plaintext
   * inside an operation record.
   */
  secretsManager?: SecretsManager;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

function readIdempotencyKey(
  headers: http.IncomingHttpHeaders,
): string | undefined {
  // Node lowercases header names on IncomingMessage.headers.
  const raw = headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
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
      useLocalEmbeddings?: boolean;
    }>(req, res);
    if (!body) return true;
    if (!body.provider || typeof body.provider !== "string") {
      error(res, "Missing provider", 400);
      return true;
    }
    const useLocalEmbeddings =
      typeof body.useLocalEmbeddings === "boolean"
        ? body.useLocalEmbeddings
        : undefined;

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

      const intent: ProviderSwitchIntent = {
        kind: "provider-switch",
        provider: normalizedProvider,
        primaryModel:
          typeof body.primaryModel === "string"
            ? body.primaryModel.trim()
            : undefined,
      };
      const idempotencyKey = readIdempotencyKey(req.headers);

      const outcome = await ctx.runtimeOperationManager.start({
        intent,
        idempotencyKey,
        prepare: async () => {
          const config = state.config;
          let apiKeyRef: string | undefined;
          if (trimmedApiKey) {
            const secrets = ctx.secretsManager ?? defaultSecretsManager();
            try {
              apiKeyRef = await persistProviderApiKey({
                secrets,
                normalizedProvider,
                apiKey: trimmedApiKey,
                caller: "provider-switch-route",
              });
            } catch (vaultErr) {
              logger.error(
                `[api] Vault write failed for provider=${normalizedProvider}: ${vaultErr instanceof Error ? vaultErr.message : String(vaultErr)}`,
              );
              throw new Error("Vault write failed");
            }
          }

          if (normalizedProvider === "elizacloud" && trimmedApiKey) {
            const cloudBaseUrl = "https://www.elizacloud.ai";
            process.env.ANTHROPIC_BASE_URL = `${cloudBaseUrl}/api/v1`;
            process.env.ANTHROPIC_API_KEY = trimmedApiKey;
            process.env.OPENAI_BASE_URL = `${cloudBaseUrl}/api/v1`;
            process.env.OPENAI_API_KEY = trimmedApiKey;
          }

          await applyOnboardingConnectionConfig(
            config,
            connection,
            useLocalEmbeddings === undefined ? {} : { useLocalEmbeddings },
          );
          ctx.saveElizaConfig(config);

          return {
            ...intent,
            ...(apiKeyRef ? { apiKeyRef } : {}),
          };
        },
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
      error(
        res,
        err instanceof Error && err.message === "Vault write failed"
          ? "Vault write failed"
          : "Provider switch failed",
        500,
      );
    }
    return true;
  }

  return false;
}
