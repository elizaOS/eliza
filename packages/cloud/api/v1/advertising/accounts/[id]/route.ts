/**
 * GET    /api/v1/advertising/accounts/[id]         — get a specific ad account.
 * DELETE /api/v1/advertising/accounts/[id]         — disconnect an ad account.
 * POST   /api/v1/advertising/accounts/[id]/approve — approve a pending account (admin).
 * POST   /api/v1/advertising/accounts/[id]/reject  — reject/suspend an account (admin).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  requireAdmin,
  requireUserOrApiKeyWithOrg,
} from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    const account = await advertisingService.getAccount(id);

    if (!account || account.organization_id !== user.organization_id) {
      return c.json({ error: "Account not found" }, 404);
    }

    return c.json({
      id: account.id,
      platform: account.platform,
      externalAccountId: account.external_account_id,
      accountName: account.account_name,
      status: account.status,
      metadata: account.metadata,
      createdAt: account.created_at.toISOString(),
      updatedAt: account.updated_at.toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    await advertisingService.disconnectAccount(id, user.organization_id);

    logger.info("[Advertising API] Account disconnected", { accountId: id });

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

/**
 * Approve a pending ad account (platform operator only). requireAdmin ensures an
 * org owner can never self-approve their own account — the same operator-executes
 * posture as fiat payouts. (#11364)
 */
app.post("/approve", async (c) => {
  try {
    await requireAdmin(c);
    const id = c.req.param("id")!;

    const account = await advertisingService.approveAccount(id);

    logger.info("[Advertising API] Account approved", { accountId: id });

    return c.json({ id: account.id, status: account.status });
  } catch (error) {
    return failureResponse(c, error);
  }
});

/**
 * Reject or suspend an ad account (platform operator only). (#11364)
 */
app.post("/reject", async (c) => {
  try {
    await requireAdmin(c);
    const id = c.req.param("id")!;

    const account = await advertisingService.rejectAccount(id);

    logger.info("[Advertising API] Account rejected/suspended", {
      accountId: id,
    });

    return c.json({ id: account.id, status: account.status });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
