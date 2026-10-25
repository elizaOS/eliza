/**
 * POST /api/internal/auth/token
 *
 * Exchange `X-Gateway-Secret` (must match `GATEWAY_BOOTSTRAP_SECRET`) for a
 * short-lived internal JWT used by gateway services.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { isJWKSConfigured } from "@elizaos/cloud-shared/lib/auth/jwks";
import {
  internalTokenLifetimeForService,
  isShortLivedGatewayService,
  signInternalToken,
} from "@elizaos/cloud-shared/lib/auth/jwt-internal";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

function digestUtf8(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function safeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(digestUtf8(a), digestUtf8(b));
}

app.post("/*", async (c) => {
  try {
    if (!isJWKSConfigured()) {
      return c.json({ error: "internal_jwks_not_configured" }, 503);
    }

    const presented = c.req.header("X-Gateway-Secret")?.trim() ?? "";
    const expected = String(c.env.GATEWAY_BOOTSTRAP_SECRET ?? "").trim();
    if (!expected || !safeEqualStr(presented, expected)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const decodedRawBody = await decodeRequestJson(c.req);
    if (!decodedRawBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const rawBody = decodedRawBody.value;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const body = rawBody as { pod_name?: unknown; service?: unknown };
    const subject =
      typeof body.pod_name === "string" ? body.pod_name.trim() : "";
    if (!subject) {
      return c.json({ error: "pod_name required" }, 400);
    }
    const service =
      typeof body.service === "string" ? body.service.trim() : undefined;
    if (!isShortLivedGatewayService(service)) {
      return c.json({ error: "unsupported_gateway_service" }, 400);
    }

    const token = await signInternalToken({
      subject,
      service,
      expiresIn: internalTokenLifetimeForService(service),
    });
    return c.json(token);
  } catch (err) {
    logger.error("[internal/auth/token]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
