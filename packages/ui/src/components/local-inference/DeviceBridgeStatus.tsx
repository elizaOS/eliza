import type { DeviceBridgeStatus } from "../../api/client-local-inference";
import { useRenderGuard } from "../../hooks/useRenderGuard";

export function DeviceBridgeStatusBar({
  status,
}: {
  status: DeviceBridgeStatus | null;
}) {
  useRenderGuard("DeviceBridgeStatusBar");

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
