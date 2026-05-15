/**
 * POST /api/internal/auth/token
 *
 * Exchange `X-Gateway-Secret` (must match `GATEWAY_BOOTSTRAP_SECRET`) for a
 * short-lived internal JWT used by gateway services.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isJWKSConfigured } from "@/lib/auth/jwks";
import { signInternalToken } from "@/lib/auth/jwt-internal";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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

    const body = (await c.req.json()) as { pod_name?: string; service?: string };
    const subject = typeof body.pod_name === "string" ? body.pod_name.trim() : "";
    if (!subject) {
      return c.json({ error: "pod_name required" }, 400);
    }
    const service = typeof body.service === "string" ? body.service.trim() : undefined;

    const token = await signInternalToken({ subject, service });
    return c.json(token);
  } catch (err) {
    logger.error("[internal/auth/token]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
