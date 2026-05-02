/**
 * GET /api/invoices/[id]
 * Gets a specific invoice by ID. Verifies ownership against the user's org.
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
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Invoice ID is required" }, 400);

    const invoice = await invoicesService.getById(id);
    if (!invoice) return c.json({ error: "Invoice not found" }, 404);
    if (invoice.organization_id !== user.organization_id) {
      return c.json({ error: "Unauthorized access to invoice" }, 403);
    }

    return c.json({
      invoice: {
        id: invoice.id,
        stripeInvoiceId: invoice.stripe_invoice_id,
        stripeCustomerId: invoice.stripe_customer_id,
        stripePaymentIntentId: invoice.stripe_payment_intent_id,
        amountDue: Number(invoice.amount_due),
        amountPaid: Number(invoice.amount_paid),
        currency: invoice.currency,
        status: invoice.status,
        invoiceType: invoice.invoice_type,
        invoiceNumber: invoice.invoice_number,
        invoicePdf: invoice.invoice_pdf,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        creditsAdded: invoice.credits_added ? Number(invoice.credits_added) : undefined,
        metadata: invoice.metadata,
        createdAt: invoice.created_at.toISOString(),
        updatedAt: invoice.updated_at.toISOString(),
        dueDate: invoice.due_date?.toISOString(),
        paidAt: invoice.paid_at?.toISOString(),
      },
    });
  } catch (error) {
    logger.error("Error fetching invoice:", error);
    return failureResponse(c, error);
  }
});

export default app;
