/**
 * Global music player — always mounted in the app shell.
 *
 * WHY LISTENER-ONLY:
 * The agent is the DJ; web clients are listeners tuning into a public
 * broadcast. There are no pause/stop/skip buttons that hit the server —
 * those actions go through chat so the agent decides. Multiple listeners
 * on different machines can all hear the same broadcast without
 * interfering with each other.
 *
 * The only local controls are mute/unmute and volume, which affect only
 * this browser tab's <audio> element.
 *
 * When the agent pauses the broadcast, GET /music-player/status reports
 * `isPaused`; we mirror that on the `<audio>` element so buffered bytes
 * don't keep playing after a server-side pause.
 */

import { useIntervalWhenDocumentVisible } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveApiUrl } from "../../utils/asset-url";

interface TrackInfo {
  title: string;
  guildId: string;
  streamUrl: string;
  isPaused: boolean;
}

export function MusicPlayerGlobal() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [track, setTrack] = useState<TrackInfo | null>(null);
  const [minimised, setMinimised] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const lastKey = useRef<string>("");

  useEffect(() => {
    if (!track) lastKey.current = "";
  }, [track]);

  // 5s (was 2s) — agent-driven pause/resume surfaces with up to a 5s delay in
  // the UI. Accepted trade-off for significantly fewer background requests.
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch(resolveApiUrl("/music-player/status"));
      if (!res.ok) {
        setTrack(null);
        return;
      }
      const data = (await res.json()) as {
        guildId?: string;
        track?: { title?: string };
        streamUrl?: string;
        isPaused?: boolean;
      };
      if (data.track?.title && data.guildId && data.streamUrl) {
        const next: TrackInfo = {
          title: data.track.title,
          guildId: data.guildId,
          streamUrl: resolveApiUrl(data.streamUrl),
          isPaused: data.isPaused === true,
        };
        setTrack((prev) => {
          if (!prev) return next;
          if (
            prev.guildId === next.guildId &&
            prev.title === next.title &&
            prev.streamUrl === next.streamUrl &&
            prev.isPaused === next.isPaused
          ) {
            return prev;
          }
          return next;
        });
      } else {
        setTrack(null);
      }
    } catch {
      /* keep current state on network error */
    }
  }, []);

  useEffect(() => {
    void pollStatus();
  }, [pollStatus]);

  useIntervalWhenDocumentVisible(() => {
    void pollStatus();
  }, 5_000);

  // Connect audio element when track identity changes (not on isPaused alone)
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !track) return;
    const key = `${track.guildId}::${track.title}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    el.src = track.streamUrl;
    el.load();
    if (!track.isPaused) {
      el.play().catch(() => {});
    }
  }, [track?.guildId, track?.title, track?.streamUrl, track]);

  // Mirror server pause state — HTML5 audio keeps decoding buffered data otherwise.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !track) return;
    if (track.isPaused) {
      el.pause();
    } else {
      el.play().catch(() => {});
    }
  }, [track?.isPaused, track?.guildId, track?.title, track]);

  // Sync mute/volume to audio element
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = muted;
    el.volume = volume;
  }, [muted, volume]);

  const toggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number.parseFloat(e.target.value);
      setVolume(v);
      if (v > 0 && muted) setMuted(false);
    },
    [muted],
  );

  const isActive = track !== null;

  return (
    <div data-music-player-global="">
      {/* Always-mounted audio element — hidden via CSS, never unmounted */}
      {/* biome-ignore lint/a11y/useMediaCaption: agent audio broadcast */}
      <audio ref={audioRef} style={{ display: "none" }} />

      {isActive && !minimised && (
        <div className="fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur-md overflow-hidden">
          {/* Track title row */}
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                  track.isPaused ? "bg-warn" : "bg-ok animate-pulse"
                }`}
              />
              <span className="text-xs font-semibold text-txt truncate">
                {track.title}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setMinimised(true)}
              className="text-muted hover:text-txt text-xs shrink-0 ml-2 cursor-pointer"
              aria-label="Minimise music player"
            >
              ✕
            </button>
          </div>

          {/* Local volume controls — affects only this browser tab */}
          <div className="flex items-center gap-2 px-3 pb-2 pt-1">
            <button
              type="button"
              onClick={toggleMute}
              className="text-txt/70 hover:text-txt transition-colors cursor-pointer shrink-0"
              aria-label={muted ? "Unmute" : "Mute"}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted || volume === 0 ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <title>Mute</title>
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <title>Volume</title>
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                </svg>
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              onChange={handleVolumeChange}
              className="flex-1 h-1 accent-ok cursor-pointer"
              aria-label="Volume"
            />
          </div>
        </div>
      )}

      {isActive && minimised && (
        <button
          type="button"
          onClick={() => setMinimised(false)}
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 shadow-lg backdrop-blur-md text-xs font-semibold text-txt hover:bg-card transition-colors cursor-pointer"
          aria-label="Expand music player"
        >
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              track.isPaused ? "bg-warn" : "bg-ok animate-pulse"
            }`}
          />
          <span className="max-w-[10rem] truncate">{track.title}</span>
        </button>
      )}
    </div>
  );
}
