import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../../state";
import { resolveApiUrl } from "../../utils/asset-url";

type NowPlayingState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; title: string; guildId: string; streamUrl: string }
  | { kind: "error"; message: string };

const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

export function MusicPlayerSettingsPanel() {
  const { t } = useApp();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [nowPlaying, setNowPlaying] = useState<NowPlayingState>({
    kind: "idle",
  });
  const [audioError, setAudioError] = useState<string | null>(null);

  const lastAttachedTrack = useRef<string | null>(null);
  useEffect(() => {
    if (nowPlaying.kind !== "ok") return;
    const key = `${nowPlaying.guildId}::${nowPlaying.title}`;
    if (lastAttachedTrack.current === key) return;
    lastAttachedTrack.current = key;
    const el = audioRef.current;
    if (!el) return;
    setAudioError(null);
    el.src = nowPlaying.streamUrl;
    el.load();
    el.play().catch(() => {
      /* autoplay may be blocked by browser policy — user can press play */
    });
  }, [nowPlaying]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const handler = () => {
      const err = el.error;
      const code = err?.code ?? 0;
      const name = MEDIA_ERROR_NAMES[code] ?? `UNKNOWN(${code})`;
      setAudioError(`${name}: ${err?.message || "no details"}`);
    };
    el.addEventListener("error", handler);
    return () => el.removeEventListener("error", handler);
  }, []);

  const pollOnce = useCallback(async () => {
    setNowPlaying((prev) =>
      prev.kind === "idle" ? { kind: "loading" } : prev,
    );
    try {
      const res = await fetch(resolveApiUrl("/music-player/status"));
      const data = (await res.json()) as {
        error?: string;
        guildId?: string;
        track?: { title?: string };
        streamUrl?: string;
      };
      if (!res.ok) {
        setNowPlaying({
          kind: "error",
          message: data.error ?? res.statusText,
        });
        return;
      }
      if (data.track?.title && data.guildId && data.streamUrl) {
        setNowPlaying({
          kind: "ok",
          title: data.track.title,
          guildId: data.guildId,
          streamUrl: resolveApiUrl(data.streamUrl),
        });
      } else {
        setNowPlaying({
          kind: "error",
          message: t("musicplayersettings.NoTrack"),
        });
      }
    } catch {
      setNowPlaying({
        kind: "error",
        message: t("musicplayersettings.PollFailed"),
      });
    }
  }, [t]);

  useEffect(() => {
    void pollOnce();
    const id = window.setInterval(() => void pollOnce(), 5000);
    return () => window.clearInterval(id);
  }, [pollOnce]);

  return (
    <div
      className="rounded-xl border border-border bg-card/60 px-3 py-3 flex flex-col gap-3"
      data-testid="settings-music-player-panel"
    >
      <div className="min-w-0">
        <div className="text-xs font-semibold text-txt">
          {t("musicplayersettings.Title")}
        </div>
      </div>

      <div className="text-2xs text-muted space-y-1">
        <div>
          <span className="font-semibold text-txt">
            {t("musicplayersettings.NowPlaying")}:{" "}
          </span>
          {nowPlaying.kind === "loading" || nowPlaying.kind === "idle" ? (
            <span className="text-muted">…</span>
          ) : nowPlaying.kind === "ok" ? (
            <span>{nowPlaying.title}</span>
          ) : (
            <span className="text-warn">{nowPlaying.message}</span>
          )}
        </div>
        {nowPlaying.kind === "ok" && (
          <div>
            <span className="font-semibold text-txt">
              {t("musicplayersettings.StreamBase")}:{" "}
            </span>
            <span className="break-all font-mono">{nowPlaying.streamUrl}</span>
          </div>
        )}
      </div>
      {/* biome-ignore lint/a11y/useMediaCaption: raw agent audio stream has no caption track */}
      <audio
        ref={audioRef}
        controls
        autoPlay
        className="w-full max-w-md rounded-md border border-border bg-bg"
        aria-label={t("musicplayersettings.Title")}
      />
      {audioError && (
        <p className="text-2xs text-warn break-words font-mono">
          Audio error: {audioError}
        </p>
      )}
    </div>
  );
}
