/**
 * POST /api/organizations/invites — create invite (owner/admin)
 * GET  /api/organizations/invites — list invites (owner/admin)
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { invitesService } from "@/lib/services/invites";
import type { AppEnv } from "@/types/cloud-worker-env";

const createInviteSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["admin", "member"]),
});

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (user.role !== "owner" && user.role !== "admin") {
      return c.json({ success: false, error: "Only owners and admins can invite members" }, 403);
    }

    const body = await c.req.json();
    const validated = createInviteSchema.parse(body);

    const result = await invitesService.createInvite({
      organizationId: user.organization_id,
      inviterUserId: user.id,
      invitedEmail: validated.email,
      invitedRole: validated.role,
    });

    return c.json({
      success: true,
      data: {
        id: result.invite.id,
        email: result.invite.invited_email,
        role: result.invite.invited_role,
        expires_at: result.invite.expires_at,
        status: result.invite.status,
      },
      message: "Invitation sent successfully",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, error: "Validation error", details: error.issues }, 400);
    }
    const message = error instanceof Error ? error.message : "Failed to create invitation";
    if (message.includes("already a member") || message.includes("already pending")) {
      return c.json({ success: false, error: message }, 409);
    }
    if (message.includes("Only owners and admins")) {
      return c.json({ success: false, error: message }, 403);
    }
    return failureResponse(c, error);
  }
});

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (user.role !== "owner" && user.role !== "admin") {
      return c.json({ success: false, error: "Only owners and admins can view invitations" }, 403);
    }

    const invites = await invitesService.listByOrganization(user.organization_id);
    type InviteWithInviter = (typeof invites)[number] & {
      inviter?: { id: string; name: string | null; email: string | null } | null;
    };

    return c.json({
      success: true,
      data: invites.map((invite) => {
        const i = invite as InviteWithInviter;
        return {
          id: i.id,
          email: i.invited_email,
          role: i.invited_role,
          status: i.status,
          expires_at: i.expires_at,
          created_at: i.created_at,
          inviter: i.inviter
            ? { id: i.inviter.id, name: i.inviter.name, email: i.inviter.email }
            : null,
          accepted_at: i.accepted_at,
        };
      }),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
