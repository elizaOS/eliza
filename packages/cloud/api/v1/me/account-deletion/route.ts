/** Exposes authenticated account-deletion status and fail-closed request admission. */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { checkElizaMutatingRequestOrigin } from "@/lib/auth/browser-origin-policy";
import { requireRecentSessionUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  AccountDeletionConflictError,
  getOpenAccountDeletionRequest,
  recoverAccountDeletionAdmission,
  requestAccountDeletion,
  toAccountDeletionRequestDto,
} from "@/lib/services/account-deletion";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  c.header("Cache-Control", "no-store, private");
  try {
    const user = await requireRecentSessionUserWithOrg(c);
    const request = await getOpenAccountDeletionRequest({
      userId: user.id,
      organizationId: user.organization_id,
    });
    return c.json({
      request: request ? toAccountDeletionRequestDto(request) : null,
    });
  } catch (error) {
    // error-policy:J1 The HTTP boundary translates service failures into a structured response.
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  c.header("Cache-Control", "no-store, private");
  const origin = checkElizaMutatingRequestOrigin(
    c.req,
    c.env.NODE_ENV === "production",
  );
  if (!origin.ok) {
    return c.json(
      { error: "Forbidden", code: "forbidden_origin" as const },
      403,
    );
  }

  try {
    let body: { confirmation?: unknown; admissionCredential?: unknown } = {};
    try {
      body = await c.req.json<{
        confirmation?: unknown;
        admissionCredential?: unknown;
      }>();
    } catch {
      // error-policy:J3 Malformed JSON is treated as an invalid confirmation, never valid input.
    }
    if (body.confirmation !== "DELETE") {
      return c.json(
        {
          error: "Type DELETE to confirm permanent account deletion",
          code: "CONFIRMATION_REQUIRED" as const,
        },
        400,
      );
    }
    if (
      typeof body.admissionCredential !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.admissionCredential)
    ) {
      return c.json(
        {
          error: "A valid deletion admission credential is required",
          code: "ADMISSION_CREDENTIAL_REQUIRED" as const,
        },
        400,
      );
    }

    const replay = await recoverAccountDeletionAdmission(
      body.admissionCredential,
    );
    if (replay) return c.json(replay, 202);

    const user = await requireRecentSessionUserWithOrg(c);
    if (!user.steward_id) {
      return c.json(
        {
          error: "This account has no deletable Steward identity",
          code: "identity_unavailable" as const,
        },
        409,
      );
    }

    const accepted = await requestAccountDeletion({
      userId: user.id,
      organizationId: user.organization_id,
      stewardUserId: user.steward_id,
      admissionCredential: body.admissionCredential,
    });
    return c.json(accepted, 202);
  } catch (error) {
    // error-policy:J1 The HTTP boundary logs and translates unexpected service failures.
    if (error instanceof AccountDeletionConflictError) {
      return c.json(
        { error: error.message, code: error.code, details: error.details },
        409,
      );
    }
    logger.error("[AccountDeletionRoute] Failed to schedule deletion", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    return failureResponse(c, error);
  }
});

export default app;
