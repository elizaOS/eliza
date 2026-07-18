/** Route-isolated throttling policy for the public native authorization exchange. */

import {
  getIpKey,
  type RateLimitConfig,
  type RateLimitDependencies,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  MOBILE_APP_AUTH_CLEANUP_DRAIN_CAPACITY,
  MobileAppAuthProtocolError,
} from "@/lib/services/mobile-app-auth";
import type { AppContext } from "@/types/cloud-worker-env";

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

function mobileAppAuthRateLimit(
  operation: "ack" | "config" | "token",
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

export const MOBILE_APP_AUTH_CONFIG_RATE_LIMIT = mobileAppAuthRateLimit(
  "config",
  RateLimitPresets.STANDARD,
);
export const MOBILE_APP_AUTH_TOKEN_RATE_LIMIT = mobileAppAuthRateLimit(
  "token",
  RateLimitPresets.STRICT,
);
export const MOBILE_APP_AUTH_ACK_RATE_LIMIT = mobileAppAuthRateLimit(
  "ack",
  RateLimitPresets.STRICT,
);

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
): Promise<Response> {
  const configs = mobileAppAuthGrantAdmissionRateLimits(userId);
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
    if (middlewareResponse instanceof Response) return middlewareResponse;
    if (downstream) return downstream;
    throw new MobileAppAuthProtocolError(
      "server_configuration_error",
      "Mobile App Auth grant admission produced no response",
    );
  };
  return await apply(0);
}
