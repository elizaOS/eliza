/**
 * GET /api/invoices/list
 * Lists all invoices for the authenticated user's organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { invoicesService } from "@/lib/services/invoices";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const invoices = await invoicesService.listByOrganization(user.organization_id);
    return c.json({
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        stripeInvoiceId: invoice.stripe_invoice_id,
        date: invoice.created_at.toLocaleString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        }),
        total: `$${Number(invoice.amount_paid).toFixed(2)}`,
        status: invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1),
        invoiceUrl: invoice.hosted_invoice_url || "",
        invoicePdf: invoice.invoice_pdf || "",
        type: invoice.invoice_type,
        creditsAdded: invoice.credits_added ? Number(invoice.credits_added) : undefined,
      })),
      count: invoices.length,
    });
  } catch (error) {
    logger.error("Error listing invoices:", error);
    return failureResponse(c, error);
  }
});

export default app;
