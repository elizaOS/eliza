/**
 * Single-line status bar for the paired on-device inference bridge (a desktop
 * fronting a phone/tablet runtime): connection dot, capability summary, and the
 * loaded model filename. Renders nothing until a bridge status arrives.
 */

import type { DeviceBridgeStatus } from "../../api/client-local-inference";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useTranslation } from "../../state/TranslationContext.hooks";

export function DeviceBridgeStatusBar({
  status,
}: {
  status: DeviceBridgeStatus | null;
}) {
  useRenderGuard("DeviceBridgeStatusBar");
  const { t } = useTranslation();

  if (!status) return null;

  const dotClass = status.connected
    ? "bg-emerald-500"
    : status.pendingRequests > 0
      ? "bg-amber-500"
      : "bg-muted-foreground/40";
  const label = status.connected
    ? status.capabilities
      ? t("devicebridge.onlineWithDevice", {
          platform: status.capabilities.platform,
          deviceModel: status.capabilities.deviceModel,
          defaultValue: "Paired device online · {{platform}} · {{deviceModel}}",
        })
      : t("devicebridge.online", { defaultValue: "Paired device online" })
    : status.pendingRequests > 0
      ? t("devicebridge.offlinePending", {
          count: status.pendingRequests,
          defaultValue:
            "Device offline · {{count}} request(s) paused pending reconnect",
        })
      : t("devicebridge.noDevice", { defaultValue: "No paired device" });

  return (
    <div
      className="flex items-center gap-2 rounded-sm border border-border bg-card/60 px-2 py-1.5 text-xs"
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
