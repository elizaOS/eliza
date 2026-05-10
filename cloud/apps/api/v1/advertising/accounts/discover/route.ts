/**
 * POST /api/v1/advertising/accounts/discover — list selectable provider ad accounts.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { DiscoverAdAccountsSchema } from "@/lib/services/advertising/schemas";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json();
    const parsed = DiscoverAdAccountsSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    const accounts = await advertisingService.listAvailableAdAccounts(
      user.organization_id,
      parsed.data.platform,
      parsed.data.accessToken,
    );

    return c.json({
      platform: parsed.data.platform,
      accounts,
      count: accounts.length,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
