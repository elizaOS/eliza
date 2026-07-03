/**
 * TranscriptPlayer — play / scrub / read a recorded transcript with word-synced
 * highlighting (#8789). Minimal, Apple-Voice-Memos-clean: one play/pause
 * control, a scrub bar, a time readout, and the {@link TranscriptBody} below
 * (which highlights the active word as playback advances; clicking a word
 * seeks). The waveform is a separate progressive enhancement.
 */

import type { Transcript } from "@elizaos/shared/transcripts";
import { Pause, Play } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { TranscriptBody } from "./TranscriptBody";
import { useAudioElement } from "./useAudioElement";

export interface TranscriptPlayerProps {
  transcript: Transcript;
  /** Served audio URL; when absent the player is read-only (no transport). */
  audioUrl?: string;
  className?: string;
}

/** `m:ss` from milliseconds. */
function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TranscriptPlayer({
  transcript,
  audioUrl,
  className,
}: TranscriptPlayerProps): React.JSX.Element {
  const audio = useAudioElement();
  const durationMs = audio.durationMs || transcript.durationMs;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {audioUrl ? (
        // biome-ignore lint/a11y/useMediaCaption: the transcript below IS the caption.
        <audio ref={audio.audioRef} src={audioUrl} preload="metadata" />
      ) : null}

      {audioUrl ? (
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            data-testid="transcript-play"
            aria-label={audio.playing ? "pause" : "play"}
            onClick={audio.toggle}
            className="h-10 w-10 shrink-0 rounded-full bg-accent/12 text-accent-fg transition-colors hover:bg-accent/20"
          >
            {audio.playing ? (
              <Pause className="h-5 w-5" aria-hidden />
            ) : (
              <Play className="h-5 w-5 translate-x-px" aria-hidden />
            )}
          </Button>
          <Input
            type="range"
            data-testid="transcript-scrub"
            aria-label="seek"
            min={0}
            max={Math.max(1, durationMs)}
            value={Math.min(audio.currentMs, durationMs)}
            onChange={(e) => audio.seekMs(Number(e.target.value))}
            className="h-1 flex-1 cursor-pointer border-0 bg-transparent p-0 accent-accent"
          />
          <span className="shrink-0 tabular-nums text-xs text-muted">
            {formatMs(audio.currentMs)} / {formatMs(durationMs)}
          </span>
        </div>
      ) : null}

      <TranscriptBody
        transcript={transcript}
        currentTimeMs={audio.currentMs}
        onSeekMs={audioUrl ? audio.seekMs : undefined}
      />
    </div>
  );
}
