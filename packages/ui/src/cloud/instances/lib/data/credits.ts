/**
 * Credit-balance read hook used by the Instances pricing banner, on the cloud
 * shell's typed {@link api} client + auth gate.
 */

import type { CreditBalanceResponse } from "@elizaos/cloud-shared/lib/types/cloud-api";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../../../lib/auth-query";

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
