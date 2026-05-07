/**
 * GET /api/credits/transactions
 * Lists credit transactions for the authenticated user's organization.
 * Supports session and API key authentication.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { creditsService } from "@/lib/services/credits";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (!user.organization_id) {
      return c.json({ error: "No organization found" }, 404);
    }

    const hoursParam = c.req.query("hours");
    const limitParam = c.req.query("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 100;
    const hours = hoursParam ? parseInt(hoursParam, 10) : null;

    const allTransactions = await creditsService.listTransactionsByOrganization(
      user.organization_id,
      limit,
    );
    const transactions =
      hours !== null
        ? allTransactions.filter(
            (t) => new Date(t.created_at) >= new Date(Date.now() - hours * 60 * 60 * 1000),
          )
        : allTransactions;

    const periodStart = hours
      ? new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
      : transactions[transactions.length - 1]?.created_at || new Date().toISOString();
    const periodEnd = new Date().toISOString();

    return c.json({
      transactions: transactions.map((t) => ({
        id: t.id,
        organization_id: t.organization_id,
        amount: Number(t.amount),
        type: t.type,
        description: t.description,
        metadata: t.metadata,
        stripe_payment_intent_id: t.stripe_payment_intent_id,
        created_at: t.created_at.toISOString(),
      })),
      total: transactions.length,
      period: { start: periodStart, end: periodEnd },
    });
  } catch (error) {
    logger.error("Error fetching transactions:", error);
    return failureResponse(c, error);
  }
});

export default app;
