import type { Metadata } from "next";
import { requireAuthWithOrg } from "@/lib/auth";
import { InvoiceDetailClient } from "@/components/invoices/invoice-detail-client";
import { invoicesService } from "@/lib/services/invoices";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Invoice Details",
  description: "View invoice details and transaction information",
};

export const dynamic = "force-dynamic";

/**
 * Invoice detail page displaying information for a specific invoice.
 * Verifies the invoice belongs to the authenticated user's organization.
 *
 * @param params - Route parameters containing the invoice ID.
 * @returns The rendered invoice detail page client component, or redirects to 404 if not found.
 */
export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireAuthWithOrg();
  const { id } = await params;

  if (!id || !user.organization_id) {
    notFound();
  }

  const invoice = await invoicesService.getById(id);

  if (!invoice || invoice.organization_id !== user.organization_id) {
    notFound();
  }

  return <InvoiceDetailClient invoice={invoice} />;
}
