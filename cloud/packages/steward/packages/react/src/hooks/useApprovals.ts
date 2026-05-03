import { useCallback, useEffect, useState } from "react";
import { useStewardContext } from "../provider.js";
import type { ApprovalQueueEntry } from "../types.js";

/**
 * Approval queue with approve/reject actions.
 */
export function useApprovals(refreshInterval?: number) {
  const { client, agentId, pollInterval } = useStewardContext();
  const interval = refreshInterval || pollInterval;

  const [pending, setPending] = useState<ApprovalQueueEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const baseUrl = client.getBaseUrl();

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/agents/${encodeURIComponent(agentId)}/approvals?status=pending`,
        { headers: { Accept: "application/json" } },
      );
      if (res.ok) {
        const json = await res.json();
        if (json.ok && json.data) {
          setPending(Array.isArray(json.data) ? json.data : []);
        }
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, agentId]);

  useEffect(() => {
    fetchApprovals();
    const timer = setInterval(fetchApprovals, interval);
    return () => clearInterval(timer);
  }, [fetchApprovals, interval]);

  const approve = useCallback(
    async (txId: string) => {
      setIsResolving(true);
      try {
        const res = await fetch(
          `${baseUrl}/agents/${encodeURIComponent(agentId)}/approvals/${encodeURIComponent(txId)}/approve`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
        setPending((prev) => prev.filter((a) => a.txId !== txId));
      } finally {
        setIsResolving(false);
      }
    },
    [baseUrl, agentId],
  );

  const reject = useCallback(
    async (txId: string, reason?: string) => {
      setIsResolving(true);
      try {
        const res = await fetch(
          `${baseUrl}/agents/${encodeURIComponent(agentId)}/approvals/${encodeURIComponent(txId)}/reject`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason }),
          },
        );
        if (!res.ok) throw new Error(`Reject failed: ${res.status}`);
        setPending((prev) => prev.filter((a) => a.txId !== txId));
      } finally {
        setIsResolving(false);
      }
    },
    [baseUrl, agentId],
  );

  return {
    pending,
    isLoading,
    error,
    approve,
    reject,
    isResolving,
    refetch: fetchApprovals,
  };
}
