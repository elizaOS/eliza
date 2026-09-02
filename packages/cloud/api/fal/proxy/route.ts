/**
 * /api/fal/proxy — proxies to fal.ai through @fal-ai/server-proxy.
 *
 * Uses the package's native Hono adapter so the proxy plumbing is owned
 * upstream. We layer Steward auth via requireUserOrApiKeyWithOrg before
 * delegating to the proxy handler, and bill priced generation submits before
 * they reach fal.ai.
 */

import {
  DEFAULT_ALLOWED_URL_PATTERNS,
  getEndpoint,
  resolveApiKeyFromEnv,
  TARGET_URL_HEADER,
} from "@fal-ai/server-proxy";
import { createRouteHandler } from "@fal-ai/server-proxy/hono";
import type { Context, Handler } from "hono";
import { Hono } from "hono";
import {
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError,
  getGenerativeExecutionContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import type { BillingContext } from "@/lib/services/ai-billing";
import {
  calculateVideoGenerationCostFromCatalog,
  getDefaultVideoBillingDimensions,
} from "@/lib/services/ai-pricing";
import { getSupportedVideoModelDefinition } from "@/lib/services/ai-pricing-definitions";
import { InsufficientCreditsError } from "@/lib/services/credits";
import { deferredCredentialAdmissionGuard } from "@/lib/services/deferred-credential-admission-guard";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const falHandler = createRouteHandler({
  allowedUrlPatterns: DEFAULT_ALLOWED_URL_PATTERNS,
  allowedEndpoints: ["fal-ai/**", "bytedance/**", "wan/**"],
  allowUnauthorizedRequests: false,
  isAuthenticated: async () => true,
  resolveFalAuth: resolveApiKeyFromEnv,
});
const invokeFalProxy = (c: Context<AppEnv>): Promise<Response> =>
  // @fal-ai/server-proxy currently carries its own Hono type copy. The runtime
  // context shape is the same object this route receives; the cast is only the
  // dependency-version boundary.
  falHandler(c as never);

const app = new Hono<AppEnv>();

function normalizeFalPricingModel(endpoint: string): string | null {
  const variantSuffixes = [
    "/image-to-video",
    "/first-last-frame-to-video",
    "/reference-to-video",
    "/extend-video",
  ];

  for (const suffix of variantSuffixes) {
    if (endpoint.endsWith(suffix)) {
      return endpoint.slice(0, -suffix.length);
    }
  }

  return endpoint;
}

function readNumber(body: unknown, keys: string[]): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return undefined;
}

function readBoolean(body: unknown, keys: string[]): boolean | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
  }

  return undefined;
}

function readString(body: unknown, keys: string[]): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().toLowerCase();
    }
  }

  return undefined;
}

async function priceFalMutation(c: Context<AppEnv>): Promise<{
  model: string;
  cost: Awaited<ReturnType<typeof calculateVideoGenerationCostFromCatalog>>;
}> {
  const targetUrl = c.req.header(TARGET_URL_HEADER);
  if (!targetUrl) {
    throw new Error("missing_target");
  }

  const endpoint = getEndpoint(targetUrl);
  const model = normalizeFalPricingModel(endpoint);
  if (!model || !getSupportedVideoModelDefinition(model)) {
    throw new Error(`Unpriced fal endpoint is disabled: ${endpoint}`);
  }

  const defaults = getDefaultVideoBillingDimensions(model);
  const body = await c.req.raw
    .clone()
    .json()
    .catch(() => ({}));
  const durationSeconds =
    readNumber(body, ["durationSeconds", "duration_seconds", "duration"]) ??
    defaults.durationSeconds;
  const dimensions = {
    ...defaults.dimensions,
    ...(readString(body, ["resolution"])
      ? { resolution: readString(body, ["resolution"]) }
      : {}),
    ...(readBoolean(body, ["audio", "generate_audio"]) !== undefined
      ? { audio: readBoolean(body, ["audio", "generate_audio"]) }
      : {}),
    ...(readBoolean(body, ["voiceControl", "voice_control"]) !== undefined
      ? { voiceControl: readBoolean(body, ["voiceControl", "voice_control"]) }
      : {}),
    ...(defaults.dimensions.durationSeconds !== undefined
      ? { durationSeconds }
      : {}),
  };

  const cost = await calculateVideoGenerationCostFromCatalog({
    model,
    billingSource: "fal",
    durationSeconds,
    dimensions,
  });

  return { model, cost };
}

const handle: Handler<AppEnv> = async (c) => {
  const isMutation = c.req.method === "POST" || c.req.method === "PUT";
  const willAdmitMutation =
    isMutation && Boolean(c.req.header(TARGET_URL_HEADER));
  let admission: Awaited<
    ReturnType<typeof admitFlatGenerativeOperation>
  > | null = null;
  let pricedMutation: Awaited<ReturnType<typeof priceFalMutation>> | null =
    null;
  let pendingResponse: Response | undefined;
  let caller: Awaited<ReturnType<typeof requireGenerativeRouteCaller>>;

  if (willAdmitMutation) {
    try {
      pricedMutation = await priceFalMutation(c);
    } catch (error) {
      if (error instanceof Error && error.message === "missing_target") {
        pendingResponse = c.json({ error: "Invalid request" }, 400);
      } else if (
        error instanceof Error &&
        error.message.startsWith("Unpriced fal endpoint")
      ) {
        pendingResponse = c.json({ error: error.message }, 400);
      } else {
        logger.error("[fal proxy] Failed to price mutation", {
          error: error instanceof Error ? error.message : String(error),
        });
        pendingResponse = c.json({ error: "fal pricing unavailable" }, 503);
      }
    }
  }

  try {
    try {
      caller = await requireGenerativeRouteCaller(c, {
        rateLimitEndpoint: "strict",
        deferStrongCredentialCheck: Boolean(pricedMutation),
      });
    } catch (error) {
      return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
    }
    await using credentialGuard = deferredCredentialAdmissionGuard({
      organizationId: () => caller.user.organization_id,
      credential: () => caller.credential,
    });
    if (pendingResponse) return pendingResponse;

    if (pricedMutation) {
      try {
        const billingContext: BillingContext = {
          organizationId: caller.user.organization_id,
          userId: caller.user.id,
          apiKeyId: caller.apiKeyId,
          model: pricedMutation.model,
          provider: "fal",
          billingSource: "fal",
          requestId: `fal-proxy:${crypto.randomUUID()}`,
          description: `fal.ai ${pricedMutation.model}`,
        };
        admission = await admitFlatGenerativeOperation({
          c,
          context: billingContext,
          apiKeyId: caller.apiKeyId,
          cost: pricedMutation.cost,
          admissionSnapshot: caller.admissionSnapshot,
          credential: credentialGuard.credentialForAdmission(),
        });
      } catch (error) {
        const admissionError = asGenerativeCacheApiError(error);
        if (admissionError) return failureResponse(c, admissionError);
        if (error instanceof InsufficientCreditsError) {
          return c.json(
            {
              error: "Insufficient credits",
              required: error.required,
              available: error.available,
            },
            402,
          );
        }
        throw error;
      }
    }

    try {
      await admission?.markProviderDispatched?.();
      const response = await invokeFalProxy(c);

      if (admission && pricedMutation) {
        await retainFalSettlement(
          c,
          admission.settle(response.ok ? pricedMutation.cost.totalCost : 0),
          response.ok ? "settle" : "release",
        );
      }

      return response;
    } catch (error) {
      if (admission) {
        await retainFalSettlement(c, admission.settle(0), "release");
      }
      throw error;
    }
  } catch (error) {
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
};

async function retainFalSettlement(
  c: Context<AppEnv>,
  settlement: Promise<unknown>,
  operation: "settle" | "release",
): Promise<void> {
  const observed = settlement.catch((error) => {
    // error-policy:J7 settlement diagnostics must not replace the provider
    // response; the durable reservation sweep remains the recovery boundary.
    logger.error(`[fal proxy] Failed to ${operation} inference admission`, {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const executionCtx = getGenerativeExecutionContext(c);
  if (executionCtx) executionCtx.waitUntil(observed);
  else await observed;
}

app.get("/", handle);
app.post("/", handle);
app.put("/", handle);

export default app;
