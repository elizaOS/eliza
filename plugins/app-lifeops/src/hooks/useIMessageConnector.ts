import { client } from "@elizaos/ui";
import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared";
import { useCallback, useEffect, useState } from "react";
import type { FullDiskAccessProbeResult } from "../lifeops/fda-probe.js";
import { formatConnectorError } from "./connector-error.js";

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
      setError(
        formatConnectorError(
          cause,
          "iMessage connector status failed to load.",
        ),
      );
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
