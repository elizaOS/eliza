/**
 * Sensitive request submit endpoint.
 *
 * POST /api/v1/sensitive-requests/:id/submit
 *
 * The submitter may be:
 *   - a sessionless out-of-band recipient who proves access with the single-use
 *     token from the link (token in body and/or `?token=` query), or
 *   - an authenticated org member submitting on their own behalf.
 *
 * We resolve the session best-effort and always forward the token. The service
 * (`authorizeSubmit`) decides which path is permitted from the request's
 * persisted policy: token-only submit is allowed only when the request was
 * created without `requireAuthenticatedLink`; otherwise the org actor is
 * required and the service rejects an unauthenticated caller.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  type SensitiveRequestActor,
  sensitiveRequestsService,
} from "@/lib/services/sensitive-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv, AuthedUser } from "@/types/cloud-worker-env";

const SubmitSensitiveRequestSchema = z.object({
  token: z.string().trim().min(1).optional(),
  value: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
});

function actorFromUser(
  user: AuthedUser & { organization_id: string },
): SensitiveRequestActor {
  return {
    type: "user",
    userId: user.id,
    organizationId: user.organization_id,
    email: user.email,
  };
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id)
      return c.json({ success: false, error: "Missing request id" }, 400);

    const body = await c.req.json().catch(() => null);
    const parsed = SubmitSensitiveRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const token = parsed.data.token ?? c.req.query("token");
    const user = await getCurrentUser(c).catch(() => null);
    const actor = user?.organization_id
      ? actorFromUser({ ...user, organization_id: user.organization_id })
      : undefined;

    const request = await sensitiveRequestsService.submit({
      id,
      token,
      actor,
      value: parsed.data.value,
      fields: parsed.data.fields,
    });

    return c.json({ success: true, request });
  } catch (error) {
    logger.error("[SensitiveRequests API] submit failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
