import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { invoicesService } from "@/lib/services/invoices";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

/**
 * GET /api/invoices/[id]
 * Gets a specific invoice by ID.
 * Supports both Privy session and API key authentication.
 * Verifies the invoice belongs to the user's organization.
 *
 * @param req - The Next.js request object.
 * @param context - Route context containing the invoice ID parameter.
 * @returns Formatted invoice details or error if not found/unauthorized.
 */
async function handleGetInvoice(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { params } = context;
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(req);

    if (!user.organization_id) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 },
      );
    }

    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: "Invoice ID is required" },
        { status: 400 },
      );
    }

    const invoice = await invoicesService.getById(id);

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    if (invoice.organization_id !== user.organization_id) {
      return NextResponse.json(
        { error: "Unauthorized access to invoice" },
        { status: 403 },
      );
    }

    const formattedInvoice = {
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
      creditsAdded: invoice.credits_added
        ? Number(invoice.credits_added)
        : undefined,
      metadata: invoice.metadata,
      createdAt: invoice.created_at.toISOString(),
      updatedAt: invoice.updated_at.toISOString(),
      dueDate: invoice.due_date?.toISOString(),
      paidAt: invoice.paid_at?.toISOString(),
    };

    return NextResponse.json({ invoice: formattedInvoice });
  } catch (error) {
    logger.error("Error fetching invoice:", error);

    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(
      { error: "Failed to fetch invoice" },
      { status: 500 },
    );
  }
}

export const GET = (
  req: NextRequest,
  context?: { params: Promise<{ id: string }> },
) =>
  withRateLimit(
    (r: NextRequest) => handleGetInvoice(r, context!),
    RateLimitPresets.STANDARD,
  )(req);
