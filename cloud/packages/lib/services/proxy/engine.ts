import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api/errors";
import {
  requireAuth,
  requireAuthOrApiKey,
  requireAuthOrApiKeyWithOrg,
  requireAuthWithOrg,
} from "@/lib/auth";
import { cache } from "@/lib/cache/client";
import { withRateLimit } from "@/lib/middleware/rate-limit";
import { creditsService, InsufficientCreditsError } from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";
import { PricingNotFoundError } from "./pricing";
import type {
  AuthLevel,
  HandlerResult,
  ProxyRequestBody,
  ServiceConfig,
  ServiceHandler,
} from "./types";

type CachedProxyResponse = {
  body: string;
  status: number;
  headers: Record<string, string>;
  cachedAt: number;
  ttl?: number;
};

async function getAuthForLevel(request: Request, level: AuthLevel) {
  switch (level) {
    case "session":
      return { user: await requireAuth(request) };
    case "sessionWithOrg":
      return { user: await requireAuthWithOrg(request) };
    case "apiKey":
      return await requireAuthOrApiKey(request);
    case "apiKeyWithOrg":
      return await requireAuthOrApiKeyWithOrg(request);
  }

  const exhaustiveCheck: never = level;
  throw new Error(`Unsupported auth level: ${exhaustiveCheck}`);
}

function buildCacheKey(
  serviceId: string,
  orgId: string,
  body: ProxyRequestBody,
  searchParams: URLSearchParams,
): string {
  const contentHash = createHash("sha256")
    .update(JSON.stringify(body) + searchParams.toString())
    .digest("hex")
    .substring(0, 16);

  return `svc:${serviceId}:${orgId}:${contentHash}`;
}

function getRequestedMaxAge(request: Request): number {
  const cacheControl = request.headers.get("cache-control");
  const maxAgeMatch = cacheControl?.match(/max-age=(\d+)/);
  return maxAgeMatch ? Number.parseInt(maxAgeMatch[1], 10) : 0;
}

function getMethodFromBody(body: ProxyRequestBody): string {
  if (Array.isArray(body)) {
    return "_batch";
  }

  return body && typeof body === "object" && "method" in body ? String(body.method) : "_default";
}

function isCacheableResponseContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType || contentType.includes("text/event-stream")) {
    return false;
  }

  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("x-www-form-urlencoded")
  );
}

function withCacheHeaders(
  headersInit: HeadersInit,
  cacheStatus: "HIT" | "MISS",
  maxAge: number,
  age?: number,
): Headers {
  const headers = new Headers(headersInit);
  headers.set("Cache-Control", `private, max-age=${Math.max(0, maxAge)}`);
  headers.set("X-Cache", cacheStatus);

  if (age !== undefined) {
    headers.set("X-Cache-Age", String(age));
  } else {
    headers.delete("X-Cache-Age");
  }

  return headers;
}

function wrapResponseWithHeaders(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isClientErrorMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("validation") ||
    lowered.includes("invalid") ||
    lowered.includes("unsupported") ||
    lowered.includes("not supported")
  );
}

export function createHandler(
  config: ServiceConfig,
  work: ServiceHandler,
): (request: Request) => Promise<Response> {
  const handler = async (request: Request): Promise<Response> => {
    const startTime = Date.now();
    const searchParams = new URL(request.url).searchParams;

    try {
      const auth = await getAuthForLevel(request, config.auth);
      const { user } = auth;
      const apiKey = "apiKey" in auth ? auth.apiKey : undefined;
      const organizationId = user.organization_id;

      if (!organizationId) {
        return Response.json(
          { error: "Organization membership required for billing" },
          { status: 403 },
        );
      }

      let body: ProxyRequestBody = null;
      if (request.method === "POST") {
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
      }

      const method = getMethodFromBody(body);
      const cost = await config.getCost(body, searchParams);

      const reservation = await creditsService.reserve({
        organizationId,
        userId: user.id,
        amount: cost,
        description: config.name,
      });

      const cacheCandidate =
        config.cache && body && !Array.isArray(body)
          ? {
              clientMaxAge: getRequestedMaxAge(request),
              method,
            }
          : null;

      const cacheKey =
        cacheCandidate &&
        cacheCandidate.clientMaxAge > 0 &&
        (config.cache?.isMethodCacheable
          ? config.cache.isMethodCacheable(cacheCandidate.method)
          : true)
          ? buildCacheKey(config.id, organizationId, body, searchParams)
          : null;

      if (cacheKey && cacheCandidate) {
        try {
          const cachedResponse = await cache.get<CachedProxyResponse>(cacheKey);

          if (cachedResponse) {
            const age = Math.floor((Date.now() - cachedResponse.cachedAt) / 1000);
            const storedMaxAge = cachedResponse.ttl ?? config.cache!.maxTTL;
            const effectiveMaxAge = Math.min(cacheCandidate.clientMaxAge, storedMaxAge);

            if (age <= effectiveMaxAge) {
              const hitMultiplier = config.cache?.hitCostMultiplier ?? 0.5;
              const cachedCost = cost * hitMultiplier;
              const remainingMaxAge = Math.max(effectiveMaxAge - age, 0);

              await reservation.reconcile(cachedCost);

              const response = new Response(cachedResponse.body, {
                status: cachedResponse.status,
                headers: withCacheHeaders(cachedResponse.headers, "HIT", remainingMaxAge, age),
              });

              void (async () => {
                try {
                  await usageService.create({
                    organization_id: organizationId,
                    user_id: user.id,
                    api_key_id: apiKey?.id,
                    type: config.id,
                    provider: config.id,
                    input_tokens: 0,
                    output_tokens: 0,
                    input_cost: String(cachedCost),
                    output_cost: "0",
                    markup: "0",
                    duration_ms: Date.now() - startTime,
                    is_successful: response.ok,
                    metadata: {
                      cached: true,
                      cache_age: age,
                      method,
                    },
                  });
                } catch (error) {
                  logger.error("[Proxy Engine] Usage tracking failed (cache hit)", { error });
                }
              })();

              return response;
            }
          }
        } catch (error) {
          logger.warn("[Proxy Engine] Cache read failed", { error });
        }
      }

      let result: HandlerResult;
      try {
        result = await work({ body, auth, searchParams });
      } catch (error) {
        await reservation.reconcile(0);
        throw error;
      }

      const actualCost = result.actualCost ?? cost;
      await reservation.reconcile(actualCost);

      if (cacheKey && cacheCandidate && config.cache) {
        const ttl = Math.min(cacheCandidate.clientMaxAge, config.cache.maxTTL);

        if (result.response.ok && isCacheableResponseContentType(result.response)) {
          const clonedResponse = result.response.clone();
          const responseBody = await clonedResponse.text();
          const maxSize = config.cache.maxResponseSize ?? 65536;

          if (responseBody.length <= maxSize) {
            const responseHeaders = withCacheHeaders(result.response.headers, "MISS", ttl);
            const headersObj: Record<string, string> = {};
            responseHeaders.forEach((value, key) => {
              headersObj[key] = value;
            });

            await cache.set(
              cacheKey,
              {
                body: responseBody,
                status: result.response.status,
                headers: headersObj,
                cachedAt: Date.now(),
                ttl,
              },
              ttl,
            );

            result.response = new Response(responseBody, {
              status: result.response.status,
              statusText: result.response.statusText,
              headers: responseHeaders,
            });
          } else {
            result.response = wrapResponseWithHeaders(
              result.response,
              withCacheHeaders(result.response.headers, "MISS", ttl),
            );
          }
        } else {
          result.response = wrapResponseWithHeaders(
            result.response,
            withCacheHeaders(result.response.headers, "MISS", ttl),
          );
        }
      }

      void (async () => {
        try {
          await usageService.create({
            organization_id: organizationId,
            user_id: user.id,
            api_key_id: apiKey?.id,
            type: config.id,
            provider: config.id,
            input_tokens: 0,
            output_tokens: 0,
            input_cost: String(actualCost),
            output_cost: "0",
            markup: "0",
            duration_ms: Date.now() - startTime,
            is_successful: result.response.ok,
            error_message: result.response.ok ? undefined : `HTTP ${result.response.status}`,
            metadata: {
              cached: false,
              method,
              ...(result.usageMetadata ?? {}),
            },
          });
        } catch (error) {
          logger.error("[Proxy Engine] Usage tracking failed", { error });
        }
      })();

      return result.response;
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return Response.json(
          {
            error: "Insufficient credits",
            required: error.required,
            available: error.available,
          },
          { status: 402 },
        );
      }

      if (error instanceof ApiError) {
        return Response.json({ error: error.message }, { status: error.status });
      }

      if (error instanceof PricingNotFoundError) {
        logger.error("[Proxy Engine] Pricing configuration error", {
          serviceId: error.serviceId,
          method: error.method,
        });
        return Response.json({ error: "Service temporarily unavailable" }, { status: 500 });
      }

      if (error instanceof Error) {
        if (isClientErrorMessage(error.message)) {
          return Response.json({ error: error.message }, { status: 400 });
        }

        if (error.name === "TimeoutError" || error.message.toLowerCase().includes("timeout")) {
          return Response.json({ error: "Upstream service timeout" }, { status: 504 });
        }
      }

      logger.error("[Proxy Engine] Handler error", { error });
      return Response.json({ error: "Upstream service error" }, { status: 502 });
    }
  };

  if (config.rateLimit) {
    return withRateLimit(handler, config.rateLimit);
  }

  return handler;
}

export async function executeWithBody(
  config: ServiceConfig,
  work: ServiceHandler,
  request: Request,
  body: ProxyRequestBody,
): Promise<Response> {
  const handler = createHandler(config, work);
  const mockRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body),
  });
  return handler(mockRequest);
}
