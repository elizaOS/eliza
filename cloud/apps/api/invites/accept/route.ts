/**
 * POST /api/invites/accept
 * Accepts an organization invitation using the invitation token.
 *
 * Note: Next's `revalidateTag("user-auth")` was dropped — Workers has no
 * route-level cache invalidation surface. // TODO(cache)
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { invitesService } from "@/lib/services/invites";
import type { AppEnv } from "@/types/cloud-worker-env";

const acceptInviteSchema = z.object({ token: z.string().min(1, "Token is required") });

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKey(c);
    const body = await c.req.json();
    const validated = acceptInviteSchema.parse(body);

    const acceptedInvite = await invitesService.acceptInvite(validated.token, user.id);

    return c.json({
      success: true,
      data: {
        organization_id: acceptedInvite.organization_id,
        role: acceptedInvite.invited_role,
        accepted_at: acceptedInvite.accepted_at,
      },
      message: "Invitation accepted successfully",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, error: "Validation error", details: error.issues }, 400);
    }

    const errorMessage = error instanceof Error ? error.message : "Failed to accept invitation";
    const status =
      errorMessage.includes("sign in with") || errorMessage.includes("already a member")
        ? 409
        : errorMessage.includes("Invalid invite") || errorMessage.includes("expired")
          ? 400
          : null;
    if (status) {
      return c.json({ success: false, error: errorMessage }, status);
    }
    return failureResponse(c, error);
  }
});

export default app;
