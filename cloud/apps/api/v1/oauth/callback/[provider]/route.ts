/**
 * OAuth intent callback (Wave C) — UNAUTHED webhook-style endpoint.
 *
 * GET  /api/v1/oauth/callback/:provider?state=...&code=...
 * POST /api/v1/oauth/callback/:provider
 *
 * Looks up the OAuth intent by hashed state token, marks it bound or denied,
 * and publishes the result to OAuthCallbackBus so any AWAIT_OAUTH_CALLBACK
 * subscriber can resume. Provider-specific token exchange is delegated to
 * existing platform OAuth handlers and is OUT OF SCOPE for this route — the
 * OAuth-intent layer only tracks state, scopes, and bind/deny status.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getIpKey, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { createOAuthCallbackBus, type OAuthCallbackBus } from "@/lib/services/oauth-callback-bus";
import { getOAuthIntentsService } from "@/lib/services/oauth-intents-default";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const SUPPORTED_PROVIDERS = new Set([
  "google",
  "discord",
  "linkedin",
  "linear",
  "shopify",
  "calendly",
]);

const CallbackQuerySchema = z.object({
  state: z.string().min(1).max(2048),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(512).optional(),
  error_description: z.string().max(2048).optional(),
});

let callbackBusSingleton: OAuthCallbackBus | null = null;
function getOAuthCallbackBus(): OAuthCallbackBus {
  callbackBusSingleton ??= createOAuthCallbackBus();
  return callbackBusSingleton;
}

async function hashState(state: string): Promise<string> {
  const data = new TextEncoder().encode(state);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function providerFromCallbackUrl(url: string): string | undefined {
  const pathname = new URL(url).pathname.replace(/\/+$/, "");
  const provider = pathname.split("/").pop();
  return provider && provider !== "callback" ? decodeURIComponent(provider) : undefined;
}

const app = new Hono<AppEnv>();

app.use(
  "*",
  rateLimit({
    windowMs: 60_000,
    maxRequests: 30,
    keyGenerator: (c) => `oauth:intent:callback:${getIpKey(c)}`,
  }),
);

async function handleCallback(c: AppContext, rawProvider: string | undefined) {
  const provider = rawProvider?.toLowerCase();
  if (!provider || !SUPPORTED_PROVIDERS.has(provider)) {
    return c.json({ success: false, error: "Unsupported provider" }, 400);
  }

  const params = CallbackQuerySchema.safeParse({
    state: c.req.query("state"),
    code: c.req.query("code"),
    error: c.req.query("error"),
    error_description: c.req.query("error_description"),
  });
  if (!params.success) {
    return c.json(
      { success: false, error: "Invalid callback query", details: params.error.issues },
      400,
    );
  }

  const stateHash = await hashState(params.data.state);
  const service = getOAuthIntentsService(c.env);
  const intent = await service.getByStateTokenHash(stateHash);
  if (!intent) {
    logger.warn("[OAuthCallback] No intent matches state token", { provider });
    return c.json({ success: false, error: "Unknown state token" }, 404);
  }
  if (intent.provider !== provider) {
    logger.warn("[OAuthCallback] Provider mismatch on intent", {
      provider,
      intentProvider: intent.provider,
      oauthIntentId: intent.id,
    });
    return c.json({ success: false, error: "Provider mismatch" }, 400);
  }

  const bus = getOAuthCallbackBus();

  if (params.data.error) {
    const denied = await service.markDenied(
      intent.id,
      params.data.error_description ?? params.data.error,
    );
    await bus.publish({
      name: "OAuthCallbackReceived",
      intentId: denied.id,
      provider,
      status: "denied",
      receivedAt: new Date(),
    });
    return c.json({
      success: true,
      oauthIntent: { id: denied.id, status: denied.status },
    });
  }

  const bound = await service.markBound(intent.id, {});
  await bus.publish({
    name: "OAuthCallbackReceived",
    intentId: bound.id,
    provider,
    status: "bound",
    receivedAt: new Date(),
  });

  return c.json({
    success: true,
    oauthIntent: { id: bound.id, status: bound.status },
  });
}

app.get("/", async (c) => {
  try {
    return await handleCallback(c, providerFromCallbackUrl(c.req.raw.url));
  } catch (error) {
    logger.error("[OAuthCallback API] Failed to handle GET callback", { error });
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    return await handleCallback(c, providerFromCallbackUrl(c.req.raw.url));
  } catch (error) {
    logger.error("[OAuthCallback API] Failed to handle POST callback", { error });
    return failureResponse(c, error);
  }
});

export default app;
