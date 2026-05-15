/**
 * DELETE /api/organizations/invites/[inviteId]
 * Revoke an organization invitation (owner/admin only).
 */

import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { invitesService } from "@/lib/services/invites";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (user.role !== "owner" && user.role !== "admin") {
      return c.json(
        { success: false, error: "Only owners and admins can revoke invitations" },
        403,
      );
    }

    const inviteId = c.req.param("inviteId");
    if (!inviteId) {
      return c.json({ success: false, error: "Invalid request" }, 400);
    }

    await invitesService.revokeInvite(inviteId, user.organization_id);
    return c.json({ success: true, message: "Invitation revoked successfully" });
  } catch (error) {
    logger.error("Error revoking invite:", error);
    const message = error instanceof Error ? error.message : "Failed to revoke invitation";
    const status = message.includes("not found")
      ? 404
      : message.includes("does not belong")
        ? 403
        : 500;
    return c.json({ success: false, error: message }, status);
  }
});

export default app;
