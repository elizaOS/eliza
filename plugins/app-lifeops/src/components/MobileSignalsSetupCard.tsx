import {
  Badge,
  Button,
  isElectrobunRuntime,
  isNative,
  useApp,
} from "@elizaos/ui";
import {
  MobileSignals,
  type MobileSignalsPermissionStatus,
  type MobileSignalsSetupAction,
} from "@elizaos/capacitor-mobile-signals";
import {
  Activity,
  Monitor,
  RefreshCw,
  Settings,
  Smartphone,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type TranslateOptions = { defaultValue?: string } & Record<
  string,
  string | number | boolean | null | undefined
>;

type TranslateFn = (key: string, options?: TranslateOptions) => string;

type BusyAction = "refresh" | "request" | `open:${string}` | null;

function actionBadge(
  action: MobileSignalsSetupAction,
  t: TranslateFn,
): { variant: "secondary" | "outline"; label: string } {
  if (action.status === "ready") {
    return {
      variant: "secondary",
      label: t("lifeopssettings.deviceSetupReady", { defaultValue: "Ready" }),
    };
  }
  if (action.status === "unavailable") {
    return {
      variant: "outline",
      label: t("lifeopssettings.deviceSetupUnavailable", {
        defaultValue: "Unavailable",
      }),
    };
  }
  return {
    variant: "outline",
    label: t("lifeopssettings.deviceSetupNeedsAction", {
      defaultValue: "Needs action",
    }),
  };
}

function primaryActionLabel(
  action: MobileSignalsSetupAction,
  t: TranslateFn,
): string {
  if (action.canRequest) {
    return t("lifeopssettings.deviceSetupGrant", { defaultValue: "Grant" });
  }
  return t("lifeopssettings.deviceSetupOpenSettings", {
    defaultValue: "Open Settings",
  });
}

function nonMobileBadgeLabel(t: TranslateFn): string {
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

  const requestPermissions = useCallback(async () => {
    if (!plugin || typeof plugin.requestPermissions !== "function") {
      return;
    }
    setBusy("request");
    try {
      const next = await plugin.requestPermissions();
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
  }, [plugin, t]);

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
  const needsRequest = actions.some(
    (action) => action.status !== "ready" && action.canRequest,
  );
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
            {message ? <p className="text-xs text-muted">{message}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:pt-0.5">
          {nativeMobile && plugin ? (
            <>
              {needsRequest ? (
                <Button
                  type="button"
                  size="sm"
                  className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
                  disabled={busy !== null}
                  onClick={() => void requestPermissions()}
                >
                  <Settings className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("lifeopssettings.deviceSetupEnable", {
                    defaultValue: "Enable",
                  })}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
                disabled={busy !== null}
                onClick={() => void refresh()}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t("lifeopssettings.deviceSetupRefresh", {
                  defaultValue: "Refresh",
                })}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {nativeMobile && actions.length > 0 ? (
        <div className="grid gap-2 border-t border-border/60 px-4 py-3 md:grid-cols-2">
          {actions.map((action: MobileSignalsSetupAction) => {
            const badge = actionBadge(action, t);
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
                    <Badge variant={badge.variant} className="text-3xs">
                      {badge.label}
                    </Badge>
                  </div>
                  {action.reason ? (
                    <p className="text-xs-tight leading-5 text-muted">
                      {action.reason}
                    </p>
                  ) : null}
                </div>
                {canAct ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={action.canRequest ? "default" : "outline"}
                    className="min-h-8 shrink-0 rounded-xl px-2.5 text-2xs font-semibold"
                    disabled={busy !== null}
                    onClick={() =>
                      action.canRequest
                        ? void requestPermissions()
                        : void openSettings(action)
                    }
                  >
                    {primaryActionLabel(action, t)}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
