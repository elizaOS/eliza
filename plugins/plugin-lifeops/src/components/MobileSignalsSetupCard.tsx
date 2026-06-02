import {
  MobileSignals,
  type MobileSignalsPermissionStatus,
  type MobileSignalsPermissionTarget,
  type MobileSignalsSetupAction,
} from "@elizaos/capacitor-mobile-signals";
import {
  mobileSignalPermissionTargetForAction,
  mobileSignalSetupActionBadge,
  mobileSignalSetupPrimaryActionLabel,
} from "@elizaos/plugin-health/screen-time/mobile-signal-setup";
import {
  Button,
  isElectrobunRuntime,
  isNative,
  useApp,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Activity, Check, Monitor, RefreshCw, Settings, Smartphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

function DeviceSetupRefreshButton({
  disabled,
  label,
  onRefresh,
}: {
  disabled: boolean;
  label: string;
  onRefresh: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "settings-device-refresh",
    role: "button",
    label,
    group: "lifeops-device-setup",
    description: "Refresh device data permission status",
  });
  return (
    <Button
      ref={ref}
      type="button"
      size="sm"
      variant="outline"
      className="h-9 w-9 rounded-xl p-0"
      disabled={disabled}
      onClick={onRefresh}
      {...agentProps}
    >
      <RefreshCw className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">{label}</span>
    </Button>
  );
}

function DeviceSetupActionButton({
  action,
  disabled,
  label,
  onAct,
}: {
  action: MobileSignalsSetupAction;
  disabled: boolean;
  label: string;
  onAct: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `settings-device-action-${action.id}`,
    role: "button",
    label: `${label}: ${action.label}`,
    group: "lifeops-device-setup",
    description: `${label} for ${action.label}`,
  });
  return (
    <Button
      ref={ref}
      type="button"
      size="sm"
      variant={action.canRequest ? "default" : "outline"}
      className="h-8 w-8 shrink-0 rounded-xl p-0"
      disabled={disabled}
      onClick={onAct}
      {...agentProps}
    >
      {action.canRequest ? (
        <Check className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Settings className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className="sr-only">{label}</span>
    </Button>
  );
}

type BusyAction = "refresh" | "request" | `open:${string}` | null;

function nonMobileBadgeLabel(
  t: (key: string, options?: { defaultValue?: string }) => string,
): string {
  return isElectrobunRuntime()
    ? t("lifeopssettings.deviceSetupDesktop", {
        defaultValue: "Desktop",
      })
    : t("lifeopssettings.deviceSetupWeb", {
        defaultValue: "Web",
      });
}

function DeviceRuntimeGlyph({
  label,
  nativeMobile,
  ready,
}: {
  label: string;
  nativeMobile: boolean;
  ready: boolean;
}) {
  const Icon = nativeMobile ? Smartphone : Monitor;
  const tone = ready
    ? "border-emerald-500/30 bg-emerald-500/12 text-emerald-500"
    : "border-border/50 bg-bg/40 text-muted";
  return (
    <span
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full border ${tone}`}
      role="img"
      title={label}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

function DeviceSetupMessagePip({ message }: { message: string }) {
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/40 bg-bg/35 text-muted"
      role="status"
      aria-label={message}
      title={message}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      <span className="sr-only">{message}</span>
    </span>
  );
}

function DeviceActionStatusPip({
  label,
  ready,
}: {
  label: string;
  ready: boolean;
}) {
  return (
    <span
      className={[
        "inline-flex h-5 w-5 items-center justify-center rounded-full border",
        ready
          ? "border-emerald-500/30 bg-emerald-500/12 text-emerald-500"
          : "border-border/40 bg-bg/35 text-muted",
      ].join(" ")}
      aria-label={label}
      title={label}
    >
      {ready ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      )}
    </span>
  );
}

export function MobileSignalsSetupCard() {
  const { t } = useApp();
  const nativeMobile = isNative && !isElectrobunRuntime();
  const [permissionStatus, setPermissionStatus] =
    useState<MobileSignalsPermissionStatus | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<string | null>(null);

  const plugin = useMemo(() => {
    if (!nativeMobile) {
      return null;
    }
    try {
      return MobileSignals;
    } catch {
      return null;
    }
  }, [nativeMobile]);

  const refresh = useCallback(async () => {
    if (!plugin || typeof plugin.checkPermissions !== "function") {
      return;
    }
    setBusy("refresh");
    try {
      setPermissionStatus(await plugin.checkPermissions());
      setMessage(null);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : t("lifeopssettings.deviceSetupRefreshFailed", {
              defaultValue: "Failed to refresh device setup.",
            }),
      );
    } finally {
      setBusy(null);
    }
  }, [plugin, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requestPermissions = useCallback(
    async (action: MobileSignalsSetupAction) => {
      if (!plugin || typeof plugin.requestPermissions !== "function") {
        return;
      }
      const target = mobileSignalPermissionTargetForAction(
        action,
      ) as MobileSignalsPermissionTarget | null;
      if (!target) {
        return;
      }
      setBusy("request");
      try {
        const next = await plugin.requestPermissions({ target });
        setPermissionStatus(next);
        setMessage(next.reason ?? null);
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : t("lifeopssettings.deviceSetupRequestFailed", {
                defaultValue: "Failed to request device permissions.",
              }),
        );
      } finally {
        setBusy(null);
      }
    },
    [plugin, t],
  );

  const openSettings = useCallback(
    async (action: MobileSignalsSetupAction) => {
      if (
        !plugin ||
        !action.settingsTarget ||
        typeof plugin.openSettings !== "function"
      ) {
        return;
      }
      setBusy(`open:${action.id}`);
      try {
        const result = await plugin.openSettings({
          target: action.settingsTarget,
        });
        setMessage(result.reason ?? null);
        window.setTimeout(() => {
          void refresh();
        }, 1_500);
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : t("lifeopssettings.deviceSetupOpenFailed", {
                defaultValue: "Failed to open device settings.",
              }),
        );
      } finally {
        setBusy(null);
      }
    },
    [plugin, refresh, t],
  );

  const actions: MobileSignalsSetupAction[] =
    permissionStatus?.setupActions ?? [];
  const runtimeLabel = nativeMobile
    ? (permissionStatus?.status ?? "checking")
    : nonMobileBadgeLabel(t);
  const runtimeReady = nativeMobile
    ? permissionStatus?.status === "granted"
    : true;

  return (
    <div className="rounded-2xl border border-border/40 bg-card/62 shadow-sm">
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/40 bg-bg/36">
            <Activity className="h-5 w-5 text-txt" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-bold text-sm text-txt">
                {t("lifeopssettings.deviceSetupTitle", {
                  defaultValue: "Device Data",
                })}
              </div>
              <DeviceRuntimeGlyph
                label={runtimeLabel}
                nativeMobile={nativeMobile}
                ready={runtimeReady}
              />
            </div>
            {message ? <DeviceSetupMessagePip message={message} /> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:pt-0.5">
          {nativeMobile && plugin ? (
            <DeviceSetupRefreshButton
              disabled={busy !== null}
              label={t("lifeopssettings.deviceSetupRefresh", {
                defaultValue: "Refresh",
              })}
              onRefresh={() => void refresh()}
            />
          ) : null}
        </div>
      </div>

      {nativeMobile && actions.length > 0 ? (
        <div className="grid gap-2 border-t border-border/60 px-4 py-3 md:grid-cols-2">
          {actions.map((action: MobileSignalsSetupAction) => {
            const badge = mobileSignalSetupActionBadge(action, t);
            const canAct =
              action.status !== "ready" &&
              (action.canRequest ||
                (action.canOpenSettings && action.settingsTarget !== null));
            return (
              <div
                key={action.id}
                className="flex min-w-0 items-start justify-between gap-3 rounded-xl border border-border/50 bg-bg/30 px-3 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-xs font-semibold text-txt">
                      {action.label}
                    </div>
                    <DeviceActionStatusPip
                      label={badge.label}
                      ready={action.status === "ready"}
                    />
                  </div>
                  {action.reason ? (
                    <span className="sr-only">{action.reason}</span>
                  ) : null}
                </div>
                {canAct ? (
                  <DeviceSetupActionButton
                    action={action}
                    disabled={busy !== null}
                    label={mobileSignalSetupPrimaryActionLabel(action, t)}
                    onAct={() =>
                      action.canRequest
                        ? void requestPermissions(action)
                        : void openSettings(action)
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
