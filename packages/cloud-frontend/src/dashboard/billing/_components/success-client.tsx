/**
 * Credit balance display component showing current credit balance.
 * Fetches and displays balance with loading, error, and success states.
 */

"use client";

import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/providers/I18nProvider";

async function getCreditBalance(): Promise<number> {
  const res = await fetch("/api/v1/credits/balance", {
    credentials: "include",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Failed to fetch credit balance (${res.status})`,
    );
  }
  const data = (await res.json()) as { balance?: number };
  if (typeof data.balance !== "number") {
    throw new Error("Credit balance missing from API response");
  }
  return data.balance;
}

interface CreditBalanceDisplayProps {
  sessionId?: string;
  creditsAdded?: number;
}

export function CreditBalanceDisplay(_props: CreditBalanceDisplayProps) {
  const t = useT();
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCreditBalance = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const balance = await getCreditBalance();
      setCreditBalance(balance);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("cloud.successClient.unknownError", {
              defaultValue: "Unknown error",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchCreditBalance();
  }, [fetchCreditBalance]);

  if (loading) {
    return (
      <div className="rounded-sm border bg-muted/50 p-4">
        <div className="text-sm text-muted-foreground">
          {t("cloud.successClient.currentBalance", {
            defaultValue: "Current Balance",
          })}
        </div>
        <div className="flex items-center justify-center py-2">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (error || creditBalance === null) {
    return (
      <div className="rounded-sm border border-red-500/40 bg-red-500/10 p-4">
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4" />
          {error
            ? t("cloud.successClient.couldNotLoadBalanceWithError", {
                error,
                defaultValue: "Could not load balance: {{error}}",
              })
            : t("cloud.successClient.couldNotLoadBalance", {
                defaultValue: "Could not load balance",
              })}
        </div>
        <button
          type="button"
          onClick={() => void fetchCreditBalance()}
          className="mt-2 inline-flex items-center gap-1 text-xs text-red-300 hover:text-red-200"
        >
          <RefreshCw className="h-3 w-3" />
          {t("cloud.successClient.refreshBalance", {
            defaultValue: "Refresh balance",
          })}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-sm border bg-muted/50 p-4">
      <div className="text-sm text-muted-foreground">
        {t("cloud.successClient.currentBalance", {
          defaultValue: "Current Balance",
        })}
      </div>
      <div className="text-3xl font-bold mt-1">${creditBalance.toFixed(2)}</div>
      <div className="text-sm text-muted-foreground">USD</div>
    </div>
  );
}
