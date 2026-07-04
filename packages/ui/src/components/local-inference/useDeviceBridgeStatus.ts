/**
 * Subscribes to the device-bridge status SSE stream and returns the latest
 * `DeviceBridgeStatus`, or null on native IPC bases that EventSource cannot
 * open. `buildDeviceBridgeStatusStreamUrl` appends the auth token as a query
 * param since EventSource cannot set headers.
 */

import { useEffect, useState } from "react";
import type { DeviceBridgeStatus } from "../../api/client-local-inference";
import { resolveApiUrl } from "../../utils/asset-url";
import { getElizaApiToken } from "../../utils/eliza-globals";
import { openEventSource } from "../../utils/event-source";

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
    // The native IPC base used by on-device runtimes is not an http(s) URL, so
    // EventSource cannot subscribe to it; leave status null in that case.
    const eventSource = openEventSource(url);
    if (eventSource) {
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
    }
    return () => eventSource?.close();
  }, []);

  return status;
}
