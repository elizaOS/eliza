import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { logger } from "@elizaos/core";
import {
  isCloudInferenceSelectedInConfig,
  migrateLegacyRuntimeConfig,
} from "@elizaos/shared/contracts/onboarding";
import { normalizeCloudSiteUrl } from "../cloud/base-url.js";
import type {
  CloudChainType,
  CloudWalletDescriptor,
  CloudWalletProvider,
} from "../cloud/bridge-client.js";
import {
  getOrCreateClientAddressKey,
  MILADY_CLOUD_CLIENT_ADDRESS_KEY_ENV,
  persistCloudWalletCache,
  provisionCloudWallets,
} from "../cloud/cloud-wallet.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import { isCloudWalletEnabled } from "../config/feature-flags.js";
import { resolveStateDir } from "../config/paths.js";
import { persistConfigEnv } from "./config-env.js";
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
  getAgentWallet: (
    agentId: string,
    chain: CloudChainType,
  ) => Promise<CloudWalletDescriptor>;
  provisionWallet: (input: {
    chainType: CloudChainType;
    clientAddress: string;
  }) => Promise<{
    walletId: string;
    address: string;
    chainType: CloudChainType;
    provider: CloudWalletProvider;
  }>;
}

interface ConnectedCloudAgentLike {
  agentName: string;
}

interface CloudManagerLike {
  init?: () => Promise<void>;
  replaceApiKey?: (apiKey: string) => Promise<void>;
  getClient: () => CloudClientLike | null;
  connect: (agentId: string) => Promise<ConnectedCloudAgentLike>;
  disconnect: () => Promise<void>;
  getStatus: () => unknown;
  getActiveAgentId: () => string | null;
}

interface RuntimeLike {
  agentId: string;
  character?: {
    secrets?: Record<string, string | number | boolean>;
  };
  getService?: (name: string) => unknown;
  updateAgent?: (
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

interface CloudAuthLike {
  authenticateWithApiKey?: (input: {
    apiKey: string;
    organizationId?: string;
    userId?: string;
  }) => unknown;
  clearAuth?: () => unknown;
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
  /**
   * Optional runtime restart hook. When Phase 8 lands the cloud-wallet
   * provisioning integration, the cloud-login handler will call this to
   * rebind plugin-evm / plugin-solana to the cloud provider. Threaded
   * from server.ts the same way provider-switch-routes does.
   */
  restartRuntime?: (reason: string) => Promise<boolean> | boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLOUD_LOGIN_CREATE_TIMEOUT_MS = 10_000;
const CLOUD_LOGIN_POLL_TIMEOUT_MS = 10_000;
const CONFIG_ENV_FILENAME = "config.env";
const CONFIG_ENV_BAK_SUFFIX = ".bak";
const CLOUD_WALLET_ROLLBACK_ENV_KEYS = [
  MILADY_CLOUD_CLIENT_ADDRESS_KEY_ENV,
  "MILADY_CLOUD_EVM_ADDRESS",
  "MILADY_CLOUD_SOLANA_ADDRESS",
  "ENABLE_EVM_PLUGIN",
  "WALLET_SOURCE_EVM",
  "WALLET_SOURCE_SOLANA",
] as const;

type CloudWalletRollbackEnvKey =
  (typeof CLOUD_WALLET_ROLLBACK_ENV_KEYS)[number];

interface ConfigEnvRollbackSnapshot {
  bakPath: string;
  filePath: string;
  originalRaw: string | null;
  previousEnv: Partial<Record<CloudWalletRollbackEnvKey, string>>;
}

function extractAgentId(pathname: string): string | null {
  const id = pathname.split("/")[4];
  return id && UUID_RE.test(id) ? id : null;
}

function replaceMutableRoot<T extends object>(target: T, snapshot: T): void {
  const targetRecord = target as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    delete targetRecord[key];
  }
  Object.assign(
    targetRecord,
    structuredClone(snapshot as Record<string, unknown>),
  );
}

function getCloudAuth(runtime: RuntimeLike | null): CloudAuthLike | null {
  if (typeof runtime?.getService !== "function") {
    return null;
  }
  const service = runtime.getService("CLOUD_AUTH");
  return service && typeof service === "object"
    ? (service as CloudAuthLike)
    : null;
}

function clearCloudAuth(runtime: RuntimeLike | null): CloudAuthLike | null {
  const cloudAuth = getCloudAuth(runtime);
  if (typeof cloudAuth?.clearAuth === "function") {
    cloudAuth.clearAuth();
  }
  return cloudAuth;
}

async function captureConfigEnvRollbackSnapshot(): Promise<ConfigEnvRollbackSnapshot> {
  const filePath = path.join(resolveStateDir(), CONFIG_ENV_FILENAME);
  const bakPath = `${filePath}${CONFIG_ENV_BAK_SUFFIX}`;

  let originalRaw: string | null = null;
  try {
    originalRaw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const previousEnv = Object.fromEntries(
    CLOUD_WALLET_ROLLBACK_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return typeof value === "string" ? ([[key, value]] as const) : [];
    }),
  ) as Partial<Record<CloudWalletRollbackEnvKey, string>>;

  return {
    bakPath,
    filePath,
    originalRaw,
    previousEnv,
  };
}

async function restoreConfigEnvRollbackSnapshot(
  snapshot: ConfigEnvRollbackSnapshot,
): Promise<void> {
  await fs.mkdir(path.dirname(snapshot.filePath), { recursive: true });

  if (snapshot.originalRaw === null) {
    await fs.rm(snapshot.filePath, { force: true });
    await fs.rm(snapshot.bakPath, { force: true });
  } else {
    await fs.writeFile(snapshot.filePath, snapshot.originalRaw, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.writeFile(snapshot.bakPath, snapshot.originalRaw, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  for (const key of CLOUD_WALLET_ROLLBACK_ENV_KEYS) {
    const previousValue = snapshot.previousEnv[key];
    if (typeof previousValue === "string") {
      process.env[key] = previousValue;
    } else {
      delete process.env[key];
    }
  }
}

function saveConfigOrThrow(state: CloudRouteState): void {
  if (!state.saveConfig) {
    throw new Error("saveConfig not available");
  }
  state.saveConfig(state.config);
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
      const cloudAuth = clearCloudAuth(state.runtime);
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
        const character = state.runtime.character ?? {};
        state.runtime.character = character;
        if (!character.secrets) {
          character.secrets = {};
        }
        const secrets = character.secrets as Record<string, string>;
        secrets.ELIZAOS_CLOUD_API_KEY = data.apiKey;
        if (cloudInferenceSelected) {
          secrets.ELIZAOS_CLOUD_ENABLED = "true";
        } else {
          delete secrets.ELIZAOS_CLOUD_ENABLED;
        }

        if (typeof state.runtime.updateAgent === "function") {
          await state.runtime.updateAgent(state.runtime.agentId, {
            secrets: { ...secrets },
          });
          logger.info("[cloud-login] API key persisted to agent DB record");
        } else {
          logger.warn(
            "[cloud-login] runtime.updateAgent not available — agent DB secrets not persisted",
          );
        }
      }

      if (
        state.cloudManager &&
        typeof state.cloudManager.replaceApiKey === "function"
      ) {
        await state.cloudManager.replaceApiKey(data.apiKey);
      } else if (
        state.cloudManager &&
        !state.cloudManager.getClient() &&
        typeof state.cloudManager.init === "function"
      ) {
        await state.cloudManager.init();
      }

      if (typeof cloudAuth?.authenticateWithApiKey === "function") {
        cloudAuth.authenticateWithApiKey({
          apiKey: data.apiKey,
        });
      }

      // Cloud-wallet remote-signing bridge (gated by ENABLE_CLOUD_WALLET).
      // Failures here do NOT abort the cloud-login response — the API key
      // is already saved. We log, rollback the partial wallet bind, and
      // fall through so the user stays logged in.
      if (isCloudWalletEnabled()) {
        const rollbackConfigSnapshot = structuredClone(
          state.config as Record<string, unknown>,
        ) as CloudConfigLike;
        const rollbackEnvSnapshot = await captureConfigEnvRollbackSnapshot();

        try {
          const bridge = state.cloudManager?.getClient();
          const agentId = state.runtime?.agentId;
          if (!bridge) {
            throw new Error("cloud-wallet bridge unavailable");
          }
          if (!agentId) {
            throw new Error("cloud-wallet runtime agentId missing");
          }

          const { address: clientAddress, minted } =
            await getOrCreateClientAddressKey();
          if (minted) {
            logger.info(
              `[cloud-login] cloud-wallet: minted client_address ${clientAddress}`,
            );
          }

          const descriptors = await provisionCloudWallets(bridge, {
            agentId,
            clientAddress,
          });

          persistCloudWalletCache(
            state.config as Record<string, unknown>,
            descriptors,
          );

          const cloudCfg = (state.config.cloud ?? {}) as Record<
            string,
            unknown
          >;
          cloudCfg.clientAddressPublicKey = clientAddress;
          (state.config as Record<string, unknown>).cloud = cloudCfg;
          saveConfigOrThrow(state);

          if (descriptors.evm?.walletAddress) {
            process.env.MILADY_CLOUD_EVM_ADDRESS =
              descriptors.evm.walletAddress;
            await persistConfigEnv(
              "MILADY_CLOUD_EVM_ADDRESS",
              descriptors.evm.walletAddress,
            );
          }
          if (descriptors.solana?.walletAddress) {
            process.env.MILADY_CLOUD_SOLANA_ADDRESS =
              descriptors.solana.walletAddress;
            await persistConfigEnv(
              "MILADY_CLOUD_SOLANA_ADDRESS",
              descriptors.solana.walletAddress,
            );
          }

          await persistConfigEnv("ENABLE_EVM_PLUGIN", "1");
          if (descriptors.evm) {
            await persistConfigEnv("WALLET_SOURCE_EVM", "cloud");
          }
          if (descriptors.solana) {
            await persistConfigEnv("WALLET_SOURCE_SOLANA", "cloud");
          }

          const wallet = ((state.config as Record<string, unknown>).wallet ??
            {}) as Record<string, unknown>;
          const primary = {
            ...((wallet.primary ?? {}) as Record<string, string>),
          };
          if (descriptors.evm) primary.evm = "cloud";
          if (descriptors.solana) primary.solana = "cloud";
          wallet.primary = primary;
          (state.config as Record<string, unknown>).wallet = wallet;
          saveConfigOrThrow(state);

          logger.info(
            `[cloud-login] cloud-wallet: provisioned ${Object.keys(descriptors).join(", ")} — applying runtime reload`,
          );

          const restarted = state.restartRuntime
            ? await Promise.resolve(state.restartRuntime("cloud-wallet-bound"))
            : false;
          if (!restarted) {
            logger.warn(
              "[cloud-login] cloud-wallet: restartRuntime not wired or restart declined — user must restart manually",
            );
          }
        } catch (cloudWalletErr) {
          try {
            await restoreConfigEnvRollbackSnapshot(rollbackEnvSnapshot);
          } catch (rollbackErr) {
            logger.error(
              `[cloud-login] cloud-wallet rollback failed: ${String(
                rollbackErr,
              )}`,
            );
          }

          replaceMutableRoot(state.config, rollbackConfigSnapshot);
          try {
            saveConfigOrThrow(state);
          } catch (saveRollbackErr) {
            logger.error(
              `[cloud-login] cloud-wallet config rollback failed: ${String(
                saveRollbackErr,
              )}`,
            );
          }

          logger.error(
            `[cloud-login] cloud-wallet provision failed: ${String(
              cloudWalletErr,
            )}`,
          );
        }
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
      const character = state.runtime.character ?? {};
      state.runtime.character = character;
      if (!character.secrets) {
        character.secrets = {};
      }
      const secrets = character.secrets as Record<
        string,
        string | number | boolean
      >;
      delete secrets.ELIZAOS_CLOUD_API_KEY;
      delete secrets.ELIZAOS_CLOUD_ENABLED;
      if (typeof state.runtime.updateAgent === "function") {
        await state.runtime.updateAgent(state.runtime.agentId, {
          secrets: { ...secrets },
        });
      } else {
        logger.warn(
          "[cloud-disconnect] updateAgent not available — runtime secrets not persisted",
        );
      }
    }

    sendJson(res, { ok: true, status: "disconnected" });
    return true;
  }

  return false;
}
