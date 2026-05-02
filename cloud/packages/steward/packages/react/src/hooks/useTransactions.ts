import type { TxRecord, TxStatus } from "@stwd/sdk";
import { useCallback, useEffect, useState } from "react";
import { useStewardContext } from "../provider.js";

interface UseTransactionsOpts {
  pageSize?: number;
  status?: TxStatus[];
  chainId?: number;
}

/**
 * Paginated transaction history.
 * Falls back to client.getHistory() and does client-side pagination
 * until the paginated API endpoint is available.
 */
export function useTransactions(opts: UseTransactionsOpts = {}) {
  const { client, agentId, pollInterval } = useStewardContext();
  const { pageSize = 20, status, chainId } = opts;

  const [allTransactions, setAllTransactions] = useState<TxRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [page, setPage] = useState(1);

  const fetchTransactions = useCallback(async () => {
    try {
      // Try paginated endpoint first
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (status?.length) params.set("status", status.join(","));
      if (chainId) params.set("chainId", String(chainId));

      const res = await fetch(
        `${client.getBaseUrl()}/agents/${encodeURIComponent(agentId)}/transactions?${params}`,
        {
          headers: { Accept: "application/json" },
        },
      );

      if (res.ok) {
        const json = await res.json();
        if (json.ok && json.data?.transactions) {
          setAllTransactions(json.data.transactions);
          setError(null);
          setIsLoading(false);
          return;
        }
      }

      // Fallback: use getHistory and convert
      const history = await client.getHistory(agentId);
      const txRecords: TxRecord[] = history.map((entry, i) => ({
        id: `tx-${i}`,
        agentId,
        status: "confirmed" as TxStatus,
        request: {
          agentId,
          tenantId: "",
          to: "",
          value: entry.value,
          chainId: chainId || 8453,
        },
        policyResults: [],
        createdAt: new Date(entry.timestamp * 1000),
      }));
      setAllTransactions(txRecords);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [client, agentId, page, pageSize, status, chainId]);

  useEffect(() => {
    fetchTransactions();
    const interval = setInterval(fetchTransactions, pollInterval);
    return () => clearInterval(interval);
  }, [fetchTransactions, pollInterval]);

  // Client-side pagination for fallback
  const totalPages = Math.max(1, Math.ceil(allTransactions.length / pageSize));
  const paginatedTx = allTransactions.slice((page - 1) * pageSize, page * pageSize);

  return {
    transactions: paginatedTx,
    isLoading,
    error,
    page,
    totalPages,
    nextPage: () => setPage((p) => Math.min(p + 1, totalPages)),
    prevPage: () => setPage((p) => Math.max(p - 1, 1)),
    setPage,
    refetch: fetchTransactions,
  };
}
