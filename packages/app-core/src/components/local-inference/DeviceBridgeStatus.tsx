import { useEffect, useState } from "react";
import type { DeviceBridgeStatus as DeviceStatus } from "../../api/client-local-inference";
import { resolveApiUrl } from "../../utils/asset-url";
import { getElizaApiToken } from "../../utils/eliza-globals";

/**
 * Thin status strip showing whether a paired mobile device is currently
 * attached to the agent. Visible in the Local Models settings panel when
 * the device-bridge feature is enabled server-side.
 *
 * Subscribes to the `/api/local-inference/device/stream` SSE endpoint so
 * the badge reflects connect/disconnect events in real time.
 */
export function DeviceBridgeStatusBar() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);

  useEffect(() => {
    const raw = resolveApiUrl("/api/local-inference/device/stream");
    const token = getElizaApiToken()?.trim();
    const url = token
      ? `${raw}${raw.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
      : raw;
    const es = new EventSource(url);
    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type: "status";
          status: DeviceStatus;
        };
        if (payload.type === "status") setStatus(payload.status);
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, []);

  if (!status) return null;

  const dotClass = status.connected
    ? "bg-emerald-500"
    : status.pendingRequests > 0
      ? "bg-amber-500"
      : "bg-muted-foreground/40";
  const label = status.connected
    ? `Paired device online${status.capabilities ? ` · ${status.capabilities.platform} · ${status.capabilities.deviceModel}` : ""}`
    : status.pendingRequests > 0
      ? `Device offline · ${status.pendingRequests} request${status.pendingRequests === 1 ? "" : "s"} paused pending reconnect`
      : "No paired device";

  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2 flex items-center gap-3 text-sm">
      <span
        className={`inline-flex h-2 w-2 rounded-full ${dotClass}`}
        aria-hidden
      />
      <span className="flex-1 truncate">{label}</span>
      {status.loadedPath && (
        <span className="text-xs text-muted-foreground truncate max-w-[40%]">
          model: {status.loadedPath.split(/[/\\]/).pop()}
        </span>
      )}
    </div>
  );
}
