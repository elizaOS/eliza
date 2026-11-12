/** Route-isolated throttling policy for the public native authorization exchange. */

import {
  getIpKey,
  type RateLimitConfig,
  type RateLimitDependencies,
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  MOBILE_APP_AUTH_CLEANUP_DRAIN_CAPACITY,
  MobileAppAuthProtocolError,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";

export const MOBILE_APP_AUTH_GRANT_ADMISSION_WINDOW_MS = 15 * 60_000;
export const MOBILE_APP_AUTH_GRANT_USER_MAX = 20;
export const MOBILE_APP_AUTH_GRANT_IP_MAX = 200;
export const MOBILE_APP_AUTH_GRANT_GLOBAL_MAX = Math.floor(
  MOBILE_APP_AUTH_CLEANUP_DRAIN_CAPACITY / 2,
);

function mobileGrantAdmissionNamespace(c: AppContext): string {
  if (c.env.ENVIRONMENT !== "staging" && c.env.ENVIRONMENT !== "production") {
    throw new MobileAppAuthProtocolError(
      "server_configuration_error",
      "Mobile App Auth grant admission requires an exact environment",
    );
  }
  return `mobile-app-auth:grant:${c.env.ENVIRONMENT}`;
}

function mobileAppAuthRateLimitConfig(
  operation: "ack" | "config" | "renew" | "token",
  preset: Pick<RateLimitConfig, "maxRequests" | "windowMs">,
): RateLimitConfig {
  const namespace = `mobile-app-auth:${operation}`;
  return {
    ...preset,
    keyGenerator: (c: AppContext) => `${namespace}:${getIpKey(c)}`,
    redisUnavailableFallback: { namespace },
    failClosed: true,
  };
}

export const MOBILE_APP_AUTH_CONFIG_RATE_LIMIT = mobileAppAuthRateLimitConfig(
  "config",
  RateLimitPresets.STANDARD,
);
export const MOBILE_APP_AUTH_TOKEN_RATE_LIMIT = mobileAppAuthRateLimitConfig(
  "token",
  RateLimitPresets.STRICT,
);
export const MOBILE_APP_AUTH_ACK_RATE_LIMIT = mobileAppAuthRateLimitConfig(
  "ack",
  RateLimitPresets.STRICT,
);

export const MOBILE_APP_AUTH_RENEW_RATE_LIMIT = mobileAppAuthRateLimitConfig(
  "renew",
  RateLimitPresets.STRICT,
);

export const MOBILE_APP_AUTH_RENEW_CREDENTIAL_WINDOW_MS = 60 * 60_000;
export const MOBILE_APP_AUTH_RENEW_CREDENTIAL_MAX = 6;

/**
 * One credential renews at most once a day in normal use. This bucket bounds
 * the codes a single (possibly stolen) credential can ask for, ahead of the
 * shared grant-admission buckets.
 */
export function mobileAppAuthRenewCredentialRateLimit(
  credentialId: string,
): RateLimitConfig {
  return {
    failClosed: true,
    windowMs: MOBILE_APP_AUTH_RENEW_CREDENTIAL_WINDOW_MS,
    maxRequests: MOBILE_APP_AUTH_RENEW_CREDENTIAL_MAX,
    keyGenerator: (c: AppContext) =>
      `${mobileGrantAdmissionNamespace(c)}:renew-credential:${credentialId}`,
  };
}

export function mobileAppAuthGrantAdmissionRateLimits(
  userId: string,
): readonly [RateLimitConfig, RateLimitConfig, RateLimitConfig] {
  const common = {
    failClosed: true,
    windowMs: MOBILE_APP_AUTH_GRANT_ADMISSION_WINDOW_MS,
  } as const;
  return [
    {
      ...common,
      maxRequests: MOBILE_APP_AUTH_GRANT_USER_MAX,
      keyGenerator: (c: AppContext) =>
        `${mobileGrantAdmissionNamespace(c)}:user:${userId}`,
    },
    {
      ...common,
      maxRequests: MOBILE_APP_AUTH_GRANT_IP_MAX,
      keyGenerator: (c: AppContext) =>
        `${mobileGrantAdmissionNamespace(c)}:${getIpKey(c)}`,
    },
    {
      ...common,
      maxRequests: MOBILE_APP_AUTH_GRANT_GLOBAL_MAX,
      keyGenerator: (c: AppContext) =>
        `${mobileGrantAdmissionNamespace(c)}:global`,
    },
  ];
}

async function adaptMobileAppAuthRateLimitResponse(
  response: Response,
): Promise<Response> {
  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");

  if (response.status === 429) {
    return Response.json(
      {
        success: false,
        error: "slow_down",
        errorDescription: "Too many mobile authorization requests",
        retryable: true,
        ...(Number.isFinite(retryAfter) && { retryAfter }),
      },
      { status: 429, headers },
    );
  }
  if (response.status === 503) {
    return Response.json(
      {
        success: false,
        error: "temporarily_unavailable",
        errorDescription:
          "Mobile authorization rate limiting is temporarily unavailable",
        retryable: true,
        ...(Number.isFinite(retryAfter) && { retryAfter }),
      },
      { status: 503, headers },
    );
  }
  return response;
}

/**
 * Limiter refusals in the canonical Cloud API error shape, for the renewal
 * route: 429 `rate_limit_exceeded` and a retryable 503 `service_unavailable`.
 */
export async function canonicalRateLimitResponse(
  response: Response,
): Promise<Response> {
  if (response.status !== 429 && response.status !== 503) return response;
  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  const limited = response.status === 429;
  return Response.json(
    {
      success: false,
      error: limited
        ? "Too many renewal requests"
        : "Renewal is temporarily unavailable",
      code: limited ? "rate_limit_exceeded" : "service_unavailable",
      ...(Number.isFinite(retryAfter) && { retryAfterSeconds: retryAfter }),
    },
    { status: response.status, headers },
  );
}

export type MobileAppAuthRateLimitResponseAdapter = (
  response: Response,
) => Promise<Response>;

/** Applies the native-auth limiter while retaining the protocol response schema. */
export function mobileAppAuthRateLimitMiddleware(
  config: RateLimitConfig,
  dependencies?: RateLimitDependencies,
  adaptResponse: MobileAppAuthRateLimitResponseAdapter = adaptMobileAppAuthRateLimitResponse,
) {
  const middleware = rateLimit(config, undefined, dependencies);
  return async (
    c: AppContext,
    next: () => Promise<void>,
  ): Promise<Response | undefined> => {
    const response = await middleware(c, next);
    return response instanceof Response
      ? await adaptResponse(response)
      : undefined;
  };
}

/**
 * Admit a validated, authenticated approval immediately before it creates a
 * grant. User and IP rejection precede the shared bucket so one abusive
 * identity cannot consume global launch capacity with already-denied traffic.
 * The global bucket is half one cleanup drain because an arbitrary fifteen-
 * minute cron interval can straddle two fixed limiter windows.
 */
export async function runMobileAppAuthGrantAdmission(
  c: AppContext,
  userId: string,
  createGrant: () => Promise<Response>,
  dependencies?: RateLimitDependencies,
  options: {
    /** Buckets checked before the shared user, IP and global ones. */
    leading?: readonly RateLimitConfig[];
    adaptResponse?: MobileAppAuthRateLimitResponseAdapter;
  } = {},
): Promise<Response> {
  const adaptResponse =
    options.adaptResponse ?? adaptMobileAppAuthRateLimitResponse;
  const configs = [
    ...(options.leading ?? []),
    ...mobileAppAuthGrantAdmissionRateLimits(userId),
  ];
  const apply = async (index: number): Promise<Response> => {
    if (index === configs.length) return await createGrant();
    const config = configs[index];
    if (!config) {
      throw new MobileAppAuthProtocolError(
        "server_configuration_error",
        "Mobile App Auth grant admission policy is incomplete",
      );
    }
    let downstream: Response | undefined;
    const middlewareResponse = await rateLimit(
      config,
      undefined,
      dependencies,
    )(c, async () => {
      downstream = await apply(index + 1);
    });
    if (middlewareResponse instanceof Response) {
      return await adaptResponse(middlewareResponse);
    }
    if (downstream) return downstream;
    throw new MobileAppAuthProtocolError(
      "server_configuration_error",
      "Mobile App Auth grant admission produced no response",
    );
  };
  return await apply(0);
}
