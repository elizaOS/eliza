import type { AgentRuntime, Service } from "@elizaos/core";
import {
  isCloudInferenceSelectedInConfig,
  isElizaCloudServiceSelectedInConfig,
  migrateLegacyRuntimeConfig,
} from "@elizaos/shared";
import { resolveCloudApiBaseUrl as resolveCanonicalCloudApiBaseUrl } from "../cloud/base-url.js";
import { resolveCloudApiKey } from "../cloud/cloud-api-key.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import type { RouteHelpers, RouteRequestMeta } from "@elizaos/agent/api/route-helpers";

const DEFAULT_CLOUD_API_BASE_URL = "https://www.elizacloud.ai/api/v1";
const CLOUD_BILLING_URL =
  "https://www.elizacloud.ai/dashboard/settings?tab=billing";

interface CloudAuthIdentityService {
  isAuthenticated: () => boolean;
  getUserId?: () => string | undefined;
  getOrganizationId?: () => string | undefined;
}

interface CloudAuthCreditsService {
  isAuthenticated: () => boolean;
  getClient: () => { get: <T>(path: string) => Promise<T> };
}

export interface CloudConfigLike {
  cloud?: {
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
  };
}

export interface CloudStatusRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json"> {
  config: CloudConfigLike;
  runtime: AgentRuntime | null;
}

function resolveCloudApiBaseUrl(rawBaseUrl?: string): string {
  return resolveCanonicalCloudApiBaseUrl(
    rawBaseUrl ?? DEFAULT_CLOUD_API_BASE_URL,
  );
}

/**
 * Coerce an Eliza Cloud `balance` field into a number. The cloud API
 * returns `balance` as `string | number` — string when upstream is using
 * fixed-precision decimals, number when arithmetic'd. Treat both as the
 * same dollar amount.
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

  const creditResponse = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    const message =
      typeof creditResponse.error === "string" && creditResponse.error.trim()
        ? creditResponse.error
        : `HTTP ${response.status}`;
    throw new Error(message);
  }

  const balance =
    coerceCloudBalance(creditResponse.balance) ??
    coerceCloudBalance(
      (creditResponse.data as Record<string, unknown> | undefined)?.balance,
    );
  return balance;
}

export async function handleCloudStatusRoutes(
  ctx: CloudStatusRouteContext,
): Promise<boolean> {
  const { res, method, pathname, config, runtime, json } = ctx;

  if (method === "GET" && pathname === "/api/cloud/status") {
    migrateLegacyRuntimeConfig(config as Record<string, unknown>);
    const cloudEnabled = isCloudInferenceSelectedInConfig(
      config as Record<string, unknown>,
    );
    const cloudVoiceProxyAvailable = isElizaCloudServiceSelectedInConfig(
      config as Record<string, unknown>,
      "tts",
    );
    const configApiKey = resolveCloudApiKey(config, runtime);
    const hasApiKey = Boolean(configApiKey);
    const cloudAuth = runtime
      ? runtime.getService<Service & CloudAuthIdentityService>("CLOUD_AUTH")
      : null;
    const authConnected = Boolean(cloudAuth?.isAuthenticated());

    if (authConnected || hasApiKey) {
      json(res, {
        connected: true,
        enabled: cloudEnabled,
        cloudVoiceProxyAvailable,
        hasApiKey,
        userId: authConnected ? cloudAuth?.getUserId?.() : undefined,
        organizationId: authConnected
          ? cloudAuth?.getOrganizationId?.()
          : undefined,
        topUpUrl: CLOUD_BILLING_URL,
        reason: authConnected
          ? undefined
          : runtime
            ? "api_key_present_not_authenticated"
            : "api_key_present_runtime_not_started",
      });
      return true;
    }

    if (!runtime) {
      json(res, {
        connected: false,
        enabled: cloudEnabled,
        cloudVoiceProxyAvailable,
        hasApiKey,
        reason: "runtime_not_started",
      });
      return true;
    }

    json(res, {
      connected: false,
      enabled: cloudEnabled,
      cloudVoiceProxyAvailable,
      hasApiKey,
      reason: "not_authenticated",
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/cloud/credits") {
    const cloudAuth = runtime
      ? runtime.getService<Service & CloudAuthCreditsService>("CLOUD_AUTH")
      : null;
    const configApiKey = resolveCloudApiKey(config, runtime);

    if (!cloudAuth?.isAuthenticated()) {
      if (!configApiKey) {
        json(res, { balance: null, connected: false });
        return true;
      }

      const resolvedBaseUrl = resolveCloudApiBaseUrl(config.cloud?.baseUrl);
      const baseUrlRejection = await validateCloudBaseUrl(resolvedBaseUrl);
      if (baseUrlRejection) {
        json(res, { balance: null, connected: true, error: baseUrlRejection });
        return true;
      }

      const balance = await fetchCloudCreditsByApiKey(
        resolvedBaseUrl,
        configApiKey,
      );
      if (typeof balance !== "number") {
        throw new Error("unexpected response");
      }
      const low = balance < 2.0;
      const critical = balance < 0.5;
      json(res, {
        connected: true,
        balance,
        low,
        critical,
        topUpUrl: CLOUD_BILLING_URL,
      });
      return true;
    }

    const client = cloudAuth.getClient();
    const creditResponse =
      await client.get<Record<string, unknown>>("/credits/balance");
    const balance =
      coerceCloudBalance(creditResponse?.balance) ??
      coerceCloudBalance(
        (creditResponse?.data as Record<string, unknown> | undefined)?.balance,
      );
    if (typeof balance !== "number") {
      throw new Error(
        `Unexpected response shape: ${JSON.stringify(creditResponse)}`,
      );
    }

    const low = balance < 2.0;
    const critical = balance < 0.5;
    json(res, {
      connected: true,
      balance,
      low,
      critical,
      topUpUrl: CLOUD_BILLING_URL,
    });
    return true;
  }

  return false;
}
