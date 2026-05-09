import { resolveCloudApiBaseUrl as resolveCanonicalCloudApiBaseUrl } from "../cloud/base-url.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  isCloudInferenceSelectedInConfig,
  isElizaSettingsDebugEnabled,
  migrateLegacyRuntimeConfig,
  settingsDebugCloudSummary,
} from "@elizaos/shared";
import {
  applyCanonicalOnboardingConfig,
  type ElizaConfig,
  normalizeEnvValue,
} from "./config-like";
import {
  clearCloudSecrets,
  getCloudSecret,
  scrubCloudSecretsFromEnv,
} from "./cloud-secrets";

const DEFAULT_CLOUD_API_BASE_URL = "https://www.elizacloud.ai/api/v1";
export const CLOUD_BILLING_URL =
  "https://www.elizacloud.ai/dashboard/settings?tab=billing";

const CLOUD_ENV_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_NANO_MODEL",
  "ELIZAOS_CLOUD_MEDIUM_MODEL",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "ELIZAOS_CLOUD_MEGA_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
  "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
  "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
  "ELIZAOS_CLOUD_PLANNER_MODEL",
  "ELIZAOS_CLOUD_USE_INFERENCE",
  "ELIZAOS_CLOUD_USE_TTS",
  "ELIZAOS_CLOUD_USE_MEDIA",
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
  "ELIZAOS_CLOUD_USE_RPC",
] as const;

const CLOUD_RUNTIME_SECRET_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_NANO_MODEL",
  "ELIZAOS_CLOUD_MEDIUM_MODEL",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "ELIZAOS_CLOUD_MEGA_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
  "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
  "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
  "ELIZAOS_CLOUD_PLANNER_MODEL",
  "ELIZA_CLOUD_AUTH_TOKEN",
  "ELIZA_CLOUD_USER_ID",
  "ELIZA_CLOUD_ORGANIZATION_ID",
] as const;

const CLOUD_RUNTIME_SETTING_KEYS = [
  "ELIZA_CLOUD_AUTH_TOKEN",
  "ELIZA_CLOUD_USER_ID",
  "ELIZA_CLOUD_ORGANIZATION_ID",
] as const;

const CLOUD_AUTH_CLEAR_METHODS = [
  "disconnect",
  "logout",
  "signOut",
  "signout",
  "clearSession",
  "clearAuth",
  "resetAuth",
  "reset",
] as const;

type CloudClientLike = {
  get?: (path: string) => Promise<unknown>;
};

export type CloudAuthLike = {
  authenticateWithApiKey?: (input: {
    apiKey: string;
    organizationId?: string;
    userId?: string;
  }) => unknown;
  isAuthenticated?: () => boolean;
  getUserId?: () => string | undefined;
  getOrganizationId?: () => string | undefined;
  getClient?: () => CloudClientLike | null;
} & Partial<
  Record<
    (typeof CLOUD_AUTH_CLEAR_METHODS)[number],
    (() => Promise<unknown>) | (() => unknown)
  >
>;

export type RuntimeCloudLike = AgentRuntime & {
  agentId: string;
  character: {
    secrets?: Record<string, string | number | boolean>;
    settings?: Record<string, unknown>;
  };
  updateAgent?: (
    agentId: string,
    update: { secrets: Record<string, string | number | boolean> },
  ) => Promise<unknown>;
  setSetting?: (key: string, value: string | null) => unknown;
  getService?: (name: string) => unknown;
};

type CloudManagerLike = {
  disconnect?: () => Promise<void>;
} | null;

export type CloudConnectionSnapshot = {
  apiKey: string | undefined;
  authConnected: boolean;
  cloudAuth: CloudAuthLike | null;
  connected: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  organizationId: string | undefined;
  userId: string | undefined;
};

type CloudCreditsResponse = {
  balance: number | null;
  connected: boolean;
  authRejected?: boolean;
  critical?: boolean;
  error?: string;
  low?: boolean;
  topUpUrl?: string;
};

/** Thrown when the credits endpoint returns 401 — same credential path as chat completions. */
export class CloudCreditsAuthRejectedError extends Error {
  override readonly name = "CloudCreditsAuthRejectedError";
  constructor(message = "Eliza Cloud API key was rejected") {
    super(message);
  }
}

function cloudCreditsHttpErrorMessage(
  status: number,
  creditResponse: { error?: unknown },
): string {
  const err = creditResponse.error;
  if (typeof err === "string" && err.trim()) {
    return err.trim();
  }
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) {
      return msg.trim();
    }
  }
  return `HTTP ${status}`;
}

function asRuntimeCloud(runtime: AgentRuntime | null): RuntimeCloudLike | null {
  return runtime as RuntimeCloudLike | null;
}

export function getCloudAuth(
  runtime: AgentRuntime | null,
): CloudAuthLike | null {
  const runtimeWithServices = asRuntimeCloud(runtime);
  if (typeof runtimeWithServices?.getService !== "function") {
    return null;
  }

  const service = runtimeWithServices.getService("CLOUD_AUTH");
  return service && typeof service === "object"
    ? (service as CloudAuthLike)
    : null;
}

function resolvePersistedCloudIdentity(runtime: AgentRuntime | null): {
  organizationId: string | undefined;
  userId: string | undefined;
} {
  const runtimeWithCloud = asRuntimeCloud(runtime);
  return {
    organizationId:
      normalizeEnvValue(
        runtimeWithCloud?.getSetting?.("ELIZA_CLOUD_ORGANIZATION_ID") as
          | string
          | undefined,
      ) ??
      normalizeEnvValue(
        runtimeWithCloud?.character?.secrets?.ELIZA_CLOUD_ORGANIZATION_ID as
          | string
          | undefined,
      ),
    userId:
      normalizeEnvValue(
        runtimeWithCloud?.getSetting?.("ELIZA_CLOUD_USER_ID") as
          | string
          | undefined,
      ) ??
      normalizeEnvValue(
        runtimeWithCloud?.character?.secrets?.ELIZA_CLOUD_USER_ID as
          | string
          | undefined,
      ),
  };
}

export function resolveCloudApiBaseUrl(rawBaseUrl?: string): string {
  return (
    resolveCanonicalCloudApiBaseUrl(rawBaseUrl ?? DEFAULT_CLOUD_API_BASE_URL) ??
    DEFAULT_CLOUD_API_BASE_URL
  );
}

export function resolveCloudApiKey(
  config: Pick<ElizaConfig, "cloud"> | Record<string, unknown>,
  runtime?: {
    character?: { secrets?: Record<string, unknown> };
    getSetting?: (key: string) => unknown;
  } | null,
): string | undefined {
  migrateLegacyRuntimeConfig(config as Record<string, unknown>);
  // 1. Config file (disk)
  const configApiKey = normalizeEnvValue(
    (config as { cloud?: { apiKey?: string } }).cloud?.apiKey,
  );
  if (configApiKey) return configApiKey;

  if (!isCloudInferenceSelectedInConfig(config as Record<string, unknown>)) {
    // A linked cloud account is represented by the persisted disk key above.
    // Do not resurrect cloud from sealed/env/runtime fallbacks when the
    // canonical connection is local, remote, or unset.
    return undefined;
  }

  // 2. Sealed in-process secret store
  const sealedKey = normalizeEnvValue(getCloudSecret("ELIZAOS_CLOUD_API_KEY"));
  if (sealedKey) return sealedKey;

  // 3. Process environment (may not be scrubbed yet)
  const envKey = normalizeEnvValue(process.env.ELIZAOS_CLOUD_API_KEY);
  if (envKey) return envKey;

  // 4. Runtime settings (persisted in database, survives restarts)
  const runtimeSettingKey = normalizeEnvValue(
    runtime?.getSetting?.("ELIZAOS_CLOUD_API_KEY") as string | undefined,
  );
  if (runtimeSettingKey) return runtimeSettingKey;

  // 5. Runtime character secrets (persisted in database, survives restarts)
  const runtimeKey = normalizeEnvValue(
    runtime?.character?.secrets?.ELIZAOS_CLOUD_API_KEY as string | undefined,
  );
  if (runtimeKey) return runtimeKey;

  return undefined;
}

export function resolveCloudConnectionSnapshot(
  config: Partial<ElizaConfig>,
  runtime: AgentRuntime | null,
): CloudConnectionSnapshot {
  migrateLegacyRuntimeConfig(config as Record<string, unknown>);
  const _cloudRecord =
    config.cloud && typeof config.cloud === "object"
      ? (config.cloud as Record<string, unknown>)
      : undefined;
  const enabled = isCloudInferenceSelectedInConfig(
    config as Record<string, unknown>,
  );
  const apiKey = resolveCloudApiKey(config, runtime);
  const cloudAuth = getCloudAuth(runtime);
  const authConnected = Boolean(cloudAuth?.isAuthenticated?.());
  const hasApiKey = Boolean(apiKey);
  const persistedIdentity = resolvePersistedCloudIdentity(runtime);
  const shouldExposeIdentity = authConnected || hasApiKey;

  return {
    apiKey,
    authConnected,
    cloudAuth,
    connected: authConnected || hasApiKey,
    enabled,
    hasApiKey,
    organizationId: shouldExposeIdentity
      ? (normalizeEnvValue(cloudAuth?.getOrganizationId?.()) ??
        persistedIdentity.organizationId)
      : undefined,
    userId: shouldExposeIdentity
      ? (normalizeEnvValue(cloudAuth?.getUserId?.()) ??
        persistedIdentity.userId)
      : undefined,
  };
}

/**
 * Coerce an Eliza Cloud `balance` field into a number. The cloud API
 * returns `balance` as `string | number` (per the Bridge client + config
 * type definitions) — string when the upstream is using a fixed-precision
 * decimal, number when it's been arithmetic'd. Treat both as the same
 * dollar amount; reject anything else as an unexpected response.
 */
function coerceCloudBalance(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchCloudCreditsByApiKey(
  baseUrl: string,
  apiKey: string,
): Promise<number | null> {
  const response = await fetch(`${baseUrl}/credits/balance`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      "Cloud credits request was redirected; redirects are not allowed",
    );
  }

  const creditResponse = (await response.json().catch((err: unknown) => {
    console.warn(
      "[cloud-connection] Failed to parse credit balance response JSON:",
      err,
    );
    return {};
  })) as {
    balance?: unknown;
    data?: { balance?: unknown };
    error?: unknown;
  };

  if (response.status === 401) {
    throw new CloudCreditsAuthRejectedError(
      cloudCreditsHttpErrorMessage(401, creditResponse),
    );
  }

  if (!response.ok) {
    throw new Error(
      cloudCreditsHttpErrorMessage(response.status, creditResponse),
    );
  }

  const balance =
    coerceCloudBalance(creditResponse.balance) ??
    coerceCloudBalance(creditResponse.data?.balance);

  return balance;
}

/** Configurable credit thresholds. Override via env vars if defaults don't fit. */
const CREDIT_LOW_THRESHOLD = Number(
  process.env.ELIZA_CREDIT_LOW_THRESHOLD ?? "2.0",
);
const CREDIT_CRITICAL_THRESHOLD = Number(
  process.env.ELIZA_CREDIT_CRITICAL_THRESHOLD ?? "0.5",
);

function withCreditFlags(balance: number): CloudCreditsResponse {
  return {
    connected: true,
    balance,
    low: balance < CREDIT_LOW_THRESHOLD,
    critical: balance < CREDIT_CRITICAL_THRESHOLD,
    topUpUrl: CLOUD_BILLING_URL,
  };
}

export async function fetchCloudCredits(
  config: Partial<ElizaConfig>,
  runtime: AgentRuntime | null,
): Promise<CloudCreditsResponse> {
  const snapshot = resolveCloudConnectionSnapshot(config, runtime);
  let authenticatedFailure: string | null = null;
  let authenticatedUnexpectedResponse = false;

  if (!snapshot.connected) {
    return { balance: null, connected: false };
  }

  const cloudClient = snapshot.cloudAuth?.getClient?.();
  if (snapshot.authConnected && typeof cloudClient?.get === "function") {
    try {
      const creditResponse = (await cloudClient.get("/credits/balance")) as {
        balance?: unknown;
        data?: { balance?: unknown };
      };
      const rawBalance =
        coerceCloudBalance(creditResponse?.balance) ??
        coerceCloudBalance(creditResponse?.data?.balance);

      if (typeof rawBalance === "number") {
        return withCreditFlags(rawBalance);
      }

      authenticatedUnexpectedResponse = true;
      logger.debug(
        `[cloud/credits] Unexpected authenticated response shape: ${JSON.stringify(creditResponse)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "cloud API unreachable";
      authenticatedFailure = msg;
      logger.debug(
        `[cloud/credits] Authenticated balance fetch failed: ${msg}`,
      );
    }
  }

  if (!snapshot.apiKey) {
    return {
      balance: null,
      connected: snapshot.connected,
      error:
        authenticatedFailure ??
        (authenticatedUnexpectedResponse
          ? "unexpected response"
          : "missing cloud api key"),
    };
  }

  const resolvedBaseUrl = resolveCloudApiBaseUrl(config.cloud?.baseUrl);
  const baseUrlRejection = await validateCloudBaseUrl(resolvedBaseUrl);
  if (baseUrlRejection) {
    return {
      balance: null,
      connected: true,
      error: baseUrlRejection,
    };
  }

  try {
    const balance = await fetchCloudCreditsByApiKey(
      resolvedBaseUrl,
      snapshot.apiKey,
    );

    if (typeof balance !== "number") {
      return {
        balance: null,
        connected: true,
        error: "unexpected response",
      };
    }

    return withCreditFlags(balance);
  } catch (err) {
    if (err instanceof CloudCreditsAuthRejectedError) {
      logger.debug(`[cloud/credits] API key rejected: ${err.message}`);
      return {
        balance: null,
        connected: true,
        authRejected: true,
        error: err.message,
        topUpUrl: CLOUD_BILLING_URL,
      };
    }
    const msg = err instanceof Error ? err.message : "cloud API unreachable";
    logger.debug(`[cloud/credits] Failed to fetch balance via API key: ${msg}`);
    return {
      balance: null,
      connected: true,
      error: msg,
    };
  }
}

export async function clearCloudAuthService(
  cloudAuth: CloudAuthLike | null,
): Promise<void> {
  if (!cloudAuth) {
    return;
  }

  const seen = new Set<(...args: never[]) => unknown>();
  for (const methodName of CLOUD_AUTH_CLEAR_METHODS) {
    const method = cloudAuth[methodName];
    if (typeof method !== "function" || seen.has(method)) {
      continue;
    }

    seen.add(method);
    try {
      await method.call(cloudAuth);
      // First successful clear method is sufficient — stop trying remaining ones.
      break;
    } catch (err) {
      logger.warn(
        `[cloud/disconnect] Failed to invoke CLOUD_AUTH.${methodName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function clearCloudEnv(): void {
  for (const key of CLOUD_ENV_KEYS) {
    delete process.env[key];
  }
  clearCloudSecrets();
  scrubCloudSecretsFromEnv();
}

async function clearRuntimeCloudState(
  runtime: AgentRuntime | null,
): Promise<void> {
  const runtimeWithCloud = asRuntimeCloud(runtime);
  if (!runtimeWithCloud) {
    return;
  }

  const existingSecrets = runtimeWithCloud.character.secrets ?? {};
  const nextSecrets = { ...existingSecrets };
  for (const key of CLOUD_RUNTIME_SECRET_KEYS) {
    delete nextSecrets[key];
  }
  runtimeWithCloud.character.secrets = nextSecrets;

  if (
    runtimeWithCloud.character.settings &&
    typeof runtimeWithCloud.character.settings === "object"
  ) {
    for (const key of CLOUD_RUNTIME_SETTING_KEYS) {
      delete runtimeWithCloud.character.settings[key];
    }
  }

  if (typeof runtimeWithCloud.setSetting === "function") {
    for (const key of CLOUD_RUNTIME_SETTING_KEYS) {
      try {
        runtimeWithCloud.setSetting(key, null);
      } catch (err) {
        logger.warn(
          `[cloud/disconnect] Failed to clear runtime setting ${key}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  if (typeof runtimeWithCloud.updateAgent === "function") {
    try {
      await runtimeWithCloud.updateAgent(runtimeWithCloud.agentId, {
        secrets: { ...nextSecrets },
      });
    } catch (err) {
      logger.warn(
        `[cloud/disconnect] Failed to clear cloud secrets from agent DB: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export async function disconnectCloudConnection(args: {
  cloudManager?: CloudManagerLike;
  config: Partial<ElizaConfig>;
  runtime: AgentRuntime | null;
  saveConfig?: (config: Partial<ElizaConfig>) => void;
}): Promise<void> {
  const { cloudManager = null, config, runtime, saveConfig } = args;

  if (isElizaSettingsDebugEnabled()) {
    const c = config.cloud as Record<string, unknown> | undefined;
    logger.debug(
      `[eliza][settings][cloud] disconnectCloudConnection start cloud=${JSON.stringify(settingsDebugCloudSummary(c))}`,
    );
  }

  if (typeof cloudManager?.disconnect === "function") {
    try {
      await cloudManager.disconnect();
    } catch (err) {
      logger.warn(
        `[cloud/disconnect] Failed to disconnect cloud manager: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  await clearCloudAuthService(getCloudAuth(runtime));

  const nextCloud = { ...(config.cloud ?? {}) };
  delete nextCloud.apiKey;
  config.cloud = nextCloud;
  applyCanonicalOnboardingConfig(config as ElizaConfig, {
    deploymentTarget: { runtime: "local" },
    linkedAccounts: {
      elizacloud: {
        status: "unlinked",
        source: "api-key",
      },
    },
    clearRoutes: ["llmText", "tts", "media", "embeddings", "rpc"],
  });
  migrateLegacyRuntimeConfig(config as Record<string, unknown>);

  try {
    saveConfig?.(config);
    if (isElizaSettingsDebugEnabled()) {
      const c = config.cloud as Record<string, unknown> | undefined;
      logger.debug(
        `[eliza][settings][cloud] disconnectCloudConnection saveConfig OK cloud=${JSON.stringify(settingsDebugCloudSummary(c))}`,
      );
    }
  } catch (err) {
    logger.warn(
      `[cloud/disconnect] Failed to save cloud disconnect state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  clearCloudEnv();
  await clearRuntimeCloudState(runtime);

  if (isElizaSettingsDebugEnabled()) {
    logger.debug(
      "[eliza][settings][cloud] disconnectCloudConnection done (env cleared + runtime cloud state cleared)",
    );
  }
}

export const disconnectUnifiedCloudConnection = disconnectCloudConnection;

/** Matches `reason` from GET /api/cloud/status when connected via API key without CLOUD_AUTH. */
const CLOUD_STATUS_API_KEY_ONLY_REASONS: ReadonlySet<string> = new Set([
  "api_key_present_not_authenticated",
  "api_key_present_runtime_not_started",
]);

export function isCloudStatusReasonApiKeyOnly(
  reason: string | null | undefined,
): boolean {
  return (
    typeof reason === "string" && CLOUD_STATUS_API_KEY_ONLY_REASONS.has(reason)
  );
}
