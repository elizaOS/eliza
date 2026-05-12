import { useQuery } from "@tanstack/react-query";
import type { Invoice } from "@/db/schemas";
import { ApiError, api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

/**
 * Worker `GET /api/invoices/[id]` returns a flattened, camelCase, ISO-string
 * payload. The shared `InvoiceDetailClient` consumes the Drizzle `Invoice`
 * row shape directly (snake_case + `Date` columns), so we adapt the payload
 * to that type at this seam rather than fork the UI.
 */
interface InvoiceApiPayload {
  id: string;
  stripeInvoiceId: string;
  stripeCustomerId: string;
  stripePaymentIntentId: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string;
  invoiceType: string;
  invoiceNumber: string | null;
  invoicePdf: string | null;
  hostedInvoiceUrl: string | null;
  creditsAdded?: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  dueDate?: string;
  paidAt?: string;
}

export interface InvoiceListEntry {
  id: string;
  stripeInvoiceId: string;
  date: string;
  total: string;
  status: string;
  invoiceUrl: string;
  invoicePdf: string;
  type: string;
  creditsAdded?: number;
}

function adaptInvoice(payload: InvoiceApiPayload, organizationId: string): Invoice {
  return {
    id: payload.id,
    organization_id: organizationId,
    stripe_invoice_id: payload.stripeInvoiceId,
    stripe_customer_id: payload.stripeCustomerId,
    stripe_payment_intent_id: payload.stripePaymentIntentId,
    amount_due: String(payload.amountDue),
    amount_paid: String(payload.amountPaid),
    currency: payload.currency,
    status: payload.status,
    invoice_type: payload.invoiceType,
    invoice_number: payload.invoiceNumber,
    invoice_pdf: payload.invoicePdf,
    hosted_invoice_url: payload.hostedInvoiceUrl,
    credits_added: payload.creditsAdded !== undefined ? String(payload.creditsAdded) : null,
    metadata: payload.metadata ?? {},
    created_at: new Date(payload.createdAt),
    updated_at: new Date(payload.updatedAt),
    due_date: payload.dueDate ? new Date(payload.dueDate) : null,
    paid_at: payload.paidAt ? new Date(payload.paidAt) : null,
  };
}

/**
 * GET /api/invoices/[id] — single invoice scoped to the caller's org.
 *
 * The Worker route enforces ownership and returns 403/404 when the invoice
 * is missing or belongs to another org; both surface as `ApiError` here so
 * the page can render a not-found state.
 */
export function useInvoice(id: string | undefined, organizationId: string | null | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(id && organizationId));
  return useQuery({
    queryKey: authenticatedQueryKey(["invoice", id], gate),
    queryFn: async () => {
      if (!id) throw new ApiError(400, "MISSING_ID", "Invoice ID is required");
      if (!organizationId) {
        throw new ApiError(401, "MISSING_ORG", "Organization required to load invoice");
      }
      const r = await api<{ invoice: InvoiceApiPayload }>(`/api/invoices/${id}`);
      return adaptInvoice(r.invoice, organizationId);
    },
    enabled: gate.enabled,
  });
}

/** GET /api/invoices/list — pre-formatted invoices for the billing tab. */
export function useInvoices() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["invoices", "list"], gate),
    queryFn: () =>
      api<{ invoices: InvoiceListEntry[]; count: number }>("/api/invoices/list").then(
        (r) => r.invoices,
      ),
    enabled: gate.enabled,
  });
}
