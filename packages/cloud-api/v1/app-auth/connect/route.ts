/**
 * POST /api/v1/app-auth/connect
 *
 * Record a user-app connection during authorization. Accepts either a Steward
 * JWT or API key via the Authorization header.
 *
 * CORS is handled globally in src/index.ts — the OPTIONS handler and per-route
 * CORS_HEADERS from the Next version are intentionally dropped.
 */

import { Hono } from "hono";
import { z } from "zod";
import { appsRepository } from "@/db/repositories/apps";
import {
  ApiError,
  failureResponse,
  NotFoundError,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { isAllowedOrigin } from "@/lib/security/origin-validation";
import { issueAppAuthCode } from "@/lib/services/app-auth-codes";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ConnectSchema = z.object({
  appId: z.string().uuid(),
  redirectUri: z.string().url().optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKey(c);

    const body = await c.req.json();
    const parsed = ConnectSchema.safeParse(body);

    if (!parsed.success) {
      throw ValidationError("Invalid request data", {
        details: parsed.error.format() as Record<string, unknown>,
      });
    }

    const { appId, redirectUri } = parsed.data;

    const appRow = await appsRepository.findPublicInfoById(appId);

    if (!appRow) {
      throw NotFoundError("App not found");
    }

    if (redirectUri) {
      const allowedOrigins = await appsService.getAllowedOrigins(appRow);
      if (!isAllowedOrigin(allowedOrigins, redirectUri)) {
        throw ValidationError("redirect_uri is not allowed for this app");
      }
    }

    const connectionAction = await appsRepository.connectUser({
      appId,
      userId: user.id,
      signupSource: "oauth",
      ipAddress: c.req.header("x-forwarded-for")?.split(",")[0] || null,
      userAgent: c.req.header("user-agent") || null,
    });

    if (connectionAction === "updated") {
      logger.info("Updated app user connection", { userId: user.id, appId });
    } else {
      logger.info("Created new app user connection", { userId: user.id, appId });
    }

    let authCode: Awaited<ReturnType<typeof issueAppAuthCode>>;
    try {
      authCode = await issueAppAuthCode({ appId, userId: user.id });
    } catch {
      throw new ApiError(
        503,
        "session_not_ready",
        "Authorization code store is unavailable. Please try again.",
      );
    }

    return c.json({
      success: true,
      message: "Connected successfully",
      code: authCode.code,
      codeType: "app_auth_code",
      expiresAt: authCode.expiresAt,
      expiresIn: authCode.expiresIn,
    });
  } catch (error) {
    logger.error("App auth connect error:", error);
    return failureResponse(c, error);
  }
});

export default app;
