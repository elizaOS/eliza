/**
 * Authenticated gateway access to the canonical Personal Shared Telegram
 * delivery ledger. The Worker resolves the authoritative Durable Object;
 * credentials and provider payloads never cross or enter durable storage.
 */

import { type Context, Hono } from "hono";
import {
  type InternalServiceAuth,
  requireInternalAuth,
} from "@/api/internal/_auth";
import {
  InvalidPersonalTelegramDeliveryScopeError,
  PERSONAL_TELEGRAM_DELIVERY_PATH,
  type PersonalTelegramDeliveryScope,
  personalTelegramDeliveryStub,
} from "@/api-app/personal-telegram-delivery";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_BODY_BYTES = 1_024;
type Authenticate = (
  c: Context<AppEnv>,
) => Promise<InternalServiceAuth | Response>;

export function createPersonalTelegramDeliveryRoute(
  authenticate: Authenticate = requireInternalAuth,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post("/*", async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    if (auth.service !== "webhook-gateway") {
      return c.json({ error: "Forbidden" }, 403);
    }

    const contentLength = Number(c.req.header("Content-Length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
      return c.json({ error: "Request body too large" }, 413);
    }

    const rawBody = await c.req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return c.json({ error: "Request body too large" }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // error-policy:J3 malformed transport JSON is an explicit invalid request.
      return c.json({ error: "Invalid delivery request" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid delivery request" }, 400);
    }

    try {
      const candidate = body as Record<string, unknown>;
      const scope: PersonalTelegramDeliveryScope = {
        project: typeof candidate.project === "string" ? candidate.project : "",
        accountFingerprint:
          typeof candidate.accountFingerprint === "string"
            ? candidate.accountFingerprint
            : "",
        senderId:
          typeof candidate.senderId === "string" ? candidate.senderId : "",
      };
      const stub = await personalTelegramDeliveryStub(c.env, scope);
      const traceId = c.req.header("X-Eliza-Trace-Id");
      const deliveryRequest = {
        messageId: candidate.messageId,
        operation: candidate.operation,
        ...(typeof candidate.ownerToken === "string"
          ? { ownerToken: candidate.ownerToken }
          : {}),
        ...(typeof candidate.leaseMs === "number"
          ? { leaseMs: candidate.leaseMs }
          : {}),
        ...(typeof candidate.contentDigest === "string"
          ? { contentDigest: candidate.contentDigest }
          : {}),
        ...(typeof candidate.totalChunks === "number"
          ? { totalChunks: candidate.totalChunks }
          : {}),
        ...(typeof candidate.chunkIndex === "number"
          ? { chunkIndex: candidate.chunkIndex }
          : {}),
        ...(typeof candidate.providerMessageId === "string"
          ? { providerMessageId: candidate.providerMessageId }
          : {}),
      };
      const response = await stub.fetch(
        `https://personal-telegram-delivery${PERSONAL_TELEGRAM_DELIVERY_PATH}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(traceId ? { "X-Eliza-Trace-Id": traceId } : {}),
          },
          body: JSON.stringify(deliveryRequest),
        },
      );
      return new Response(response.body, response);
    } catch (error) {
      if (error instanceof InvalidPersonalTelegramDeliveryScopeError) {
        // error-policy:J3 authenticated but malformed scope is explicitly invalid.
        return c.json({ error: "Invalid delivery scope" }, 400);
      }
      // error-policy:J1 the authenticated transport fails closed without exposing scope data.
      logger.error("[PersonalTelegramDeliveryRoute] ledger request failed", {
        traceId: c.req.header("X-Eliza-Trace-Id") ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Telegram delivery ledger unavailable" }, 502);
    }
  });
  return app;
}

const app = createPersonalTelegramDeliveryRoute();
export default app;
