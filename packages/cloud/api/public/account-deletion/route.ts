/** Public account-deletion request and post-session status capability boundary. */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { checkElizaMutatingRequestOrigin } from "@/lib/auth/browser-origin-policy";
import { requireRecentSessionUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  AccountDeletionRecoveryError,
  AccountDeletionConflictError,
  cancelAccountDeletion,
  getAccountDeletionStatusByCredential,
  requestAccountDeletion,
} from "@/lib/services/account-deletion";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.use(
  "*",
  rateLimit({
    ...RateLimitPresets.CRITICAL,
    failClosed: true,
    localLease: false,
  }),
);

app.get("/", async (c) => {
  c.header("Cache-Control", "no-store, private");
  const credential = c.req.header("X-Account-Deletion-Status")?.trim() ?? "";
  const request = await getAccountDeletionStatusByCredential(credential);
  if (!request) {
    return c.json(
      {
        error: "Deletion status credential is invalid or expired",
        code: "STATUS_CREDENTIAL_INVALID",
      },
      401,
    );
  }
  return c.json({ request });
});

app.delete("/", async (c) => {
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
  const credential = c.req.header("X-Account-Deletion-Recovery")?.trim() ?? "";
  let body: { confirmation?: unknown } = {};
  try {
    body = await c.req.json<{ confirmation?: unknown }>();
  } catch {
    // error-policy:J3 malformed JSON is an invalid confirmation, never a
    // fabricated valid recovery request.
  }
  if (body.confirmation !== "CANCEL DELETION") {
    return c.json(
      {
        error: "Type CANCEL DELETION to undo account deletion",
        code: "CONFIRMATION_REQUIRED",
      },
      400,
    );
  }
  try {
    const request = await cancelAccountDeletion(credential);
    return c.json({ request });
  } catch (error) {
    // error-policy:J1 typed recovery failures are translated only at this
    // transport boundary and never expose the submitted capability.
    if (error instanceof AccountDeletionRecoveryError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
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
    const user = await requireRecentSessionUserWithOrg(c);
    if (!user.steward_id) {
      return c.json(
        {
          error: "This account has no deletable Steward identity",
          code: "identity_unavailable",
        },
        409,
      );
    }
    let body: { confirmation?: unknown } = {};
    try {
      body = await c.req.json<{ confirmation?: unknown }>();
    } catch {
      // error-policy:J3 malformed JSON is an invalid confirmation, never a
      // fabricated valid deletion request.
    }
    if (body.confirmation !== "DELETE") {
      return c.json(
        {
          error: "Type DELETE to confirm permanent account deletion",
          code: "CONFIRMATION_REQUIRED",
        },
        400,
      );
    }

    const accepted = await requestAccountDeletion({
      userId: user.id,
      organizationId: user.organization_id,
      stewardUserId: user.steward_id,
    });
    return c.json(accepted, 202);
  } catch (error) {
    // error-policy:J1 The public boundary emits no credential or identity values.
    if (error instanceof AccountDeletionConflictError) {
      return c.json(
        { error: error.message, code: error.code, details: error.details },
        409,
      );
    }
    logger.error("[PublicAccountDeletionRoute] Request failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    return failureResponse(c, error);
  }
});

export default app;
