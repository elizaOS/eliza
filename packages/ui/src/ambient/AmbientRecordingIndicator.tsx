/**
 * Always-visible ambient recording indicator.
 *
 * AMBIENT-MODE-DESIGN §8.1 requires a persistent, monochrome-safe, unmistakable
 * "listening / paused" element — "a requirement, not a toast." So this is not a
 * subtle dot: it is a bordered pill that communicates state three redundant
 * ways so it survives a small grayscale-ish LP3 screen and reduced-motion:
 *
 *   1. SHAPE   — a filled square while capturing (the universal "recording"
 *                glyph), an outlined double-bar while paused, a hollow ring idle.
 *   2. MOTION  — a slow pulse while capturing (disabled under reduce-motion,
 *                where the solid shape + word still carry the state).
 *   3. WORD    — an explicit "LISTENING" / "PAUSED" / "OFF" label, never
 *                icon-only, so colorblind + grayscale users read state directly.
 *
 * It also states the processing location honestly ("cloud" vs "on-device") so
 * the UI never implies on-device for a cloud path. Uses only the black/white/
 * orange token system and lucide icons — no gradients, no emoji.
 */

import { CircleDot, Radio, Square } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import type {
  AmbientCaptureStatus,
  AmbientProcessingLocation,
} from "./ambient-session-adapter";

export interface AmbientRecordingIndicatorProps {
  status: AmbientCaptureStatus;
  processingLocation: AmbientProcessingLocation;
  className?: string;
}

function stateWord(status: AmbientCaptureStatus): string {
  switch (status) {
    case "capturing":
      return "Listening";
    case "paused":
      return "Paused";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "error":
      return "Error";
    case "unsupported":
      return "Unavailable";
    default:
      return "Off";
  }
}

export function AmbientRecordingIndicator({
  status,
  processingLocation,
  className,
}: AmbientRecordingIndicatorProps): React.ReactElement {
  const capturing = status === "capturing";
  const paused = status === "paused";
  const active = capturing || paused;
  const location =
    processingLocation === "cloud" ? "cloud" : "on-device";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="ambient-recording-indicator"
      data-capturing={capturing ? "true" : "false"}
      className={cn(
        "inline-flex items-center gap-2 rounded-sm border px-3 py-2 text-sm font-medium",
        // High-contrast border + fill so the pill reads on a grayscale screen.
        capturing
          ? "border-accent bg-accent-subtle text-txt-strong"
          : paused
            ? "border-border bg-card text-muted-strong"
            : "border-border bg-card text-muted",
        className,
      )}
    >
      {/* SHAPE: filled square = recording, double-bar ring = paused, hollow = off. */}
      {capturing ? (
        <Square
          className={cn(
            "size-3.5 fill-accent text-accent",
            "animate-pulse motion-reduce:animate-none",
          )}
          aria-hidden
        />
      ) : paused ? (
        <Radio className="size-3.5 text-muted-strong" aria-hidden />
      ) : (
        <CircleDot className="size-3.5 text-muted" aria-hidden />
      )}
      {/* WORD: never icon-only. */}
      <span data-testid="ambient-recording-word">{stateWord(status)}</span>
      {active ? (
        <span
          className="border-l border-border pl-2 text-2xs uppercase tracking-wide text-muted"
          data-testid="ambient-processing-location"
        >
          {location}
        </span>
      ) : null}
    </div>
  );
}
