/**
 * ScreenshareView — the single GUI/XR data wrapper for the Screen Share surface.
 *
 * It owns the live operator data (capability fetch + poll, launched-session
 * load, host start/stop/rotate, copy/open-viewer, remote connect, refresh) and
 * renders the one presentational {@link ScreenshareSpatialView} inside a
 * {@link SpatialSurface}. Omitting the `modality` prop lets `SpatialSurface`
 * auto-detect GUI vs XR via `window.__elizaXRContext`, so the SAME component
 * serves both surfaces. The TUI surface renders the same `ScreenshareSpatialView`
 * through the terminal registry (see `register-terminal-view.tsx`).
 */

import { client, selectLatestRunForApp, useAppSelector } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/components/ui/button";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildViewerUrl,
  type CapabilitiesResponse,
  fetchJson,
  type PublicSession,
  type StartSessionResponse,
} from "../ui/screenshare-helpers.ts";
import {
  type ScreenshareCapabilitySnapshot,
  type ScreenshareSnapshot,
  ScreenshareSpatialView,
} from "./ScreenshareSpatialView.tsx";

const APP_NAME = "@elizaos/plugin-screenshare";

const CONTROL_BTN =
  "inline-flex items-center justify-center rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-strong transition-colors hover:bg-bg-hover hover:text-txt disabled:pointer-events-none disabled:opacity-50";

/** Short clock time, or null when the underlying timestamp is absent. */
function formatTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString();
}

/** Pull the launched session id + token out of a run's viewer URL. */
function parseViewerSession(
  viewerUrl: string | null | undefined,
): { sessionId: string; token: string } | null {
  if (!viewerUrl) return null;
  try {
    const url = new URL(viewerUrl, window.location.origin);
    const sessionId = url.searchParams.get("sessionId")?.trim();
    const token = url.searchParams.get("token")?.trim();
    return sessionId && token ? { sessionId, token } : null;
  } catch {
    return null;
  }
}

function toCapabilitySnapshots(
  capabilities: CapabilitiesResponse | null,
): ScreenshareCapabilitySnapshot[] {
  if (!capabilities) return [];
  return Object.entries(capabilities.capabilities).map(
    ([name, capability]) => ({
      name,
      available: capability.available,
      tool: capability.tool,
    }),
  );
}

export function ScreenshareView() {
  const appRuns = useAppSelector((s) => s.appRuns);
  const { run } = useMemo(
    () => selectLatestRunForApp(APP_NAME, appRuns),
    [appRuns],
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCapabilities = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchJson<CapabilitiesResponse>(
        "/api/apps/screenshare/capabilities",
      );
      setCapabilities(next);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to load capabilities.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Load capabilities on mount, then keep them fresh with a quiet poll.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoadedRef.current) {
      autoLoadedRef.current = true;
      void loadCapabilities();
    }
    const interval = setInterval(() => {
      void loadCapabilities();
    }, 20_000);
    return () => clearInterval(interval);
  }, [loadCapabilities]);

  // When launched with a viewer URL, hydrate the host session it points at.
  useEffect(() => {
    if (!launchedSession) return;
    setHostToken(launchedSession.token);
    void fetchJson<{ session: PublicSession }>(
      `/api/apps/screenshare/session/${encodeURIComponent(
        launchedSession.sessionId,
      )}?token=${encodeURIComponent(launchedSession.token)}`,
    )
      .then((next) => setHostSession(next.session))
      .catch((caught) =>
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to load screen share session.",
        ),
      );
  }, [launchedSession]);

  const startHostSession = useCallback(async () => {
    setBusy("start");
    setError(null);
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
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to start session.",
      );
    } finally {
      setBusy(null);
    }
  }, []);

  const stopHostSession = useCallback(async () => {
    if (!hostSession || !hostToken) return;
    setBusy("stop");
    setError(null);
    try {
      const response = await fetchJson<{ session: PublicSession }>(
        `/api/apps/screenshare/session/${encodeURIComponent(
          hostSession.id,
        )}/stop`,
        {
          method: "POST",
          body: JSON.stringify({ token: hostToken }),
          headers: { "X-Screenshare-Token": hostToken },
        },
      );
      setHostSession(response.session);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to stop session.",
      );
    } finally {
      setBusy(null);
    }
  }, [hostSession, hostToken]);

  const copyHostDetails = useCallback(async () => {
    if (!hostSession || !hostToken) return;
    const viewerUrl = buildViewerUrl({
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
            viewerUrl,
          },
          null,
          2,
        ),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Clipboard write failed.",
      );
    }
  }, [hostSession, hostToken]);

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

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("remote-base:")) {
        setRemoteBase(action.slice("remote-base:".length));
        return;
      }
      if (action.startsWith("remote-session:")) {
        setRemoteSessionId(action.slice("remote-session:".length));
        return;
      }
      if (action.startsWith("remote-token:")) {
        setRemoteToken(action.slice("remote-token:".length));
        return;
      }
      switch (action) {
        case "start":
        case "rotate":
          void startHostSession();
          return;
        case "stop":
          void stopHostSession();
          return;
        case "copy":
          void copyHostDetails();
          return;
        case "open-viewer":
          if (hostViewerUrl) {
            window.open(hostViewerUrl, "_blank", "noopener,noreferrer");
          }
          return;
        case "connect":
          if (remoteViewerUrl) {
            window.open(remoteViewerUrl, "_blank", "noopener,noreferrer");
          }
          return;
        case "refresh":
          void loadCapabilities();
          return;
      }
    },
    [
      copyHostDetails,
      hostViewerUrl,
      loadCapabilities,
      remoteViewerUrl,
      startHostSession,
      stopHostSession,
    ],
  );

  const isActive = hostSession?.status === "active";

  const sessionToggle = useAgentElement<HTMLButtonElement>({
    id: "screenshare-session-toggle",
    role: "button",
    label: isActive ? "Stop host session" : "Start host session",
    group: "screenshare-operator",
    description: "Start or stop the local screen-share host session",
    status: isActive ? "active" : "inactive",
    onActivate: () => onAction(isActive ? "stop" : "start"),
  });

  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "screenshare-refresh",
    role: "button",
    label: "Refresh capabilities",
    group: "screenshare-operator",
    description: "Reload the screen-share capability snapshot",
    status: loading ? "active" : "inactive",
    onActivate: () => onAction("refresh"),
  });

  const snapshot: ScreenshareSnapshot = {
    platform: capabilities?.platform ?? hostSession?.platform ?? "desktop",
    session: hostSession
      ? {
          id: hostSession.id,
          label: hostSession.label,
          status: hostSession.status,
          platform: hostSession.platform,
          frameCount: hostSession.frameCount,
          inputCount: hostSession.inputCount,
          lastFrameAt: formatTime(hostSession.lastFrameAt),
          lastInputAt: formatTime(hostSession.lastInputAt),
        }
      : null,
    capabilities: toCapabilitySnapshots(capabilities),
    host: hostViewerUrl
      ? {
          token: hostToken,
          sessionId: hostSession?.id ?? "",
          baseUrl: client.getBaseUrl() || "",
        }
      : null,
    // Always reflect the live draft so the connect fields render what the user
    // typed; the spatial view derives Connect-enablement from session + token.
    remote:
      remoteBase || remoteSessionId || remoteToken
        ? {
            token: remoteToken,
            sessionId: remoteSessionId,
            baseUrl: remoteBase,
          }
        : null,
    loading,
    busy,
    error,
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <Button
          unstyled
          type="button"
          ref={sessionToggle.ref}
          {...sessionToggle.agentProps}
          onClick={() => onAction(isActive ? "stop" : "start")}
          disabled={busy === "start" || busy === "stop"}
          aria-pressed={isActive}
          className={`${CONTROL_BTN}${isActive ? " border-accent/50 text-accent" : ""}`}
        >
          {isActive ? "Stop host session" : "Start host session"}
        </Button>
        <Button
          unstyled
          type="button"
          ref={refreshControl.ref}
          {...refreshControl.agentProps}
          onClick={() => onAction("refresh")}
          disabled={loading}
          aria-label="Refresh capabilities"
          className={CONTROL_BTN}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <ScreenshareSpatialView snapshot={snapshot} onAction={onAction} />
    </div>
  );
}
