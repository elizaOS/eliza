/**
 * TranscriptBody — the read + word-sync surface of the Transcripts player
 * (#8789). Pure + presentational: given a transcript and the current playback
 * position, it renders speaker-labeled segments and highlights the single active
 * word (binding to the tested `activeWordIndex`), or — for segments that have no
 * per-word timing (the local CTC acoustic model is gated) — falls back to a
 * segment-level highlight. Clicking a word (or an untimed segment) seeks.
 *
 * Keeping it prop-driven (`currentTimeMs` in, `onSeekMs` out) means the sync is
 * deterministic and unit-testable without real audio playback.
 */

import {
  activeWordIndex,
  flattenTranscriptWords,
  type Transcript,
} from "@elizaos/shared/transcripts";
import * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export interface TranscriptBodyProps {
  transcript: Transcript;
  /** Current playback position (ms from audio start) driving the highlight. */
  currentTimeMs: number;
  /** Seek to a position when a word / untimed segment is clicked. */
  onSeekMs?: (ms: number) => void;
}

/** Last segment whose start is ≤ `ms` (segment-level fallback highlight). */
function segmentAt(segments: Transcript["segments"], ms: number): number {
  let found = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].startMs <= ms) found = i;
    else break;
  }
  return found;
}

interface TranscriptWordProps {
  text: string;
  startMs: number;
  isActive: boolean;
  testId: string;
  onSeek: (startMs: number) => void;
}

// Memoized so that, as playback advances, only the word whose active-state flips
// re-renders — not every word button in the transcript on every audio frame.
// `onSeek` is stable (ref-backed in the parent), so `isActive` is the only prop
// that changes.
const TranscriptWord = React.memo(function TranscriptWord({
  text,
  startMs,
  isActive,
  testId,
  onSeek,
}: TranscriptWordProps): React.JSX.Element {
  return (
    <>
      <Button
        variant="ghost"
        data-testid={testId}
        data-active={isActive ? "true" : undefined}
        onClick={() => onSeek(startMs)}
        className={cn(
          "h-auto rounded px-0.5 py-0 font-normal transition-colors hover:bg-bg-muted/40",
          isActive && "bg-accent/16 text-accent-fg",
        )}
      >
        {text}
      </Button>{" "}
    </>
  );
});

export function TranscriptBody({
  transcript,
  currentTimeMs,
  onSeekMs,
}: TranscriptBodyProps): React.JSX.Element {
  const flat = React.useMemo(
    () => flattenTranscriptWords(transcript.segments),
    [transcript.segments],
  );
  const activeFlat = activeWordIndex(flat, currentTimeMs);
  const active = activeFlat >= 0 ? flat[activeFlat] : undefined;
  const fallbackSeg = segmentAt(transcript.segments, currentTimeMs);
  // Stable seek handler so the memoized words don't see a new prop every frame.
  const onSeekRef = React.useRef(onSeekMs);
  onSeekRef.current = onSeekMs;
  const handleSeek = React.useCallback(
    (ms: number) => onSeekRef.current?.(ms),
    [],
  );

  return (
    <div className="space-y-4 leading-relaxed text-txt">
      {transcript.segments.map((seg, si) => {
        const segActive = seg.words.length === 0 && si === fallbackSeg;
        return (
          <div key={seg.id} data-testid={`transcript-segment-${si}`}>
            {seg.speakerLabel ? (
              <div className="mb-0.5 text-xs font-medium text-muted">
                {seg.speakerLabel}
              </div>
            ) : null}
            <p
              className={cn(
                "rounded",
                segActive && "bg-accent/12 px-1 text-accent-fg",
              )}
            >
              {seg.words.length > 0 ? (
                seg.words.map((w, wi) => (
                  <TranscriptWord
                    key={`${seg.id}-${w.startMs}-${w.text}`}
                    text={w.text}
                    startMs={w.startMs}
                    isActive={
                      active !== undefined &&
                      active.segmentIndex === si &&
                      active.wordIndex === wi
                    }
                    testId={`transcript-word-${si}-${wi}`}
                    onSeek={handleSeek}
                  />
                ))
              ) : (
                <Button
                  variant="ghost"
                  data-testid={`transcript-segment-text-${si}`}
                  onClick={() => handleSeek(seg.startMs)}
                  className="h-auto whitespace-normal rounded-none bg-transparent p-0 text-left font-normal hover:bg-transparent"
                >
                  {seg.text}
                </Button>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
