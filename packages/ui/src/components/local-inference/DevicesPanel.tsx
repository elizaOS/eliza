import type { DeviceBridgeStatus } from "../../api/client-local-inference";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useTranslation } from "../../state/TranslationContext.hooks";

/**
 * Multi-device panel. Lists every connected bridge device (desktop +
 * phone + tablet, etc.) ranked by score. The device ranked first is the
 * "primary" — new generate calls route there by default. Devices that
 * drop offline show up greyed-out until they reconnect.
 */
export function DevicesPanel({
  status,
}: {
  status: DeviceBridgeStatus | null;
}) {
  useRenderGuard("DevicesPanel");
  const { t } = useTranslation();

  if (!status || status.devices.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {t("devicespanel.title", { defaultValue: "Connected bridge devices" })}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t("devicespanel.description", {
          defaultValue:
            "Requests route to the highest-scoring device available. Scoring favours desktops over phones, more RAM, and an available GPU. The primary device is the one ranked first.",
        })}
      </p>
      <div className="flex flex-col gap-2">
        {status.devices.map((device) => (
          <div
            key={device.deviceId}
            className={`rounded-sm border p-3 flex items-center gap-3 text-sm ${
              device.isPrimary
                ? "border-primary/50 bg-primary/5"
                : "border-border bg-card"
            }`}
          >
            <span
              className={`inline-flex h-2 w-2 rounded-full ${
                device.isPrimary ? "bg-emerald-500" : "bg-muted-foreground/60"
              }`}
              aria-hidden
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">
                {device.capabilities.deviceModel}
                {device.isPrimary && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-primary">
                    {t("devicespanel.primary", { defaultValue: "primary" })}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {device.capabilities.platform} ·{" "}
                {device.capabilities.totalRamGb.toFixed(0)} GB RAM ·{" "}
                {device.capabilities.gpu?.available
                  ? `${device.capabilities.gpu.backend}${
                      device.capabilities.gpu.totalVramGb
                        ? ` ${device.capabilities.gpu.totalVramGb.toFixed(1)} GB`
                        : ""
                    }`
                  : t("devicespanel.cpuOnly", { defaultValue: "CPU only" })}
                {device.loadedPath &&
                  t("devicespanel.loaded", {
                    file: device.loadedPath.split(/[/\\]/).pop(),
                    defaultValue: " · loaded: {{file}}",
                  })}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {t("devicespanel.score", {
                score: Math.round(device.score),
                defaultValue: "score {{score}}",
              })}
              {device.activeRequests > 0 &&
                t("devicespanel.active", {
                  count: device.activeRequests,
                  defaultValue: " · {{count}} active",
                })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
