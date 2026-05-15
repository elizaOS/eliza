/**
 * POST /api/internal/auth/refresh
 *
 * Rotate an internal JWT before expiry. Requires a valid `Authorization: Bearer`
 * internal token; returns a fresh token with the same subject and service.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isJWKSConfigured } from "@/lib/auth/jwks";
import {
  extractBearerToken,
  signInternalToken,
  verifyInternalToken,
} from "@/lib/auth/jwt-internal";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/*", async (c) => {
  try {
    if (!isJWKSConfigured()) {
      return c.json({ error: "internal_jwks_not_configured" }, 503);
    }

    const token = extractBearerToken(c.req.header("Authorization") ?? null);
    if (!token) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let sub: string;
    let service: string | undefined;
    try {
      const verified = await verifyInternalToken(token);
      sub = verified.payload.sub;
      service = verified.payload.service;
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const refreshed = await signInternalToken({ subject: sub, service });
    return c.json(refreshed);
  } catch (err) {
    logger.error("[internal/auth/refresh]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
