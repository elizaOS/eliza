/**
 * Admits paid legacy proxy routes through the same one-read standing boundary
 * as generative inference before any provider-specific work can run.
 */

import { ApiError } from "@/lib/api/cloud-worker-errors";
import { deferredCredentialAdmissionGuard } from "@/lib/services/deferred-credential-admission-guard";
import type { EndpointType } from "@/lib/services/org-rate-limits";
import type { ProxyCombinedAdmission } from "@/lib/services/proxy/engine";
import { createHandler, executeWithBody } from "@/lib/services/proxy/engine";
import type {
  ProxyRequestBody,
  ServiceConfig,
  ServiceHandler,
} from "@/lib/services/proxy/types";
import { logger } from "@/lib/utils/logger";
import type { AppContext } from "@/types/cloud-worker-env";
import {
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  requireGenerativeRouteCaller,
} from "./generative-route-auth";

interface GuardedPaidProxyOptions {
  request?: Request;
  rateLimitEndpoint?: EndpointType;
  deferStrongCredentialCheck?: boolean;
}

/** Delays route-local parsing until the shared caller standing decision exists. */
export interface PreparedPaidProxyBody {
  config: ServiceConfig;
  work: ServiceHandler;
  body: ProxyRequestBody;
}

export type PaidProxyPreflight = () =>
  | PreparedPaidProxyBody
  | Response
  | Promise<PreparedPaidProxyBody | Response>;

function paidProxyApiErrorResponse(error: ApiError): Response {
  const retryAfterSeconds = error.details?.retryAfterSeconds;
  const headers = new Headers({ "Content-Type": "application/json" });
  if (typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
    headers.set("Retry-After", String(Math.ceil(retryAfterSeconds)));
  }
  return Response.json(error.toJSON(), { status: error.status, headers });
}

/** Resolve caller standing exactly once and pass the decision to paid work. */
export async function withGuardedPaidProxyAdmission(
  c: AppContext,
  dispatch: (admission: ProxyCombinedAdmission) => Promise<Response>,
  options: GuardedPaidProxyOptions = {},
): Promise<Response> {
  const request = options.request ?? c.req.raw;
  const executionCtx = getGenerativeExecutionContext(c);
  const requestId =
    c.get("requestId") ?? c.get("traceId") ?? crypto.randomUUID();
  if (!executionCtx && c.env.NODE_ENV === "production") {
    logger.error("[PaidProxyAdmission] Worker execution context missing", {
      requestId,
      route: new URL(request.url).pathname,
    });
    return paidProxyApiErrorResponse(
      new ApiError(
        503,
        "service_unavailable",
        "Provider admission is unavailable; retry shortly",
        { retryable: true, retryAfterSeconds: 1 },
      ),
    );
  }
  try {
    const caller = await requireGenerativeRouteCaller(c, {
      request,
      compatibility: "raw",
      deferStrongCredentialCheck: options.deferStrongCredentialCheck ?? true,
      rateLimitEndpoint: options.rateLimitEndpoint ?? "standard",
    });
    await using credentialGuard = deferredCredentialAdmissionGuard({
      organizationId: () => caller.user.organization_id,
      credential: () => caller.credential,
    });
    const auth = {
      user: caller.user,
      ...(caller.apiKeyId ? { apiKey: { id: caller.apiKeyId } } : {}),
    };

    if (!executionCtx) {
      return dispatch({ mode: "compatibility", auth, requestId });
    }
    if (!caller.admissionSnapshot) {
      logger.error("[PaidProxyAdmission] Combined admission snapshot missing", {
        requestId,
        route: new URL(c.req.url).pathname,
        organizationId: caller.user.organization_id,
        authSource: caller.authSource,
      });
      return paidProxyApiErrorResponse(
        new ApiError(
          503,
          "service_unavailable",
          "Provider admission is unavailable; retry shortly",
          { retryable: true, retryAfterSeconds: 1 },
        ),
      );
    }

    return dispatch({
      mode: "combined",
      auth,
      requestId,
      admissionSnapshot: caller.admissionSnapshot,
      ...(caller.credential ? { credential: caller.credential } : {}),
      credentialForAdmission: () => credentialGuard.credentialForAdmission(),
      executionCtx,
    });
  } catch (error) {
    // error-policy:J1 the shared paid boundary preserves canonical standing
    // denials and converts known cache warm-up failures into retryable 503s.
    const mapped =
      error instanceof ApiError
        ? error
        : asGenerativeCacheApiError(error, {
            route: new URL(request.url).pathname,
            traceId: c.get("traceId") ?? c.get("requestId"),
          });
    if (mapped) return paidProxyApiErrorResponse(mapped);
    throw error;
  }
}

/** Execute a paid proxy body only after the shared standing decision. */
export async function executeGuardedPaidProxyWithBody(
  c: AppContext,
  config: ServiceConfig,
  work: ServiceHandler,
  body: ProxyRequestBody,
  options: GuardedPaidProxyOptions = {},
): Promise<Response> {
  return withGuardedPaidProxyAdmission(
    c,
    (admission) =>
      executeWithBody(
        config,
        work,
        options.request ?? c.req.raw,
        body,
        admission,
      ),
    { ...options, request: options.request ?? c.req.raw },
  );
}

/**
 * Resolves identity and standing before a route reads or validates paid input.
 * Invalid input can return a local response without opening provider admission.
 */
export async function executeGuardedPaidProxyWithPreflight(
  c: AppContext,
  preflight: PaidProxyPreflight,
  options: GuardedPaidProxyOptions = {},
): Promise<Response> {
  return withGuardedPaidProxyAdmission(
    c,
    async (admission) => {
      const prepared = await preflight();
      if (prepared instanceof Response) return prepared;
      return executeWithBody(
        prepared.config,
        prepared.work,
        options.request ?? c.req.raw,
        prepared.body,
        admission,
      );
    },
    { ...options, request: options.request ?? c.req.raw },
  );
}

/** Execute a body-carrying paid proxy request after the shared admission. */
export async function executeGuardedPaidProxyRequest(
  c: AppContext,
  config: ServiceConfig,
  work: ServiceHandler,
  options: GuardedPaidProxyOptions = {},
): Promise<Response> {
  return withGuardedPaidProxyAdmission(
    c,
    (admission) =>
      createHandler(config, work, admission)(options.request ?? c.req.raw),
    { ...options, request: options.request ?? c.req.raw },
  );
}
