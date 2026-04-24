import { client } from "@elizaos/app-core/api";
import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import { useCallback, useEffect, useState } from "react";
import type { FullDiskAccessProbeResult } from "../lifeops/fda-probe.js";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

function isMacHostPlatform(
  platform: LifeOpsIMessageConnectorStatus["hostPlatform"] | null | undefined,
): boolean {
  return platform === "darwin";
}

export function useIMessageConnector() {
  const [status, setStatus] = useState<LifeOpsIMessageConnectorStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullDiskAccess, setFullDiskAccess] =
    useState<FullDiskAccessProbeResult | null>(null);

  const refreshSupportState = useCallback(
    async (nextStatus: LifeOpsIMessageConnectorStatus | null) => {
      if (!isMacHostPlatform(nextStatus?.hostPlatform)) {
        setFullDiskAccess(null);
        return;
      }

      const fullDiskAccessResult =
        await client.getLifeOpsFullDiskAccessStatus();
      setFullDiskAccess(fullDiskAccessResult);
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getIMessageConnectorStatus();
      setStatus(nextStatus);
      setError(null);
      await refreshSupportState(nextStatus);
    } catch (cause) {
      setError(formatError(cause, "iMessage connector status failed to load."));
    } finally {
      setLoading(false);
    }
  }, [refreshSupportState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    status,
    loading,
    error,
    fullDiskAccess,
    refresh,
  } as const;
}
