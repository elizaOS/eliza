/**
 * Shared handler for the /api/v1/maps routes. Order: authenticate the account,
 * read the configured provider, check the subscription entitlement, ask the
 * durable organization Maps request allowance, then call
 * the provider. Location data stays in POST bodies,
 * is passed only to the provider and is never logged.
 */

import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { getCloudAwareEnv } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import {
  admitAllMapsRequests,
  type MapsAdmissionHook,
  type MapsOperation,
  type MapsProviderAdapter,
  MapsServiceError,
  mapsPlaceDetailsRequestSchema,
  mapsReverseRequestSchema,
  mapsRoutesRequestSchema,
  mapsTextSearchRequestSchema,
} from "@elizaos/cloud-shared/lib/services/maps/contract";
import { osmMapsProviderFromEnv } from "@elizaos/cloud-shared/lib/services/maps/osm-provider";
import {
  consumePlanRequest,
  readPlanRequestLimitConfig,
} from "@elizaos/cloud-shared/lib/services/plan-request-limiter";
import { readOrganizationEntitlementSummary } from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { getGenerativeExecutionContext } from "./generative-route-auth";
import {
  admitMapsRequest,
  authenticateMapsCaller,
  MapsAdmissionError,
  type MapsCaller,
  type MapsCompletion,
} from "./maps-request-admission";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface MapsRouteDependencies {
  authenticate(c: AppContext): Promise<MapsCaller>;
  /** Production durable admission; injected tests may exercise the legacy seam. */
  admitRequest?: typeof admitMapsRequest;
  /** Whether the organization's plan is active or trialing, and the policy that keys its buckets. */
  entitlement(organizationId: string): Promise<MapsPlanEntitlement>;
  admit: MapsAdmissionHook;
  /** The configured provider, or null while Maps is not provisioned. */
  provider(): MapsProviderAdapter | null;
}

let cachedProvider:
  | { key: string; provider: MapsProviderAdapter | null }
  | undefined;

function configuredProvider(): MapsProviderAdapter | null {
  const env = getCloudAwareEnv();
  const key = [
    env.ELIZA_MAPS_GEOCODER_URL,
    env.ELIZA_MAPS_ROUTER_URL,
    env.ELIZA_MAPS_ROUTER_API_KEY,
    env.ELIZA_MAPS_COVERAGE_JSON,
    env.ELIZA_MAPS_DATASET_REVISION,
    env.ELIZA_MAPS_ROUTE_ALTERNATIVES,
  ].join("\u0000");
  if (cachedProvider?.key !== key)
    cachedProvider = {
      key,
      provider: osmMapsProviderFromEnv(env as Record<string, unknown>),
    };
  return cachedProvider.provider;
}

export interface MapsPlanEntitlement {
  entitled: boolean;
  planKey: string | null;
  planEffectiveUntil: string | null;
}

/**
 * Legacy isolate limiter retained for explicit injected callers. Production
 * routes use durable Maps admission, which requires a selected allowance.
 */
export const admitMapsByPlanBuckets: MapsAdmissionHook = async (request) => {
  const config = readPlanRequestLimitConfig();
  if (!config) return admitAllMapsRequests(request);
  const decision = consumePlanRequest(
    {
      service: "maps",
      organizationId: request.organizationId,
      userId: request.userId,
      planKey: request.planKey,
      planEffectiveUntil: request.planEffectiveUntil,
    },
    config,
  );
  return decision.allowed
    ? { allowed: true }
    : {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(decision.retryAfterMs / 1_000),
        ),
      };
};

export const defaultMapsRouteDependencies: MapsRouteDependencies = {
  authenticate: authenticateMapsCaller,
  admitRequest: admitMapsRequest,
  entitlement: async (organizationId) => {
    const { plan, rateTier, effectiveUntil } =
      await readOrganizationEntitlementSummary(organizationId);
    return {
      entitled: plan.status === "active" || plan.status === "trialing",
      planKey: rateTier ?? null,
      planEffectiveUntil: effectiveUntil?.toISOString() ?? null,
    };
  },
  admit: admitMapsByPlanBuckets,
  provider: configuredProvider,
};

function failure(c: AppContext, error: MapsServiceError) {
  // The retry time is in the body too: native clients read the body only.
  const body =
    error.retryAfterSeconds === undefined
      ? { error: error.message, code: error.code }
      : {
          error: error.message,
          code: error.code,
          retryAfterSeconds: error.retryAfterSeconds,
        };
  return c.json(body, error.status, {
    ...NO_STORE,
    ...(error.retryAfterSeconds !== undefined
      ? { "Retry-After": String(error.retryAfterSeconds) }
      : {}),
  });
}

async function readBody(c: AppContext): Promise<unknown> {
  try {
    return await c.req.raw.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // error-policy:J3 malformed JSON is an explicit invalid request.
    throw new MapsServiceError(
      "invalid_request",
      "The request body must be JSON.",
    );
  }
}

function parsed<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new MapsServiceError(
      "invalid_request",
      "The maps request is invalid.",
    );
  return result.data;
}

async function dispatch(
  operation: MapsOperation,
  provider: MapsProviderAdapter,
  c: AppContext,
  body: unknown,
): Promise<Record<string, unknown>> {
  const signal = c.req.raw.signal;
  const { providerId, attribution } = provider.coverage();
  switch (operation) {
    case "coverage":
      return { ...provider.coverage() };
    case "geocode":
      return {
        providerId,
        attribution,
        places: await provider.geocode(
          parsed(mapsTextSearchRequestSchema, body),
          signal,
        ),
      };
    case "search":
      return {
        providerId,
        attribution,
        places: await provider.search(
          parsed(mapsTextSearchRequestSchema, body),
          signal,
        ),
      };
    case "reverse":
      return {
        providerId,
        attribution,
        place: await provider.reverse(
          parsed(mapsReverseRequestSchema, body),
          signal,
        ),
      };
    case "details":
      return {
        providerId,
        attribution,
        place: await provider.details(
          parsed(mapsPlaceDetailsRequestSchema, body),
          signal,
        ),
      };
    case "routes":
      return {
        providerId,
        attribution,
        routes: await provider.routes(
          parsed(mapsRoutesRequestSchema, body),
          signal,
        ),
      };
  }
}

/** One Maps route: GET for coverage, POST for every operation that carries a query or location. */
export function createMapsRoute(
  operation: MapsOperation,
  dependencies: MapsRouteDependencies = defaultMapsRouteDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", rateLimit(RateLimitPresets.STANDARD));
  const handler = async (c: AppContext) => {
    let user: MapsCaller;
    try {
      user = await dependencies.authenticate(c);
    } catch (error) {
      if (error instanceof ApiError)
        return c.json(
          { error: error.message, code: error.code },
          error.status,
          NO_STORE,
        );
      throw error;
    }
    let provider: MapsProviderAdapter | null;
    try {
      provider = dependencies.provider();
    } catch (error) {
      // error-policy:J1 invalid operator configuration is reported as not configured.
      logger.error("[Maps] Provider configuration is invalid", {
        error: error instanceof Error ? error.message : String(error),
      });
      provider = null;
    }
    if (!provider)
      return failure(
        c,
        new MapsServiceError(
          "maps_not_configured",
          "Eliza Cloud Maps is not configured.",
        ),
      );
    let body: unknown;
    try {
      body = operation === "coverage" ? undefined : await readBody(c);
      if (operation !== "coverage")
        parsed<unknown>(
          operation === "search" || operation === "geocode"
            ? mapsTextSearchRequestSchema
            : operation === "reverse"
              ? mapsReverseRequestSchema
              : operation === "details"
                ? mapsPlaceDetailsRequestSchema
                : mapsRoutesRequestSchema,
          body,
        );
    } catch (error) {
      if (error instanceof MapsServiceError) return failure(c, error);
      throw error;
    }
    let completion: MapsCompletion | undefined;
    if (dependencies.admitRequest) {
      try {
        completion = await dependencies.admitRequest(c, user, operation);
      } catch (error) {
        if (error instanceof ApiError || error instanceof MapsAdmissionError)
          return c.json(
            {
              error: error.message,
              code: error.code,
              ...(error.details?.retryAfterSeconds
                ? { retryAfterSeconds: error.details.retryAfterSeconds }
                : {}),
            },
            error.status as 400 | 403 | 408 | 409 | 429 | 503,
            NO_STORE,
          );
        throw error;
      }
    } else {
      let entitlement: MapsPlanEntitlement;
      try {
        entitlement = await dependencies.entitlement(user.organization_id);
      } catch (error) {
        // error-policy:J1 an entitlement read failure refuses the request; it never admits it.
        logger.error("[Maps] Entitlement unavailable", {
          organizationId: user.organization_id,
          error: error instanceof Error ? error.message : String(error),
        });
        return failure(
          c,
          new MapsServiceError(
            "entitlement_unavailable",
            "Subscription status is temporarily unavailable.",
            {
              retryAfterSeconds: 60,
            },
          ),
        );
      }
      if (!entitlement.entitled)
        return failure(
          c,
          new MapsServiceError(
            "subscription_required",
            "An active Eliza subscription is required for Maps.",
          ),
        );
      const decision = await dependencies.admit({
        organizationId: user.organization_id,
        userId: user.id,
        operation,
        planKey: entitlement.planKey,
        planEffectiveUntil: entitlement.planEffectiveUntil,
      });
      if (!decision.allowed)
        return failure(
          c,
          new MapsServiceError(
            "rate_limited",
            "Maps request limit reached. Try again later.",
            {
              retryAfterSeconds: decision.retryAfterSeconds,
            },
          ),
        );
    }
    const record = (outcome: "succeeded" | "failed" | "cancelled") => {
      if (!completion) return;
      const task = completion(outcome).catch(() => {
        logger.warn("[Maps] Usage outcome remains unknown", { operation });
      });
      const execution = getGenerativeExecutionContext(c);
      if (execution) execution.waitUntil(task);
      return task;
    };
    try {
      if (c.req.raw.signal.aborted) {
        await record("cancelled");
        return c.json(
          { error: "Maps request cancelled", code: "maps_request_cancelled" },
          408,
          NO_STORE,
        );
      }
      const result = await dispatch(operation, provider, c, body);
      if (c.req.raw.signal.aborted) {
        await record("cancelled");
        return c.json(
          { error: "Maps request cancelled", code: "maps_request_cancelled" },
          408,
          NO_STORE,
        );
      }
      const outcome = record("succeeded");
      if (!getGenerativeExecutionContext(c)) await outcome;
      return c.json(result, 200, NO_STORE);
    } catch (error) {
      if (c.req.raw.signal.aborted) await record("cancelled");
      if (!(error instanceof MapsServiceError)) throw error;
      if (
        !c.req.raw.signal.aborted &&
        [
          "unsupported_region",
          "unsupported_mode",
          "no_route",
          "provider_unavailable",
          "provider_invalid_response",
        ].includes(error.code)
      )
        await record("failed");
      // Operation and code only: queries and coordinates are never logged.
      logger.warn("[Maps] Request refused", {
        operation,
        code: error.code,
        organizationId: user.organization_id,
      });
      return failure(c, error);
    }
  };
  if (operation === "coverage") app.get("/", handler);
  else app.post("/", handler);
  return app;
}
