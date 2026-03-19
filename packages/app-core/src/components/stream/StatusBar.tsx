import { isElectrobunRuntime } from "@elizaos/app-core/bridge";
import { useApp } from "@elizaos/app-core/state";
import { Button, Input, Slider } from "@elizaos/ui";
import {
  ChevronDown,
  ExternalLink,
  PictureInPicture,
  Pin,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  type AgentMode,
  IS_POPOUT,
  isSupportedStreamUrl,
  STREAM_SOURCE_LABELS,
  type StreamSourceType,
  toggleAlwaysOnTop,
} from "./helpers";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function StatusBar({
  agentName,
  mode,
  viewerCount,
  isPip,
  onTogglePip,
  streamAvailable,
  streamLive,
  streamLoading,
  onToggleStream,
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
  destinations,
  activeDestination,
  onDestinationChange,
  uptime,
  frameCount,
  audioSource,
  streamSource,
  activeGameViewerUrl,
  onSourceChange,
  onOpenSettings,
}: {
  agentName: string;
  mode: AgentMode;
  viewerCount: number | null;
  isPip: boolean;
  onTogglePip: () => void;
  streamAvailable: boolean;
  streamLive: boolean;
  streamLoading: boolean;
  onToggleStream: () => void;
  volume: number;
  muted: boolean;
  onVolumeChange: (vol: number) => void;
  onToggleMute: () => void;
  destinations: Array<{ id: string; name: string }>;
  activeDestination: { id: string; name: string } | null;
  onDestinationChange: (id: string) => void;
  uptime: number;
  frameCount: number;
  audioSource: string;
  streamSource: { type: StreamSourceType; url?: string };
  activeGameViewerUrl: string;
  onSourceChange: (sourceType: StreamSourceType, customUrl?: string) => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useApp();
  const isElectrobun = isElectrobunRuntime();
  const isLive = streamLive;
  const [pinned, setPinned] = useState(IS_POPOUT); // popout starts pinned
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceDropdownRef = useRef<HTMLSpanElement>(null);
  const [customUrlInput, setCustomUrlInput] = useState("");
  const trimmedCustomUrl = customUrlInput.trim();
  const customUrlValid = isSupportedStreamUrl(trimmedCustomUrl);

  // Close source picker on click outside
  useEffect(() => {
    if (!sourceOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        sourceDropdownRef.current &&
        !sourceDropdownRef.current.contains(e.target as Node)
      ) {
        setSourceOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sourceOpen]);
  const popoutPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup popout polling interval on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (popoutPollRef.current) {
        clearInterval(popoutPollRef.current);
        popoutPollRef.current = null;
      }
    };
  }, []);

  const modeLabel =
    mode === "gaming"
      ? "gaming"
      : mode === "terminal"
        ? "terminal"
        : mode === "chatting"
          ? "chatting"
          : "idle";
  return (
    <div
      className={`flex items-center justify-between bg-bg border-b border-border shrink-0 ${isPip ? "px-2 py-1" : "px-4 py-2"}`}
      style={
        IS_POPOUT ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined
      }
    >
      <div className="flex items-center gap-2">
        <span
          className={`${isPip ? "w-2 h-2" : "w-2.5 h-2.5"} rounded-full ${isLive
            ? "bg-danger shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse"
            : "bg-muted"
            }`}
        />
        {!isPip && (
          <>
            <span className="text-xs font-bold uppercase tracking-wider text-txt">
              {isLive ? "LIVE" : "OFFLINE"}
            </span>
            <span className="text-sm font-semibold text-txt-strong">
              {agentName}
            </span>
          </>
        )}
      </div>
      <div
        className={`flex items-center ${isPip ? "gap-1" : "gap-3"} text-xs text-muted`}
        style={
          IS_POPOUT
            ? ({ WebkitAppRegion: "no-drag" } as CSSProperties)
            : undefined
        }
      >
        {!isPip && viewerCount !== null && viewerCount > 0 && (
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-bg-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]" />
            <span className="text-txt">{viewerCount}</span>
          </span>
        )}
        {!isPip && (
          <span className="px-2 py-0.5 rounded bg-bg-muted">{modeLabel}</span>
        )}

        {/* Stream source picker — always visible */}
        {!isPip && (
          <span ref={sourceDropdownRef} className="relative flex items-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={!streamAvailable}
              className="flex items-center gap-1 px-2 py-0.5 h-6 rounded bg-bg-muted hover:bg-accent/20 transition-colors text-[11px] font-normal"
              onClick={() => setSourceOpen((o) => !o)}
              title={
                streamAvailable
                  ? "Select a stream source"
                  : "Install and enable the streaming plugin to change sources"
              }
            >
              <span className="text-muted">{t("statusbar.Src")}</span>
              <span className="text-txt font-medium">
                {STREAM_SOURCE_LABELS[streamSource.type]}
              </span>
              <ChevronDown className="w-2.5 h-2.5" />
            </Button>
            {sourceOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-bg border border-border rounded shadow-lg min-w-[180px]">
                {(
                  ["stream-tab", "game", "custom-url"] as StreamSourceType[]
                ).map((st) => {
                  const isGame = st === "game";
                  const disabled =
                    !streamAvailable || (isGame && !activeGameViewerUrl.trim());
                  return (
                    <Button
                      key={st}
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      className={`h-auto w-full justify-start rounded-lg px-3 py-1.5 text-xs transition-colors ${streamSource.type === st
                        ? "bg-accent/20 text-txt hover:bg-accent/30"
                        : disabled
                          ? "text-muted/40 opacity-50"
                          : "text-txt hover:bg-bg-muted"
                        }`}
                      onClick={() => {
                        if (st === "custom-url") return; // handled by input below
                        onSourceChange(
                          st,
                          isGame ? activeGameViewerUrl : undefined,
                        );
                        setSourceOpen(false);
                      }}
                    >
                      {STREAM_SOURCE_LABELS[st]}
                      {isGame && activeGameViewerUrl.trim() && (
                        <span className="ml-1 text-muted text-[10px]">
                          {t("statusbar.Active")}
                        </span>
                      )}
                    </Button>
                  );
                })}
                {/* Custom URL input */}
                <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border bg-bg">
                  <Input
                    placeholder={t("statusbar.https")}
                    value={customUrlInput}
                    onChange={(e) => setCustomUrlInput(e.target.value)}
                    disabled={!streamAvailable}
                    className={`flex-1 h-7 bg-bg-muted text-txt text-[11px] rounded px-2 border outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50 ${trimmedCustomUrl && !customUrlValid
                      ? "border-danger"
                      : "border-border"
                      }`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && customUrlValid) {
                        onSourceChange("custom-url", trimmedCustomUrl);
                        setSourceOpen(false);
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!streamAvailable || !customUrlValid}
                    className="px-2 py-1 h-7 rounded bg-accent/20 text-txt text-[10px] font-semibold hover:bg-accent/30 transition-colors disabled:opacity-40"
                    onClick={() => {
                      if (customUrlValid) {
                        onSourceChange("custom-url", trimmedCustomUrl);
                        setSourceOpen(false);
                      }
                    }}
                    title={
                      streamAvailable
                        ? "Custom URLs must start with http:// or https://"
                        : "Install and enable the streaming plugin to use custom URLs"
                    }
                  >
                    Go
                  </Button>
                </div>
              </div>
            )}
          </span>
        )}

        {/* Health stats — live only */}
        {!isPip && isLive && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-bg-muted text-[10px] font-mono">
            <span className="text-txt">{formatUptime(uptime)}</span>
            <span className="text-border">|</span>
            <span className="text-txt">{frameCount.toLocaleString()}f</span>
            {audioSource && (
              <>
                <span className="text-border">|</span>
                <span className="text-txt">{audioSource}</span>
              </>
            )}
          </span>
        )}

        {/* Volume controls */}
        {!isPip && (
          <span className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!streamAvailable}
              className="p-1 h-6 w-6 rounded bg-bg-muted hover:bg-accent/20 transition-colors disabled:opacity-50"
              title={muted ? "Unmute" : "Mute"}
              onClick={onToggleMute}
            >
              {muted ? (
                <VolumeX className="w-3.5 h-3.5" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )}
            </Button>
            <div className="w-16">
              <Slider
                min={0}
                max={100}
                step={1}
                value={[muted ? 0 : volume]}
                disabled={!streamAvailable}
                onValueChange={([vol]) => onVolumeChange(vol)}
                title={`Volume: ${muted ? 0 : volume}%`}
                className="cursor-pointer"
              />
            </div>
          </span>
        )}

        {/* Destination selector — always visible when destinations exist */}
        {!isPip && destinations.length > 0 && (
          <select
            className="bg-bg-muted text-txt border border-border text-[11px] rounded px-1.5 py-0.5 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            value={activeDestination?.id ?? ""}
            disabled={isLive || !streamAvailable}
            title={
              !streamAvailable
                ? "Install and enable the streaming plugin to change destinations"
                : isLive
                  ? "Stop stream to change destination"
                  : "Select destination"
            }
            onChange={(e) => onDestinationChange(e.target.value)}
          >
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}

        {/* Settings gear */}
        {!isPip && onOpenSettings && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!streamAvailable}
            className="px-2 py-0.5 h-6 rounded bg-bg-muted hover:bg-accent/20 hover:text-txt transition-colors disabled:opacity-50"
            title={
              streamAvailable
                ? "Stream settings"
                : "Install and enable the streaming plugin to configure streaming"
            }
            onClick={onOpenSettings}
          >
            <Settings className="w-3.5 h-3.5" />
          </Button>
        )}

        {!isPip && (
          <Button
            size="sm"
            disabled={!streamAvailable || streamLoading}
            className={`px-3 py-0.5 h-6 rounded font-semibold text-[11px] uppercase tracking-wider transition-colors disabled:opacity-50 disabled:cursor-wait ${isLive
              ? "bg-danger/20 text-danger hover:bg-danger/30"
              : "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
              }`}
            onClick={onToggleStream}
            title={
              streamAvailable
                ? undefined
                : "Install and enable the streaming plugin to go live"
            }
          >
            {streamLoading ? "..." : isLive ? "Stop Stream" : "Go Live"}
          </Button>
        )}
        {IS_POPOUT ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className={`px-2 py-0.5 h-6 rounded transition-colors ${isPip
                ? "bg-purple-500/20 text-purple-400"
                : "bg-bg-muted hover:bg-purple-500/20 hover:text-purple-400"
                }`}
              title={
                isPip
                  ? "Exit picture-in-picture"
                  : "Picture-in-picture (small overlay)"
              }
              onClick={onTogglePip}
            >
              <PictureInPicture className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`px-2 py-0.5 h-6 rounded transition-colors ${pinned
                ? "bg-accent/20 text-txt"
                : "bg-bg-muted hover:bg-accent/20 hover:text-txt"
                }`}
              title={pinned ? "Unpin from top" : "Pin to top (always on top)"}
              onClick={() => {
                const next = !pinned;
                toggleAlwaysOnTop(next).then((result) => {
                  if (result !== undefined) setPinned(next);
                });
              }}
            >
              <Pin className="w-3.5 h-3.5" />
            </Button>
          </>
        ) : !isElectrobun ? (
          <Button
            variant="ghost"
            size="sm"
            className="px-2 py-0.5 h-6 rounded bg-bg-muted hover:bg-accent/20 hover:text-txt transition-colors"
            title={t("statusbar.PopOutStreamView")}
            onClick={() => {
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
              const popoutWin = window.open(
                `${base}${sep}/?${qs}`,
                "milady-stream",
                "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no",
              );
              // Notify the main window to navigate away from stream tab
              if (popoutWin) {
                window.dispatchEvent(
                  new CustomEvent("stream-popout", { detail: "opened" }),
                );
                // Clear any existing poll before creating a new one
                if (popoutPollRef.current) {
                  clearInterval(popoutPollRef.current);
                }
                // Poll for popout close and notify to switch back
                popoutPollRef.current = setInterval(() => {
                  if (popoutWin.closed) {
                    if (popoutPollRef.current) {
                      clearInterval(popoutPollRef.current);
                      popoutPollRef.current = null;
                    }
                    window.dispatchEvent(
                      new CustomEvent("stream-popout", { detail: "closed" }),
                    );
                  }
                }, 500);
              }
            }}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
