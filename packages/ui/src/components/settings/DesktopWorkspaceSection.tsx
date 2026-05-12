import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { ContentLayout } from "../../layouts/content-layout/content-layout";
import { Textarea } from "../ui/textarea";
import { Monitor, RefreshCw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { fetchWithCsrf } from "../../api/csrf-client";
import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../../bridge";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useApp } from "../../state";
import { resolveApiUrl } from "../../utils/asset-url";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  DESKTOP_WORKSPACE_SURFACES,
  type DesktopWorkspaceSnapshot,
  loadDesktopWorkspaceSnapshot,
  openDesktopSettingsWindow,
  openDesktopSurfaceWindow,
} from "../../utils/desktop-workspace";
import {
  DesktopWorkspaceDisplay,
  useDesktopDiagnosticsText,
} from "./DesktopWorkspaceDisplay";
import { useDesktopWindowControls } from "./useDesktopWindowControls";

export { DESKTOP_WORKSPACE_CLICK_AUDIT } from "./desktop-workspace-audit-config";

function buildDesktopDiagnosticsBundle(options: {
  diagnosticsText: string;
  devStackText: string;
  devConsoleText: string;
}): string {
  return [
    "Desktop Diagnostics",
    "",
    "== Runtime Snapshot ==",
    options.diagnosticsText.trim(),
    "",
    "== Desktop Dev Stack ==",
    options.devStackText.trim(),
    "",
    "== Desktop Console Log ==",
    options.devConsoleText.trim(),
  ].join("\n");
}

function renderPathList(
  paths: string[],
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (paths.length === 0) {
    return (
      <span className="text-muted-strong">
        {t("desktopworkspacesection.NoPathSelectedYet")}
      </span>
    );
  }

  return (
    <ul className="space-y-1 text-xs text-txt">
      {paths.map((path) => (
        <li key={path} className="break-all">
          {path}
        </li>
      ))}
    </ul>
  );
}

export function DesktopWorkspaceSection({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  useRenderGuard("DesktopWorkspaceSection");
  const desktopRuntime = isElectrobunRuntime();
  const { relaunchDesktop, restartBackend, t } = useApp();
  const [snapshot, setSnapshot] = useState<DesktopWorkspaceSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(desktopRuntime);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [clipboardDraft, setClipboardDraft] = useState("");
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [savePaths, setSavePaths] = useState<string[]>([]);
  const [devStackText, setDevStackText] = useState(
    "Loading desktop dev stack…",
  );
  const [devConsoleText, setDevConsoleText] = useState(
    "Loading desktop console log…",
  );
  const [devConsoleFilter, setDevConsoleFilter] = useState("");
  const getSurfaceLabel = useCallback(
    (surfaceId: (typeof DESKTOP_WORKSPACE_SURFACES)[number]["id"]) =>
      t(`desktopworkspacesection.surface.${surfaceId}.label`),
    [t],
  );
  const windowControls = useDesktopWindowControls(snapshot, t);

  const refreshSnapshot = useCallback(async () => {
    if (!desktopRuntime) {
      setSnapshot(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setActionError(null);
    const nextSnapshot = await loadDesktopWorkspaceSnapshot();
    setSnapshot(nextSnapshot);
    setClipboardDraft(
      (current) => current || nextSnapshot.clipboard?.text || "",
    );
    setLoading(false);
  }, [desktopRuntime]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  const refreshDevDiagnostics = useCallback(async () => {
    if (!desktopRuntime || typeof fetch !== "function") {
      setDevStackText("Desktop dev stack unavailable.");
      setDevConsoleText("Desktop console log unavailable.");
      return;
    }

    try {
      const [stackResponse, consoleResponse] = await Promise.all([
        fetchWithCsrf(resolveApiUrl("/api/dev/stack"), {
          headers: { Accept: "application/json" },
        }),
        fetchWithCsrf(
          resolveApiUrl("/api/dev/console-log?maxLines=250&maxBytes=200000"),
          {
            headers: { Accept: "text/plain" },
          },
        ),
      ]);

      if (stackResponse.ok) {
        const stackJson = (await stackResponse.json()) as unknown;
        setDevStackText(JSON.stringify(stackJson, null, 2));
      } else {
        setDevStackText(`GET /api/dev/stack → ${stackResponse.status}`);
      }

      if (consoleResponse.ok) {
        const consoleText = await consoleResponse.text();
        setDevConsoleText(
          consoleText.trim() || "Desktop console log is currently empty.",
        );
      } else {
        setDevConsoleText(
          `GET /api/dev/console-log → ${consoleResponse.status}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDevStackText(`Desktop dev stack error: ${message}`);
      setDevConsoleText(`Desktop console log error: ${message}`);
    }
  }, [desktopRuntime]);

  useEffect(() => {
    void refreshDevDiagnostics();
    if (!desktopRuntime) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshDevDiagnostics();
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [desktopRuntime, refreshDevDiagnostics]);

  const runAction = useCallback(
    async (
      id: string,
      action: () => Promise<void>,
      message?: string,
      refresh = true,
    ) => {
      setBusyAction(id);
      setActionError(null);
      setActionMessage(null);
      try {
        await action();
        if (refresh) {
          await refreshSnapshot();
        }
        if (message) {
          setActionMessage(message);
        }
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : t("desktopworkspacesection.DesktopActionFailed"),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [refreshSnapshot, t],
  );

  const diagnosticsText = useDesktopDiagnosticsText(snapshot, t);

  const devConsoleLines = useMemo(
    () =>
      devConsoleText
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0),
    [devConsoleText],
  );

  const filteredDevConsoleLines = useMemo(() => {
    const needle = devConsoleFilter.trim().toLowerCase();
    if (!needle) {
      return devConsoleLines;
    }
    return devConsoleLines.filter((line) =>
      line.toLowerCase().includes(needle),
    );
  }, [devConsoleFilter, devConsoleLines]);

  const filteredDevConsoleText = useMemo(
    () => filteredDevConsoleLines.join("\n"),
    [filteredDevConsoleLines],
  );

  const devConsoleSummary = useMemo(() => {
    const summarize = (matcher: (line: string) => boolean) =>
      devConsoleLines.filter(matcher).length;
    return {
      total: devConsoleLines.length,
      errors: summarize((line) => /\b(error|failed|fatal)\b/i.test(line)),
      warnings: summarize((line) => /\bwarn\b/i.test(line)),
      rpc: summarize((line) => line.includes("[Renderer:rpc]")),
      fetch: summarize((line) => line.includes("[Renderer:fetch]")),
      talkmode: summarize((line) => /talkmode/i.test(line)),
    };
  }, [devConsoleLines]);

  const copyDesktopDiagnosticsBundle = useCallback(async () => {
    await copyTextToClipboard(
      buildDesktopDiagnosticsBundle({
        diagnosticsText,
        devStackText,
        devConsoleText,
      }),
    );
    setActionMessage("Copied desktop diagnostics bundle.");
    setActionError(null);
  }, [diagnosticsText, devConsoleText, devStackText]);

  if (!desktopRuntime) {
    return (
      <ContentLayout contentHeader={contentHeader}>
        <Card className="text-sm text-muted">
          <CardContent className="pt-6">
            {t("desktopworkspacesection.DesktopToolsOnlyAvailable")}
          </CardContent>
        </Card>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout contentHeader={contentHeader} contentClassName="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Button
          variant="outline"
          size="sm"
          className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
          onClick={() => {
            void refreshSnapshot();
            void refreshDevDiagnostics();
          }}
          disabled={loading}
        >
          <RefreshCw
            className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          {t("desktopworkspacesection.RefreshDiagnostics")}
        </Button>
        <Button
          variant="default"
          size="sm"
          className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
          onClick={() =>
            void runAction(
              "desktop-open-settings-window",
              async () => openDesktopSettingsWindow("desktop"),
              t("desktopworkspacesection.OpenedDetachedDesktopSettingsWindow"),
              false,
            )
          }
          disabled={busyAction === "desktop-open-settings-window"}
        >
          <Monitor className="mr-1 h-3.5 w-3.5" />
          {t("desktopworkspacesection.OpenDesktopSettingsWindow")}
        </Button>
      </div>

      {(actionError || actionMessage) && (
        <div
          className={`rounded-xl border px-3 py-2 text-sm ${
            actionError
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-ok/40 bg-ok/10 text-ok"
          }`}
          role={actionError ? "alert" : "status"}
        >
          {actionError ?? actionMessage}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <DesktopWorkspaceDisplay diagnosticsText={diagnosticsText} t={t} />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Desktop Dev Stack</CardTitle>
            <CardDescription>
              Live `/api/dev/stack` snapshot for the current desktop session.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() => void refreshDevDiagnostics()}
              >
                Refresh Desktop Logs
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() => void copyTextToClipboard(devStackText)}
              >
                Copy Dev Stack
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() => void copyDesktopDiagnosticsBundle()}
              >
                Copy Full Diagnostics Bundle
              </Button>
            </div>
            <pre className="max-h-72 overflow-auto break-all rounded-xl border border-border bg-bg px-3 py-3 text-xs-tight leading-5 text-txt">
              {devStackText}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {t("desktopworkspacesection.DetachedSurfaces")}
            </CardTitle>
            <CardDescription>
              {t("desktopworkspacesection.DetachedSurfacesDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2">
              {DESKTOP_WORKSPACE_SURFACES.map((surface) => (
                <Button
                  key={surface.id}
                  variant="outline"
                  size="sm"
                  className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                  onClick={() =>
                    void runAction(
                      `desktop-surface-${surface.id}`,
                      async () => openDesktopSurfaceWindow(surface.id),
                      t("desktopworkspacesection.SurfaceOpened", {
                        surface: getSurfaceLabel(surface.id),
                      }),
                      false,
                    )
                  }
                  disabled={busyAction === `desktop-surface-${surface.id}`}
                >
                  {getSurfaceLabel(surface.id)}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Desktop Console Log</CardTitle>
          <CardDescription>
            Live tail of `.eliza/desktop-dev-console.log`, including renderer
            console, network failures, RPC failures, and Electrobun/main logs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
              onClick={() => void refreshDevDiagnostics()}
            >
              Refresh Console Tail
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
              onClick={() =>
                void copyTextToClipboard(
                  filteredDevConsoleText || devConsoleText,
                )
              }
            >
              Copy Visible Console Tail
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted">
            <span>Total: {devConsoleSummary.total}</span>
            <span>Errors: {devConsoleSummary.errors}</span>
            <span>Warnings: {devConsoleSummary.warnings}</span>
            <span>RPC: {devConsoleSummary.rpc}</span>
            <span>Fetch: {devConsoleSummary.fetch}</span>
            <span>TalkMode: {devConsoleSummary.talkmode}</span>
          </div>
          <Textarea
            value={devConsoleFilter}
            onChange={(event) => setDevConsoleFilter(event.target.value)}
            placeholder="Filter console lines (e.g. rpc, fetch, talkmode, 404)"
            className="min-h-[4rem] text-xs"
          />
          <Textarea
            value={
              filteredDevConsoleText ||
              "No console lines match the current filter."
            }
            readOnly
            className="min-h-[22rem] font-mono text-xs-tight leading-5"
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {t("desktopworkspacesection.WindowControls")}
            </CardTitle>
            <CardDescription>
              {t("desktopworkspacesection.WindowControlsDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction("desktop-show-window", windowControls.show)
                }
                disabled={busyAction === "desktop-show-window"}
              >
                {t("gameview.ShowWindow")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction("desktop-hide-window", windowControls.hide)
                }
                disabled={busyAction === "desktop-hide-window"}
              >
                {t("gameview.HideWindow")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction("desktop-focus-window", windowControls.focus)
                }
                disabled={busyAction === "desktop-focus-window"}
              >
                {t("gameview.FocusWindow")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction(
                    "desktop-minimize-window",
                    windowControls.toggleMinimize,
                  )
                }
                disabled={busyAction === "desktop-minimize-window"}
              >
                {snapshot?.window.minimized
                  ? t("desktopworkspacesection.RestoreWindow")
                  : t("desktopworkspacesection.MinimizeWindow")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="sm:col-span-2 min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction(
                    "desktop-maximize-toggle",
                    windowControls.toggleMaximize,
                  )
                }
                disabled={busyAction === "desktop-maximize-toggle"}
              >
                {snapshot?.window.maximized
                  ? t("desktopworkspacesection.UnmaximizeWindow")
                  : t("desktopworkspacesection.MaximizeWindow")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {t("desktopworkspacesection.Lifecycle")}
            </CardTitle>
            <CardDescription>
              {t("desktopworkspacesection.LifecycleDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction(
                    "desktop-notify",
                    windowControls.notify,
                    t("desktopworkspacesection.NotificationSent"),
                    false,
                  )
                }
                disabled={busyAction === "desktop-notify"}
              >
                {t("desktopworkspacesection.SendTestNotification")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction(
                    "desktop-restart-agent",
                    async () => restartBackend(),
                    t("desktopworkspacesection.AgentRestartRequested"),
                  )
                }
                disabled={busyAction === "desktop-restart-agent"}
              >
                {t("finetuningview.RestartAgentTitle")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction(
                    "desktop-relaunch-app",
                    async () => relaunchDesktop(),
                    t("desktopworkspacesection.DesktopRelaunchRequested"),
                    false,
                  )
                }
                disabled={busyAction === "desktop-relaunch-app"}
              >
                {t("desktopworkspacesection.Relaunch")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction("desktop-toggle-auto-launch", async () => {
                    await invokeDesktopBridgeRequest<void>({
                      rpcMethod: "desktopSetAutoLaunch",
                      ipcChannel: "desktop:setAutoLaunch",
                      params: {
                        enabled: !(snapshot?.autoLaunch?.enabled ?? false),
                        openAsHidden:
                          snapshot?.autoLaunch?.openAsHidden ?? false,
                      },
                    });
                  })
                }
                disabled={busyAction === "desktop-toggle-auto-launch"}
              >
                {snapshot?.autoLaunch?.enabled
                  ? t("desktopworkspacesection.DisableAutoLaunch")
                  : t("desktopworkspacesection.EnableAutoLaunch")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="sm:col-span-2 min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction("desktop-toggle-hidden-launch", async () => {
                    await invokeDesktopBridgeRequest<void>({
                      rpcMethod: "desktopSetAutoLaunch",
                      ipcChannel: "desktop:setAutoLaunch",
                      params: {
                        enabled: snapshot?.autoLaunch?.enabled ?? false,
                        openAsHidden: !(
                          snapshot?.autoLaunch?.openAsHidden ?? false
                        ),
                      },
                    });
                  })
                }
                disabled={busyAction === "desktop-toggle-hidden-launch"}
              >
                {snapshot?.autoLaunch?.openAsHidden
                  ? t("desktopworkspacesection.LaunchVisibleOnLogin")
                  : t("desktopworkspacesection.LaunchHiddenOnLogin")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {t("desktopworkspacesection.NativeFileDialogs")}
            </CardTitle>
            <CardDescription>
              {t("desktopworkspacesection.NativeFileDialogsDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction(
                    "desktop-open-file-dialog",
                    async () => {
                      const result = await invokeDesktopBridgeRequest<{
                        canceled: boolean;
                        filePaths: string[];
                      }>({
                        rpcMethod: "desktopShowOpenDialog",
                        ipcChannel: "desktop:showOpenDialog",
                        params: {
                          title: t("desktopworkspacesection.SelectFiles"),
                          defaultPath: snapshot?.paths.downloads,
                          canChooseFiles: true,
                          allowsMultipleSelection: true,
                        },
                      });
                      setOpenPaths(result?.filePaths ?? []);
                    },
                    t("desktopworkspacesection.FileDialogCompleted"),
                    false,
                  )
                }
                disabled={busyAction === "desktop-open-file-dialog"}
              >
                {t("desktopworkspacesection.OpenFilesDialog")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction(
                    "desktop-open-folder-dialog",
                    async () => {
                      const result = await invokeDesktopBridgeRequest<{
                        canceled: boolean;
                        filePaths: string[];
                      }>({
                        rpcMethod: "desktopShowOpenDialog",
                        ipcChannel: "desktop:showOpenDialog",
                        params: {
                          title: t("desktopworkspacesection.SelectFolder"),
                          defaultPath: snapshot?.paths.home,
                          canChooseDirectory: true,
                        },
                      });
                      setOpenPaths(result?.filePaths ?? []);
                    },
                    t("desktopworkspacesection.FolderDialogCompleted"),
                    false,
                  )
                }
                disabled={busyAction === "desktop-open-folder-dialog"}
              >
                {t("desktopworkspacesection.OpenFolderDialog")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="sm:col-span-2 min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction(
                    "desktop-save-dialog",
                    async () => {
                      const result = await invokeDesktopBridgeRequest<{
                        canceled: boolean;
                        filePaths: string[];
                      }>({
                        rpcMethod: "desktopShowSaveDialog",
                        ipcChannel: "desktop:showSaveDialog",
                        params: {
                          title: t("desktopworkspacesection.SaveFile"),
                          defaultPath: snapshot?.paths.documents,
                          allowedFileTypes: "txt,md,json",
                        },
                      });
                      setSavePaths(result?.filePaths ?? []);
                    },
                    t("desktopworkspacesection.SaveDialogCompleted"),
                    false,
                  )
                }
                disabled={busyAction === "desktop-save-dialog"}
              >
                {t("desktopworkspacesection.SaveFileDialog")}
              </Button>
            </div>
            <div className="space-y-2 rounded-xl border border-border bg-bg px-3 py-3 text-xs text-muted">
              <div>
                <div className="mb-1 font-semibold text-txt">
                  {t("desktopworkspacesection.OpenDialogResult")}
                </div>
                {renderPathList(openPaths, t)}
              </div>
              <div>
                <div className="mb-1 font-semibold text-txt">
                  {t("desktopworkspacesection.SaveDialogResult")}
                </div>
                {renderPathList(savePaths, t)}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {t("desktopworkspacesection.ClipboardAndPaths")}
            </CardTitle>
            <CardDescription>
              {t("desktopworkspacesection.ClipboardAndPathsDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={clipboardDraft}
              onChange={(event) => setClipboardDraft(event.target.value)}
              className="min-h-24 w-full rounded-xl border border-border bg-bg px-3 py-2 text-sm text-txt outline-none"
              placeholder={t("desktopworkspacesection.ClipboardDraft")}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction("desktop-clipboard-read", async () => {
                    const result = await invokeDesktopBridgeRequest<{
                      text?: string;
                    }>({
                      rpcMethod: "desktopReadFromClipboard",
                      ipcChannel: "desktop:readFromClipboard",
                    });
                    setClipboardDraft(result?.text ?? "");
                  })
                }
                disabled={busyAction === "desktop-clipboard-read"}
              >
                {t("desktopworkspacesection.ReadClipboard")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction("desktop-clipboard-copy", async () => {
                    await copyTextToClipboard(clipboardDraft);
                  })
                }
                disabled={busyAction === "desktop-clipboard-copy"}
              >
                {t("desktopworkspacesection.CopyDraft")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                onClick={() =>
                  void runAction("desktop-clipboard-clear", async () => {
                    await invokeDesktopBridgeRequest<void>({
                      rpcMethod: "desktopClearClipboard",
                      ipcChannel: "desktop:clearClipboard",
                    });
                    setClipboardDraft("");
                  })
                }
                disabled={busyAction === "desktop-clipboard-clear"}
              >
                {t("desktopworkspacesection.ClearClipboard")}
              </Button>
              {savePaths[0] && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                    onClick={() =>
                      void runAction(
                        "desktop-open-path",
                        async () => {
                          await invokeDesktopBridgeRequest<void>({
                            rpcMethod: "desktopOpenPath",
                            ipcChannel: "desktop:openPath",
                            params: { path: savePaths[0] },
                          });
                        },
                        t("desktopworkspacesection.OpenedSavedPath"),
                        false,
                      )
                    }
                    disabled={busyAction === "desktop-open-path"}
                  >
                    {t("desktopworkspacesection.OpenSavedPath")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-9 justify-start whitespace-normal text-left sm:min-h-10"
                    onClick={() =>
                      void runAction(
                        "desktop-reveal-path",
                        async () => {
                          await invokeDesktopBridgeRequest<void>({
                            rpcMethod: "desktopShowItemInFolder",
                            ipcChannel: "desktop:showItemInFolder",
                            params: { path: savePaths[0] },
                          });
                        },
                        t("desktopworkspacesection.RevealedSavedPath"),
                        false,
                      )
                    }
                    disabled={busyAction === "desktop-reveal-path"}
                  >
                    {t("desktopworkspacesection.RevealSavedPath")}
                  </Button>
                </>
              )}
            </div>
            <div className="rounded-xl border border-border bg-bg px-3 py-3 text-xs text-muted">
              {snapshot?.clipboard ? (
                <>
                  <div className="font-semibold text-txt">
                    {t("desktopworkspacesection.Formats")}{" "}
                    {snapshot.clipboard.formats.join(", ") ||
                      t("desktopworkspacesection.PlainText")}
                  </div>
                  <div className="mt-1 break-all">
                    {snapshot.clipboard.text ||
                      t("desktopworkspacesection.ClipboardTextUnavailable")}
                  </div>
                </>
              ) : (
                t("desktopworkspacesection.ClipboardDetailsUnavailable")
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </ContentLayout>
  );
}
