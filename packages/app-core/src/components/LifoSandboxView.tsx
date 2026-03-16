import { useCallback, useEffect, useRef, useState } from "react";
import "@elizaos/app-core/styles/xterm.css";
import {
  client,
  type SandboxBrowserEndpoints,
  type SandboxWindowInfo,
} from "@elizaos/app-core/api";
import { LifoMonitorPanel } from "@elizaos/app-core/components";
import { useLifoSync } from "@elizaos/app-core/hooks";
import {
  createLifoRuntime,
  generateLifoSessionId,
  isSafeEndpointUrl,
  type LifoRuntime,
  normalizeTerminalText,
} from "@elizaos/app-core/platform";
import { useApp } from "@elizaos/app-core/state";

interface TerminalOutputEvent {
  event?: unknown;
  command?: unknown;
}

const MONITOR_SCREENSHOT_POLL_MS = 1800;
const MONITOR_META_POLL_MS = 10000;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function LifoSandboxView({ inModal }: { inModal?: boolean } = {}) {
  const { t } = useApp();
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const explorerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<LifoRuntime | null>(null);
  const queueRef = useRef<string[]>([]);
  const runningRef = useRef(false);
  const controllerHeartbeatAtRef = useRef(0);

  const [booting, setBooting] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [runCount, setRunCount] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);

  const popoutMode = false;
  const [lifoSessionId] = useState(() => generateLifoSessionId());
  const [controllerOnline, setControllerOnline] = useState(false);
  const controllerOnlineRef = useRef(false);
  controllerOnlineRef.current = controllerOnline;
  const [monitorOnline, setMonitorOnline] = useState(false);
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const [monitorUpdatedAt, setMonitorUpdatedAt] = useState<number | null>(null);
  const [browserEndpoints, setBrowserEndpoints] =
    useState<SandboxBrowserEndpoints | null>(null);
  const [sandboxWindows, setSandboxWindows] = useState<SandboxWindowInfo[]>([]);
  const [noVncFailed, setNoVncFailed] = useState(false);
  const [screenPreviewBase64, setScreenPreviewBase64] = useState<string | null>(
    null,
  );

  const appendOutput = useCallback((line: string) => {
    setOutput((prev) => {
      const next = [...prev, line];
      return next.slice(-600);
    });
  }, []);

  const screenPreviewUrl = screenPreviewBase64
    ? `data:image/png;base64,${screenPreviewBase64}`
    : null;
  const noVncEndpoint = browserEndpoints?.noVncEndpoint ?? null;
  const safeNoVncEndpoint =
    noVncEndpoint && isSafeEndpointUrl(noVncEndpoint) ? noVncEndpoint : null;
  const noVncActive = Boolean(safeNoVncEndpoint) && !noVncFailed;

  const { broadcastSyncMessage } = useLifoSync({
    popoutMode,
    lifoSessionId,
    runtimeRef,
    appendOutput,
    setRunCount,
    setSessionKey,
    setControllerOnline,
    controllerHeartbeatAtRef,
  });

  const teardown = useCallback(() => {
    try {
      const term = runtimeRef.current?.terminal;
      if (term && "dispose" in term) {
        (term as { dispose(): void }).dispose();
      }
    } catch {
      // Ignore terminal disposal failures.
    }
    try {
      runtimeRef.current?.explorer.destroy();
    } catch {
      // Ignore teardown failures.
    }

    runtimeRef.current = null;
    queueRef.current = [];
    runningRef.current = false;

    if (terminalRef.current) {
      terminalRef.current.innerHTML = "";
    }
    if (explorerRef.current) {
      explorerRef.current.innerHTML = "";
    }
  }, []);

  const runQueuedCommands = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || runningRef.current) return;

    runningRef.current = true;

    try {
      while (queueRef.current.length > 0) {
        const command = queueRef.current.shift();
        if (!command) continue;

        runtime.terminal.writeln(`$ ${command}`);
        appendOutput(`$ ${command}`);
        setRunCount((prev) => prev + 1);
        broadcastSyncMessage({ type: "command-start", command });

        try {
          const result = await runtime.shell.execute(command, {
            onStdout: (chunk: string) => {
              runtime.terminal.write(normalizeTerminalText(chunk));
              const trimmed = chunk.trimEnd();
              if (trimmed) appendOutput(trimmed);
              broadcastSyncMessage({ type: "stdout", chunk });
            },
            onStderr: (chunk: string) => {
              runtime.terminal.write(normalizeTerminalText(chunk));
              const trimmed = chunk.trimEnd();
              if (trimmed) appendOutput(`stderr: ${trimmed}`);
              broadcastSyncMessage({ type: "stderr", chunk });
            },
          });

          runtime.terminal.writeln(`[exit ${result.exitCode}]`);
          appendOutput(`[exit ${result.exitCode}]`);
          broadcastSyncMessage({
            type: "command-exit",
            exitCode: result.exitCode,
          });
        } catch (err) {
          const message = formatError(err);
          runtime.terminal.writeln(`error: ${message}`);
          appendOutput(`error: ${message}`);
          broadcastSyncMessage({ type: "command-error", message });
        }

        try {
          runtime.explorer.refresh();
        } catch {
          // Keep processing command queue even if explorer refresh fails.
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [appendOutput, broadcastSyncMessage]);

  const enqueueAgentCommand = useCallback(
    (command: string) => {
      const trimmed = command.trim();
      if (!trimmed) return;
      queueRef.current.push(trimmed);
      void runQueuedCommands();
    },
    [runQueuedCommands],
  );

  const refreshMonitorMeta = useCallback(async () => {
    if (popoutMode) return;
    try {
      const [browser, windowsResponse] = await Promise.all([
        client.getSandboxBrowser(),
        client.getSandboxWindows(),
      ]);
      setBrowserEndpoints(browser);
      if (!browser.noVncEndpoint) {
        setNoVncFailed(false);
      }
      setSandboxWindows(
        Array.isArray(windowsResponse.windows) ? windowsResponse.windows : [],
      );
      setMonitorError(null);
    } catch (err) {
      setMonitorError(formatError(err));
    }
  }, []);

  const refreshScreenPreview = useCallback(async () => {
    if (popoutMode) return;
    if (noVncActive) return;
    try {
      const screenshot = await client.getSandboxScreenshot();
      if (typeof screenshot.data !== "string" || !screenshot.data.trim()) {
        throw new Error("Sandbox screenshot response was empty");
      }
      setScreenPreviewBase64(screenshot.data);
      setMonitorUpdatedAt(Date.now());
      setMonitorOnline(true);
      setMonitorError(null);
    } catch (err) {
      setMonitorOnline(false);
      setMonitorError(formatError(err));
    }
  }, [noVncActive]);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      const terminalElement = terminalRef.current;
      const explorerElement = explorerRef.current;
      if (!terminalElement || !explorerElement) return;

      teardown();
      setBooting(true);
      setReady(false);
      setError(null);
      setOutput([`Starting Lifo session #${sessionKey + 1}...`]);
      setRunCount(0);

      try {
        const runtime = await createLifoRuntime(
          terminalElement,
          explorerElement,
        );
        if (cancelled) {
          try {
            runtime.explorer.destroy();
          } catch {
            // Ignore cleanup failure on cancelled boot.
          }
          return;
        }

        runtimeRef.current = runtime;
        runtime.terminal.writeln(
          "Lifo runtime ready. Waiting for agent commands...",
        );
        appendOutput("Lifo runtime ready. Waiting for agent commands...");
        setReady(true);

        void runQueuedCommands();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setBooting(false);
      }
    };

    void initialize();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [appendOutput, runQueuedCommands, sessionKey, teardown]);

  useEffect(() => {
    if (popoutMode) return;

    let cancelled = false;
    let previewInterval: number | null = null;
    let metaInterval: number | null = null;

    const refreshMeta = async () => {
      if (cancelled) return;
      await refreshMonitorMeta();
    };
    const refreshPreview = async () => {
      if (cancelled) return;
      await refreshScreenPreview();
    };

    const startPolling = () => {
      stopPolling();
      void refreshMeta();
      void refreshPreview();
      previewInterval = window.setInterval(() => {
        void refreshPreview();
      }, MONITOR_SCREENSHOT_POLL_MS);
      metaInterval = window.setInterval(() => {
        void refreshMeta();
      }, MONITOR_META_POLL_MS);
    };

    const stopPolling = () => {
      if (previewInterval) window.clearInterval(previewInterval);
      if (metaInterval) window.clearInterval(metaInterval);
      previewInterval = null;
      metaInterval = null;
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        startPolling();
      } else {
        stopPolling();
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshMonitorMeta, refreshScreenPreview]);

  useEffect(() => {
    const unbind = client.onWsEvent(
      "terminal-output",
      (data: Record<string, unknown>) => {
        const event = data as TerminalOutputEvent;
        if (event.event !== "start") return;
        if (typeof event.command !== "string" || !event.command.trim()) return;
        if (!popoutMode && controllerOnlineRef.current) {
          // A dedicated popout controller is active; watcher mirrors via sync.
          return;
        }
        enqueueAgentCommand(event.command);
      },
    );

    return unbind;
  }, [enqueueAgentCommand]);

  const resetSession = useCallback(() => {
    setSessionKey((value) => value + 1);
    broadcastSyncMessage({ type: "session-reset" });
  }, [broadcastSyncMessage]);

  const panelCls = inModal
    ? "rounded-xl border border-[var(--border)] overflow-hidden bg-[rgba(255,255,255,0.04)] backdrop-blur-sm"
    : "rounded-xl border border-border overflow-hidden bg-panel";
  const headerCls = inModal
    ? "rounded-xl border border-[var(--border)] bg-[rgba(255,255,255,0.04)] backdrop-blur-sm p-3"
    : "rounded-xl border border-border bg-panel p-3";
  const badgeCls = inModal
    ? "rounded-full px-2 py-1 text-[11px] font-medium bg-[rgba(255,255,255,0.06)] border border-[var(--border)] text-[var(--muted)]"
    : "rounded-full px-2 py-1 text-[11px] font-medium bg-card border border-border text-muted";
  const btnCls = inModal
    ? "px-3 py-1.5 rounded-md border border-[var(--border)] bg-[rgba(255,255,255,0.06)] text-xs text-[var(--txt)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
    : "px-3 py-1.5 rounded-md border border-border bg-card text-xs text-txt hover:border-accent hover:text-txt transition-colors";

  return (
    <section
      className={`h-full flex flex-col gap-3 ${inModal ? "p-4" : "min-h-[620px]"}`}
    >
      <header className={headerCls}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2
              className={`text-sm font-semibold ${inModal ? "text-[var(--txt)]" : "text-txt"}`}
            >
              Lifo Agent Surface
            </h2>
            <p
              className={`mt-1 text-xs ${inModal ? "text-[var(--muted)]" : "text-muted"}`}
            >
              Embedded Lifo watcher. Agent commands execute here in real time.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                error
                  ? "bg-danger/20 text-danger"
                  : ready
                    ? "bg-ok/20 text-ok"
                    : "bg-warn/20 text-warn"
              }`}
            >
              {error ? "error" : ready ? "ready" : "booting"}
            </span>

            <span className={badgeCls}>embedded</span>

            <button type="button" onClick={resetSession} className={btnCls}>
              {t("lifosandboxview.Reset")}
            </button>
          </div>
        </div>

        <div
          className={`mt-2 text-[11px] ${inModal ? "text-[var(--muted)]" : "text-muted"}`}
        >
          {t("lifosandboxview.AgentCommandsRepla")}{" "}
          <span className={inModal ? "text-[var(--txt)]" : "text-txt"}>
            {runCount}
          </span>
        </div>

        {error && (
          <p className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
            {error}
          </p>
        )}
      </header>

      <div className="grid flex-1 min-h-[360px] grid-cols-1 xl:grid-cols-[360px_1fr] gap-3">
        <div
          className={`${panelCls} min-h-[280px] ${
            popoutMode ? "" : "pointer-events-none select-none"
          }`}
        >
          <div
            className={`px-3 py-2 text-xs font-semibold border-b ${
              inModal
                ? "border-[var(--border)] text-[var(--txt)]"
                : "border-border text-txt"
            }`}
          >
            {t("lifosandboxview.Explorer")}
          </div>
          <div ref={explorerRef} className="h-[calc(100%-37px)] w-full" />
        </div>
        <div
          className={`${panelCls} min-h-[280px] ${
            popoutMode ? "" : "pointer-events-none select-none"
          }`}
        >
          <div
            className={`px-3 py-2 text-xs font-semibold border-b ${
              inModal
                ? "border-[var(--border)] text-[var(--txt)]"
                : "border-border text-txt"
            }`}
          >
            {t("lifosandboxview.Terminal")}
          </div>
          <div ref={terminalRef} className="h-[calc(100%-37px)] w-full" />
        </div>
      </div>

      <LifoMonitorPanel
        monitorOnline={monitorOnline}
        monitorError={monitorError}
        monitorUpdatedAt={monitorUpdatedAt}
        noVncActive={noVncActive}
        safeNoVncEndpoint={safeNoVncEndpoint}
        noVncFailed={noVncFailed}
        setNoVncFailed={setNoVncFailed}
        screenPreviewUrl={screenPreviewUrl}
        browserEndpoints={browserEndpoints}
        sandboxWindows={sandboxWindows}
        noVncEndpoint={noVncEndpoint}
        refreshMonitorMeta={refreshMonitorMeta}
        refreshScreenPreview={refreshScreenPreview}
        setMonitorOnline={setMonitorOnline}
        setMonitorError={setMonitorError}
      />

      <div
        className={`${
          inModal
            ? "rounded-xl border border-[var(--border)] bg-[rgba(255,255,255,0.04)] backdrop-blur-sm"
            : "rounded-xl border border-border bg-panel"
        } p-3 min-h-[140px] max-h-[220px] overflow-auto`}
      >
        <div
          className={`text-xs font-semibold ${inModal ? "text-[var(--txt)]" : "text-txt"}`}
        >
          {t("lifosandboxview.AgentReplayLog")}
        </div>
        <pre
          className={`mt-2 whitespace-pre-wrap break-words text-[11px] font-mono ${
            inModal ? "text-[var(--muted)]" : "text-muted"
          }`}
        >
          {output.length > 0
            ? output.join("\n")
            : booting
              ? "Booting Lifo..."
              : "Waiting for the agent to run a terminal command."}
        </pre>
      </div>
    </section>
  );
}
