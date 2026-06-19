// odysseus spinner.js — the AI "thinking/processing" indicator, ported to a
// lightweight, pure-presentational React component.
//
// Upstream (static/js/spinner.js) is a class that paints one of several
// animations into a DOM node it owns and tears down via start()/stop()/destroy().
// The three that actually ship in odysseus' loading UI are:
//   • `spinner` — ASCII frames ['|','/','-','\\'] cycled at 150 ms ("AI is
//     processing |"). The export's default `style` is "right" (label then frame).
//   • `wave`    — block-bar frames ['▁▂▃','▂▃▄', …] cycled the same way.
//   • `whirlpool` — a canvas spiral ring used by `createWhirlpool()` /
//     `createLoadingRow()` for list/empty-state loading (`.lib-loading-row`):
//     a label beside a spinning ring that self-stops once removed from the DOM.
//
// Here those map to <Spinner variant>:
//   • variant omitted / "whirlpool" → the spinning ring (the default odysseus
//     loading indicator; faithful to createWhirlpool/createLoadingRow). A CSS
//     conic/border ring is the equivalent of the canvas spiral and stops
//     painting the instant React unmounts it — same leak-safety guarantee the
//     upstream `isConnected` check provides.
//   • "dots" → the ASCII |/-\ frames, cycled at the upstream 150 ms cadence.
//   • "wave" → the upstream block-bar frames, same cadence.
//
// `LoadingRow` is the direct port of `createLoadingRow` / `.lib-loading-row`:
// a label plus the ring, for swapping in place of a bare "Loading…" string.
//
// Pure presentational: no data, no side-effects beyond a frame timer that is
// cleaned up on unmount. Theme-var coloured; styles live in ODYSSEUS_CSS
// (returned as cssAdditions), scoped under .odysseus-root.

import type { ReactNode } from "react";
import { useEffect, useState } from "react";

/** Which animation to render. Omit for the whirlpool ring (odysseus default). */
export type SpinnerVariant = "dots" | "wave" | "whirlpool";

/** odysseus `animations.spinner` — the ASCII frames, cycled at 150 ms. */
const DOTS_FRAMES: readonly string[] = ["|", "/", "-", "\\"];

/** odysseus `animations.wave` — block-bar frames (literal glyphs, never escapes). */
const WAVE_FRAMES: readonly string[] = [
  "▁▂▃",
  "▂▃▄",
  "▃▄▅",
  "▄▅▆",
  "▅▆▅",
  "▆▅▄",
  "▅▄▃",
  "▄▃▂",
  "▃▂▁",
];

/** Upstream `start(speed = 150)`: frame advance interval, in ms. */
const FRAME_MS = 150;

/**
 * Cycle through `frames` at the upstream cadence, returning the current glyph.
 * The interval is torn down on unmount — the React equivalent of `stop()`.
 */
function useFrameCycle(frames: readonly string[]): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setIndex((current) => (current + 1) % frames.length);
    }, FRAME_MS);
    return () => {
      clearInterval(id);
    };
  }, [frames.length]);
  return frames[index] ?? frames[0] ?? "";
}

/** The ASCII / block-bar text spinner (`variant: "dots" | "wave"`). */
function GlyphSpinner({
  frames,
  label,
}: {
  frames: readonly string[];
  label?: string;
}): ReactNode {
  const frame = useFrameCycle(frames);
  // odysseus default `style` is "right": message then frame, single space.
  return (
    <span
      className="od-spinner od-spinner-glyph"
      role="status"
      aria-live="polite"
    >
      {label ? <span className="od-spinner-label">{label}</span> : null}
      <span className="od-spinner-frame" aria-hidden="true">
        {frame}
      </span>
      {label ? null : <span className="od-sr-only">Loading</span>}
    </span>
  );
}

/** The whirlpool ring (odysseus default loading indicator). Pure CSS. */
function RingSpinner({ label }: { label?: string }): ReactNode {
  return (
    <span
      className="od-spinner od-spinner-ring"
      role="status"
      aria-live="polite"
    >
      <span className="od-whirlpool" aria-hidden="true" />
      {label ? (
        <span className="od-spinner-label">{label}</span>
      ) : (
        <span className="od-sr-only">Loading</span>
      )}
    </span>
  );
}

/**
 * The odysseus processing indicator. Omit `variant` (or pass "whirlpool") for
 * the spinning ring used across odysseus' loading UI; pass "dots" / "wave" for
 * the ASCII / block-bar text spinners. `label` is shown beside the animation.
 */
export function Spinner({
  variant,
  label,
}: {
  variant?: SpinnerVariant;
  label?: string;
}): ReactNode {
  if (variant === "dots") {
    return <GlyphSpinner frames={DOTS_FRAMES} label={label} />;
  }
  if (variant === "wave") {
    return <GlyphSpinner frames={WAVE_FRAMES} label={label} />;
  }
  return <RingSpinner label={label} />;
}

/**
 * odysseus spinner.js `createLoadingRow` / `.lib-loading-row`: a consistent
 * inline loading row (label + whirlpool ring) for list/empty-state loading.
 * Drop-in replacement for a bare "Loading…" string in a view body.
 */
export function LoadingRow({ label }: { label: string }): ReactNode {
  return (
    <div className="od-loading-row">
      <span>{label}</span>
      <span className="od-whirlpool" aria-hidden="true" />
    </div>
  );
}
