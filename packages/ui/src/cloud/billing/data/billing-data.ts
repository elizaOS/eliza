/**
 * React Query data hooks for the billing domain (user/org and invoices),
 * on the cloud {@link api} client (steward Bearer on native, same-origin cookie
 * on web) with the auth gate driven by {@link useSessionAuth}.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../../lib/api-client";
import { useSessionAuth } from "../../lib/use-session-auth";
import type {
  BillingUser,
  CurrentUserResponse,
  InvoiceApiPayload,
  InvoiceDto,
  VerifyCheckoutResult,
} from "../types";
import { BILLING_SNAPSHOT_V2_QUERY_KEY } from "./billing-snapshot";

interface AuthGate {
  enabled: boolean;
  userId: string | null;
}

function useAuthGate(enabled = true): AuthGate {
  const session = useSessionAuth();
  return {
    enabled: enabled && session.ready && session.authenticated,
    userId: session.user?.id ?? null,
  };
}

function authKey(
  parts: readonly unknown[],
  gate: AuthGate,
): readonly unknown[] {
  return [...parts, "auth", gate.userId];
}

/**
 * GET /api/v1/user — current user's org summary for the billing surface. Gated
 * on the synchronous session check so we never fire before the session restores.
 */
export function useBillingUser(
  options: { requireFreshOrganization?: boolean } = {},
) {
  const gate = useAuthGate();
  const requireFreshOrganization = options.requireFreshOrganization === true;
  const query = useQuery({
    queryKey: authKey(["billing-user"], gate),
    queryFn: async ({ signal }): Promise<BillingUser | null> => {
      const res = await api<CurrentUserResponse>("/api/v1/user", { signal });
      const { organization_id, wallet_address, organization } = res.data;
      if (!organization_id || !organization) return null;
      return {
        organization_id,
        wallet_address,
      };
    },
    enabled: gate.enabled,
    // Tenant-sensitive surfaces must not paint a cached organization after an
    // invite or membership change. They opt into a fresh membership read and
    // keep their content gated while that request is in flight.
    refetchOnMount: requireFreshOrganization ? "always" : undefined,
    refetchOnWindowFocus: requireFreshOrganization ? "always" : undefined,
  });
  return {
    ...query,
    user: query.data ?? null,
    isAuthenticated: gate.enabled,
  };
}

/**
 * POST /api/billing/checkout/verify — synchronous webhook fallback for the
 * billing-success page. Idempotent on the payment intent; invalidates the
 * cached balance on success.
 */
export function useVerifyCheckout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string; from?: string }) =>
      api<VerifyCheckoutResult>("/api/billing/checkout/verify", {
        method: "POST",
        json: { session_id: input.sessionId, from: input.from },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credits", "balance"] });
      queryClient.invalidateQueries({
        queryKey: BILLING_SNAPSHOT_V2_QUERY_KEY,
      });
    },
  });
}

function adaptInvoice(
  payload: InvoiceApiPayload,
  organizationId: string,
): InvoiceDto {
  return {
    id: payload.id,
    organization_id: organizationId,
    stripe_invoice_id: payload.stripeInvoiceId,
    stripe_customer_id: payload.stripeCustomerId,
    stripe_payment_intent_id: payload.stripePaymentIntentId,
    amount_due: payload.amountDue,
    amount_paid: payload.amountPaid,
    currency: payload.currency,
    status: payload.status,
    invoice_type: payload.invoiceType,
    invoice_number: payload.invoiceNumber,
    invoice_pdf: payload.invoicePdf,
    hosted_invoice_url: payload.hostedInvoiceUrl,
    credits_added: payload.creditsAdded ?? null,
    metadata: payload.metadata ?? {},
    created_at: payload.createdAt,
    updated_at: payload.updatedAt,
    due_date: payload.dueDate ?? null,
    paid_at: payload.paidAt ?? null,
  };
}

/**
 * GET /api/invoices/:id — single invoice scoped to the caller's org. The Worker
 * route enforces ownership and returns 403/404; both surface as {@link ApiError}.
 */
export function useInvoice(
  id: string | undefined,
  organizationId: string | null | undefined,
) {
  const gate = useAuthGate(Boolean(id && organizationId));
  return useQuery({
    queryKey: authKey(["invoice", id], gate),
    queryFn: async () => {
      if (!id) throw new ApiError(400, "MISSING_ID", "Invoice ID is required");
      if (!organizationId) {
        throw new ApiError(
          401,
          "MISSING_ORG",
          "Organization required to load invoice",
        );
      }
      const res = await api<{ invoice: InvoiceApiPayload }>(
        `/api/invoices/${id}`,
      );
      return adaptInvoice(res.invoice, organizationId);
    },
    enabled: gate.enabled,
  });
}

export { ApiError };
