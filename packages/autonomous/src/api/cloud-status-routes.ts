import { type AgentRuntime, logger } from "@elizaos/core";
import { resolveCloudApiBaseUrl as resolveCanonicalCloudApiBaseUrl } from "../cloud/base-url";
import { validateCloudBaseUrl } from "../cloud/validate-url";
import type { RouteHelpers, RouteRequestMeta } from "./route-helpers";

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

  const rawBalance =
    typeof creditResponse.balance === "number"
      ? creditResponse.balance
      : typeof (creditResponse.data as Record<string, unknown>)?.balance ===
          "number"
        ? ((creditResponse.data as Record<string, unknown>).balance as number)
        : undefined;
  return typeof rawBalance === "number" ? rawBalance : null;
}

export async function handleCloudStatusRoutes(
  ctx: CloudStatusRouteContext,
): Promise<boolean> {
  const { res, method, pathname, config, runtime, json } = ctx;

  if (method === "GET" && pathname === "/api/cloud/status") {
    const cloudMode = config.cloud?.enabled;
    const cloudEnabled = cloudMode === true;
    const hasApiKey = Boolean(config.cloud?.apiKey?.trim());
    const effectivelyEnabled = cloudEnabled;
    const cloudAuth = runtime
      ? (runtime.getService("CLOUD_AUTH") as CloudAuthIdentityService | null)
      : null;
    const authConnected = Boolean(cloudAuth?.isAuthenticated());

    if (authConnected || hasApiKey) {
      json(res, {
        connected: true,
        enabled: effectivelyEnabled,
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
        enabled: effectivelyEnabled,
        hasApiKey,
        reason: "runtime_not_started",
      });
      return true;
    }

    json(res, {
      connected: false,
      enabled: effectivelyEnabled,
      hasApiKey,
      reason: "not_authenticated",
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/cloud/credits") {
    const cloudAuth = runtime
      ? (runtime.getService("CLOUD_AUTH") as CloudAuthCreditsService | null)
      : null;
    const configApiKey = config.cloud?.apiKey?.trim();

    if (!cloudAuth || !cloudAuth.isAuthenticated()) {
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

      try {
        const balance = await fetchCloudCreditsByApiKey(
          resolvedBaseUrl,
          configApiKey,
        );
        if (typeof balance !== "number") {
          json(res, {
            balance: null,
            connected: true,
            error: "unexpected response",
          });
          return true;
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
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "cloud API unreachable";
        logger.debug(
          `[cloud/credits] Failed to fetch balance via API key: ${msg}`,
        );
        json(res, { balance: null, connected: true, error: msg });
      }
      return true;
    }

    let balance: number;
    const client = cloudAuth.getClient();
    try {
      const creditResponse =
        await client.get<Record<string, unknown>>("/credits/balance");
      const rawBalance =
        typeof creditResponse?.balance === "number"
          ? creditResponse.balance
          : typeof (creditResponse?.data as Record<string, unknown>)
                ?.balance === "number"
            ? ((creditResponse.data as Record<string, unknown>)
                .balance as number)
            : undefined;
      if (typeof rawBalance !== "number") {
        logger.debug(
          `[cloud/credits] Unexpected response shape: ${JSON.stringify(creditResponse)}`,
        );
        json(res, {
          balance: null,
          connected: true,
          error: "unexpected response",
        });
        return true;
      }
      balance = rawBalance;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "cloud API unreachable";
      logger.debug(`[cloud/credits] Failed to fetch balance: ${msg}`);
      json(res, { balance: null, connected: true, error: msg });
      return true;
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
