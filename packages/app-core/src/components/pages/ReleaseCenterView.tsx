import { Button, Input } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "../../bridge";
import { useBranding } from "../../config/branding";
import { useApp } from "../../state";
import { openDesktopSurfaceWindow } from "../../utils/desktop-workspace";
import {
  normalizeReleaseNotesUrl,
  summarizeError,
} from "../release-center/shared";
import {
  type AppReleaseStatus,
  type DesktopUpdaterSnapshot,
} from "../release-center/types";

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
    if (!desktopRuntime) return;
    void loadUpdateStatus();
    void refreshNativeState();
  }, [desktopRuntime, loadUpdateStatus, refreshNativeState]);

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

  if (!desktopRuntime) {
    return (
      <p className="text-xs leading-5 text-muted">
        {t("releasecenterview.WebReadOnly", {
          defaultValue:
            "This web session is read-only for release management. Open the app in the desktop shell to check for updates, apply downloaded builds, or manage the detached release notes window.",
        })}
      </p>
    );
  }

  const detachReleaseCenter = async () => {
    await openDesktopSurfaceWindow("release");
  };

  const refreshReleaseState = async () => {
    await Promise.all([loadUpdateStatus(true), refreshNativeState()]);
  };

  const checkForDesktopUpdate = async () => {
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
    await invokeDesktopBridgeRequest<void>({
      rpcMethod: "desktopApplyUpdate",
      ipcChannel: "desktop:applyUpdate",
    });
  };

  const openReleaseNotesWindow = async () => {
    await invokeDesktopBridgeRequest({
      rpcMethod: "desktopOpenReleaseNotesWindow",
      ipcChannel: "desktop:openReleaseNotesWindow",
      params: {
        url: releaseNotesUrl,
        title: t("releasecenterview.ReleaseNotesWindowTitle", {
          defaultValue: "Release Notes",
        }),
      },
    });
  };

  const appStatus = updateStatus as AppReleaseStatus | null | undefined;
  const appVersion = appStatus?.currentVersion ?? "—";
  const desktopVersion = nativeUpdater?.currentVersion ?? "—";
  const channel = nativeUpdater?.channel ?? "—";
  const latestVersion =
    appStatus?.latestVersion ??
    t("releasecenterview.Current", { defaultValue: "Current" });
  const lastCheckAt = appStatus?.lastCheckAt;
  const lastChecked = lastCheckAt
    ? new Date(lastCheckAt).toLocaleString()
    : t("releasecenterview.NotYet", { defaultValue: "Not yet" });
  const updaterStatus = nativeUpdater?.updateReady
    ? t("releasecenterview.UpdateReady", { defaultValue: "Update ready" })
    : nativeUpdater?.updateAvailable
      ? t("releasecenterview.UpdateAvailable", {
          defaultValue: "Update available",
        })
      : t("releasecenterview.Idle", { defaultValue: "Idle" });
  const autoUpdateDisabled =
    nativeUpdater != null && !nativeUpdater.canAutoUpdate;

  const versionRows: Array<{ label: string; value: string }> = [
    { label: t("releasecenterview.App", { defaultValue: "App" }), value: appVersion },
    {
      label: t("releasecenterview.Desktop", { defaultValue: "Desktop" }),
      value: desktopVersion,
    },
    {
      label: t("releasecenterview.Channel", { defaultValue: "Channel" }),
      value: channel,
    },
    {
      label: t("releasecenterview.Latest", { defaultValue: "Latest" }),
      value: latestVersion,
    },
    {
      label: t("releasecenterview.LastChecked", { defaultValue: "Last checked" }),
      value: lastChecked,
    },
    {
      label: t("releasecenterview.Status", { defaultValue: "Status" }),
      value: updaterStatus,
    },
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

      {/* Version info — compact dl */}
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

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-9 rounded-lg px-3 text-xs font-medium"
          disabled={
            busyAction === "check-updates" || updateLoading || autoUpdateDisabled
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
          {t("releasecenterview.CheckDownloadUpdate", {
            defaultValue: "Check / Download Update",
          })}
        </Button>
        {nativeUpdater?.updateReady && (
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
            {t("releasecenterview.ApplyDownloadedUpdate", {
              defaultValue: "Apply Downloaded Update",
            })}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-9 rounded-lg px-3 text-xs font-medium"
          disabled={busyAction === "refresh" || updateLoading}
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
          {t("common.refresh")}
        </Button>
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
          {t("releasecenterview.OpenDetachedReleaseCenter", {
            defaultValue: "Open Detached Release Center",
          })}
        </Button>
      </div>

      {/* Release notes URL */}
      <div className="border-t border-border/40 pt-4">
        <label
          htmlFor="release-notes-url"
          className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted"
        >
          {t("releasecenterview.ReleaseNotes", { defaultValue: "Release Notes" })}
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
                    defaultValue: "Release notes window opened.",
                  }),
                )
              }
            >
              {t("releasecenterview.OpenBrowserViewWindow", {
                defaultValue: "Open BrowserView Window",
              })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-9 rounded-lg px-3 text-xs text-muted-strong"
              onClick={() =>
                void runAction(
                  "reset-release-url",
                  async () => {
                    setReleaseNotesUrlDirty(false);
                    setReleaseNotesUrl(
                      normalizeReleaseNotesUrl(nativeUpdater?.baseUrl),
                    );
                  },
                  t("releasecenterview.ReleaseNotesReset", {
                    defaultValue: "Release notes URL reset.",
                  }),
                )
              }
            >
              {t("releasecenterview.ResetUrl", { defaultValue: "Reset URL" })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
