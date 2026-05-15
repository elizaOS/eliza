/**
 * GET  /api/v1/advertising/accounts — list connected ad accounts.
 * POST /api/v1/advertising/accounts — connect a new ad account.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { type AdPlatform, advertisingService } from "@/lib/services/advertising";
import { ConnectAccountSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const platform = c.req.query("platform") as AdPlatform | null;

    const accounts = await advertisingService.listAccounts(
      user.organization_id,
      platform ? { platform } : undefined,
    );

    return c.json({
      accounts: accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        externalAccountId: a.external_account_id,
        accountName: a.account_name,
        status: a.status,
        createdAt: a.created_at.toISOString(),
      })),
      count: accounts.length,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json();
    const parsed = ConnectAccountSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    const account = await advertisingService.connectAccount({
      organizationId: user.organization_id,
      userId: user.id,
      platform: parsed.data.platform,
      accessToken: parsed.data.accessToken,
      refreshToken: parsed.data.refreshToken,
      externalAccountId: parsed.data.externalAccountId,
      accountName: parsed.data.accountName,
    });

    logger.info("[Advertising API] Account connected", {
      accountId: account.id,
      platform: account.platform,
    });

    return c.json(
      {
        id: account.id,
        platform: account.platform,
        externalAccountId: account.external_account_id,
        accountName: account.account_name,
        status: account.status,
        createdAt: account.created_at.toISOString(),
      },
      201,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
