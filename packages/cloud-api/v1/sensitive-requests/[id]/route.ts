/**
 * Sensitive request detail.
 *
 * GET /api/v1/sensitive-requests/:id              Authed org-member view (full
 *                                                 record + audit trail).
 * GET /api/v1/sensitive-requests/:id?token=...    Public, token-gated view for
 *                                                 the sessionless out-of-band
 *                                                 recipient (redacted, no audit).
 *
 * The hosted request page is visited by a recipient who has no Cloud session;
 * they prove access with the single-use token from the link. When a token is
 * present we read the redacted public view; otherwise we require an authed
 * org member.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  type SensitiveRequestActor,
  sensitiveRequestsService,
} from "@/lib/services/sensitive-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

function actorFromUser(
  user: Awaited<ReturnType<typeof requireUserOrApiKeyWithOrg>>,
): SensitiveRequestActor {
  return {
    type: "user",
    userId: user.id,
    organizationId: user.organization_id,
    email: user.email,
  };
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id)
      return c.json({ success: false, error: "Missing request id" }, 400);

    const token = c.req.query("token");
    if (token) {
      const request = await sensitiveRequestsService.getPublicByToken(
        id,
        token,
      );
      return c.json({ success: true, request });
    }

    const user = await requireUserOrApiKeyWithOrg(c);
    const request = await sensitiveRequestsService.get(id, actorFromUser(user));
    return c.json({ success: true, request });
  } catch (error) {
    logger.error("[SensitiveRequests API] get failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
