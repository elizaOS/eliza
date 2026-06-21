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
                seg.words.map((w, wi) => {
                  const isActive =
                    active !== undefined &&
                    active.segmentIndex === si &&
                    active.wordIndex === wi;
                  return (
                    <React.Fragment key={`${seg.id}-${w.startMs}-${w.text}`}>
                      <button
                        type="button"
                        data-testid={`transcript-word-${si}-${wi}`}
                        data-active={isActive ? "true" : undefined}
                        onClick={() => onSeekMs?.(w.startMs)}
                        className={cn(
                          "rounded px-0.5 transition-colors hover:bg-bg-muted/40",
                          isActive && "bg-accent/16 text-accent-fg",
                        )}
                      >
                        {w.text}
                      </button>{" "}
                    </React.Fragment>
                  );
                })
              ) : (
                <button
                  type="button"
                  data-testid={`transcript-segment-text-${si}`}
                  onClick={() => onSeekMs?.(seg.startMs)}
                  className="text-left"
                >
                  {seg.text}
                </button>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}
