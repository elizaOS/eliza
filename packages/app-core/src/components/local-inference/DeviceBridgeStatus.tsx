import { useEffect, useState } from "react";
import type { DeviceBridgeStatus as DeviceStatus } from "../../api/client-local-inference";
import { resolveApiUrl } from "../../utils/asset-url";
import { getElizaApiToken } from "../../utils/eliza-globals";

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
    <div
      className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-2 py-1.5 text-xs"
      title={label}
    >
      <span
        className={`inline-flex h-2 w-2 rounded-full ${dotClass}`}
        aria-hidden
      />
      <span className="flex-1 truncate">{label}</span>
      {status.loadedPath && (
        <span className="max-w-[40%] truncate text-muted">
          {status.loadedPath.split(/[/\\]/).pop()}
        </span>
      )}
    </div>
  );
}
