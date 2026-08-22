/**
 * Desktop-only workspace section: loads the DesktopWorkspaceSnapshot (displays,
 * power/idle, clipboard, paths) from the desktop bridge, exposes actions to open
 * companion surface windows, relaunch the shell / restart the backend, and read
 * the clipboard and exposes the diagnostics card. Only active under the
 * Electrobun runtime; renders nothing meaningful in
 * the browser.
 */

import { Monitor, RefreshCw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import { fetchWithCsrf } from "../../api/csrf-client";
import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../../bridge";
import { useDocumentVisibility } from "../../hooks/useDocumentVisibility";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { ContentLayout } from "../../layouts/content-layout/content-layout";
import { useAppSelector } from "../../state";
import { resolveApiUrl } from "../../utils/asset-url";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  DESKTOP_WORKSPACE_SURFACES,
  type DesktopWorkspaceSnapshot,
  loadDesktopWorkspaceSnapshot,
  openDesktopSettingsWindow,
  openDesktopSurfaceWindow,
} from "../../utils/desktop-workspace";
import { Button } from "../ui/button";
import { SettingsTextarea } from "../ui/settings-controls";
import { ChatHotkeySettingsGroup } from "./ChatHotkeySettingsGroup";
import { DesktopWorkspaceDisplay } from "./DesktopWorkspaceDisplay";
import { useDesktopDiagnosticsText } from "./DesktopWorkspaceDisplay.hooks";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";
import { useDesktopWindowControls } from "./useDesktopWindowControls";

function WorkspaceActionRow({
  agentId,
  label,
  group,
  disabled,
  onClick,
}: {
  agentId: string;
  label: string;
  group: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <SettingsRow
      label={label}
      disabled={disabled}
      control={
        <WorkspaceActionButton
          agentId={agentId}
          label={label}
          group={group}
          disabled={disabled}
          onClick={onClick}
          className="min-h-11 shrink-0"
        >
          {label}
        </WorkspaceActionButton>
      }
    />
  );
}

function WorkspaceActionButton({
  agentId,
  label,
  group,
  variant = "outline",
  className = "min-h-9 justify-start whitespace-normal text-left sm:min-h-10",
  disabled,
  onClick,
  children,
}: {
  agentId: string;
  label: string;
  group: string;
  variant?: "outline" | "default";
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group,
    status: disabled ? "inactive" : "active",
    onActivate: onClick,
  });
  return (
    <Button
      ref={ref}
      variant={variant}
      size="sm"
      className={className}
      disabled={disabled}
      onClick={onClick}
      {...agentProps}
    >
      {children}
    </Button>
  );
}

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
  const isMacDesktop =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent);
  const relaunchDesktop = useAppSelector((s) => s.relaunchDesktop);
  const restartBackend = useAppSelector((s) => s.restartBackend);
  const t = useAppSelector((s) => s.t);
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
        const stackJson: unknown = await stackResponse.json();
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

  const documentVisible = useDocumentVisibility();
  useEffect(() => {
    // The 2s dev-diagnostics poll (/api/dev/stack + /api/dev/console-log) is
    // aggressive; run it only while the document is visible so a backgrounded
    // window stops polling entirely. Refreshes once on becoming visible.
    if (!documentVisible) {
      return;
    }
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
  }, [desktopRuntime, documentVisible, refreshDevDiagnostics]);

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
    setActionMessage(
      t("desktopworkspacesection.copiedBundle", {
        defaultValue: "Copied desktop diagnostics bundle.",
      }),
    );
    setActionError(null);
  }, [diagnosticsText, devConsoleText, devStackText, t]);

  const { ref: consoleFilterRef, agentProps: consoleFilterAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "desktop-console-filter",
      role: "textarea",
      label: t("desktopworkspacesection.console.filterPlaceholder", {
        defaultValue: "Filter console lines (e.g. rpc, fetch, talkmode, 404)",
      }),
      group: "desktop-console",
      getValue: () => devConsoleFilter,
      onFill: setDevConsoleFilter,
    });
  const { ref: clipboardDraftRef, agentProps: clipboardDraftAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "desktop-clipboard-draft",
      role: "textarea",
      label: t("desktopworkspacesection.ClipboardDraft"),
      group: "desktop-clipboard",
      getValue: () => clipboardDraft,
      onFill: setClipboardDraft,
    });

  if (!desktopRuntime) {
    return (
      <ContentLayout contentHeader={contentHeader}>
        <SettingsGroup bare>
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-base font-semibold text-txt-strong">
            {t("desktopworkspacesection.DesktopToolsOnlyAvailable")}
          </div>
        </SettingsGroup>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout contentHeader={contentHeader}>
      <SettingsStack>
        <SettingsGroup
          title={t("desktopworkspacesection.toolbar", {
            defaultValue: "Desktop tools",
          })}
        >
          <SettingsRow
            icon={RefreshCw}
            label={t("desktopworkspacesection.RefreshDiagnostics")}
            control={
              <WorkspaceActionButton
                agentId="desktop-refresh-diagnostics"
                label={t("desktopworkspacesection.RefreshDiagnostics")}
                group="desktop-toolbar"
                disabled={loading}
                onClick={() => {
                  void refreshSnapshot();
                  void refreshDevDiagnostics();
                }}
                className="min-h-11"
              >
                {t("desktopworkspacesection.RefreshDiagnostics")}
              </WorkspaceActionButton>
            }
          />
          <SettingsRow
            icon={Monitor}
            label={t("desktopworkspacesection.OpenDesktopSettingsWindow")}
            control={
              <WorkspaceActionButton
                agentId="desktop-open-settings-window"
                label={t("desktopworkspacesection.OpenDesktopSettingsWindow")}
                group="desktop-toolbar"
                variant="default"
                disabled={busyAction === "desktop-open-settings-window"}
                onClick={() =>
                  void runAction(
                    "desktop-open-settings-window",
                    async () => openDesktopSettingsWindow("desktop"),
                    t(
                      "desktopworkspacesection.OpenedDetachedDesktopSettingsWindow",
                    ),
                    false,
                  )
                }
                className="min-h-11"
              >
                {t("desktopworkspacesection.OpenDesktopSettingsWindow")}
              </WorkspaceActionButton>
            }
          />
        </SettingsGroup>

        {(actionError || actionMessage) && (
          <div
            className={`rounded-sm border px-3 py-2 text-sm ${
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

          <SettingsGroup
            title={t("desktopworkspacesection.devStack.title", {
              defaultValue: "Desktop Dev Stack",
            })}
            description={t("desktopworkspacesection.devStack.description", {
              defaultValue:
                "Live `/api/dev/stack` snapshot for the current desktop session.",
            })}
          >
            <WorkspaceActionRow
              agentId="desktop-refresh-logs"
              label={t("desktopworkspacesection.devStack.refreshLogs", {
                defaultValue: "Refresh Desktop Logs",
              })}
              group="desktop-dev-stack"
              onClick={() => void refreshDevDiagnostics()}
            />
            <WorkspaceActionRow
              agentId="desktop-copy-dev-stack"
              label={t("desktopworkspacesection.devStack.copyStack", {
                defaultValue: "Copy Dev Stack",
              })}
              group="desktop-dev-stack"
              onClick={() => void copyTextToClipboard(devStackText)}
            />
            <WorkspaceActionRow
              agentId="desktop-copy-diagnostics-bundle"
              label={t("desktopworkspacesection.devStack.copyBundle", {
                defaultValue: "Copy Full Diagnostics Bundle",
              })}
              group="desktop-dev-stack"
              onClick={() => void copyDesktopDiagnosticsBundle()}
            />
            <SettingsRow
              label={t("desktopworkspacesection.devStack.snapshot", {
                defaultValue: "Current snapshot",
              })}
              stacked
            >
              <pre className="max-h-72 overflow-auto break-all rounded-sm border border-border bg-bg px-3 py-3 text-xs-tight leading-5 text-txt">
                {devStackText}
              </pre>
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup
            title={t("desktopworkspacesection.DetachedSurfaces")}
            description={t(
              "desktopworkspacesection.DetachedSurfacesDescription",
            )}
          >
            {DESKTOP_WORKSPACE_SURFACES.map((surface) => (
              <WorkspaceActionRow
                key={surface.id}
                agentId={`desktop-surface-${surface.id}`}
                label={getSurfaceLabel(surface.id)}
                group="desktop-surfaces"
                disabled={busyAction === `desktop-surface-${surface.id}`}
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
              />
            ))}
          </SettingsGroup>
        </div>

        {!isMacDesktop && <ChatHotkeySettingsGroup />}

        <SettingsGroup
          title={t("desktopworkspacesection.console.title", {
            defaultValue: "Desktop Console Log",
          })}
          description={t("desktopworkspacesection.console.description", {
            defaultValue:
              "Live tail of the desktop console log: renderer, network, RPC, and main-process logs.",
          })}
        >
          <WorkspaceActionRow
            agentId="desktop-console-refresh-tail"
            label={t("desktopworkspacesection.console.refreshTail", {
              defaultValue: "Refresh Console Tail",
            })}
            group="desktop-console"
            onClick={() => void refreshDevDiagnostics()}
          />
          <WorkspaceActionRow
            agentId="desktop-console-copy-tail"
            label={t("desktopworkspacesection.console.copyTail", {
              defaultValue: "Copy Visible Console Tail",
            })}
            group="desktop-console"
            onClick={() =>
              void copyTextToClipboard(filteredDevConsoleText || devConsoleText)
            }
          />
          <SettingsRow
            label={t("desktopworkspacesection.console.filter", {
              defaultValue: "Filter",
            })}
            description={`${t("desktopworkspacesection.console.total", {
              count: devConsoleSummary.total,
              defaultValue: "Total: {{count}}",
            })} · ${t("desktopworkspacesection.console.errors", {
              count: devConsoleSummary.errors,
              defaultValue: "Errors: {{count}}",
            })} · ${t("desktopworkspacesection.console.warnings", {
              count: devConsoleSummary.warnings,
              defaultValue: "Warnings: {{count}}",
            })}`}
            htmlFor="desktop-console-filter"
            stacked
          >
            <SettingsTextarea
              id="desktop-console-filter"
              ref={consoleFilterRef}
              value={devConsoleFilter}
              onChange={(event) => setDevConsoleFilter(event.target.value)}
              placeholder={t(
                "desktopworkspacesection.console.filterPlaceholder",
                {
                  defaultValue:
                    "Filter console lines (e.g. rpc, fetch, talkmode, 404)",
                },
              )}
              className="min-h-[4rem]"
              {...consoleFilterAgentProps}
            />
          </SettingsRow>
          <SettingsRow
            label={t("desktopworkspacesection.console.tail", {
              defaultValue: "Console tail",
            })}
            stacked
          >
            <SettingsTextarea
              value={
                filteredDevConsoleText ||
                t("desktopworkspacesection.console.noMatch", {
                  defaultValue: "No console lines match the current filter.",
                })
              }
              readOnly
              className="min-h-[22rem] leading-5"
            />
          </SettingsRow>
        </SettingsGroup>

        <div className="grid gap-4 xl:grid-cols-2">
          <SettingsGroup
            title={t("desktopworkspacesection.WindowControls")}
            description={t("desktopworkspacesection.WindowControlsDescription")}
          >
            <WorkspaceActionRow
              agentId="desktop-show-window"
              label={t("gameview.ShowWindow")}
              group="desktop-window-controls"
              disabled={busyAction === "desktop-show-window"}
              onClick={() =>
                void runAction("desktop-show-window", windowControls.show)
              }
            />
            <WorkspaceActionRow
              agentId="desktop-hide-window"
              label={t("gameview.HideWindow")}
              group="desktop-window-controls"
              disabled={busyAction === "desktop-hide-window"}
              onClick={() =>
                void runAction("desktop-hide-window", windowControls.hide)
              }
            />
            <WorkspaceActionRow
              agentId="desktop-focus-window"
              label={t("gameview.FocusWindow")}
              group="desktop-window-controls"
              disabled={busyAction === "desktop-focus-window"}
              onClick={() =>
                void runAction("desktop-focus-window", windowControls.focus)
              }
            />
            <WorkspaceActionRow
              agentId="desktop-minimize-window"
              label={
                snapshot?.window.minimized
                  ? t("desktopworkspacesection.RestoreWindow")
                  : t("desktopworkspacesection.MinimizeWindow")
              }
              group="desktop-window-controls"
              disabled={busyAction === "desktop-minimize-window"}
              onClick={() =>
                void runAction(
                  "desktop-minimize-window",
                  windowControls.toggleMinimize,
                )
              }
            />
            <WorkspaceActionRow
              agentId="desktop-maximize-toggle"
              label={
                snapshot?.window.maximized
                  ? t("desktopworkspacesection.UnmaximizeWindow")
                  : t("desktopworkspacesection.MaximizeWindow")
              }
              group="desktop-window-controls"
              disabled={busyAction === "desktop-maximize-toggle"}
              onClick={() =>
                void runAction(
                  "desktop-maximize-toggle",
                  windowControls.toggleMaximize,
                )
              }
            />
          </SettingsGroup>

          <SettingsGroup
            title={t("desktopworkspacesection.Lifecycle")}
            description={t("desktopworkspacesection.LifecycleDescription")}
          >
            <WorkspaceActionRow
              agentId="desktop-notify"
              label={t("desktopworkspacesection.SendTestNotification")}
              group="desktop-lifecycle"
              disabled={busyAction === "desktop-notify"}
              onClick={() =>
                void runAction(
                  "desktop-notify",
                  windowControls.notify,
                  t("desktopworkspacesection.NotificationSent"),
                  false,
                )
              }
            />
            <WorkspaceActionRow
              agentId="desktop-restart-agent"
              label={t("finetuningview.RestartAgentTitle")}
              group="desktop-lifecycle"
              disabled={busyAction === "desktop-restart-agent"}
              onClick={() =>
                void runAction(
                  "desktop-restart-agent",
                  async () => restartBackend(),
                  t("desktopworkspacesection.AgentRestartRequested"),
                )
              }
            />
            <WorkspaceActionRow
              agentId="desktop-relaunch-app"
              label={t("desktopworkspacesection.Relaunch")}
              group="desktop-lifecycle"
              disabled={busyAction === "desktop-relaunch-app"}
              onClick={() =>
                void runAction(
                  "desktop-relaunch-app",
                  async () => relaunchDesktop(),
                  t("desktopworkspacesection.DesktopRelaunchRequested"),
                  false,
                )
              }
            />
            <WorkspaceActionRow
              agentId="desktop-toggle-auto-launch"
              label={
                snapshot?.autoLaunch?.enabled
                  ? t("desktopworkspacesection.DisableAutoLaunch")
                  : t("desktopworkspacesection.EnableAutoLaunch")
              }
              group="desktop-lifecycle"
              disabled={busyAction === "desktop-toggle-auto-launch"}
              onClick={() =>
                void runAction("desktop-toggle-auto-launch", async () => {
                  await invokeDesktopBridgeRequest<void>({
                    rpcMethod: "desktopSetAutoLaunch",
                    ipcChannel: "desktop:setAutoLaunch",
                    params: {
                      enabled: !(snapshot?.autoLaunch?.enabled ?? false),
                      openAsHidden: snapshot?.autoLaunch?.openAsHidden ?? false,
                    },
                  });
                })
              }
            />
            {!isMacDesktop && (
              <WorkspaceActionRow
                agentId="desktop-toggle-hidden-launch"
                label={
                  snapshot?.autoLaunch?.openAsHidden
                    ? t("desktopworkspacesection.LaunchVisibleOnLogin")
                    : t("desktopworkspacesection.LaunchHiddenOnLogin")
                }
                group="desktop-lifecycle"
                disabled={busyAction === "desktop-toggle-hidden-launch"}
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
              />
            )}
          </SettingsGroup>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <SettingsGroup
            title={t("desktopworkspacesection.NativeFileDialogs")}
            description={t(
              "desktopworkspacesection.NativeFileDialogsDescription",
            )}
          >
            <WorkspaceActionRow
              agentId="desktop-open-file-dialog"
              label={t("desktopworkspacesection.OpenFilesDialog")}
              group="desktop-file-dialogs"
              disabled={busyAction === "desktop-open-file-dialog"}
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
            />
            <WorkspaceActionRow
              agentId="desktop-open-folder-dialog"
              label={t("desktopworkspacesection.OpenFolderDialog")}
              group="desktop-file-dialogs"
              disabled={busyAction === "desktop-open-folder-dialog"}
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
            />
            <WorkspaceActionRow
              agentId="desktop-save-dialog"
              label={t("desktopworkspacesection.SaveFileDialog")}
              group="desktop-file-dialogs"
              disabled={busyAction === "desktop-save-dialog"}
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
            />
            <SettingsRow
              label={t("desktopworkspacesection.OpenDialogResult")}
              description={renderPathList(openPaths, t)}
            />
            <SettingsRow
              label={t("desktopworkspacesection.SaveDialogResult")}
              description={renderPathList(savePaths, t)}
            />
          </SettingsGroup>

          <SettingsGroup
            title={t("desktopworkspacesection.ClipboardAndPaths")}
            description={t(
              "desktopworkspacesection.ClipboardAndPathsDescription",
            )}
          >
            <SettingsRow
              label={t("desktopworkspacesection.ClipboardDraft")}
              htmlFor="desktop-clipboard-draft"
              stacked
            >
              <SettingsTextarea
                id="desktop-clipboard-draft"
                ref={clipboardDraftRef}
                value={clipboardDraft}
                onChange={(event) => setClipboardDraft(event.target.value)}
                className="min-h-24 text-sm"
                placeholder={t("desktopworkspacesection.ClipboardDraft")}
                {...clipboardDraftAgentProps}
              />
            </SettingsRow>
            <WorkspaceActionRow
              agentId="desktop-clipboard-read"
              label={t("desktopworkspacesection.ReadClipboard")}
              group="desktop-clipboard"
              disabled={busyAction === "desktop-clipboard-read"}
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
            />
            <WorkspaceActionRow
              agentId="desktop-clipboard-copy"
              label={t("desktopworkspacesection.CopyDraft")}
              group="desktop-clipboard"
              disabled={busyAction === "desktop-clipboard-copy"}
              onClick={() =>
                void runAction("desktop-clipboard-copy", async () => {
                  await copyTextToClipboard(clipboardDraft);
                })
              }
            />
            <WorkspaceActionRow
              agentId="desktop-clipboard-clear"
              label={t("desktopworkspacesection.ClearClipboard")}
              group="desktop-clipboard"
              disabled={busyAction === "desktop-clipboard-clear"}
              onClick={() =>
                void runAction("desktop-clipboard-clear", async () => {
                  await invokeDesktopBridgeRequest<void>({
                    rpcMethod: "desktopClearClipboard",
                    ipcChannel: "desktop:clearClipboard",
                  });
                  setClipboardDraft("");
                })
              }
            />
            {savePaths[0] ? (
              <>
                <WorkspaceActionRow
                  agentId="desktop-open-path"
                  label={t("desktopworkspacesection.OpenSavedPath")}
                  group="desktop-clipboard"
                  disabled={busyAction === "desktop-open-path"}
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
                />
                <WorkspaceActionRow
                  agentId="desktop-reveal-path"
                  label={t("desktopworkspacesection.RevealSavedPath")}
                  group="desktop-clipboard"
                  disabled={busyAction === "desktop-reveal-path"}
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
                />
              </>
            ) : null}
            <SettingsRow
              label={t("desktopworkspacesection.Formats")}
              description={
                snapshot?.clipboard
                  ? `${snapshot.clipboard.formats.join(", ") || t("desktopworkspacesection.PlainText")} · ${
                      snapshot.clipboard.text ||
                      t("desktopworkspacesection.ClipboardTextUnavailable")
                    }`
                  : t("desktopworkspacesection.ClipboardDetailsUnavailable")
              }
            />
          </SettingsGroup>
        </div>
      </SettingsStack>
    </ContentLayout>
  );
}
