/**
 * GET /api/v1/user/wallets — list server-side wallets provisioned for the user's org.
 */

import { requireUserOrApiKey } from "@elizaos/cloud-shared/auth";
import { dbWrite } from "@elizaos/cloud-shared/db/helpers";
import { agentServerWallets } from "@elizaos/cloud-shared/db/schemas/agent-server-wallets";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKey(c);
    if (!user.organization?.id) {
      return c.json(
        { success: false, error: "User does not belong to an organization" },
        403,
      );
    }

    const wallets = await dbWrite
      .select({
        id: agentServerWallets.id,
        address: agentServerWallets.address,
        chainType: agentServerWallets.chain_type,
        clientAddress: agentServerWallets.client_address,
        stewardAgentId: agentServerWallets.steward_agent_id,
        createdAt: agentServerWallets.created_at,
      })
      .from(agentServerWallets)
      .where(eq(agentServerWallets.organization_id, user.organization.id));

    return c.json({ success: true, data: wallets });
  } catch (error) {
    logger.error("[user-wallets] Error listing wallets:", error);
    return failureResponse(c, error);
  }
});

export default app;
