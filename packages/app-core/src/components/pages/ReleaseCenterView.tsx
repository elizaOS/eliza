import { useCallback, useEffect, useRef, useState } from "react";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "../../bridge";
import { useApp } from "../../state";
import { openDesktopSurfaceWindow } from "../../utils/desktop-workspace";
import {
  normalizeReleaseNotesUrl,
  summarizeError,
} from "../release-center/shared";
import {
  type AppReleaseStatus,
  type DesktopBuildInfo,
  type DesktopReleaseNotesWindowInfo,
  type DesktopSessionSnapshot,
  type DesktopUpdaterSnapshot,
  RELEASE_NOTES_PARTITION,
  SESSION_PARTITIONS,
  type WebGpuBrowserStatus,
  type WgpuTagElement,
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
  const [_buildInfo, setBuildInfo] = useState<DesktopBuildInfo | null>(null);
  const [_dockVisible, _setDockVisible] = useState<boolean>(true);
  const [_sessionSnapshots, setSessionSnapshots] = useState<
    Record<string, DesktopSessionSnapshot | undefined>
  >({});
  const [_webGpuStatus, setWebGpuStatus] = useState<WebGpuBrowserStatus | null>(
    null,
  );
  const [_releaseNotesWindow, setReleaseNotesWindow] =
    useState<DesktopReleaseNotesWindowInfo | null>(null);
  const [releaseNotesUrl, setReleaseNotesUrl] = useState(
    defaultReleaseNotesUrl,
  );
  const [releaseNotesUrlDirty, setReleaseNotesUrlDirty] = useState(false);
  const [wgpuTagAvailable, setWgpuTagAvailable] = useState(false);
  const [_wgpuReady, setWgpuReady] = useState(false);
  const [_wgpuTransparent, _setWgpuTransparent] = useState(false);
  const [_wgpuPassthrough, _setWgpuPassthrough] = useState(false);
  const [_wgpuHidden, _setWgpuHidden] = useState(false);
  const wgpuRef = useRef<WgpuTagElement | null>(null);

  const refreshNativeState = useCallback(async () => {
    if (!desktopRuntime) {
      return;
    }

    const [
      updaterResult,
      buildResult,
      dockResult,
      gpuStatusResult,
      ...sessionResults
    ] = await Promise.allSettled([
      invokeDesktopBridgeRequest<DesktopUpdaterSnapshot>({
        rpcMethod: "desktopGetUpdaterState",
        ipcChannel: "desktop:getUpdaterState",
      }),
      invokeDesktopBridgeRequest<DesktopBuildInfo>({
        rpcMethod: "desktopGetBuildInfo",
        ipcChannel: "desktop:getBuildInfo",
      }),
      invokeDesktopBridgeRequest<{ visible: boolean }>({
        rpcMethod: "desktopGetDockIconVisibility",
        ipcChannel: "desktop:getDockIconVisibility",
      }),
      invokeDesktopBridgeRequest<WebGpuBrowserStatus>({
        rpcMethod: "desktopGetWebGpuBrowserStatus",
        ipcChannel: "desktop:getWebGpuBrowserStatus",
      }),
      ...SESSION_PARTITIONS.map(({ partition }) =>
        invokeDesktopBridgeRequest<DesktopSessionSnapshot>({
          rpcMethod: "desktopGetSessionSnapshot",
          ipcChannel: "desktop:getSessionSnapshot",
          params: { partition },
        }),
      ),
    ]);

    const updater =
      updaterResult.status === "fulfilled" ? updaterResult.value : null;
    const build = buildResult.status === "fulfilled" ? buildResult.value : null;
    const dock = dockResult.status === "fulfilled" ? dockResult.value : null;
    const gpuStatus =
      gpuStatusResult.status === "fulfilled" ? gpuStatusResult.value : null;

    setNativeUpdater(updater);
    setBuildInfo(build);
    _setDockVisible(dock?.visible ?? true);
    setWebGpuStatus(gpuStatus);
    setSessionSnapshots(
      Object.fromEntries(
        SESSION_PARTITIONS.map((entry, index) => [
          entry.partition,
          sessionResults[index]?.status === "fulfilled"
            ? (sessionResults[index].value ?? undefined)
            : undefined,
        ]),
      ),
    );
    setReleaseNotesUrl((current) =>
      releaseNotesUrlDirty
        ? current
        : normalizeReleaseNotesUrl(updater?.baseUrl ?? current),
    );

    if (
      updaterResult.status === "rejected" ||
      buildResult.status === "rejected" ||
      dockResult.status === "rejected" ||
      gpuStatusResult.status === "rejected" ||
      sessionResults.some((result) => result.status === "rejected")
    ) {
      console.warn(
        "[ReleaseCenter] One or more desktop runtime requests failed during refresh.",
      );
    }
  }, [desktopRuntime, releaseNotesUrlDirty]);

  useEffect(() => {
    if (!desktopRuntime) {
      return;
    }

    void loadUpdateStatus();
    void refreshNativeState();
  }, [desktopRuntime, loadUpdateStatus, refreshNativeState]);

  useEffect(() => {
    setWgpuTagAvailable(
      typeof window !== "undefined" &&
        Boolean(window.customElements.get("electrobun-wgpu")),
    );
  }, []);

  useEffect(() => {
    const element = wgpuRef.current;
    if (!desktopRuntime || !wgpuTagAvailable || !element) {
      return;
    }

    const onReady = () => {
      setWgpuReady(true);
    };

    element.on?.("ready", onReady);
    return () => {
      element.off?.("ready", onReady);
    };
  }, [desktopRuntime, wgpuTagAvailable]);

  useEffect(() => {
    if (!desktopRuntime) {
      return;
    }

    const unsubscribers = [
      subscribeDesktopBridgeEvent({
        rpcMessage: "desktopUpdateAvailable",
        ipcChannel: "desktop:updateAvailable",
        listener: () => {
          void refreshNativeState();
        },
      }),
      subscribeDesktopBridgeEvent({
        rpcMessage: "desktopUpdateReady",
        ipcChannel: "desktop:updateReady",
        listener: () => {
          void refreshNativeState();
        },
      }),
      subscribeDesktopBridgeEvent({
        rpcMessage: "webGpuBrowserStatus",
        ipcChannel: "webgpu:browserStatus",
        listener: (payload) => {
          setWebGpuStatus(payload as WebGpuBrowserStatus);
        },
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
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
        if (successMessage) {
          setActionMessage(successMessage);
        }
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
      <section
        className={`rounded-2xl border border-border/50 bg-card/92 shadow-sm space-y-3 p-4`}
      >
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-txt">
            {t("releasecenterview.ReleaseCenter", {
              defaultValue: "Release Center",
            })}
          </h2>
        </div>
        <div className="rounded-xl border border-border/40 bg-bg-hover/60 px-3 py-3 text-xs leading-5 text-muted">
          {t("releasecenterview.WebReadOnly", {
            defaultValue:
              "This web session is read-only for release management. Open the app in the desktop shell to check for updates, apply downloaded builds, or manage the detached release notes window.",
          })}
        </div>
      </section>
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
    const info =
      await invokeDesktopBridgeRequest<DesktopReleaseNotesWindowInfo>({
        rpcMethod: "desktopOpenReleaseNotesWindow",
        ipcChannel: "desktop:openReleaseNotesWindow",
        params: {
          url: releaseNotesUrl,
          title: t("releasecenterview.ReleaseNotesWindowTitle", {
            defaultValue: "Release Notes",
          }),
        },
      });
    setReleaseNotesWindow(info);
    const refreshedSession =
      await invokeDesktopBridgeRequest<DesktopSessionSnapshot>({
        rpcMethod: "desktopGetSessionSnapshot",
        ipcChannel: "desktop:getSessionSnapshot",
        params: { partition: RELEASE_NOTES_PARTITION },
      });
    if (refreshedSession) {
      setSessionSnapshots((current) => ({
        ...current,
        [RELEASE_NOTES_PARTITION]: refreshedSession,
      }));
    }
  };

  const appVersion =
    (updateStatus as AppReleaseStatus | null | undefined)?.currentVersion ??
    "—";
  const desktopVersion = nativeUpdater?.currentVersion ?? "—";
  const channel = nativeUpdater?.channel ?? "—";
  const latestVersion =
    (updateStatus as AppReleaseStatus | null | undefined)?.latestVersion ??
    t("releasecenterview.Current", { defaultValue: "Current" });
  const lastCheckAt = (updateStatus as AppReleaseStatus | null | undefined)
    ?.lastCheckAt;
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

  return (
    <div className="space-y-4">
      {actionError ? (
        <div
          role="alert"
          className={`rounded-xl border px-3 py-2 text-xs shadow-sm border-destructive/40 bg-destructive/10 text-destructive`}
        >
          {actionError}
        </div>
      ) : null}
      {actionMessage ? (
        <div
          role="status"
          className={`rounded-xl border px-3 py-2 text-xs shadow-sm border-ok/30 bg-ok/10 text-ok`}
        >
          {actionMessage}
        </div>
      ) : null}

      {/* ── Version info rows ─────────────────────────────────── */}
      <div
        className={`rounded-2xl border border-border/50 bg-card/92 shadow-sm grid gap-2 p-4 text-xs sm:grid-cols-2`}
      >
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border/40 bg-bg-hover/70 px-3 py-2">
          <span className="text-muted">
            {t("releasecenterview.App", { defaultValue: "App" })}
          </span>
          <span className="break-all text-right font-semibold text-txt">
            {appVersion}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border/40 bg-bg-hover/70 px-3 py-2">
          <span className="text-muted">
            {t("releasecenterview.Desktop", { defaultValue: "Desktop" })}
          </span>
          <span className="break-all text-right font-semibold text-txt">
            {desktopVersion}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border/40 bg-bg-hover/70 px-3 py-2">
          <span className="text-muted">
            {t("releasecenterview.Channel", { defaultValue: "Channel" })}
          </span>
          <span className="break-all text-right font-semibold text-txt">
            {channel}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border/40 bg-bg-hover/70 px-3 py-2">
          <span className="text-muted">
            {t("releasecenterview.Latest", { defaultValue: "Latest" })}
          </span>
          <span className="break-all text-right font-semibold text-txt">
            {latestVersion}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border/40 bg-bg-hover/70 px-3 py-2">
          <span className="text-muted">
            {t("releasecenterview.LastChecked", {
              defaultValue: "Last checked",
            })}
          </span>
          <span className="break-all text-right font-semibold text-txt">
            {lastChecked}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border/40 bg-bg-hover/70 px-3 py-2">
          <span className="text-muted">
            {t("releasecenterview.Status", { defaultValue: "Status" })}
          </span>
          <span className="break-all text-right font-semibold text-txt">
            {updaterStatus}
          </span>
        </div>
      </div>

      {autoUpdateDisabled && nativeUpdater?.autoUpdateDisabledReason ? (
        <div
          role="status"
          className={`rounded-xl border px-3 py-2 text-xs shadow-sm border-warning/40 bg-warning/10 text-warning`}
        >
          {nativeUpdater.autoUpdateDisabledReason}
        </div>
      ) : null}

      {/* ── Actions ───────────────────────────────────────────── */}
      <section
        className={`rounded-2xl border border-border/50 bg-card/92 shadow-sm space-y-3 p-4`}
      >
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-txt">
            {t("releasecenterview.UpdateActions", {
              defaultValue: "Update Actions",
            })}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="min-h-10 rounded-xl px-3 text-xs font-medium"
            disabled={
              busyAction === "check-updates" ||
              updateLoading ||
              autoUpdateDisabled
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
              className="min-h-10 rounded-xl px-3 text-xs font-medium"
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
            className="min-h-10 rounded-xl px-3 text-xs font-medium"
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
            className="min-h-10 rounded-xl px-3 text-xs font-medium"
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
      </section>

      {/* ── Release Notes ─────────────────────────────────────── */}
      <section
        className={`rounded-2xl border border-border/50 bg-card/92 shadow-sm space-y-3 p-4`}
      >
        <div className="space-y-1">
          <span className="text-sm font-semibold text-txt">
            {t("releasecenterview.ReleaseNotes", {
              defaultValue: "Release Notes",
            })}
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="text"
            className="min-h-10 flex-1 rounded-xl border-border/50 bg-bg/80 text-xs"
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
              className="min-h-10 rounded-xl px-3 text-xs font-medium"
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
              className="min-h-10 rounded-xl px-3 text-xs font-medium text-muted-strong"
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
              {t("releasecenterview.ResetUrl", {
                defaultValue: "Reset URL",
              })}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

import { Button, Input } from "@elizaos/ui";
import { useBranding } from "../../config/branding";
