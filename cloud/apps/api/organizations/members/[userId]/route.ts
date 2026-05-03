/**
 * PATCH  /api/organizations/members/[userId]  — update role (owner only)
 * DELETE /api/organizations/members/[userId]  — remove member (owner/admin)
 *
 * `revalidateTag("user-auth")` from Next is dropped — Workers has no
 * route-cache invalidation surface. // TODO(cache)
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { usersService } from "@/lib/services/users";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const updateMemberSchema = z.object({ role: z.enum(["admin", "member"]) });

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.patch("/", async (c) => {
  try {
    const currentUser = await requireUserOrApiKeyWithOrg(c);
    if (currentUser.role !== "owner") {
      return c.json(
        { success: false, error: "Only organization owners can update member roles" },
        403,
      );
    }

    const userId = c.req.param("userId");
    if (!userId) return c.json({ success: false, error: "Invalid request" }, 400);

    const body = await c.req.json();
    const validated = updateMemberSchema.parse(body);

    const targetUser = await usersService.getById(userId);
    if (!targetUser) return c.json({ success: false, error: "User not found" }, 404);
    if (targetUser.organization_id !== currentUser.organization_id) {
      return c.json({ success: false, error: "User does not belong to your organization" }, 403);
    }
    if (targetUser.id === currentUser.id) {
      return c.json({ success: false, error: "Cannot change your own role" }, 400);
    }
    if (targetUser.role === "owner") {
      return c.json({ success: false, error: "Cannot change owner role" }, 400);
    }

    const updated = await usersService.update(userId, {
      role: validated.role,
      updated_at: new Date(),
    });
    if (!updated) return c.json({ success: false, error: "Failed to update member" }, 500);

    return c.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        updated_at: updated.updated_at,
      },
      message: "Member role updated successfully",
    });
  } catch (error) {
    logger.error("Error updating member:", error);
    if (error instanceof z.ZodError) {
      return c.json({ success: false, error: "Validation error", details: error.issues }, 400);
    }
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const currentUser = await requireUserOrApiKeyWithOrg(c);
    if (currentUser.role !== "owner" && currentUser.role !== "admin") {
      return c.json({ success: false, error: "Only owners and admins can remove members" }, 403);
    }

    const userId = c.req.param("userId");
    if (!userId) return c.json({ success: false, error: "Invalid request" }, 400);

    const targetUser = await usersService.getById(userId);
    if (!targetUser) return c.json({ success: false, error: "User not found" }, 404);
    if (targetUser.organization_id !== currentUser.organization_id) {
      return c.json({ success: false, error: "User does not belong to your organization" }, 403);
    }
    if (targetUser.id === currentUser.id) {
      return c.json({ success: false, error: "Cannot remove yourself from the organization" }, 400);
    }
    if (targetUser.role === "owner") {
      return c.json({ success: false, error: "Cannot remove organization owner" }, 400);
    }
    if (currentUser.role === "admin" && targetUser.role === "admin") {
      return c.json({ success: false, error: "Admins cannot remove other admins" }, 403);
    }

    await usersService.delete(userId);
    return c.json({ success: true, message: "Member removed successfully" });
  } catch (error) {
    logger.error("Error removing member:", error);
    return failureResponse(c, error);
  }
});

export default app;
