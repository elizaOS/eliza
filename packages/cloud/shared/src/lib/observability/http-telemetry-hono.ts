/**
 * Hono middleware that stamps every Cloud Worker response with the resolved
 * application trace id and a `cloud_worker` Server-Timing metric. Registered
 * globally in the API's bootstrap-app; kept beside http-telemetry.ts so the
 * header semantics and the middleware that applies them evolve together.
 *
 * Responses returned straight from `fetch()` in workerd carry immutable
 * headers — mutating them throws a TypeError and would 500 an otherwise
 * healthy proxied response. When that happens the middleware re-wraps the
 * response (`new Response(body, response)`) without buffering the body, so
 * streaming passthrough routes stay zero-copy and still get telemetry headers.
 */

import type { MiddlewareHandler } from "hono";
import {
  resolveElizaTraceId,
  type ServerTimingMetric,
  setHttpTelemetryHeaders,
} from "./http-telemetry";

type TraceEnv = { Variables: { traceId: string } };

export function httpTelemetryMiddleware(): MiddlewareHandler<TraceEnv> {
  return async (c, next) => {
    const traceId = resolveElizaTraceId(c.req.raw.headers);
    const startedAt = performance.now();
    c.set("traceId", traceId);
    await next();
    const metrics: ServerTimingMetric[] = [
      {
        name: "cloud_worker",
        durationMs: performance.now() - startedAt,
        description: "Cloud_API_until_response_headers",
      },
    ];
    const timingAllowOrigin = c.res.headers.get("Access-Control-Allow-Origin") ?? undefined;
    try {
      setHttpTelemetryHeaders(c.res.headers, traceId, metrics, timingAllowOrigin);
    } catch (error) {
      // error-policy:J1 workerd freezes headers on a raw fetched Response
      // (agent bridge/stream passthrough); re-wrap without buffering the body
      // so a healthy proxied response is never 500'd by telemetry decoration.
      if (!(error instanceof TypeError)) throw error;
      const headers = new Headers(c.res.headers);
      setHttpTelemetryHeaders(headers, traceId, metrics, timingAllowOrigin);
      c.res = new Response(c.res.body, {
        status: c.res.status,
        statusText: c.res.statusText,
        headers,
      });
    }
  };
}
