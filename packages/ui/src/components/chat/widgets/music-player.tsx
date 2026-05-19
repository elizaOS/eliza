import { Music, Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithCsrf } from "../../../api/csrf-client";
import { resolveApiUrl } from "../../../utils/asset-url";
import { EmptyWidgetState, WidgetSection } from "./shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./types";

type PlayerState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "playing";
      title: string;
      guildId: string;
      streamUrl: string;
      isPaused: boolean;
    }
  | { kind: "error"; message: string };

const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

function statusLabel(state: PlayerState): string {
  if (state.kind === "playing") return state.isPaused ? "Paused" : "Live";
  if (state.kind === "loading") return "Loading";
  if (state.kind === "error") return "Unavailable";
  return "Idle";
}

export function MusicPlayerSidebarWidget(_props: ChatSidebarWidgetProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastAttachedTrack = useRef<string | null>(null);
  const [player, setPlayer] = useState<PlayerState>({ kind: "idle" });
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioPaused, setAudioPaused] = useState(true);
  const isPlaying = player.kind === "playing";

  const pollOnce = useCallback(async () => {
    setPlayer((prev) => (prev.kind === "idle" ? { kind: "loading" } : prev));
    try {
      const res = await fetchWithCsrf(resolveApiUrl("/music-player/status"));
      const data = (await res.json()) as {
        error?: string;
        guildId?: string;
        track?: { title?: string };
        streamUrl?: string;
        isPaused?: boolean;
      };
      if (!res.ok) {
        setPlayer({ kind: "error", message: data.error ?? res.statusText });
        return;
      }
      if (data.track?.title && data.guildId && data.streamUrl) {
        setPlayer({
          kind: "playing",
          title: data.track.title,
          guildId: data.guildId,
          streamUrl: resolveApiUrl(data.streamUrl),
          isPaused: data.isPaused === true,
        });
        return;
      }
      setPlayer({ kind: "idle" });
      setAudioPaused(true);
    } catch {
      setPlayer({
        kind: "error",
        message: "Could not reach the music player.",
      });
      setAudioPaused(true);
    }
  }, []);

  useEffect(() => {
    void pollOnce();
    const id = window.setInterval(() => void pollOnce(), 5_000);
    return () => window.clearInterval(id);
  }, [pollOnce]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (player.kind !== "playing") {
      el.pause();
      el.removeAttribute("src");
      el.load();
      lastAttachedTrack.current = null;
      return;
    }
    const key = `${player.guildId}::${player.title}`;
    if (lastAttachedTrack.current !== key) {
      lastAttachedTrack.current = key;
      setAudioError(null);
      setAudioPaused(true);
      el.src = player.streamUrl;
      el.load();
    }
    if (player.isPaused) {
      el.pause();
      setAudioPaused(true);
      return;
    }
    el.play().catch(() => {
      /* Browser autoplay policy may require the user to press play. */
    });
  }, [player]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const handlePlay = () => setAudioPaused(false);
    const handlePause = () => setAudioPaused(true);
    const handler = () => {
      const err = el.error;
      const code = err?.code ?? 0;
      const name = MEDIA_ERROR_NAMES[code] ?? `UNKNOWN(${code})`;
      setAudioError(`${name}: ${err?.message || "no details"}`);
    };
    el.addEventListener("play", handlePlay);
    el.addEventListener("pause", handlePause);
    el.addEventListener("error", handler);
    return () => {
      el.removeEventListener("play", handlePlay);
      el.removeEventListener("pause", handlePause);
      el.removeEventListener("error", handler);
    };
  }, []);

  function togglePlayback() {
    const el = audioRef.current;
    if (!el || player.kind !== "playing" || !player.streamUrl) return;
    if (el.paused) {
      void el.play();
      return;
    }
    el.pause();
  }

  return (
    <WidgetSection
      title="Music"
      icon={<Music className="h-3.5 w-3.5" />}
      testId="chat-widget-music-player"
      action={
        <button
          type="button"
          onClick={() => void pollOnce()}
          aria-label="Refresh music player"
          className="inline-flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
        </button>
      }
    >
      <div className="flex flex-col gap-2 pt-0.5">
        {isPlaying ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={togglePlayback}
              aria-label={audioPaused ? "Play music" : "Pause music"}
              title={audioPaused ? "Play" : "Pause"}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt"
            >
              {audioPaused ? (
                <Play className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Pause className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                player.isPaused ? "bg-warn" : "bg-ok"
              }`}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-3xs font-semibold text-txt">
              {player.title}
            </span>
            <span className="shrink-0 text-3xs uppercase tracking-wider text-muted/70">
              {statusLabel(player)}
            </span>
          </div>
        ) : (
          <EmptyWidgetState
            icon={<Music className="h-5 w-5" />}
            title={
              player.kind === "error"
                ? player.message
                : "No music stream is active."
            }
            description="Ask the agent to play music in chat."
          />
        )}
        {/* biome-ignore lint/a11y/useMediaCaption: agent music stream has no caption track */}
        <audio
          ref={audioRef}
          className="hidden"
          aria-label="Agent music stream"
        />
        {audioError ? (
          <p className="break-words font-mono text-3xs text-warn">
            {audioError}
          </p>
        ) : null}
      </div>
    </WidgetSection>
  );
}

export const MUSIC_PLAYER_WIDGET: ChatSidebarWidgetDefinition = {
  id: "music-player.stream",
  pluginId: "music-player",
  order: 125,
  defaultEnabled: true,
  Component: MusicPlayerSidebarWidget,
};
