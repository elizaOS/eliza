import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreditBalanceResponse } from "@/lib/types/cloud-api";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

/**
 * GET /api/credits/balance — cached for 30s by default. Pass `fresh: true` to
 * bypass the server-side cache (matches the legacy `?fresh=true` query).
 */
export function useCreditsBalance(opts: { fresh?: boolean } = {}) {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(
      ["credits", "balance", opts.fresh ?? false],
      gate,
    ),
    queryFn: () =>
      api<CreditBalanceResponse>(
        opts.fresh ? "/api/credits/balance?fresh=true" : "/api/credits/balance",
      ),
    enabled: gate.enabled,
  });
}

export interface VerifyCheckoutResult {
  success: boolean;
  balance: number;
  alreadyApplied: boolean;
}

/**
 * POST /api/billing/checkout/verify — synchronous webhook fallback for the
 * billing-success page. Verifies the Stripe Checkout session belongs to the
 * caller and credits the org once (idempotent on the payment intent ID).
 * Invalidates the cached credit balance on success.
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
    },
  });
}
