import type { AppOperatorSurfaceProps } from "@elizaos/app-core";
import {
  Button,
  client,
  Input,
  SurfaceBadge,
  SurfaceEmptyState,
  SurfaceSection,
  selectLatestRunForApp,
  useApp,
} from "@elizaos/app-core";
import {
  Copy,
  ExternalLink,
  MonitorUp,
  PlugZap,
  Power,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface Capability {
  available: boolean;
  tool: string;
}

interface CapabilitiesResponse {
  platform: string;
  capabilities: Record<string, Capability>;
}

interface PublicSession {
  id: string;
  label: string;
  status: "active" | "stopped";
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  platform: string;
  frameCount: number;
  inputCount: number;
  lastFrameAt: string | null;
  lastInputAt: string | null;
}

interface StartSessionResponse {
  session: PublicSession;
  token: string;
  viewerUrl: string;
}

const APP_NAME = "@elizaos/app-screenshare";

function apiUrl(path: string): string {
  const base = client.getBaseUrl();
  return base ? `${base}${path}` : path;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = client.getRestAuthToken();
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

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

function buildViewerUrl(args: {
  baseUrl?: string;
  sessionId: string;
  token: string;
}): string {
  const params = new URLSearchParams({
    sessionId: args.sessionId,
    token: args.token,
  });
  const base = args.baseUrl?.trim().replace(/\/+$/, "") ?? "";
  if (base) {
    params.set("remoteBase", base);
    return `${base}/api/apps/screenshare/viewer?${params.toString()}`;
  }
  return apiUrl(`/api/apps/screenshare/viewer?${params.toString()}`);
}

function formatTime(value: string | null): string {
  if (!value) {
    return "Not yet";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not yet" : date.toLocaleTimeString();
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
        <div className="flex flex-wrap items-center gap-2">
          <SurfaceBadge
            tone={hostSession?.status === "active" ? "success" : "neutral"}
          >
            {hostSession?.status ?? "idle"}
          </SurfaceBadge>
          <SurfaceBadge tone="neutral">
            {capabilities?.platform ?? hostSession?.platform ?? "desktop"}
          </SurfaceBadge>
          {capabilities?.capabilities.headfulGui ? (
            <SurfaceBadge
              tone={
                capabilities.capabilities.headfulGui.available
                  ? "success"
                  : "warn"
              }
            >
              GUI
            </SurfaceBadge>
          ) : null}
        </div>

        <div className="mt-3 grid gap-2">
          <Input
            value={hostSession?.id ?? ""}
            readOnly
            placeholder="Session"
            className="h-9 bg-bg text-xs"
          />
          <Input
            value={hostToken}
            readOnly
            placeholder="Token"
            className="h-9 bg-bg text-xs"
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-9 gap-2"
            onClick={() => void startHostSession()}
            disabled={busy === "start"}
          >
            <MonitorUp className="h-4 w-4" />
            {hostSession?.status === "active" ? "Rotate" : "Start"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 gap-2"
            onClick={() => hostViewerUrl && openViewer(hostViewerUrl)}
            disabled={!hostViewerUrl}
          >
            <ExternalLink className="h-4 w-4" />
            Open
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 gap-2"
            onClick={() => void copyHostDetails()}
            disabled={!hostSession || !hostToken}
          >
            <Copy className="h-4 w-4" />
            Copy
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 gap-2"
            onClick={() => void stopHostSession()}
            disabled={!hostSession || hostSession.status !== "active"}
          >
            <Power className="h-4 w-4" />
            Stop
          </Button>
        </div>

        {hostSession ? (
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs-tight text-muted-strong">
            <span>Frames: {hostSession.frameCount}</span>
            <span>Inputs: {hostSession.inputCount}</span>
            <span>Frame: {formatTime(hostSession.lastFrameAt)}</span>
            <span>Input: {formatTime(hostSession.lastInputAt)}</span>
          </div>
        ) : null}
      </SurfaceSection>

      <SurfaceSection title="Connect">
        <div className="grid gap-2">
          <Input
            value={remoteBase}
            onChange={(event) => setRemoteBase(event.target.value)}
            placeholder="Server URL"
            className="h-9 bg-bg text-xs"
          />
          <Input
            value={remoteSessionId}
            onChange={(event) => setRemoteSessionId(event.target.value)}
            placeholder="Session"
            className="h-9 bg-bg text-xs"
          />
          <Input
            value={remoteToken}
            onChange={(event) => setRemoteToken(event.target.value)}
            placeholder="Token"
            className="h-9 bg-bg text-xs"
          />
        </div>
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-9 flex-1 gap-2"
            onClick={() => remoteViewerUrl && openViewer(remoteViewerUrl)}
            disabled={!remoteViewerUrl}
          >
            <PlugZap className="h-4 w-4" />
            Connect
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 gap-2"
            onClick={() => void loadCapabilities()}
            aria-label="Refresh capabilities"
            title="Refresh capabilities"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </SurfaceSection>

      {capabilities ? (
        <SurfaceSection title="Capabilities">
          <div className="grid gap-2">
            {Object.entries(capabilities.capabilities).map(
              ([name, capability]) => (
                <div
                  key={name}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/35 bg-bg/65 px-3 py-2 text-xs"
                >
                  <span className="font-medium text-txt">{name}</span>
                  <span
                    className={
                      capability.available ? "text-ok" : "text-muted-strong"
                    }
                  >
                    {capability.tool}
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
