/** Exposes authenticated account-deletion status and fail-closed request admission. */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { checkElizaMutatingRequestOrigin } from "@/lib/auth/browser-origin-policy";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  AccountDeletionConflictError,
  getAccountDeletionStatus,
  requestAccountDeletion,
  toAccountDeletionRequestDto,
} from "@/lib/services/account-deletion";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const status = await getAccountDeletionStatus({
      userId: user.id,
      organizationId: user.organization_id,
    });
    return c.json(status);
  } catch (error) {
    // error-policy:J1 The HTTP boundary translates service failures into a structured response.
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
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
    const user = await requireUserWithOrg(c);
    if (!user.steward_id) {
      return c.json(
        {
          error: "This account has no deletable Steward identity",
          code: "identity_unavailable" as const,
        },
        409,
      );
    }
    let body: { confirmation?: unknown } = {};
    try {
      body = await c.req.json<{ confirmation?: unknown }>();
    } catch {
      // error-policy:J3 Malformed JSON is treated as an invalid confirmation, never valid input.
    }
    if (body.confirmation !== "DELETE") {
      return c.json(
        {
          error: "Type DELETE to confirm permanent account deletion",
          code: "confirmation_required" as const,
        },
        400,
      );
    }

    const request = await requestAccountDeletion({
      userId: user.id,
      organizationId: user.organization_id,
      stewardUserId: user.steward_id,
    });
    return c.json({ request: toAccountDeletionRequestDto(request) }, 202);
  } catch (error) {
    if (error instanceof AccountDeletionConflictError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    // error-policy:J1 The HTTP boundary logs and translates unexpected service failures.
    logger.error("[AccountDeletionRoute] Failed to schedule deletion", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
