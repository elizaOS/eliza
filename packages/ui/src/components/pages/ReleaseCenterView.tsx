import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "../../bridge";
import { useBranding } from "../../config/branding";
import {
  type ApplicationUpdateSnapshot,
  getApplicationUpdateSnapshot,
  mapAgentUpdateStatusToSnapshot,
} from "../../services/app-updates/update-policy";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import { openDesktopSurfaceWindow } from "../../utils/desktop-workspace";
import {
  normalizeReleaseNotesUrl,
  summarizeError,
} from "../release-center/shared";
import type {
  AppReleaseStatus,
  DesktopUpdaterSnapshot,
} from "../release-center/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function ReleaseCenterView() {
  const { appUrl } = useBranding();
  const defaultReleaseNotesUrl = `${appUrl}/releases/`;
  const desktopRuntime = isElectrobunRuntime();
  const { loadUpdateStatus, t, updateLoading, updateStatus } = useApp();

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [nativeUpdater, setNativeUpdater] =
    useState<DesktopUpdaterSnapshot | null>(null);
  const [applicationUpdate, setApplicationUpdate] =
    useState<ApplicationUpdateSnapshot | null>(null);
  const [releaseNotesUrl, setReleaseNotesUrl] = useState(
    defaultReleaseNotesUrl,
  );
  const [releaseNotesUrlDirty, setReleaseNotesUrlDirty] = useState(false);

  const refreshNativeState = useCallback(async () => {
    if (!desktopRuntime) return;

    const snapshot = await invokeDesktopBridgeRequest<DesktopUpdaterSnapshot>({
      rpcMethod: "desktopGetUpdaterState",
      ipcChannel: "desktop:getUpdaterState",
    }).catch(() => null);

    setNativeUpdater(snapshot);
    setReleaseNotesUrl((current) =>
      releaseNotesUrlDirty
        ? current
        : normalizeReleaseNotesUrl(snapshot?.baseUrl ?? current),
    );
  }, [desktopRuntime, releaseNotesUrlDirty]);

  useEffect(() => {
    void loadUpdateStatus();
  }, [loadUpdateStatus]);

  useEffect(() => {
    void getApplicationUpdateSnapshot({
      desktop: desktopRuntime,
      version: desktopRuntime ? nativeUpdater?.currentVersion : undefined,
    }).then(setApplicationUpdate);
  }, [desktopRuntime, nativeUpdater?.currentVersion]);

  useEffect(() => {
    if (!desktopRuntime) return;
    void refreshNativeState();
  }, [desktopRuntime, refreshNativeState]);

  useEffect(() => {
    if (!desktopRuntime) return;

    const unsubscribers = [
      subscribeDesktopBridgeEvent({
        rpcMessage: "desktopUpdateAvailable",
        ipcChannel: "desktop:updateAvailable",
        listener: () => void refreshNativeState(),
      }),
      subscribeDesktopBridgeEvent({
        rpcMessage: "desktopUpdateReady",
        ipcChannel: "desktop:updateReady",
        listener: () => void refreshNativeState(),
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [desktopRuntime, refreshNativeState]);

  const runAction = useCallback(
    async <T,>(
      id: string,
      action: () => Promise<T>,
      successMessage?: string,
    ): Promise<T | null> => {
      setBusyAction(id);
      setActionError(null);
      setActionMessage(null);
      try {
        const result = await action();
        if (successMessage) setActionMessage(successMessage);
        return result;
      } catch (error) {
        setActionError(summarizeError(error));
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const detachReleaseCenter = async () => {
    if (!desktopRuntime) return;
    await openDesktopSurfaceWindow("release");
  };

  const refreshReleaseState = async () => {
    if (desktopRuntime) {
      await Promise.all([loadUpdateStatus(true), refreshNativeState()]);
      return;
    }
    await loadUpdateStatus(true);
  };

  const checkForDesktopUpdate = async () => {
    if (!desktopRuntime) return;
    const snapshot = await invokeDesktopBridgeRequest<DesktopUpdaterSnapshot>({
      rpcMethod: "desktopCheckForUpdates",
      ipcChannel: "desktop:checkForUpdates",
    });
    setNativeUpdater(snapshot);
    if (!releaseNotesUrlDirty && snapshot?.baseUrl) {
      setReleaseNotesUrl(normalizeReleaseNotesUrl(snapshot.baseUrl));
    }
  };

  const applyDesktopUpdate = async () => {
    if (!desktopRuntime) return;
    await invokeDesktopBridgeRequest<void>({
      rpcMethod: "desktopApplyUpdate",
      ipcChannel: "desktop:applyUpdate",
    });
  };

  const openReleaseNotesWindow = async () => {
    if (!desktopRuntime) {
      await openExternalUrl(releaseNotesUrl);
      return;
    }
    await invokeDesktopBridgeRequest({
      rpcMethod: "desktopOpenReleaseNotesWindow",
      ipcChannel: "desktop:openReleaseNotesWindow",
      params: {
        url: releaseNotesUrl,
        title: t("releasecenterview.ReleaseNotes", {
          defaultValue: "Release Notes",
        }),
      },
    });
  };

  const appStatus = updateStatus as AppReleaseStatus | null | undefined;
  const agentUpdate = mapAgentUpdateStatusToSnapshot(updateStatus ?? null);
  const appVersion =
    applicationUpdate?.version ??
    t("common.unknown", { defaultValue: "Unknown" });
  const desktopVersion = nativeUpdater?.currentVersion ?? "—";
  const channel = nativeUpdater?.channel ?? "—";
  const lastCheckAt = appStatus?.lastCheckAt;
  const lastChecked = lastCheckAt
    ? new Date(lastCheckAt).toLocaleString()
    : t("releasecenter.NotYet", { defaultValue: "Not yet" });
  const updaterStatus = nativeUpdater?.updateReady
    ? t("releasecenterview.UpdateReady", { defaultValue: "Update ready" })
    : nativeUpdater?.updateAvailable
      ? t("releasecenterview.UpdateAvailable", {
          defaultValue: "Update available",
        })
      : t("common.idle", { defaultValue: "Idle" });
  const updaterNeedsAttention = Boolean(
    nativeUpdater?.updateReady || nativeUpdater?.updateAvailable,
  );
  const autoUpdateDisabled =
    nativeUpdater != null && !nativeUpdater.canAutoUpdate;
  const canManualCheck =
    applicationUpdate?.canManualCheck ?? Boolean(desktopRuntime);
  const canAutoUpdate =
    applicationUpdate?.canAutoUpdate ?? Boolean(nativeUpdater?.canAutoUpdate);

  const versionRows: Array<{ label: string; value: ReactNode }> = [
    {
      label: t("releasecenterview.App", { defaultValue: "App" }),
      value: appVersion,
    },
    ...(applicationUpdate?.build
      ? [
          {
            label: t("releasecenterview.Build", { defaultValue: "Build" }),
            value: applicationUpdate.build,
          },
        ]
      : []),
    ...(applicationUpdate
      ? [
          {
            label: t("releasecenterview.Distribution", {
              defaultValue: "Distribution",
            }),
            value: applicationUpdate.statusLabel,
          },
        ]
      : []),
    ...(applicationUpdate
      ? [
          {
            label: t("releasecenterview.AutoUpdates", {
              defaultValue: "Auto updates",
            }),
            value: canAutoUpdate
              ? t("common.enabled", { defaultValue: "Enabled" })
              : t("common.disabled", { defaultValue: "Disabled" }),
          },
        ]
      : []),
    ...(desktopRuntime
      ? [
          {
            label: t("common.desktop", {
              defaultValue: "Desktop",
            }),
            value: desktopVersion,
          },
          {
            label: t("common.channel", {
              defaultValue: "Channel",
            }),
            value: channel,
          },
        ]
      : []),
    {
      label: t("common.status", { defaultValue: "Status" }),
      value: (
        <span className="inline-flex items-center gap-1.5">
          {updaterNeedsAttention ? (
            <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden />
          )}
          {updaterStatus}
        </span>
      ),
    },
    ...(agentUpdate
      ? [
          {
            label: t("releasecenterview.Agent", {
              defaultValue: "Agent",
            }),
            value: agentUpdate.currentVersion,
          },
          {
            label: t("releasecenterview.AgentLatest", {
              defaultValue: "Agent latest",
            }),
            value:
              agentUpdate.latestVersion ??
              t("releasecenterview.Current", { defaultValue: "Current" }),
          },
          {
            label: t("releasecenterview.AgentAuthority", {
              defaultValue: "Agent authority",
            }),
            value: agentUpdate.authorityLabel,
          },
          {
            label: t("releasecenterview.AgentChannel", {
              defaultValue: "Agent channel",
            }),
            value: agentUpdate.channel,
          },
          {
            label: t("releasecenterview.AgentLastChecked", {
              defaultValue: "Agent last checked",
            }),
            value: lastChecked,
          },
          {
            label: t("releasecenterview.AgentStatus", {
              defaultValue: "Agent status",
            }),
            value: (
              <span className="inline-flex items-center gap-1.5">
                {agentUpdate.status === "error" ||
                agentUpdate.status === "update-available" ? (
                  <AlertTriangle
                    className="h-3.5 w-3.5 text-warn"
                    aria-hidden
                  />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden />
                )}
                {agentUpdate.statusLabel}
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      {actionError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {actionError}
        </div>
      )}
      {actionMessage && (
        <div
          role="status"
          className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok"
        >
          {actionMessage}
        </div>
      )}
      {autoUpdateDisabled && nativeUpdater?.autoUpdateDisabledReason && (
        <div
          role="status"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          {nativeUpdater.autoUpdateDisabledReason}
        </div>
      )}
      {applicationUpdate && !desktopRuntime && (
        <div
          role="status"
          className="rounded-lg border border-border/60 bg-bg/40 px-3 py-2 text-xs text-muted"
        >
          {applicationUpdate.detail}
        </div>
      )}
      {agentUpdate && (
        <div
          role="status"
          className="rounded-lg border border-border/60 bg-bg/40 px-3 py-2 text-xs text-muted"
        >
          {agentUpdate.error ?? agentUpdate.detail}
        </div>
      )}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        {versionRows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-3 border-b border-border/30 py-1.5"
          >
            <dt className="text-muted">{row.label}</dt>
            <dd className="break-all text-right font-medium text-txt">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-2">
        {desktopRuntime ? (
          <Button
            size="sm"
            className="h-9 rounded-lg px-3 text-xs font-medium"
            disabled={
              busyAction === "check-updates" ||
              updateLoading ||
              autoUpdateDisabled ||
              !canManualCheck
            }
            onClick={() =>
              void runAction(
                "check-updates",
                checkForDesktopUpdate,
                t("releasecenterview.CheckStarted", {
                  defaultValue: "Desktop update check started.",
                }),
              )
            }
          >
            {t("releasecenter.CheckDownloadUpdate", {
              defaultValue: "Check / Download Update",
            })}
          </Button>
        ) : null}
        {desktopRuntime && nativeUpdater?.updateReady && (
          <Button
            size="sm"
            className="h-9 rounded-lg px-3 text-xs font-medium"
            disabled={busyAction === "apply-update" || autoUpdateDisabled}
            onClick={() =>
              void runAction(
                "apply-update",
                applyDesktopUpdate,
                t("releasecenterview.ApplyStarted", {
                  defaultValue: "Applying downloaded update.",
                }),
              )
            }
          >
            {t("releasecenter.ApplyDownloadedUpdate", {
              defaultValue: "Apply Downloaded Update",
            })}
          </Button>
        )}
        <Button
          size="icon"
          variant="outline"
          className="h-9 w-9 rounded-lg"
          disabled={busyAction === "refresh" || updateLoading}
          aria-label={t("common.refresh")}
          title={t("common.refresh")}
          onClick={() =>
            void runAction(
              "refresh",
              refreshReleaseState,
              t("releasecenterview.ReleaseStatusRefreshed", {
                defaultValue: "Release status refreshed.",
              }),
            )
          }
        >
          <RefreshCw
            className={`h-4 w-4 ${busyAction === "refresh" || updateLoading ? "animate-spin" : ""}`}
            aria-hidden
          />
        </Button>
        {desktopRuntime ? (
          <Button
            size="sm"
            variant="outline"
            className="h-9 rounded-lg px-3 text-xs font-medium"
            disabled={busyAction === "detach-release"}
            onClick={() =>
              void runAction(
                "detach-release",
                detachReleaseCenter,
                t("releasecenterview.DetachedOpened", {
                  defaultValue: "Detached release center opened.",
                }),
              )
            }
          >
            {t("releasecenter.OpenDetachedReleaseCenter", {
              defaultValue: "Open Detached Release Center",
            })}
          </Button>
        ) : null}
      </div>

      <div className="border-t border-border/40 pt-4">
        <label
          htmlFor="release-notes-url"
          className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted"
        >
          {t("releasecenterview.ReleaseNotes", {
            defaultValue: "Release Notes",
          })}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="release-notes-url"
            type="text"
            className="h-9 flex-1 rounded-lg bg-bg text-xs"
            value={releaseNotesUrl}
            onChange={(e) => {
              setReleaseNotesUrlDirty(true);
              setReleaseNotesUrl(e.target.value);
            }}
          />
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              size="sm"
              variant="outline"
              className="h-9 rounded-lg px-3 text-xs font-medium"
              disabled={busyAction === "open-release-notes"}
              onClick={() =>
                void runAction(
                  "open-release-notes",
                  openReleaseNotesWindow,
                  t("releasecenterview.ReleaseNotesOpened", {
                    defaultValue: "Release notes opened.",
                  }),
                )
              }
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t("common.open", { defaultValue: "Open" })}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 rounded-lg text-muted-strong"
              aria-label={t("releasecenter.ResetUrl", {
                defaultValue: "Reset URL",
              })}
              title={t("releasecenter.ResetUrl", {
                defaultValue: "Reset URL",
              })}
              onClick={() =>
                void runAction(
                  "reset-release-url",
                  async () => {
                    setReleaseNotesUrlDirty(false);
                    setReleaseNotesUrl(
                      normalizeReleaseNotesUrl(
                        nativeUpdater?.baseUrl ?? defaultReleaseNotesUrl,
                      ),
                    );
                  },
                  t("releasecenterview.ReleaseNotesReset", {
                    defaultValue: "Release notes URL reset.",
                  }),
                )
              }
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
