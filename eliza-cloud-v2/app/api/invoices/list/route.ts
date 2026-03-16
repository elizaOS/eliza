import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { invoicesService } from "@/lib/services/invoices";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

/**
 * GET /api/invoices/list
 * Lists all invoices for the authenticated user's organization.
 * Supports both Privy session and API key authentication.
 *
 * @param req - The Next.js request object.
 * @returns Array of formatted invoices with metadata.
 */
async function handleListInvoices(req: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(req);

    if (!user.organization_id) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 },
      );
    }

    const invoices = await invoicesService.listByOrganization(
      user.organization_id,
    );

    const formattedInvoices = invoices.map((invoice) => ({
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
      creditsAdded: invoice.credits_added
        ? Number(invoice.credits_added)
        : undefined,
    }));

    return NextResponse.json({
      invoices: formattedInvoices,
      count: formattedInvoices.length,
    });
  } catch (error) {
    logger.error("Error listing invoices:", error);

    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(
      { error: "Failed to list invoices" },
      { status: 500 },
    );
  }
}

export const GET = withRateLimit(handleListInvoices, RateLimitPresets.STANDARD);
