import { useEffect, useState } from "react";
import type { DeviceBridgeStatus } from "../../api/client-local-inference";
import { resolveApiUrl } from "../../utils/asset-url";
import { getElizaApiToken } from "../../utils/eliza-globals";

export function buildDeviceBridgeStatusStreamUrl(
  rawUrl: string,
  token?: string | null,
): string {
  const trimmedToken = token?.trim();
  if (!trimmedToken) {
    return rawUrl;
  }
  return `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(trimmedToken)}`;
}

export function useDeviceBridgeStatus() {
  const [status, setStatus] = useState<DeviceBridgeStatus | null>(null);

  useEffect(() => {
    const url = buildDeviceBridgeStatusStreamUrl(
      resolveApiUrl("/api/local-inference/device/stream"),
      getElizaApiToken(),
    );
    const eventSource = new EventSource(url);
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type: "status";
          status: DeviceBridgeStatus;
        };
        if (payload.type === "status") {
          setStatus(payload.status);
        }
      } catch {
        // Ignore malformed stream events and keep the last good status.
      }
    };
    return () => eventSource.close();
  }, []);

  return status;
}
