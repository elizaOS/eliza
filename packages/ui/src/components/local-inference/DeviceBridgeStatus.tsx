/**
 * Single-line status bar for the paired on-device inference bridge (a desktop
 * fronting a phone/tablet runtime): connection dot, capability summary, and the
 * loaded model filename. Renders nothing until a bridge status arrives.
 */

import type { DeviceBridgeStatus } from "@elizaos/contracts";
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

  const primary = status.devices.find(
    (device) => device.deviceId === status.primaryDeviceId,
  );
  const dotClass = status.connected
    ? "bg-status-success"
    : status.pendingRequests > 0
      ? "bg-warning"
      : "bg-muted/40";
  const label = status.connected
    ? primary?.capabilities
      ? t("devicebridge.onlineWithDevice", {
          platform: primary?.capabilities.platform,
          deviceModel: primary?.capabilities.deviceModel,
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
        className={`inline-flex size-2 rounded-full ${dotClass}`}
        aria-hidden
      />
      <span className="flex-1 truncate">{label}</span>
      {primary?.loadedPath && (
        <span className="max-w-[40%] truncate text-muted">
          {primary?.loadedPath.split(/[/\\]/).pop()}
        </span>
      )}
    </div>
  );
}
