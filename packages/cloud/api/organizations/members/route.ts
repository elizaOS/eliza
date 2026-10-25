/**
 * GET /api/organizations/members
 * Lists all members of the organization. Owner / admin only.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { usersService } from "@elizaos/cloud-shared/lib/services/users";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (user.role !== "owner" && user.role !== "admin") {
      return c.json(
        { success: false, error: "Only owners and admins can view members" },
        403,
      );
    }

    const members = await usersService.listByOrganization(user.organization_id);
    return c.json({
      success: true,
      data: members.map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        wallet_address: member.wallet_address,
        wallet_chain_type: member.wallet_chain_type,
        role: member.role,
        is_active: member.is_active,
        created_at: member.created_at,
        updated_at: member.updated_at,
      })),
    });
  } catch (error) {
    logger.error("Error fetching members:", error);
    return failureResponse(c, error);
  }
});

export default app;
