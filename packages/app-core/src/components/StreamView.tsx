/**
 * StreamView — Dynamic agent activity screen for live streaming.
 *
 * Shows what the agent is actively doing as the primary content:
 * - Terminal output when running commands
 * - Game iframe when playing a game
 * - Chat exchanges when conversing
 * - Activity dashboard when idle
 *
 * VRM avatar floats as a small picture-in-picture overlay (bottom-left).
 * Activity feed runs along the right sidebar. Chat ticker at the bottom.
 */

import { client, isApiError } from "@elizaos/app-core/api";
import { isElectrobunRuntime } from "@elizaos/app-core/bridge";
import { useApp } from "@elizaos/app-core/state";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityFeed } from "./stream/ActivityFeed";
import { AvatarPip } from "./stream/AvatarPip";
import { ChatContent } from "./stream/ChatContent";
import { ChatTicker } from "./stream/ChatTicker";
import {
  type AgentMode,
  CHAT_ACTIVE_WINDOW_MS,
  FULL_SIZE,
  IS_POPOUT,
  PIP_SIZE,
  type StreamSourceType,
  TERMINAL_ACTIVE_WINDOW_MS,
} from "./stream/helpers";
import { IdleContent } from "./stream/IdleContent";
import { OverlayLayer } from "./stream/overlays/OverlayLayer";
import { useOverlayLayout } from "./stream/overlays/useOverlayLayout";
import { StatusBar } from "./stream/StatusBar";
import { StreamSettings } from "./stream/StreamSettings";
import { StreamTerminal } from "./stream/StreamTerminal";
import { StreamVoiceConfig } from "./stream/StreamVoiceConfig";

// ---------------------------------------------------------------------------
// StreamView
// ---------------------------------------------------------------------------

export function StreamView({ inModal }: { inModal?: boolean } = {}) {
  const {
    agentStatus,
    autonomousEvents,
    conversationMessages,
    activeGameViewerUrl,
    activeGameSandbox,
    chatAvatarSpeaking,
    t,
  } = useApp();

  const agentName = agentStatus?.agentName ?? "Milady";
  const isElectrobun = isElectrobunRuntime();

  // ── Stream status polling ─────────────────────────────────────────────
  const [streamLive, setStreamLive] = useState(false);
  const [streamLoading, setStreamLoading] = useState(false);
  const loadingRef = useRef(false);

  const [streamAvailable, setStreamAvailable] = useState(true);

  // ── Volume / mute ───────────────────────────────────────────────────
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);

  // ── Destinations ────────────────────────────────────────────────────
  const [destinations, setDestinations] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [activeDestination, setActiveDestination] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // ── Health stats ────────────────────────────────────────────────────
  const [uptime, setUptime] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [audioSource, setAudioSource] = useState("");

  // ── Stream source ─────────────────────────────────────────────────
  const [streamSource, setStreamSource] = useState<{
    type: StreamSourceType;
    url?: string;
  }>({ type: "stream-tab" });

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      if (loadingRef.current || !streamAvailable) return;
      try {
        const status = await client.streamStatus();
        if (mounted && !loadingRef.current) {
          setStreamLive(status.running && status.ffmpegAlive);
          setVolume(status.volume);
          setMuted(status.muted);
          setUptime(status.uptime);
          setFrameCount(status.frameCount);
          setAudioSource(status.audioSource);
          if (status.destination) setActiveDestination(status.destination);
        }
      } catch (err: unknown) {
        // 404 means stream routes are not configured — stop polling
        if (isApiError(err) && err.status === 404) {
          setStreamAvailable(false);
          return;
        }
        // Other errors — API not yet available, leave as offline
      }
    };
    if (!streamAvailable) return;
    poll();
    const id = setInterval(poll, 5_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [streamAvailable]);

  // ── Auto-detect game source ─────────────────────────────────────────
  useEffect(() => {
    if (!streamLive) return;
    let cancelled = false;
    if (activeGameViewerUrl.trim() && streamSource.type !== "game") {
      client
        .setStreamSource("game", activeGameViewerUrl)
        .then((result) => {
          if (!cancelled && result.ok) {
            setStreamSource({ type: "game", url: activeGameViewerUrl });
          }
        })
        .catch(() => { });
    } else if (!activeGameViewerUrl.trim() && streamSource.type === "game") {
      client
        .setStreamSource("stream-tab")
        .then((result) => {
          if (!cancelled && result.ok) {
            setStreamSource({ type: "stream-tab" });
          }
        })
        .catch(() => { });
    }
    return () => {
      cancelled = true;
    };
  }, [activeGameViewerUrl, streamLive, streamSource.type]);

  const toggleStream = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setStreamLoading(true);
    try {
      if (streamLive) {
        await client.streamGoOffline();
        setStreamLive(false);
      } else {
        const result = await client.streamGoLive();
        setStreamLive(result.live);

        // Browser popout is only meaningful on the web. Electrobun now captures
        // the native app window directly, so a renderer popup no longer changes
        // the capture target and should not be opened on desktop.
        if (result.live && !IS_POPOUT && !isElectrobun) {
          const apiBase = (window as unknown as Record<string, unknown>)
            .__MILADY_API_BASE__ as string | undefined;
          const base = window.location.origin || "";
          const sep =
            window.location.protocol === "file:" ||
              window.location.protocol === "electrobun:"
              ? "#"
              : "";
          const qs = apiBase
            ? `popout&apiBase=${encodeURIComponent(apiBase)}`
            : "popout";
          window.open(
            `${base}${sep}/?${qs}`,
            "milady-stream",
            "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no",
          );
        }
      }
    } catch {
      try {
        const status = await client.streamStatus();
        setStreamLive(status.running && status.ffmpegAlive);
      } catch {
        /* poll will recover within 5s */
      }
    } finally {
      loadingRef.current = false;
      setStreamLoading(false);
    }
  }, [isElectrobun, streamLive]);

  // ── Fetch destinations on mount ──────────────────────────────────────
  useEffect(() => {
    if (!streamAvailable) return;
    client
      .getStreamingDestinations()
      .then((res) => {
        if (res.ok) setDestinations(res.destinations);
      })
      .catch(() => { });
  }, [streamAvailable]);

  // ── Volume / mute / destination handlers ────────────────────────────
  const handleVolumeChange = useCallback((vol: number) => {
    setVolume(vol);
    client.setStreamVolume(vol).catch(() => { });
  }, []);

  const handleToggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    (next ? client.muteStream() : client.unmuteStream()).catch(() => { });
  }, [muted]);

  const handleDestinationChange = useCallback((id: string) => {
    client
      .setActiveDestination(id)
      .then((res) => {
        if (res.ok && res.destination) setActiveDestination(res.destination);
      })
      .catch(() => { });
  }, []);

  const handleSourceChange = useCallback(
    async (sourceType: StreamSourceType, customUrl?: string) => {
      try {
        const result = await client.setStreamSource(sourceType, customUrl);
        if (result.ok) {
          setStreamSource(
            result.source as { type: StreamSourceType; url?: string },
          );
        }
      } catch {
        // Non-fatal — UI will show stale state
      }
    },
    [],
  );

  // Settings panel
  const [showSettings, setShowSettings] = useState(false);

  // PIP mode state — small overlay window
  const [isPip, setIsPip] = useState(false);

  const togglePip = useCallback(() => {
    if (!IS_POPOUT) return;
    const next = !isPip;
    if (next) {
      // Enter PIP: small window positioned at bottom-right
      window.resizeTo(PIP_SIZE.width, PIP_SIZE.height);
      const sw = window.screen.availWidth;
      const sh = window.screen.availHeight;
      window.moveTo(sw - PIP_SIZE.width - 20, sh - PIP_SIZE.height - 20);
    } else {
      // Exit PIP: restore full size, centered
      window.resizeTo(FULL_SIZE.width, FULL_SIZE.height);
      const sw = window.screen.availWidth;
      const sh = window.screen.availHeight;
      window.moveTo(
        Math.round((sw - FULL_SIZE.width) / 2),
        Math.round((sh - FULL_SIZE.height) / 2),
      );
    }
    setIsPip(next);
  }, [isPip]);

  // Track whether terminal is active (received output recently)
  const [terminalActive, setTerminalActive] = useState(false);
  const terminalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unbind = client.onWsEvent(
      "terminal-output",
      (data: Record<string, unknown>) => {
        const event = data.event as string;
        if (event === "start" || event === "stdout" || event === "stderr") {
          setTerminalActive(true);
          if (terminalTimeoutRef.current) {
            clearTimeout(terminalTimeoutRef.current);
          }
          terminalTimeoutRef.current = setTimeout(() => {
            setTerminalActive(false);
          }, TERMINAL_ACTIVE_WINDOW_MS);
        }
      },
    );
    return () => {
      unbind();
      if (terminalTimeoutRef.current) clearTimeout(terminalTimeoutRef.current);
    };
  }, []);

  // Detect current mode (priority order)
  const mode: AgentMode = useMemo(() => {
    if (activeGameViewerUrl.trim()) return "gaming";
    if (terminalActive) return "terminal";

    const now = Date.now();
    const recentChat = autonomousEvents.find(
      (e) => e.stream === "assistant" && now - e.ts < CHAT_ACTIVE_WINDOW_MS,
    );
    if (recentChat) return "chatting";

    return "idle";
  }, [activeGameViewerUrl, terminalActive, autonomousEvents]);

  const overlayLayout = useOverlayLayout(activeDestination?.id);
  const { layout } = overlayLayout;

  const feedEvents = useMemo(
    () =>
      autonomousEvents
        .filter((e) => e.stream !== "viewer_stats")
        .slice(-80)
        .reverse(),
    [autonomousEvents],
  );

  // Extract latest viewer stats from events
  const viewerCount = useMemo(() => {
    for (let i = autonomousEvents.length - 1; i >= 0; i--) {
      const evt = autonomousEvents[i];
      if (evt.stream === "viewer_stats") {
        const p = evt.payload as Record<string, unknown>;
        if (typeof p.apiViewerCount === "number") return p.apiViewerCount;
        if (typeof p.uniqueChatters === "number") return p.uniqueChatters;
      }
    }
    return null;
  }, [autonomousEvents]);

  // In PIP mode, render the full 1280×720 layout and CSS-transform-scale it
  // down to fit the PIP window. This keeps the stream capture identical to
  // the normal view — capturePage() captures the full layout at native pixels.
  const pipScale = isPip ? PIP_SIZE.width / FULL_SIZE.width : 1;
  const pipStyle: CSSProperties | undefined = isPip
    ? {
      width: FULL_SIZE.width,
      height: FULL_SIZE.height,
      transform: `scale(${pipScale})`,
      transformOrigin: "top left",
    }
    : undefined;

  return (
    <div
      data-stream-view
      className={`flex flex-col text-txt font-body ${inModal ? "bg-transparent" : "bg-bg"
        } ${isPip ? "" : "h-full w-full"}`}
      style={pipStyle}
    >
      <StatusBar
        agentName={agentName}
        mode={mode}
        viewerCount={viewerCount}
        isPip={isPip}
        onTogglePip={togglePip}
        streamAvailable={streamAvailable}
        streamLive={streamLive}
        streamLoading={streamLoading}
        onToggleStream={toggleStream}
        volume={volume}
        muted={muted}
        onVolumeChange={handleVolumeChange}
        onToggleMute={handleToggleMute}
        destinations={destinations}
        activeDestination={activeDestination}
        onDestinationChange={handleDestinationChange}
        uptime={uptime}
        frameCount={frameCount}
        audioSource={audioSource}
        streamSource={streamSource}
        activeGameViewerUrl={activeGameViewerUrl}
        onSourceChange={handleSourceChange}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Stream voice config — TTS toggle and status */}
      {!isPip && streamAvailable && (
        <div
          className={`flex items-center px-4 py-1 border-b ${inModal
              ? "border-[var(--border)] bg-[rgba(255,255,255,0.03)]"
              : "border-border bg-bg"
            }`}
        >
          <StreamVoiceConfig streamLive={streamLive} />
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Main content area — shows what the agent is doing */}
        <div className="flex-1 min-w-0 relative">
          {!streamAvailable ? (
            <div className="h-full flex items-center justify-center p-6">
              <div className="max-w-md rounded-2xl border border-border bg-bg-muted/50 p-6 text-center shadow-lg">
                <p className="text-[11px] uppercase tracking-[0.24em] text-muted">
                  {t("streamview.StreamingUnavailabl")}
                </p>
                <h2 className="mt-2 text-xl font-semibold text-txt">
                  {t("streamview.EnableTheStreaming")}
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted">
                  {t("streamview.MiladyCouldNotRea")}{" "}
                  <code>{t("streamview.streamingBase")}</code>{" "}
                  {t("streamview.pluginThenReload")}
                </p>
                <p className="mt-4 text-xs text-muted">
                  {t("streamview.IfThePluginIsAlr")}
                </p>
              </div>
            </div>
          ) : mode === "gaming" ? (
            <iframe
              src={activeGameViewerUrl}
              title={t("streamview.Game")}
              className="w-full h-full border-0"
              sandbox={
                activeGameSandbox ||
                "allow-scripts allow-same-origin allow-popups"
              }
            />
          ) : mode === "terminal" ? (
            <StreamTerminal />
          ) : mode === "chatting" ? (
            <ChatContent
              events={autonomousEvents.slice(-20)}
              messages={conversationMessages}
            />
          ) : (
            <IdleContent events={autonomousEvents.slice(-20)} />
          )}

          {/* Stream overlay widgets */}
          <OverlayLayer
            layout={layout}
            events={autonomousEvents}
            agentMode={mode}
            agentName={agentName}
          />

          {/* VRM avatar — picture-in-picture overlay */}
          <AvatarPip isSpeaking={chatAvatarSpeaking} />

          {/* Stream settings panel */}
          {showSettings && streamAvailable && (
            <StreamSettings
              destinations={destinations}
              activeDestination={activeDestination}
              onDestinationChange={handleDestinationChange}
              streamLive={streamLive}
              streamSource={streamSource}
              activeGameViewerUrl={activeGameViewerUrl}
              onSourceChange={handleSourceChange}
              overlayLayout={overlayLayout}
              onClose={() => setShowSettings(false)}
            />
          )}
        </div>

        {/* Activity sidebar */}
        <div className="w-[260px] min-w-[260px] xl:w-[300px] xl:min-w-[300px]">
          <ActivityFeed events={feedEvents} />
        </div>
      </div>

      <ChatTicker events={autonomousEvents} />
    </div>
  );
}
