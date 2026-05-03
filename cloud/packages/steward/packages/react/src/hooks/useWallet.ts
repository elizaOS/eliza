import type { AgentBalance, AgentIdentity } from "@stwd/sdk";
import { useCallback, useEffect, useState } from "react";
import { useStewardContext } from "../provider.js";

/**
 * Agent data with auto-refresh.
 */
export function useWallet() {
  const { client, agentId, pollInterval } = useStewardContext();
  const [agent, setAgent] = useState<AgentIdentity | null>(null);
  const [balance, setBalance] = useState<AgentBalance | null>(null);
  const [addresses, setAddresses] = useState<Array<{ chainFamily: string; address: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [agentData, balanceData, addressData] = await Promise.all([
        client.getAgent(agentId),
        client.getBalance(agentId).catch(() => null),
        client.getAddresses(agentId).catch(() => ({ addresses: [] })),
      ]);
      setAgent(agentData);
      setBalance(balanceData);
      setAddresses(addressData.addresses || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [client, agentId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, pollInterval);
    return () => clearInterval(interval);
  }, [fetchData, pollInterval]);

  return {
    agent,
    balance,
    addresses,
    isLoading,
    error,
    refetch: fetchData,
  };
}
