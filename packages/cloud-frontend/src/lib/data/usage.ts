/**
 * Usage data hooks for the settings usage tab.
 *
 * Replaces the tab's hand-rolled `setInterval` + raw-`fetch` polls with
 * TanStack Query so polling is visibility-gated (`refetchIntervalInBackground:
 * false`), de-duplicated, and cached across tab revisits (no spinner-flash on
 * background ticks; read `isFetching` for background state, `isLoading` for
 * first-load only).
 */
import { useQuery } from "@tanstack/react-query";
import type { QuotaUsageDto, SessionStatsDto } from "@/lib/types/cloud-api";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

const SESSION_STATS_INTERVAL_MS = 30_000;
const QUOTA_USAGE_INTERVAL_MS = 60_000;
const DAILY_BURN_STALE_MS = 60_000;

interface SessionStatsResponse {
  success: boolean;
  data: SessionStatsDto | null;
}

interface QuotaUsageResponse {
  success: boolean;
  data: QuotaUsageDto | null;
}

interface CreditTransaction {
  amount: string | number;
}

interface CreditTransactionsResponse {
  transactions?: unknown[];
}

function isCreditTransaction(value: unknown): value is CreditTransaction {
  if (typeof value !== "object" || value === null || !("amount" in value)) {
    return false;
  }
  const { amount } = value as Record<string, unknown>;
  return typeof amount === "string" || typeof amount === "number";
}

/** GET /api/sessions/current - live credit/request/token usage for the session. */
export function useSessionStats() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["usage", "session-stats"], gate),
    queryFn: async () => {
      const res = await api<SessionStatsResponse>("/api/sessions/current");
      return res.success ? res.data : null;
    },
    enabled: gate.enabled,
    refetchInterval: gate.enabled ? SESSION_STATS_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: SESSION_STATS_INTERVAL_MS,
  });
}

/** GET /api/quotas/usage - global + per-model weekly quota usage. */
export function useQuotaUsage() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["usage", "quota"], gate),
    queryFn: async () => {
      const res = await api<QuotaUsageResponse>("/api/quotas/usage");
      return res.success ? res.data : null;
    },
    enabled: gate.enabled,
    refetchInterval: gate.enabled ? QUOTA_USAGE_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: QUOTA_USAGE_INTERVAL_MS,
  });
}

/**
 * GET /api/credits/transactions?hours=24 - total credits burned in the last
 * 24h, summed from the (negative) debit transactions. Returned pre-computed so
 * the usage tab only renders the value.
 */
export function useDailyBurn() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["usage", "daily-burn"], gate),
    queryFn: async () => {
      const res = await api<CreditTransactionsResponse>(
        "/api/credits/transactions?hours=24",
      );
      const transactions = Array.isArray(res.transactions)
        ? res.transactions.filter(isCreditTransaction)
        : [];
      return transactions
        .filter((tx) => Number(tx.amount) < 0)
        .reduce((sum, tx) => sum + Math.abs(Number(tx.amount)), 0);
    },
    enabled: gate.enabled,
    staleTime: DAILY_BURN_STALE_MS,
  });
}
