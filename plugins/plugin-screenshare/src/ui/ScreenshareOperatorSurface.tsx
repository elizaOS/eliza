import {
  type AgentElementRole,
  type AppOperatorSurfaceProps,
  Button,
  type ButtonProps,
  client,
  Input,
  type InputProps,
  SurfaceEmptyState,
  SurfaceSection,
  selectLatestRunForApp,
  useApp,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  type LucideIcon,
  MonitorUp,
  PlugZap,
  Power,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildViewerUrl,
  type CapabilitiesResponse,
  fetchJson,
  loadScreenshareTuiState,
  type PublicSession,
  type StartSessionResponse,
} from "./ScreenshareOperatorSurface.helpers";

const APP_NAME = "@elizaos/plugin-screenshare";

function parseViewerSession(
  viewerUrl: string | null | undefined,
): { sessionId: string; token: string } | null {
  if (!viewerUrl) {
    return null;
  }
  try {
    const url = new URL(viewerUrl, window.location.origin);
    const sessionId = url.searchParams.get("sessionId")?.trim();
    const token = url.searchParams.get("token")?.trim();
    return sessionId && token ? { sessionId, token } : null;
  } catch {
    return null;
  }
}

function formatTime(value: string | null): string {
  if (!value) {
    return "Not yet";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not yet" : date.toLocaleTimeString();
}

function ScreenshareMetric({
  icon: Icon,
  label,
  value,
  active,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  active?: boolean;
}) {
  return (
    <div
      className={`flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-lg border px-3 py-2 transition-colors ${
        active ? "border-ok/35 bg-ok/8" : "border-border/35 bg-bg/55"
      }`}
      title={label}
      role="status"
      aria-label={`${label}: ${value}`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            active ? "bg-ok" : "bg-muted/40"
          }`}
          aria-hidden
        />
        <Icon className={`h-3.5 w-3.5 ${active ? "text-ok" : "text-muted"}`} />
      </div>
      <span
        className={`truncate text-sm font-semibold ${
          active ? "text-txt" : "text-muted-strong"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function ScreenshareActionButton({
  agentId,
  label,
  group,
  description,
  status,
  ...buttonProps
}: ButtonProps & {
  agentId: string;
  label: string;
  group: string;
  description: string;
  status?: "active" | "inactive";
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group,
    description,
    ...(status ? { status } : {}),
  });
  return (
    <Button ref={ref} aria-label={label} {...agentProps} {...buttonProps} />
  );
}

function ScreenshareField({
  agentId,
  label,
  group,
  description,
  role = "text-input",
  ...inputProps
}: InputProps & {
  agentId: string;
  label: string;
  group: string;
  description: string;
  role?: AgentElementRole;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role,
    label,
    group,
    description,
    fillable: !inputProps.readOnly,
  });
  return <Input ref={ref} aria-label={label} {...agentProps} {...inputProps} />;
}

export function ScreenshareOperatorSurface({
  appName,
  focus = "all",
}: AppOperatorSurfaceProps) {
  const { appRuns, setActionNotice } = useApp();
  const { run } = useMemo(
    () => selectLatestRunForApp(appName || APP_NAME, appRuns),
    [appName, appRuns],
  );
  const launchedSession = useMemo(
    () => parseViewerSession(run?.viewer?.url),
    [run?.viewer?.url],
  );

  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(
    null,
  );
  const [hostSession, setHostSession] = useState<PublicSession | null>(null);
  const [hostToken, setHostToken] = useState<string>(
    launchedSession?.token ?? "",
  );
  const [remoteBase, setRemoteBase] = useState("");
  const [remoteSessionId, setRemoteSessionId] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const loadCapabilities = useCallback(async () => {
    const next = await fetchJson<CapabilitiesResponse>(
      "/api/apps/screenshare/capabilities",
    );
    setCapabilities(next);
  }, []);

  const loadLaunchedSession = useCallback(async () => {
    if (!launchedSession) {
      return;
    }
    setHostToken(launchedSession.token);
    const next = await fetchJson<{ session: PublicSession }>(
      `/api/apps/screenshare/session/${encodeURIComponent(
        launchedSession.sessionId,
      )}?token=${encodeURIComponent(launchedSession.token)}`,
    );
    setHostSession(next.session);
  }, [launchedSession]);

  useEffect(() => {
    void loadCapabilities().catch((error) => {
      setActionNotice(
        error instanceof Error ? error.message : "Failed to load capabilities.",
        "error",
        3200,
      );
    });
  }, [loadCapabilities, setActionNotice]);

  useEffect(() => {
    void loadLaunchedSession().catch((error) => {
      setActionNotice(
        error instanceof Error
          ? error.message
          : "Failed to load screen share session.",
        "error",
        3200,
      );
    });
  }, [loadLaunchedSession, setActionNotice]);

  const startHostSession = useCallback(async () => {
    setBusy("start");
    try {
      const response = await fetchJson<StartSessionResponse>(
        "/api/apps/screenshare/session",
        {
          method: "POST",
          body: JSON.stringify({ label: "This machine" }),
        },
      );
      setHostSession(response.session);
      setHostToken(response.token);
      setActionNotice("Screen share session started.", "success", 2400);
    } catch (error) {
      setActionNotice(
        error instanceof Error ? error.message : "Failed to start session.",
        "error",
        3600,
      );
    } finally {
      setBusy(null);
    }
  }, [setActionNotice]);

  const stopHostSession = useCallback(async () => {
    if (!hostSession || !hostToken) {
      return;
    }
    setBusy("stop");
    try {
      const response = await fetchJson<{ session: PublicSession }>(
        `/api/apps/screenshare/session/${encodeURIComponent(hostSession.id)}/stop`,
        {
          method: "POST",
          body: JSON.stringify({ token: hostToken }),
          headers: { "X-Screenshare-Token": hostToken },
        },
      );
      setHostSession(response.session);
      setActionNotice("Screen share session stopped.", "success", 2400);
    } catch (error) {
      setActionNotice(
        error instanceof Error ? error.message : "Failed to stop session.",
        "error",
        3600,
      );
    } finally {
      setBusy(null);
    }
  }, [hostSession, hostToken, setActionNotice]);

  const copyHostDetails = useCallback(async () => {
    if (!hostSession || !hostToken) {
      return;
    }
    const url = buildViewerUrl({
      sessionId: hostSession.id,
      token: hostToken,
    });
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            serverUrl: client.getBaseUrl() || window.location.origin,
            sessionId: hostSession.id,
            token: hostToken,
            viewerUrl: url,
          },
          null,
          2,
        ),
      );
      setActionNotice("Screen share details copied.", "success", 1800);
    } catch (error) {
      setActionNotice(
        error instanceof Error ? error.message : "Clipboard write failed.",
        "error",
        3200,
      );
    }
  }, [hostSession, hostToken, setActionNotice]);

  const openViewer = useCallback((url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const hostViewerUrl =
    hostSession && hostToken
      ? buildViewerUrl({ sessionId: hostSession.id, token: hostToken })
      : null;
  const remoteViewerUrl =
    remoteSessionId.trim() && remoteToken.trim()
      ? buildViewerUrl({
          baseUrl: remoteBase,
          sessionId: remoteSessionId.trim(),
          token: remoteToken.trim(),
        })
      : null;

  if (focus === "chat") {
    return (
      <SurfaceEmptyState
        title="Screen Share"
        body="Remote desktop control is available from the actions surface."
      />
    );
  }

  return (
    <section className="flex min-h-0 flex-col gap-3 p-3">
      <SurfaceSection title="Host">
        <div className="grid grid-cols-3 gap-2">
          <ScreenshareMetric
            icon={MonitorUp}
            label="Session"
            value={hostSession?.status ?? "idle"}
            active={hostSession?.status === "active"}
          />
          <ScreenshareMetric
            icon={PlugZap}
            label="Platform"
            value={capabilities?.platform ?? hostSession?.platform ?? "desktop"}
            active={Boolean(capabilities?.platform || hostSession?.platform)}
          />
          <ScreenshareMetric
            icon={
              capabilities?.capabilities.headfulGui?.available
                ? CheckCircle2
                : XCircle
            }
            label="GUI"
            value="GUI"
            active={capabilities?.capabilities.headfulGui?.available}
          />
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <ScreenshareActionButton
            agentId="action-start-host"
            label={
              hostSession?.status === "active"
                ? "Rotate host session"
                : "Start host session"
            }
            group="host"
            description="Start or rotate the screen share session for this machine"
            type="button"
            size="sm"
            variant="default"
            className="h-10 w-full justify-center gap-2"
            onClick={() => void startHostSession()}
            disabled={busy === "start"}
          >
            <MonitorUp className="h-4 w-4" />
            {hostSession?.status === "active"
              ? "Rotate session"
              : "Start session"}
          </ScreenshareActionButton>
          <div className="grid grid-cols-3 gap-2">
            <ScreenshareActionButton
              agentId="action-open-host-viewer"
              label="Open host viewer"
              group="host"
              description="Open the viewer for the host screen share session"
              type="button"
              size="sm"
              variant="outline"
              className="h-9 justify-center gap-1.5"
              onClick={() => hostViewerUrl && openViewer(hostViewerUrl)}
              disabled={!hostViewerUrl}
            >
              <ExternalLink className="h-4 w-4" />
              Open
            </ScreenshareActionButton>
            <ScreenshareActionButton
              agentId="action-copy-host-details"
              label="Copy host details"
              group="host"
              description="Copy the host session connection details to the clipboard"
              type="button"
              size="sm"
              variant="outline"
              className="h-9 justify-center gap-1.5"
              onClick={() => void copyHostDetails()}
              disabled={!hostSession || !hostToken}
            >
              <Copy className="h-4 w-4" />
              Copy
            </ScreenshareActionButton>
            <ScreenshareActionButton
              agentId="action-stop-host"
              label="Stop host session"
              group="host"
              description="Stop the active host screen share session"
              type="button"
              size="sm"
              variant="outline"
              className="h-9 justify-center gap-1.5"
              onClick={() => void stopHostSession()}
              disabled={hostSession?.status !== "active"}
            >
              <Power className="h-4 w-4" />
              Stop
            </ScreenshareActionButton>
          </div>
        </div>

        {hostSession ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <ScreenshareMetric
              icon={MonitorUp}
              label="Frames"
              value={hostSession.frameCount}
              active={hostSession.frameCount > 0}
            />
            <ScreenshareMetric
              icon={PlugZap}
              label="Inputs"
              value={hostSession.inputCount}
              active={hostSession.inputCount > 0}
            />
            <ScreenshareMetric
              icon={RefreshCw}
              label="Last frame"
              value={formatTime(hostSession.lastFrameAt)}
              active={hostSession.lastFrameAt !== null}
            />
            <ScreenshareMetric
              icon={Power}
              label="Last input"
              value={formatTime(hostSession.lastInputAt)}
              active={hostSession.lastInputAt !== null}
            />
          </div>
        ) : null}
      </SurfaceSection>

      <SurfaceSection title="Connect">
        <div className="grid gap-2">
          <ScreenshareField
            agentId="input-remote-base"
            label="Remote server URL"
            group="connect"
            description="Server URL of the remote machine to connect to"
            value={remoteBase}
            onChange={(event) => setRemoteBase(event.target.value)}
            placeholder="Server URL"
            className="h-9 rounded-lg border-border/45 bg-bg/60 text-xs"
          />
          <ScreenshareField
            agentId="input-remote-session"
            label="Remote session id"
            group="connect"
            description="Session id of the remote screen share to connect to"
            value={remoteSessionId}
            onChange={(event) => setRemoteSessionId(event.target.value)}
            placeholder="Session"
            className="h-9 rounded-lg border-border/45 bg-bg/60 text-xs"
          />
          <ScreenshareField
            agentId="input-remote-token"
            label="Remote session token"
            group="connect"
            description="Token of the remote screen share to connect to"
            value={remoteToken}
            onChange={(event) => setRemoteToken(event.target.value)}
            placeholder="Token"
            className="h-9 rounded-lg border-border/45 bg-bg/60 text-xs"
          />
        </div>
        <div className="mt-3 flex gap-2">
          <ScreenshareActionButton
            agentId="action-connect-remote"
            label="Connect to remote"
            group="connect"
            description="Open the viewer for the entered remote screen share"
            type="button"
            size="sm"
            variant={remoteViewerUrl ? "default" : "outline"}
            className="h-10 flex-1 justify-center gap-2"
            onClick={() => remoteViewerUrl && openViewer(remoteViewerUrl)}
            disabled={!remoteViewerUrl}
          >
            <PlugZap className="h-4 w-4" />
            Connect
          </ScreenshareActionButton>
          <ScreenshareActionButton
            agentId="action-refresh-capabilities"
            label="Refresh capabilities"
            group="connect"
            description="Reload the host screen share capabilities"
            type="button"
            size="sm"
            variant="outline"
            className="h-10 w-10 justify-center gap-2 px-0"
            onClick={() => void loadCapabilities()}
            title="Refresh capabilities"
          >
            <RefreshCw className="h-4 w-4" />
          </ScreenshareActionButton>
        </div>
      </SurfaceSection>

      {capabilities ? (
        <SurfaceSection title="Capabilities">
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(capabilities.capabilities).map(
              ([name, capability]) => (
                <div
                  key={name}
                  className="flex min-h-14 items-center justify-center gap-2 rounded-lg border border-border/35 bg-bg/65 px-3 py-2"
                  title={`${name}: ${capability.tool}`}
                >
                  {capability.available ? (
                    <CheckCircle2 className="h-4 w-4 text-ok" />
                  ) : (
                    <XCircle className="h-4 w-4 text-muted" />
                  )}
                  <span
                    className={
                      capability.available
                        ? "truncate text-xs font-semibold text-txt"
                        : "truncate text-xs font-semibold text-muted-strong"
                    }
                  >
                    {name}
                  </span>
                </div>
              ),
            )}
          </div>
        </SurfaceSection>
      ) : null}
    </section>
  );
}

export function ScreenshareTuiView() {
  const [state, setState] = useState<Awaited<
    ReturnType<typeof loadScreenshareTuiState>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refreshElement = useAgentElement<HTMLButtonElement>({
    id: "tui-refresh-sessions",
    role: "button",
    label: "Refresh sessions",
    group: "tui-sessions",
    description: "Reload the screen share sessions and capabilities",
    status: loading ? "loading" : "idle",
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadScreenshareTuiState();
      setState(next);
      setLastAction("refresh");
    } catch (caught) {
      setState(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Screen share refresh failed",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeSessions =
    state?.sessions.sessions.filter((session) => session.status === "active") ??
    [];
  const viewState = {
    viewType: "tui",
    viewId: "screenshare",
    platform: state?.capabilities.platform ?? null,
    sessionCount: state?.sessions.sessions.length ?? 0,
    activeSessionCount: activeSessions.length,
    capabilities: state
      ? Object.fromEntries(
          Object.entries(state.capabilities.capabilities).map(
            ([name, capability]) => [name, capability.available],
          ),
        )
      : {},
    loading,
    lastAction,
    error,
  };

  return (
    <div
      data-view-state={JSON.stringify(viewState)}
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "#7dd3fc", marginBottom: 4 }}>
        elizaos://screenshare --type=tui
      </div>
      <div
        data-status={loading ? "loading" : "ready"}
        style={{ color: "#475569", marginBottom: 16 }}
      >
        {loading ? "loading" : (state?.capabilities.platform ?? "unknown")} |{" "}
        {activeSessions.length} active sessions | {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 16,
        }}
      >
        <section
          aria-label="Screen share sessions"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <strong style={{ color: "#e2e8f0" }}>sessions</strong>
            <button
              ref={refreshElement.ref}
              type="button"
              aria-label="Refresh sessions"
              onClick={() => void refresh()}
              disabled={loading}
              style={{
                background: "transparent",
                color: "#a7f3d0",
                border: "1px solid rgba(167,243,208,0.45)",
                borderRadius: 4,
                padding: "4px 8px",
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
              {...refreshElement.agentProps}
            >
              refresh
            </button>
          </div>
          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
          {(state?.sessions.sessions ?? []).map((session) => (
            <div
              key={session.id}
              style={{
                borderTop: "1px solid rgba(125,211,252,0.14)",
                padding: "8px 0",
              }}
            >
              <div style={{ color: "#e2e8f0" }}>
                {session.id} / {session.status}
              </div>
              <div style={{ color: "#94a3b8" }}>
                {session.label} frames {session.frameCount} inputs{" "}
                {session.inputCount}
              </div>
              <div style={{ color: "#64748b" }}>
                last frame {formatTime(session.lastFrameAt)} / last input{" "}
                {formatTime(session.lastInputAt)}
              </div>
            </div>
          ))}
        </section>

        <section
          aria-label="Screen share capabilities"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>capabilities</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            {
              Object.values(state?.capabilities.capabilities ?? {}).filter(
                (capability) => capability.available,
              ).length
            }{" "}
            live / {state?.sessions.length ?? 0} sessions
          </div>
          <div>
            <span style={{ color: "#64748b" }}>platform</span>{" "}
            {state?.capabilities.platform ?? "unknown"}
          </div>
          {Object.entries(state?.capabilities.capabilities ?? {}).map(
            ([name, capability]) => (
              <div key={name} style={{ padding: "6px 0" }}>
                <span
                  style={{
                    color: capability.available ? "#a7f3d0" : "#fca5a5",
                  }}
                >
                  {capability.available ? "ok" : "off"}
                </span>{" "}
                {name} via {capability.tool}
              </div>
            ),
          )}
        </section>
      </div>
    </div>
  );
}
