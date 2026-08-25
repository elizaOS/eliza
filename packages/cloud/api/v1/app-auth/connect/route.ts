/**
 * POST /api/v1/app-auth/connect
 *
 * Record a user-app connection during explicit browser authorization. Legacy
 * third-party apps accept a Steward JWT or API key; the first-party mobile
 * PKCE branch requires an interactive Steward user session and resolves its
 * internal app UUID exclusively from server configuration.
 *
 * Cookie-authenticated callers must additionally pass the cookie-mutation
 * guard (first-party Origin + non-simple request marker) so a cross-site
 * simple request cannot ride an ambient session cookie into a connection —
 * the same policy the global middleware applies; repeated here so the route
 * does not depend on middleware ordering for its CSRF posture. Bearer/API-key
 * callers are unaffected.
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
import { checkCookieMutationGuard } from "@/lib/auth/cookie-mutation-guard";
import {
  requireUserOrApiKey,
  requireUserWithOrg,
} from "@/lib/auth/workers-hono-auth";
import { isAllowedOrigin } from "@/lib/security/origin-validation";
import { issueAppAuthCode } from "@/lib/services/app-auth-codes";
import { appsService } from "@/lib/services/apps";
import {
  issueMobileAppAuthCode,
  MobileAppAuthProtocolError,
  validateMobileAppAuthPkceBinding,
} from "@/lib/services/mobile-app-auth";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { runMobileAppAuthGrantAdmission } from "../mobile/_rate-limit";
import { requireRegisteredMobileApp } from "../mobile/_registration";
import { mobileAppAuthErrorResponse } from "../mobile/_response";
import { mobileAppAuthPkceBindingSchema } from "../mobile/_schemas";

const ConnectSchema = z.object({
  appId: z.string().uuid(),
  redirectUri: z.string().url().optional(),
});

const MobileConnectSchema = mobileAppAuthPkceBindingSchema.extend({
  flow: z.literal("mobile_pkce"),
});

function isMobileFlowBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "flow" in body &&
    body.flow === "mobile_pkce"
  );
}

async function connectUserToApp(
  c: AppContext,
  input: { appId: string; userId: string },
): Promise<void> {
  const connectionAction = await appsRepository.connectUser({
    appId: input.appId,
    userId: input.userId,
    signupSource: "oauth",
    ipAddress: c.req.header("x-forwarded-for")?.split(",")[0] ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  });
  logger.info("[AppAuth] User approved app connection", {
    appId: input.appId,
    connectionAction,
    userId: input.userId,
  });
}

async function handleMobileConnect(
  c: AppContext,
  input: z.infer<typeof MobileConnectSchema>,
): Promise<Response> {
  const user = await requireUserWithOrg(c);
  const { registration } = await requireRegisteredMobileApp(c);
  validateMobileAppAuthPkceBinding(registration, input);
  return await runMobileAppAuthGrantAdmission(c, user.id, async () => {
    // app_users records durable consent, not possession of a transient code.
    // If grant creation fails, a retry updates this same connection and issues
    // a fresh code without erasing the user's already-recorded approval.
    await connectUserToApp(c, {
      appId: registration.appId,
      userId: user.id,
    });
    const authCode = await issueMobileAppAuthCode({
      registration,
      userId: user.id,
      organizationId: user.organization_id,
      binding: input,
    });
    return c.json({
      success: true,
      message: "Connected successfully",
      code: authCode.code,
      codeType: "mobile_app_auth_code",
      expiresAt: authCode.expiresAt,
      expiresIn: authCode.expiresIn,
    });
  });
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  let mobileFlow = false;
  try {
    const guard = checkCookieMutationGuard(
      c.req,
      c.env?.ENVIRONMENT,
      c.env?.NODE_ENV === "production",
    );
    if (!guard.ok) {
      logger.warn("[AppAuthConnect] rejected cookie-authenticated connect", {
        code: guard.code,
        detail: guard.reason,
      });
      return c.json({ error: "Forbidden", code: guard.code }, 403);
    }

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;

    mobileFlow = isMobileFlowBody(body);
    if (mobileFlow) {
      const mobileParsed = MobileConnectSchema.safeParse(body);
      if (!mobileParsed.success) {
        throw new MobileAppAuthProtocolError(
          "invalid_request",
          "Invalid mobile authorization approval",
        );
      }
      return await handleMobileConnect(c, mobileParsed.data);
    }

    const user = await requireUserOrApiKey(c);
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

    await connectUserToApp(c, { appId, userId: user.id });

    let authCode: Awaited<ReturnType<typeof issueAppAuthCode>>;
    try {
      authCode = await issueAppAuthCode({ appId, userId: user.id });
    } catch (error) {
      // error-policy:J1 The HTTP boundary translates an unavailable one-time
      // code store into a retryable protocol failure and records the cause.
      logger.error("[AppAuth] Authorization code store is unavailable", {
        error,
      });
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
    // error-policy:J1 HTTP boundary returns canonical auth or mobile protocol failures.
    if (mobileFlow) {
      if (error instanceof ApiError) return failureResponse(c, error);
      return mobileAppAuthErrorResponse(c, error, "connect");
    }
    logger.error("App auth connect error:", error);
    return failureResponse(c, error);
  }
});

export default app;
