/**
 * Game View — embeds a running app's game client in an iframe.
 *
 * Features:
 * - Full-screen iframe for game client
 * - PostMessage auth for embedded app viewers
 * - Split-screen mode with agent logs panel
 * - Connection status indicator
 */

import { packageNameToAppRouteSlug } from "@elizaos/shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useDocumentVisibility, useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { useTimeout } from "../../hooks/useTimeout";
import { Pin, PinOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AppRunSummary,
  type AppSessionControlAction,
  type AppSessionState,
  client,
  type LogEntry,
} from "../../api";
import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../../bridge";
import { useBranding } from "../../config/branding";
import { useMediaQuery } from "../../hooks";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useApp } from "../../state";
import {
  navigatePreOpenedWindow,
  openExternalUrl,
  preOpenWindow,
} from "../../utils";
import type { DesktopClickAuditItem } from "../../utils/desktop-workspace";
import { formatTime } from "../../utils/format";
import { getAppOperatorSurface } from "./surfaces/registry";
import {
  buildViewerSessionKey,
  resolveEmbeddedViewerUrl,
  resolvePostMessageTargetOrigin,
  resolveViewerReadyEventType,
  shouldUseEmbeddedAppViewer,
} from "./viewer-auth";

export function buildDisconnectedSessionState(
  session: AppSessionState | null,
): AppSessionState | null {
  if (!session) return null;
  return {
    ...session,
    status: "disconnected",
    canSendCommands: false,
    controls: [],
    goalLabel: null,
    suggestedPrompts: [],
    telemetry: null,
    summary: session.displayName
      ? `Session unavailable: ${session.displayName}`
      : "Session unavailable.",
  };
}

type RunSteeringDisposition =
  | "accepted"
  | "queued"
  | "rejected"
  | "unsupported";

interface RunSteeringResult {
  success: boolean;
  message: string;
  disposition: RunSteeringDisposition;
  status: number;
  run?: AppRunSummary | null;
  session?: AppSessionState | null;
}

function getSteeringNotice(
  disposition: RunSteeringDisposition,
  message: string,
): {
  tone: "info" | "success" | "error";
  ttlMs: number;
  text: string;
} {
  if (disposition === "queued") {
    return {
      tone: "info",
      ttlMs: 2600,
      text: message,
    };
  }
  if (disposition === "accepted") {
    return {
      tone: "success",
      ttlMs: 2400,
      text: message,
    };
  }
  return {
    tone: "error",
    ttlMs: 3200,
    text: message,
  };
}

function getSteeringFallbackMessage(
  disposition: RunSteeringDisposition,
  defaultValue: string,
): string {
  if (disposition === "queued") return "Command queued.";
  if (disposition === "accepted") return "Command accepted.";
  if (disposition === "unsupported") {
    return "This run does not support that steering channel.";
  }
  return defaultValue;
}

function getApiStatus(err: unknown): number | null {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status?: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return null;
}

/** Tag badge colors for logs panel. */
const TAG_COLORS: Record<string, { bg: string; fg: string }> = {
  agent: { bg: "rgba(99, 102, 241, 0.15)", fg: "rgb(99, 102, 241)" },
  game: { bg: "rgba(34, 197, 94, 0.15)", fg: "rgb(34, 197, 94)" },
  autonomy: { bg: "rgba(245, 158, 11, 0.15)", fg: "rgb(245, 158, 11)" },
  websocket: { bg: "rgba(20, 184, 166, 0.15)", fg: "rgb(20, 184, 166)" },
};

export const DESKTOP_GAME_CLICK_AUDIT: readonly DesktopClickAuditItem[] = [
  {
    id: "game-native-refresh",
    entryPoint: "game",
    label: "Refresh Native Window State",
    expectedAction: "Refresh canvas bounds and GPU window state.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-native-focus",
    entryPoint: "game",
    label: "Focus Game Window",
    expectedAction: "Focus the native game canvas window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-native-visibility",
    entryPoint: "game",
    label: "Show/Hide Game Window",
    expectedAction: "Show or hide the native game canvas window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-native-always-on-top",
    entryPoint: "game",
    label: "Toggle Game Window Always On Top",
    expectedAction:
      "Toggle whether the native game window floats above other windows.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-native-snapshot",
    entryPoint: "game",
    label: "Snapshot Game Window",
    expectedAction: "Capture a native snapshot of the game canvas window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-gpu-window",
    entryPoint: "game",
    label: "Launch GPU Diagnostics",
    expectedAction: "Create or focus a safe GPU diagnostics window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
] as const;

export function DesktopGameWindowControls({
  gameWindowId,
}: {
  gameWindowId: string | null;
}) {
  const { t } = useApp();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [boundsLabel, setBoundsLabel] = useState(
    t("gameview.BoundsUnavailable", { defaultValue: "Bounds unavailable." }),
  );
  const [gpuWindowId, setGpuWindowId] = useState<string | null>(null);
  const branding = useBranding();

  const refresh = useCallback(async () => {
    if (!gameWindowId) {
      setBoundsLabel(
        t("gameview.WaitingForNativeGameWindow", {
          defaultValue: "Waiting for native game window.",
        }),
      );
      setAlwaysOnTop(false);
    } else {
      const bounds = await invokeDesktopBridgeRequest<{
        x: number;
        y: number;
        width: number;
        height: number;
      }>({
        rpcMethod: "canvasGetBounds",
        ipcChannel: "canvas:getBounds",
        params: { id: gameWindowId },
      });
      if (bounds) {
        setBoundsLabel(
          `${bounds.width}x${bounds.height} @ ${bounds.x},${bounds.y}`,
        );
      }
      try {
        const windows = await invokeDesktopBridgeRequest<{
          windows: Array<{ id: string; alwaysOnTop: boolean }>;
        }>({
          rpcMethod: "canvasListWindows",
          ipcChannel: "canvas:listWindows",
        });
        const currentWindow = windows?.windows.find(
          (item) => item.id === gameWindowId,
        );
        setAlwaysOnTop(currentWindow?.alwaysOnTop ?? false);
      } catch (err) {
        console.warn("[GameView] Failed to refresh game window pin state", err);
      }
    }

    const gpuWindows = await invokeDesktopBridgeRequest<{
      windows: Array<{ id: string }>;
    }>({
      rpcMethod: "gpuWindowList",
      ipcChannel: "gpuWindow:list",
    });
    setGpuWindowId(gpuWindows?.windows[0]?.id ?? null);
  }, [gameWindowId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (
      id: string,
      action: () => Promise<void>,
      successMessage?: string,
      refreshAfter = true,
    ) => {
      setBusyAction(id);
      setError(null);
      setMessage(null);
      try {
        await action();
        if (refreshAfter) {
          await refresh();
        }
        if (successMessage) {
          setMessage(successMessage);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("gameview.NativeGameActionFailed", {
                defaultValue: "Native game action failed.",
              }),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, t],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded border border-border px-2 py-1 text-2xs text-muted">
        {boundsLabel}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs shadow-sm hover:border-accent"
        onClick={() =>
          void runAction(
            "game-native-refresh",
            async () => {},
            t("gameview.NativeGameStateRefreshed", {
              defaultValue: "Native game state refreshed.",
            }),
          )
        }
        disabled={busyAction === "game-native-refresh"}
      >
        {t("gameview.RefreshNativeState", {
          defaultValue: "Refresh Native State",
        })}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs shadow-sm hover:border-accent"
        onClick={() =>
          void runAction(
            "game-native-focus",
            async () => {
              if (!gameWindowId) {
                throw new Error(
                  t("gameview.GameWindowNotReadyYet", {
                    defaultValue: "Game window not ready yet.",
                  }),
                );
              }
              await invokeDesktopBridgeRequest<void>({
                rpcMethod: "canvasFocus",
                ipcChannel: "canvas:focus",
                params: { id: gameWindowId },
              });
            },
            t("gameview.FocusedNativeGameWindow", {
              defaultValue: "Focused native game window.",
            }),
            false,
          )
        }
        disabled={!gameWindowId || busyAction === "game-native-focus"}
      >
        {t("gameview.FocusWindow", { defaultValue: "Focus Window" })}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs shadow-sm hover:border-accent"
        onClick={() =>
          void runAction(
            "game-native-show",
            async () => {
              if (!gameWindowId) {
                throw new Error(
                  t("gameview.GameWindowNotReadyYet", {
                    defaultValue: "Game window not ready yet.",
                  }),
                );
              }
              await invokeDesktopBridgeRequest<void>({
                rpcMethod: "canvasShow",
                ipcChannel: "canvas:show",
                params: { id: gameWindowId },
              });
            },
            t("gameview.ShownNativeGameWindow", {
              defaultValue: "Shown native game window.",
            }),
            false,
          )
        }
        disabled={!gameWindowId || busyAction === "game-native-show"}
      >
        {t("gameview.ShowWindow", { defaultValue: "Show Window" })}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs shadow-sm hover:border-accent"
        onClick={() =>
          void runAction(
            "game-native-hide",
            async () => {
              if (!gameWindowId) {
                throw new Error(
                  t("gameview.GameWindowNotReadyYet", {
                    defaultValue: "Game window not ready yet.",
                  }),
                );
              }
              await invokeDesktopBridgeRequest<void>({
                rpcMethod: "canvasHide",
                ipcChannel: "canvas:hide",
                params: { id: gameWindowId },
              });
            },
            t("gameview.HidNativeGameWindow", {
              defaultValue: "Hid native game window.",
            }),
            false,
          )
        }
        disabled={!gameWindowId || busyAction === "game-native-hide"}
      >
        {t("gameview.HideWindow", { defaultValue: "Hide Window" })}
      </Button>
      <Button
        variant={alwaysOnTop ? "default" : "outline"}
        size="sm"
        className="h-7 gap-1.5 text-xs shadow-sm hover:border-accent"
        onClick={() =>
          void runAction(
            "game-native-always-on-top",
            async () => {
              if (!gameWindowId) {
                throw new Error(
                  t("gameview.GameWindowNotReadyYet", {
                    defaultValue: "Game window not ready yet.",
                  }),
                );
              }
              const next = !alwaysOnTop;
              const result = await invokeDesktopBridgeRequest<{
                success: boolean;
              }>({
                rpcMethod: "canvasSetAlwaysOnTop",
                ipcChannel: "canvas:setAlwaysOnTop",
                params: { id: gameWindowId, flag: next },
              });
              if (!result?.success) {
                throw new Error(
                  t("gameview.GameWindowNoLongerOpen", {
                    defaultValue: "Game window is no longer open.",
                  }),
                );
              }
              setAlwaysOnTop(next);
            },
            alwaysOnTop
              ? t("gameview.NativeGameWindowNormal", {
                  defaultValue: "Native game window acts like a normal window.",
                })
              : t("gameview.NativeGameWindowPinned", {
                  defaultValue: "Native game window stays on top.",
                }),
          )
        }
        disabled={!gameWindowId || busyAction === "game-native-always-on-top"}
      >
        {alwaysOnTop ? (
          <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Pin className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {alwaysOnTop
          ? t("gameview.NormalWindow", { defaultValue: "Normal Window" })
          : t("gameview.KeepOnTop", { defaultValue: "Keep On Top" })}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs shadow-sm hover:border-accent"
        onClick={() =>
          void runAction(
            "game-native-snapshot",
            async () => {
              if (!gameWindowId) {
                throw new Error(
                  t("gameview.GameWindowNotReadyYet", {
                    defaultValue: "Game window not ready yet.",
                  }),
                );
              }
              const snapshot = await invokeDesktopBridgeRequest<{
                data: string;
              } | null>({
                rpcMethod: "canvasSnapshot",
                ipcChannel: "canvas:snapshot",
                params: { id: gameWindowId, format: "png" },
              });
              if (!snapshot?.data) {
                throw new Error(
                  t("gameview.SnapshotUnavailable", {
                    defaultValue: "Snapshot unavailable.",
                  }),
                );
              }
            },
            t("gameview.CapturedNativeGameSnapshot", {
              defaultValue: "Captured native game snapshot.",
            }),
            false,
          )
        }
        disabled={!gameWindowId || busyAction === "game-native-snapshot"}
      >
        {t("gameview.SnapshotWindow", { defaultValue: "Snapshot Window" })}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs shadow-sm hover:border-accent"
        onClick={() =>
          void runAction(
            "game-gpu-window",
            async () => {
              const created = await invokeDesktopBridgeRequest<{ id: string }>({
                rpcMethod: "gpuWindowCreate",
                ipcChannel: "gpuWindow:create",
                params: {
                  id: "gpu-diagnostics",
                  title: `${branding.appName} GPU Diagnostics`,
                  width: 640,
                  height: 360,
                },
              });
              const nextGpuWindowId = created?.id ?? gpuWindowId;
              if (nextGpuWindowId) {
                await invokeDesktopBridgeRequest<void>({
                  rpcMethod: "gpuWindowShow",
                  ipcChannel: "gpuWindow:show",
                  params: { id: nextGpuWindowId },
                });
                await invokeDesktopBridgeRequest<void>({
                  rpcMethod: "gpuWindowGetInfo",
                  ipcChannel: "gpuWindow:getInfo",
                  params: { id: nextGpuWindowId },
                });
                setGpuWindowId(nextGpuWindowId);
              }
            },
            t("gameview.GpuDiagnosticsWindowReady", {
              defaultValue: "GPU diagnostics window ready.",
            }),
          )
        }
        disabled={busyAction === "game-gpu-window"}
      >
        {t("gameview.LaunchGpuDiagnostics", {
          defaultValue: "Launch GPU Diagnostics",
        })}
      </Button>
      {gpuWindowId && (
        <>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs shadow-sm hover:border-accent"
            onClick={() =>
              void runAction(
                "game-gpu-show",
                async () => {
                  await invokeDesktopBridgeRequest<void>({
                    rpcMethod: "gpuWindowShow",
                    ipcChannel: "gpuWindow:show",
                    params: { id: gpuWindowId },
                  });
                },
                t("gameview.GpuDiagnosticsWindowShown", {
                  defaultValue: "GPU diagnostics window shown.",
                }),
                false,
              )
            }
            disabled={busyAction === "game-gpu-show"}
          >
            {t("gameview.ShowGpuWindow", {
              defaultValue: "Show GPU Window",
            })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs shadow-sm hover:border-accent"
            onClick={() =>
              void runAction(
                "game-gpu-hide",
                async () => {
                  await invokeDesktopBridgeRequest<void>({
                    rpcMethod: "gpuWindowHide",
                    ipcChannel: "gpuWindow:hide",
                    params: { id: gpuWindowId },
                  });
                },
                t("gameview.GpuDiagnosticsWindowHidden", {
                  defaultValue: "GPU diagnostics window hidden.",
                }),
                false,
              )
            }
            disabled={busyAction === "game-gpu-hide"}
          >
            {t("gameview.HideGpuWindow", {
              defaultValue: "Hide GPU Window",
            })}
          </Button>
        </>
      )}
      {(message || error) && (
        <span className={`text-2xs ${error ? "text-danger" : "text-ok"}`}>
          {error ?? message}
        </span>
      )}
    </div>
  );
}

export function GameView() {
  useRenderGuard("GameView");
  const { setTimeout } = useTimeout();
  const {
    appRuns,
    activeGameRunId,
    activeGameApp,
    activeGameDisplayName,
    activeGameViewerUrl,
    activeGameSandbox,
    activeGamePostMessageAuth,
    activeGamePostMessagePayload,
    activeGameSession,
    gameOverlayEnabled,
    logs,
    logLoadError,
    loadLogs,
    setState,
    setActionNotice,
    t,
  } = useApp();
  const isElectrobun = isElectrobunRuntime();
  const isCompactLayout = useMediaQuery("(max-width: 1023px)");
  const [stopping, setStopping] = useState(false);
  const [attachingViewer, setAttachingViewer] = useState(false);
  const [detachingViewer, setDetachingViewer] = useState(false);
  const [showLogsPanel, setShowLogsPanel] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [mobileSurface, setMobileSurface] = useState<
    "game" | "dashboard" | "chat"
  >("game");
  const docVisible = useDocumentVisibility();
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [chatInput, setChatInput] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const [sessionBusyAction, setSessionBusyAction] =
    useState<AppSessionControlAction | null>(null);
  const [sessionState, setSessionState] = useState<AppSessionState | null>(
    activeGameSession,
  );
  const [gameWindowId, setGameWindowId] = useState<string | null>(null);
  const gameWindowIdRef = useRef<string | null>(null);
  const appRunsRef = useRef(appRuns);
  const activeGameSessionRef = useRef(activeGameSession);
  const sessionStateRef = useRef(sessionState);
  const refreshSessionPromiseRef =
    useRef<Promise<AppSessionState | null> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const authSentRef = useRef(false);
  const viewerSessionRef = useRef<string>("");
  const activeGameRun = useMemo(
    () => appRuns.find((run) => run.runId === activeGameRunId) ?? null,
    [activeGameRunId, appRuns],
  );
  const useEmbeddedViewer = useMemo(
    () => shouldUseEmbeddedAppViewer(activeGameRun),
    [activeGameRun],
  );
  const useNativeGameWindow = Boolean(
    isElectrobun &&
      activeGameRun?.viewer?.url &&
      activeGameRun.viewerAttachment === "attached" &&
      !useEmbeddedViewer,
  );
  const OperatorSurface = useMemo(
    () => getAppOperatorSurface(activeGameApp),
    [activeGameApp],
  );
  const hasOperatorSurface = Boolean(OperatorSurface);
  const openOperatorPanelByDefault =
    activeGameApp !== "@hyperscape/plugin-hyperscape" &&
    activeGameApp !== "@elizaos/app-hyperscape";
  const resolvedActiveGameViewerUrl = useMemo(
    () => resolveEmbeddedViewerUrl(activeGameViewerUrl),
    [activeGameViewerUrl],
  );
  const resolvedActiveGameLaunchUrl = useMemo(
    () => resolveEmbeddedViewerUrl(activeGameRun?.launchUrl ?? ""),
    [activeGameRun?.launchUrl],
  );
  const dashboardPanelEnabled =
    !hasOperatorSurface || openOperatorPanelByDefault;
  const hasActiveRun = Boolean(activeGameRun);
  const hasViewer = Boolean(activeGameRun?.viewer?.url);
  const viewerAttached = activeGameRun?.viewerAttachment === "attached";
  const openableUrl =
    resolvedActiveGameViewerUrl || resolvedActiveGameLaunchUrl || "";
  const canAttachViewer =
    Boolean(activeGameRun?.viewer?.url) &&
    activeGameRun?.viewerAttachment === "detached";
  const canDetachViewer =
    activeGameRun?.viewerAttachment === "attached" &&
    (activeGameRun?.supportsViewerDetach ?? true);

  useEffect(() => {
    appRunsRef.current = appRuns;
  }, [appRuns]);

  useEffect(() => {
    activeGameSessionRef.current = activeGameSession;
  }, [activeGameSession]);

  useEffect(() => {
    sessionStateRef.current = sessionState;
  }, [sessionState]);

  const applySessionState = useCallback(
    (nextSession: AppSessionState | null) => {
      setSessionState(nextSession);
      sessionStateRef.current = nextSession;
      if (!activeGameRunId) return;
      const currentRuns = appRunsRef.current;
      const nextUpdatedAt = new Date().toISOString();
      const nextRuns = currentRuns.map((run) => {
        if (run.runId !== activeGameRunId) return run;
        const nextHealth =
          nextSession?.status === "disconnected"
            ? {
                state: "degraded" as const,
                message:
                  nextSession.summary ?? run.summary ?? "Session unavailable.",
              }
            : nextSession
              ? {
                  state: "healthy" as const,
                  message: nextSession.summary ?? null,
                }
              : run.health;
        return {
          ...run,
          session: nextSession,
          status: nextSession?.status ?? run.status,
          summary: nextSession?.summary ?? run.summary,
          updatedAt: nextUpdatedAt,
          lastHeartbeatAt: nextSession ? nextUpdatedAt : run.lastHeartbeatAt,
          health: nextHealth,
        } satisfies AppRunSummary;
      });
      appRunsRef.current = nextRuns;
      setState("appRuns", nextRuns);
    },
    [activeGameRunId, setState],
  );

  const applyRunState = useCallback(
    (nextRun: AppRunSummary | null) => {
      if (!nextRun) return;
      const nextUpdatedAt = new Date().toISOString();
      setSessionState(nextRun.session ?? null);
      sessionStateRef.current = nextRun.session ?? null;
      if (nextRun.runId !== activeGameRunId) return;
      const currentRuns = appRunsRef.current;
      const nextRuns = currentRuns.map((run) => {
        if (run.runId !== nextRun.runId) return run;
        const nextHealth =
          nextRun.health ??
          (nextRun.session?.status === "disconnected"
            ? {
                state: "degraded" as const,
                message:
                  nextRun.session.summary ??
                  nextRun.summary ??
                  "Session unavailable.",
              }
            : nextRun.session
              ? {
                  state: "healthy" as const,
                  message: nextRun.session.summary ?? null,
                }
              : run.health);
        return {
          ...run,
          ...nextRun,
          updatedAt: nextUpdatedAt,
          lastHeartbeatAt: nextRun.session
            ? nextUpdatedAt
            : run.lastHeartbeatAt,
          health: nextHealth,
        } satisfies AppRunSummary;
      });
      appRunsRef.current = nextRuns;
      setState("appRuns", nextRuns);
    },
    [activeGameRunId, setState],
  );

  const refreshSessionState = useCallback(async () => {
    if (refreshSessionPromiseRef.current) {
      return refreshSessionPromiseRef.current;
    }

    const refreshTask = (async () => {
      const currentSession =
        sessionStateRef.current ?? activeGameSessionRef.current;

      if (activeGameRunId) {
        try {
          const nextRun = await client.getAppRun(activeGameRunId);
          if (nextRun) {
            applyRunState(nextRun);
            setConnectionStatus(
              nextRun.health.state === "offline" ||
                nextRun.session?.status === "disconnected"
                ? "disconnected"
                : "connected",
            );
            return nextRun.session ?? null;
          }
        } catch (err) {
          console.warn("[GameView] Failed to refresh app run state:", err);
          if (!activeGameApp || !currentSession?.sessionId) {
            setConnectionStatus("disconnected");
            return currentSession ?? null;
          }
        }
      }

      if (!activeGameApp || !currentSession?.sessionId) return null;
      try {
        const nextSession = await client.getAppSessionState(
          activeGameApp,
          currentSession.sessionId,
        );
        applySessionState(nextSession);
        setConnectionStatus("connected");
        return nextSession;
      } catch (err) {
        console.warn("[GameView] Failed to refresh app session state:", err);
        if (activeGameRunId) {
          setConnectionStatus("disconnected");
          return currentSession ?? null;
        }
        applySessionState(buildDisconnectedSessionState(currentSession));
        setConnectionStatus("disconnected");
        return null;
      }
    })();

    refreshSessionPromiseRef.current = refreshTask;
    try {
      return await refreshTask;
    } finally {
      if (refreshSessionPromiseRef.current === refreshTask) {
        refreshSessionPromiseRef.current = null;
      }
    }
  }, [activeGameRunId, activeGameApp, applyRunState, applySessionState]);

  useEffect(() => {
    setSessionState(activeGameSession);
    sessionStateRef.current = activeGameSession;
  }, [activeGameSession]);

  useEffect(() => {
    setShowLogsPanel(dashboardPanelEnabled);
    setMobileSurface("game");
  }, [dashboardPanelEnabled]);

  useEffect(() => {
    if (!activeGameRunId && !activeGameSession?.sessionId) return;
    void refreshSessionState();
  }, [activeGameRunId, activeGameSession?.sessionId, refreshSessionState]);

  useIntervalWhenDocumentVisible(
    () => {
      void refreshSessionState();
    },
    3000,
    Boolean(activeGameRunId || activeGameSession?.sessionId),
  );

  // Cheap liveness ping — separate from the 3s session refresh so it still
  // fires when the upstream game API is degraded. The server's stale-run
  // sweeper uses this to decide whether to stop a run whose UI tab has
  // gone silent. Pauses while the document is hidden; the sweeper's
  // 90s grace window covers brief tab-switching.
  useIntervalWhenDocumentVisible(
    () => {
      if (!activeGameRunId) return;
      void client.heartbeatAppRun(activeGameRunId).catch((err: unknown) => {
        // 404 means the run was reaped (sweeper or another window) — drop
        // local state so the user sees the empty-state UI instead of a
        // ghost session that no longer exists server-side.
        const status = getApiStatus(err);
        if (status === 404) {
          setState(
            "appRuns",
            appRunsRef.current.filter((run) => run.runId !== activeGameRunId),
          );
          setState("activeGameRunId", "");
        }
      });
    },
    15_000,
    Boolean(activeGameRunId),
  );

  // Clean up server-side state when the browser tab closes. `sendBeacon`
  // is the only request method browsers reliably deliver during unload —
  // a normal `fetch` would be cancelled. Falls through silently if the
  // browser is too old or the run is already gone.
  useEffect(() => {
    if (!activeGameRunId) return;
    const handleUnload = () => {
      const beacon = navigator?.sendBeacon;
      if (typeof beacon !== "function") return;
      const baseUrl = client.getBaseUrl();
      const stopPath = `/api/apps/runs/${encodeURIComponent(activeGameRunId)}/stop`;
      const stopUrl = baseUrl ? `${baseUrl}${stopPath}` : stopPath;
      beacon.call(navigator, stopUrl);
    };
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [activeGameRunId]);

  const sendChatCommand = useCallback(
    async (rawContent: string) => {
      const content = rawContent.trim();
      if (!content) return;
      const currentSession = sessionState ?? activeGameSession;
      const currentRun = activeGameRun ?? null;
      setSendingChat(true);
      try {
        if (currentRun?.runId) {
          const response = (await client.sendAppRunMessage(
            currentRun.runId,
            content,
          )) as RunSteeringResult;
          if (response.run) {
            applyRunState(response.run);
          } else if (response.session) {
            applySessionState(response.session);
          }
          const notice = getSteeringNotice(
            response.disposition,
            response.message ||
              getSteeringFallbackMessage(
                response.disposition,
                t("gameview.CommandSentToAppRun", {
                  defaultValue: "Command sent to app run.",
                }),
              ),
          );
          setActionNotice(notice.text, notice.tone, notice.ttlMs);
          if (
            response.disposition === "accepted" ||
            response.disposition === "queued"
          ) {
            if (!response.run && !response.session) {
              await refreshSessionState();
            }
            setChatInput("");
            setTimeout(() => void loadLogs(), 1500);
          }
        } else if (
          currentSession?.sessionId &&
          currentSession.canSendCommands
        ) {
          const response = await client.sendAppSessionMessage(
            activeGameApp,
            currentSession.sessionId,
            content,
          );
          if (response.session) {
            applySessionState(response.session);
          } else {
            await refreshSessionState();
          }
          setActionNotice(
            response.message ||
              t("gameview.CommandSentToAppSession", {
                defaultValue: "Command sent to app session.",
              }),
            "success",
            2400,
          );
          setChatInput("");
          setTimeout(() => void loadLogs(), 1500);
        } else {
          setActionNotice(
            t("gameview.RunSteeringUnsupported", {
              defaultValue: "This run does not expose a steering channel yet.",
            }),
            "error",
            3200,
          );
        }
      } catch (err) {
        const status = getApiStatus(err);
        setActionNotice(
          status === 501 || status === 503
            ? t("gameview.RunSteeringUnsupported", {
                defaultValue:
                  "This run does not expose a steering channel yet.",
              })
            : t("gameview.FailedToSend", {
                defaultValue: "Failed to send: {{message}}",
                message: err instanceof Error ? err.message : "error",
              }),
          "error",
          3000,
        );
      } finally {
        setSendingChat(false);
      }
    },
    [
      activeGameApp,
      activeGameSession,
      applySessionState,
      loadLogs,
      refreshSessionState,
      setActionNotice,
      setTimeout,
      sessionState,
      t,
      activeGameRun,
      applyRunState,
    ],
  );

  const handleSendChat = useCallback(() => {
    void sendChatCommand(chatInput);
  }, [chatInput, sendChatCommand]);

  const activeSessionState = sessionState ?? activeGameSession;
  const sessionControlAction = useMemo<AppSessionControlAction | null>(() => {
    if (activeSessionState?.controls?.includes("pause")) return "pause";
    if (activeSessionState?.controls?.includes("resume")) return "resume";
    return null;
  }, [activeSessionState]);

  const handleSessionControl = useCallback(async () => {
    if (
      !activeGameRunId ||
      !activeGameApp ||
      !activeGameSession?.sessionId ||
      !sessionControlAction
    )
      return;
    setSessionBusyAction(sessionControlAction);
    try {
      const response = (await client.controlAppRun(
        activeGameRunId,
        sessionControlAction,
      )) as RunSteeringResult;
      if (response.run) {
        applyRunState(response.run);
      } else if (response.session) {
        applySessionState(response.session);
      }
      const notice = getSteeringNotice(
        response.disposition,
        response.message ||
          getSteeringFallbackMessage(
            response.disposition,
            t("gameview.SessionControlSent", {
              defaultValue: "Session control updated.",
            }),
          ),
      );
      setActionNotice(notice.text, notice.tone, notice.ttlMs);
      if (
        (response.disposition === "accepted" ||
          response.disposition === "queued") &&
        !response.run &&
        !response.session
      ) {
        await refreshSessionState();
      }
    } catch (err) {
      const status = getApiStatus(err);
      setActionNotice(
        status === 501 || status === 503
          ? t("gameview.SessionControlUnsupported", {
              defaultValue: "This run does not expose session controls.",
            })
          : t("gameview.SessionControlFailed", {
              defaultValue: "Failed to update session: {{message}}",
              message: err instanceof Error ? err.message : "error",
            }),
        "error",
        3200,
      );
    } finally {
      setSessionBusyAction(null);
    }
  }, [
    activeGameApp,
    activeGameSession?.sessionId,
    applySessionState,
    refreshSessionState,
    sessionControlAction,
    setActionNotice,
    t,
    activeGameRunId,
    applyRunState,
  ]);
  const postMessageTargetOrigin = useMemo(
    () => resolvePostMessageTargetOrigin(activeGameViewerUrl),
    [activeGameViewerUrl],
  );
  const viewerSessionKey = useMemo(
    () =>
      buildViewerSessionKey(activeGameViewerUrl, activeGamePostMessagePayload),
    [activeGamePostMessagePayload, activeGameViewerUrl],
  );

  // Filter logs relevant to the current game
  const gameLogs = useMemo(() => {
    if (!activeGameApp) return [];
    const appKeyword = (
      packageNameToAppRouteSlug(activeGameApp) ?? activeGameApp
    ).toLowerCase();
    return logs.filter((entry) => {
      const message = (entry.message ?? "").toLowerCase();
      const source = (entry.source ?? "").toLowerCase();
      const tags = (entry.tags ?? []).map((t) => t.toLowerCase());
      return (
        message.includes(appKeyword) ||
        source.includes(appKeyword) ||
        tags.some((t) => t.includes(appKeyword)) ||
        tags.includes("game") ||
        tags.includes("autonomy") ||
        source.includes("agent")
      );
    });
  }, [activeGameApp, logs]);

  // Auto-refresh logs when panel is open and tab is visible (catch-up on focus).
  useEffect(() => {
    if (!showLogsPanel || !docVisible) return;
    void loadLogs();
  }, [showLogsPanel, docVisible, loadLogs]);

  useIntervalWhenDocumentVisible(
    () => {
      void loadLogs();
    },
    3000,
    showLogsPanel,
  );

  // Open the game URL in an isolated Electrobun BrowserWindow.
  // Runs whenever the viewer URL or game title changes and we're inside the desktop app.
  useEffect(() => {
    if (!useNativeGameWindow || !resolvedActiveGameViewerUrl) return;

    let cancelled = false;

    void invokeDesktopBridgeRequest<{ id: string }>({
      rpcMethod: "gameOpenWindow",
      ipcChannel: "game:openWindow",
      params: {
        url: resolvedActiveGameViewerUrl,
        title:
          activeGameDisplayName ||
          activeGameApp ||
          t("common.game", { defaultValue: "Game" }),
      },
    })
      .then((result) => {
        if (cancelled) return;
        if (result?.id) {
          gameWindowIdRef.current = result.id;
          setGameWindowId(result.id);
          setConnectionStatus("connected");
        }
      })
      .catch((err) => {
        console.warn("[GameView] game:openWindow failed:", err);
        // Fall through — iframe fallback is still rendered
      });

    return () => {
      cancelled = true;
      // Close the game window when GameView unmounts or the URL changes
      if (gameWindowIdRef.current) {
        void invokeDesktopBridgeRequest({
          rpcMethod: "canvasDestroyWindow",
          ipcChannel: "canvas:destroyWindow",
          params: { id: gameWindowIdRef.current },
        }).catch(() => {});
        gameWindowIdRef.current = null;
        setGameWindowId(null);
      }
    };
  }, [
    activeGameApp,
    activeGameDisplayName,
    resolvedActiveGameViewerUrl,
    t,
    useNativeGameWindow,
  ]);

  // Reset auth handshake state when the active viewer session changes.
  useEffect(() => {
    if (viewerSessionRef.current !== viewerSessionKey) {
      viewerSessionRef.current = viewerSessionKey;
      authSentRef.current = false;
    }
    if (activeGamePostMessageAuth && useEmbeddedViewer) {
      setConnectionStatus("connecting");
      return;
    }
    if (useNativeGameWindow) {
      setConnectionStatus("connecting");
      return;
    }
    setConnectionStatus("connected");
  }, [
    activeGamePostMessageAuth,
    useEmbeddedViewer,
    useNativeGameWindow,
    viewerSessionKey,
  ]);

  const resetActiveGameState = useCallback(() => {
    setSessionState(null);
    setState("activeGameRunId", "");
  }, [setState]);

  useEffect(() => {
    if (
      !useEmbeddedViewer ||
      !activeGamePostMessageAuth ||
      !activeGamePostMessagePayload
    )
      return;
    if (authSentRef.current) return;
    const expectedReadyType = resolveViewerReadyEventType(
      activeGamePostMessagePayload,
    );
    if (!expectedReadyType) return;

    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (authSentRef.current) return;
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;
      if (event.data?.type !== expectedReadyType) return;
      if (
        postMessageTargetOrigin !== "*" &&
        event.origin !== postMessageTargetOrigin
      ) {
        return;
      }
      iframeWindow.postMessage(
        activeGamePostMessagePayload,
        postMessageTargetOrigin,
      );
      authSentRef.current = true;
      setConnectionStatus("connected");
      setActionNotice(
        t("gameview.ViewerAuthSent", { defaultValue: "Viewer auth sent." }),
        "info",
        1800,
      );
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [
    activeGamePostMessageAuth,
    activeGamePostMessagePayload,
    postMessageTargetOrigin,
    setActionNotice,
    t,
    useEmbeddedViewer,
  ]);

  const handleOpenInNewTab = useCallback(async () => {
    if (!openableUrl) {
      setActionNotice(
        t("gameview.ViewerUnavailable", {
          defaultValue: "No viewer or launch URL is available for this run.",
        }),
        "error",
        3200,
      );
      return;
    }
    const popup = preOpenWindow();
    try {
      if (popup) {
        navigatePreOpenedWindow(popup, openableUrl);
      } else {
        await openExternalUrl(openableUrl);
      }
    } catch {
      setActionNotice(
        t("appsview.PopupBlocked", {
          defaultValue: "Popup blocked. Allow popups and try again.",
        }),
        "error",
        3600,
      );
    }
  }, [openableUrl, setActionNotice, t]);

  const handleAttachViewer = useCallback(async () => {
    if (!activeGameRun) return;
    setAttachingViewer(true);
    try {
      const result = await client.attachAppRun(activeGameRun.runId);
      if (result.run) {
        applyRunState(result.run);
      }
      setActionNotice(
        result.message ||
          t("gameview.ViewerAttached", {
            defaultValue: "Viewer attached.",
          }),
        "success",
        2200,
      );
    } catch (err) {
      setActionNotice(
        t("gameview.ViewerAttachFailed", {
          defaultValue: "Failed to attach viewer: {{message}}",
          message: err instanceof Error ? err.message : "error",
        }),
        "error",
        3600,
      );
    } finally {
      setAttachingViewer(false);
    }
  }, [activeGameRun, applyRunState, setActionNotice, t]);

  const handleDetachViewer = useCallback(async () => {
    if (!activeGameRun) return;
    setDetachingViewer(true);
    try {
      const result = await client.detachAppRun(activeGameRun.runId);
      if (result.run) {
        applyRunState(result.run);
      }
      setActionNotice(
        result.message ||
          t("gameview.ViewerDetached", {
            defaultValue: "Viewer detached.",
          }),
        "success",
        2200,
      );
    } catch (err) {
      setActionNotice(
        t("gameview.ViewerDetachFailed", {
          defaultValue: "Failed to detach viewer: {{message}}",
          message: err instanceof Error ? err.message : "error",
        }),
        "error",
        3600,
      );
    } finally {
      setDetachingViewer(false);
    }
  }, [activeGameRun, applyRunState, setActionNotice, t]);

  const handleStop = useCallback(async () => {
    if (!activeGameRunId) return;
    setStopping(true);
    try {
      const stopResult = await client.stopAppRun(activeGameRunId);
      const nextRuns = appRuns.filter((run) => run.runId !== activeGameRunId);
      setState("appRuns", nextRuns);
      resetActiveGameState();
      setState("tab", "apps");
      setState("appsSubTab", nextRuns.length > 0 ? "running" : "browse");
      setActionNotice(
        stopResult.message,
        stopResult.success ? "success" : "info",
        stopResult.needsRestart ? 5000 : 3200,
      );
    } catch (err) {
      setActionNotice(
        t("gameview.FailedToStop", {
          defaultValue: "Failed to stop: {{message}}",
          message: err instanceof Error ? err.message : "error",
        }),
        "error",
      );
    } finally {
      setStopping(false);
    }
  }, [
    activeGameRunId,
    appRuns,
    resetActiveGameState,
    setActionNotice,
    setState,
    t,
  ]);

  if (!hasActiveRun) {
    return (
      <div className="flex items-center justify-center py-10 text-muted italic">
        {t("game.noActiveSession")}{" "}
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            setState("tab", "apps");
            setState("appsSubTab", "browse");
          }}
          className="ml-2 font-bold tracking-wide shadow-sm"
        >
          {t("game.backToApps")}
        </Button>
      </div>
    );
  }

  const renderLogsPanel = (layout: "sidebar" | "standalone" = "sidebar") => (
    <div
      className={`flex min-h-0 flex-col bg-card ${
        layout === "sidebar" ? "w-80" : "h-full"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-bold text-xs">{t("game.agentActivity")}</span>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-2xs px-2 py-0 border-border bg-card hover:border-accent"
          onClick={() => void loadLogs()}
        >
          {t("common.refresh")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-2xs px-2 py-0 border-border bg-card hover:border-accent"
          onClick={() => setShowLogsPanel(false)}
        >
          {t("common.hide")}
        </Button>
      </div>
      {activeSessionState?.goalLabel ? (
        <div className="px-2 py-1.5 text-2xs text-muted">
          {activeSessionState.goalLabel}
        </div>
      ) : null}
      {/* Defense of the Agents telemetry dashboard */}
      {activeSessionState?.telemetry?.heroClass != null ? (
        <div className="px-2 py-2 text-2xs space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-txt">
              {String(activeSessionState.telemetry.heroClass)
                .charAt(0)
                .toUpperCase() +
                String(activeSessionState.telemetry.heroClass).slice(1)}{" "}
              Lv{String(activeSessionState.telemetry.heroLevel ?? "?")}
            </span>
            <span className="text-muted">
              {String(activeSessionState.telemetry.heroLane ?? "?")} lane
            </span>
            {activeSessionState.telemetry.heroAlive === false ? (
              <span className="text-danger font-semibold">DEAD</span>
            ) : null}
            {activeSessionState.telemetry.autoPlay ? (
              <span className="px-1 py-0.5 rounded bg-ok/15 text-ok font-semibold">
                AUTO
              </span>
            ) : (
              <span className="px-1 py-0.5 rounded bg-muted/15 text-muted">
                MANUAL
              </span>
            )}
          </div>
          {/* HP bar */}
          {typeof activeSessionState.telemetry.heroHp === "number" &&
          typeof activeSessionState.telemetry.heroMaxHp === "number" &&
          activeSessionState.telemetry.heroMaxHp > 0 ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, Math.round((Number(activeSessionState.telemetry.heroHp) / Number(activeSessionState.telemetry.heroMaxHp)) * 100))}%`,
                    background:
                      Number(activeSessionState.telemetry.heroHp) /
                        Number(activeSessionState.telemetry.heroMaxHp) >
                      0.5
                        ? "rgb(34, 197, 94)"
                        : Number(activeSessionState.telemetry.heroHp) /
                              Number(activeSessionState.telemetry.heroMaxHp) >
                            0.25
                          ? "rgb(245, 158, 11)"
                          : "rgb(239, 68, 68)",
                  }}
                />
              </div>
              <span className="text-muted whitespace-nowrap">
                {activeSessionState.telemetry.heroHp}/
                {activeSessionState.telemetry.heroMaxHp}
              </span>
            </div>
          ) : null}
          {/* Strategy info */}
          {activeSessionState.telemetry.strategyVersion != null ? (
            <div className="space-y-0.5 text-muted">
              <div className="flex items-center gap-2">
                <span>
                  Strategy v
                  {String(activeSessionState.telemetry.strategyVersion)}
                </span>
                {activeSessionState.telemetry.strategyScore != null ? (
                  <span>
                    score:{" "}
                    {Number(activeSessionState.telemetry.strategyScore).toFixed(
                      2,
                    )}
                  </span>
                ) : null}
                {activeSessionState.telemetry.bestStrategyVersion != null ? (
                  <span>
                    best: v
                    {String(activeSessionState.telemetry.bestStrategyVersion)} (
                    {Number(
                      activeSessionState.telemetry.bestStrategyScore ?? 0,
                    ).toFixed(2)}
                    )
                  </span>
                ) : null}
              </div>
              {(activeSessionState.telemetry as Record<string, unknown>)
                .abilityPriority ? (
                <div className="text-3xs">
                  Priority:{" "}
                  {(
                    (activeSessionState.telemetry as Record<string, unknown>)
                      .abilityPriority as string[]
                  ).join(" > ")}
                  {" · "}
                  Recall @
                  {Math.round(
                    Number(
                      (activeSessionState.telemetry as Record<string, unknown>)
                        .recallThreshold ?? 0.25,
                    ) * 100,
                  )}
                  % HP
                </div>
              ) : null}
              {(activeSessionState.telemetry as Record<string, unknown>)
                .ticksTracked != null ? (
                <div className="text-3xs">
                  {String(
                    (activeSessionState.telemetry as Record<string, unknown>)
                      .ticksTracked,
                  )}{" "}
                  ticks tracked ·{" "}
                  {String(
                    (activeSessionState.telemetry as Record<string, unknown>)
                      .abilitiesLearned ?? 0,
                  )}{" "}
                  abilities learned
                  {activeSessionState.telemetry.survivalRate != null
                    ? ` · ${Math.round(Number(activeSessionState.telemetry.survivalRate) * 100)}% survival`
                    : ""}
                </div>
              ) : null}
            </div>
          ) : null}
          {/* Lane pressure */}
          {activeSessionState.telemetry.laneHumanUnits != null ? (
            <div className="flex items-center gap-2 text-muted">
              <span>Lane:</span>
              <span
                className={
                  Number(activeSessionState.telemetry.laneFrontline ?? 0) > 0
                    ? "text-ok"
                    : Number(activeSessionState.telemetry.laneFrontline ?? 0) <
                        0
                      ? "text-danger"
                      : ""
                }
              >
                {String(activeSessionState.telemetry.laneHumanUnits)}v
                {String(activeSessionState.telemetry.laneOrcUnits)} (
                {Number(activeSessionState.telemetry.laneFrontline ?? 0) > 0
                  ? "+"
                  : ""}
                {String(activeSessionState.telemetry.laneFrontline)})
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {activeSessionState?.suggestedPrompts?.length ? (
        <div className="flex flex-wrap gap-1 px-2 py-2">
          {activeSessionState.suggestedPrompts.slice(0, 4).map((prompt) => (
            <Button
              key={prompt}
              variant="outline"
              size="sm"
              className="h-6 max-w-full text-2xs shadow-sm"
              onClick={() => void sendChatCommand(prompt)}
              disabled={sendingChat}
            >
              <span className="truncate">{prompt}</span>
            </Button>
          ))}
        </div>
      ) : null}
      {activeSessionState?.recommendations?.length ? (
        <div className="px-2 py-2 text-2xs space-y-1.5">
          <div className="font-semibold text-txt">
            {t("gameview.Recommendations", {
              defaultValue: "Recommendations",
            })}
          </div>
          {activeSessionState.recommendations.slice(0, 3).map((item) => (
            <div key={item.id} className="space-y-0.5">
              <div className="text-txt">
                {item.label}
                {typeof item.priority === "number" ? (
                  <span className="ml-1 text-muted">#{item.priority}</span>
                ) : null}
              </div>
              {item.reason ? (
                <div className="text-muted">{item.reason}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {logLoadError ? (
        <div className="border-b border-danger/25 bg-danger/8 px-2 py-1.5 text-2xs text-danger">
          {t("logsview.LoadFailed", {
            defaultValue: "Failed to load logs: {{message}}",
            message: logLoadError,
          })}
        </div>
      ) : null}
      {/* Chat input for sending commands to agent */}
      <div className="flex items-center gap-2 px-2 py-2">
        <Input
          type="text"
          data-testid="game-command-input"
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !sendingChat) {
              e.preventDefault();
              handleSendChat();
            }
          }}
          placeholder={t("game.chatPlaceholder")}
          className="flex-1 h-8 text-xs bg-bg focus-visible:ring-accent"
          disabled={sendingChat}
        />
        <Button
          variant="default"
          size="sm"
          data-testid="game-command-send"
          onClick={handleSendChat}
          disabled={sendingChat || !chatInput.trim()}
          className="h-8 shadow-sm font-bold tracking-wide"
        >
          {sendingChat ? "..." : t("common.send")}
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 text-xs-tight font-mono">
        {/* Prefer telemetry activity feed when available (Defense game loop pushes entries here) */}
        {Array.isArray(
          (activeSessionState?.telemetry as Record<string, unknown> | null)
            ?.recentActivity,
        ) &&
        (
          (activeSessionState?.telemetry as Record<string, unknown>)
            .recentActivity as { ts: number; action: string; detail: string }[]
        ).length > 0 ? (
          (
            (activeSessionState?.telemetry as Record<string, unknown>)
              .recentActivity as {
              ts: number;
              action: string;
              detail: string;
            }[]
          )
            .slice()
            .reverse()
            .slice(0, 30)
            .map(
              (
                entry: { ts: number; action: string; detail: string },
                idx: number,
              ) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: composite key with index as tiebreaker
                  key={`${entry.ts}-${idx}`}
                  className="py-1 flex flex-col gap-0.5"
                >
                  <div className="flex items-center gap-1">
                    <span className="text-muted text-2xs">
                      {formatTime(entry.ts, { fallback: "—" })}
                    </span>
                    <span
                      className={`font-semibold text-2xs uppercase ${
                        entry.action === "error"
                          ? "text-danger"
                          : entry.action.startsWith("ability")
                            ? "text-ok"
                            : entry.action.startsWith("move")
                              ? "text-warn"
                              : "text-muted"
                      }`}
                    >
                      {entry.action.split(":")[0]}
                    </span>
                  </div>
                  <div className="text-txt break-all">{entry.detail}</div>
                </div>
              ),
            )
        ) : Array.isArray(activeSessionState?.activity) &&
          activeSessionState.activity.length > 0 ? (
          activeSessionState.activity
            .slice()
            .sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0))
            .slice(0, 30)
            .map((entry) => (
              <div key={entry.id} className="py-1 flex flex-col gap-0.5">
                <div className="flex items-center gap-1">
                  <span className="text-muted text-2xs">
                    {formatTime(entry.timestamp ?? 0, { fallback: "—" })}
                  </span>
                  <span
                    className={`font-semibold text-2xs uppercase ${
                      entry.severity === "error"
                        ? "text-danger"
                        : entry.severity === "warning"
                          ? "text-warn"
                          : "text-muted"
                    }`}
                  >
                    {entry.type}
                  </span>
                </div>
                <div className="text-txt break-all">{entry.message}</div>
              </div>
            ))
        ) : gameLogs.length === 0 ? (
          <div className="text-center py-4 text-muted italic">
            {t("game.noAgentActivity")}
          </div>
        ) : (
          gameLogs.slice(0, 50).map((entry: LogEntry, idx) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: composite key with index as tiebreaker
              key={`${entry.timestamp}-${idx}`}
              className="py-1 flex flex-col gap-0.5"
            >
              <div className="flex items-center gap-1">
                <span className="text-muted text-2xs">
                  {formatTime(entry.timestamp, { fallback: "—" })}
                </span>
                <span
                  className={`font-semibold text-2xs uppercase ${
                    entry.level === "error"
                      ? "text-danger"
                      : entry.level === "warn"
                        ? "text-warn"
                        : "text-muted"
                  }`}
                >
                  {entry.level}
                </span>
                {(entry.tags ?? []).slice(0, 2).map((t: string) => {
                  const c = TAG_COLORS[t];
                  return (
                    <span
                      key={t}
                      className="text-3xs px-1 py-px rounded"
                      style={{
                        background: c ? c.bg : "var(--bg-muted)",
                        color: c ? c.fg : "var(--muted)",
                      }}
                    >
                      {t}
                    </span>
                  );
                })}
              </div>
              <div className="text-txt break-all">{entry.message}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );

  const activeRunSummary =
    activeGameRun?.summary ??
    activeGameRun?.health.message ??
    activeSessionState?.summary ??
    null;
  const gameStatusLabel =
    connectionStatus !== "connected"
      ? connectionStatus === "connecting"
        ? "Starting"
        : "Offline"
      : activeGameRun?.health.state === "offline" ||
          activeGameRun?.health.state === "degraded"
        ? "Needs attention"
        : "Live";
  const gameStatusClass =
    gameStatusLabel === "Live"
      ? "border-ok/30 bg-ok/10 text-ok"
      : gameStatusLabel === "Needs attention"
        ? "border-warn/35 bg-warn/10 text-warn"
        : "border-border/45 bg-bg-hover/70 text-muted-strong";
  const diagnostics = [
    { label: "Connection", value: connectionStatus },
    {
      label: "Viewer",
      value: activeGameRun?.viewerAttachment ?? "unavailable",
    },
    { label: "Health", value: activeGameRun?.health.state ?? "unknown" },
    {
      label: "Chat",
      value: activeGameRun?.chatAvailability ?? "unknown",
    },
    {
      label: "Control",
      value: activeGameRun?.controlAvailability ?? "unknown",
    },
  ];
  const operatorSurfaceFocus =
    isCompactLayout && mobileSurface === "dashboard"
      ? "dashboard"
      : isCompactLayout && mobileSurface === "chat"
        ? "chat"
        : "all";
  const openInNewTabLabel = hasViewer
    ? t("game.openInNewTab")
    : "Open launch URL";
  const renderOpenInNewTabButton = (
    variant: "default" | "outline",
    className?: string,
  ) => {
    if (!openableUrl || isElectrobun) {
      return (
        <Button
          variant={variant}
          size="sm"
          className={className}
          onClick={handleOpenInNewTab}
          disabled={!openableUrl}
        >
          {openInNewTabLabel}
        </Button>
      );
    }

    return (
      <Button asChild variant={variant} size="sm" className={className}>
        <a href={openableUrl} target="_blank" rel="noreferrer">
          {openInNewTabLabel}
        </a>
      </Button>
    );
  };

  const renderViewerPane = () => {
    if (!hasViewer) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
          <div className="text-sm font-semibold text-txt">
            {activeGameDisplayName || activeGameApp}
          </div>
          <div className="max-w-md text-xs leading-6 text-muted">
            This run is alive, but it does not currently expose a viewer URL.
            You can keep steering it from the dashboard and running-runs panel.
          </div>
        </div>
      );
    }

    if (!viewerAttached) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
          <div className="text-sm font-semibold text-txt">Viewer detached</div>
          <div className="max-w-md text-xs leading-6 text-muted">
            The autonomous run is still active. Reattach the viewer to resume
            watching without restarting the session.
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {renderOpenInNewTabButton("outline")}
          </div>
        </div>
      );
    }

    if (useNativeGameWindow) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center bg-bg text-muted gap-3">
          {gameWindowId ? (
            <>
              <span className="text-sm font-semibold text-txt">
                {activeGameDisplayName || activeGameApp}
              </span>
              <span className="text-xs text-muted">
                {t("game.openInNativeWindow")}
              </span>
            </>
          ) : (
            <span className="text-xs italic">{t("common.launching")}</span>
          )}
        </div>
      );
    }

    return (
      <iframe
        ref={iframeRef}
        src={resolvedActiveGameViewerUrl}
        sandbox={activeGameSandbox}
        allow="fullscreen *"
        allowFullScreen
        data-testid="game-view-iframe"
        className="w-full h-full border-none"
        title={
          activeGameDisplayName || t("common.game", { defaultValue: "Game" })
        }
      />
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-3 bg-card px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-sm">
              {activeGameDisplayName || activeGameApp}
            </span>
            <span
              className={`rounded-full border px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] ${gameStatusClass}`}
            >
              {gameStatusLabel}
            </span>
          </div>
          {activeRunSummary ? (
            <div className="mt-1 max-w-3xl truncate text-xs-tight leading-5 text-muted-strong">
              {activeRunSummary}
            </div>
          ) : null}
        </div>
        {sessionControlAction ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="game-session-control"
            className="h-7 text-xs shadow-sm hover:border-accent"
            onClick={() => void handleSessionControl()}
            disabled={sessionBusyAction === sessionControlAction}
          >
            {sessionBusyAction === sessionControlAction
              ? t("gameview.UpdatingSession", {
                  defaultValue: "Updating…",
                })
              : sessionControlAction === "pause"
                ? t("common.pause", { defaultValue: "Pause" })
                : t("common.resume", { defaultValue: "Resume" })}
          </Button>
        ) : null}
        {dashboardPanelEnabled && !isCompactLayout ? (
          <Button
            variant={showLogsPanel ? "default" : "outline"}
            size="sm"
            data-testid="game-toggle-logs"
            className="h-7 text-xs shadow-sm hover:border-accent"
            onClick={() => setShowLogsPanel(!showLogsPanel)}
          >
            {showLogsPanel ? "Hide game chat" : "Show game chat"}
          </Button>
        ) : null}
        <Button
          variant={showDiagnostics ? "default" : "outline"}
          size="sm"
          className="h-7 text-xs shadow-sm hover:border-accent"
          onClick={() => setShowDiagnostics((current) => !current)}
        >
          Details
        </Button>
        {canAttachViewer ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs shadow-sm hover:border-accent"
            onClick={() => void handleAttachViewer()}
            disabled={attachingViewer}
          >
            {attachingViewer ? "Reattaching..." : "Reattach viewer"}
          </Button>
        ) : null}
        {canDetachViewer ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs shadow-sm hover:border-accent"
            onClick={() => void handleDetachViewer()}
            disabled={detachingViewer}
          >
            {detachingViewer ? "Detaching..." : "Detach viewer"}
          </Button>
        ) : null}
        {useNativeGameWindow ? (
          <DesktopGameWindowControls gameWindowId={gameWindowId} />
        ) : null}
        {hasViewer ? (
          <Button
            variant={gameOverlayEnabled ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs shadow-sm hover:border-accent"
            onClick={() => setState("gameOverlayEnabled", !gameOverlayEnabled)}
            title={
              gameOverlayEnabled
                ? t("game.disableOverlay")
                : t("game.keepVisible")
            }
          >
            {gameOverlayEnabled ? t("game.unpinOverlay") : t("game.keepOnTop")}
          </Button>
        ) : null}
        {renderOpenInNewTabButton("default", "h-7 text-xs shadow-sm")}
        <Button
          variant="default"
          size="sm"
          className="h-7 text-xs shadow-sm"
          disabled={stopping}
          onClick={handleStop}
        >
          {stopping ? t("game.stopping") : t("common.stop")}
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-7 text-xs shadow-sm"
          onClick={() => {
            setState("tab", "apps");
            setState("appsSubTab", "browse");
          }}
        >
          {t("game.backToApps")}
        </Button>
      </div>
      {showDiagnostics ? (
        <div className="border-t border-border/30 bg-card/70 px-4 py-2 text-xs-tight leading-5 text-muted-strong">
          <div className="flex flex-wrap gap-2">
            {diagnostics.map((item) => (
              <span
                key={item.label}
                className="rounded-full border border-border/35 bg-bg/65 px-2.5 py-1"
              >
                <span className="text-muted">{item.label}: </span>
                {item.value}
              </span>
            ))}
            {activeGamePostMessageAuth ? (
              <span className="rounded-full border border-border/35 bg-bg/65 px-2.5 py-1">
                {t("gameview.postMessageAuth")}
              </span>
            ) : null}
          </div>
          {activeGameRun?.health.message ? (
            <div className="mt-2">{activeGameRun.health.message}</div>
          ) : null}
        </div>
      ) : null}
      {dashboardPanelEnabled && isCompactLayout ? (
        <div className="flex items-center gap-2 bg-card px-4 py-2">
          <Button
            variant={mobileSurface === "game" ? "default" : "outline"}
            size="sm"
            data-testid="game-mobile-surface-game"
            className="h-8 text-xs shadow-sm"
            onClick={() => setMobileSurface("game")}
          >
            {t("common.game", {
              defaultValue: "Game",
            })}
          </Button>
          <Button
            variant={mobileSurface === "dashboard" ? "default" : "outline"}
            size="sm"
            data-testid="game-mobile-surface-dashboard"
            className="h-8 text-xs shadow-sm"
            onClick={() => setMobileSurface("dashboard")}
          >
            {t("common.actions", {
              defaultValue: "Actions",
            })}
          </Button>
          <Button
            variant={mobileSurface === "chat" ? "default" : "outline"}
            size="sm"
            data-testid="game-mobile-surface-chat"
            className="h-8 text-xs shadow-sm"
            onClick={() => setMobileSurface("chat")}
          >
            {t("nav.chat", {
              defaultValue: "Chat",
            })}
          </Button>
        </div>
      ) : null}
      <div
        className={`flex-1 min-h-0 ${
          isCompactLayout ? "flex flex-col" : "flex"
        }`}
      >
        {!dashboardPanelEnabled ||
        !isCompactLayout ||
        mobileSurface === "game" ? (
          <div className="flex-1 min-h-0 relative">{renderViewerPane()}</div>
        ) : null}
        {(showLogsPanel && dashboardPanelEnabled) ||
        (isCompactLayout &&
          dashboardPanelEnabled &&
          mobileSurface !== "game") ? (
          isCompactLayout ? (
            mobileSurface === "dashboard" || mobileSurface === "chat" ? (
              hasOperatorSurface && OperatorSurface ? (
                <div className="h-full overflow-y-auto">
                  <OperatorSurface
                    appName={activeGameApp}
                    variant="live"
                    focus={operatorSurfaceFocus}
                  />
                </div>
              ) : (
                renderLogsPanel("standalone")
              )
            ) : null
          ) : hasOperatorSurface && OperatorSurface ? (
            <div className="w-[30rem] min-h-0 overflow-y-auto bg-card">
              <OperatorSurface
                appName={activeGameApp}
                variant="live"
                focus="all"
              />
            </div>
          ) : (
            renderLogsPanel()
          )
        ) : null}
      </div>
    </div>
  );
}
