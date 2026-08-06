"use client";

/**
 * Web-adapted Spinner.
 *
 * The terminal Spinner (src/components/Spinner.tsx) drives animation via
 * useAnimationFrame and renders Unicode braille/block characters with ANSI
 * colour via Ink's <Text>.  In the browser we replace that with a pure-CSS
 * spinning ring, preserving the same optional `tip` text and `mode` prop
 * surface so callers can swap in this component without changing props.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Mirrors the SpinnerMode type from src/components/Spinner/index.ts */
export type SpinnerMode =
  | "queued"
  | "loading"
  | "thinking"
  | "auto"
  | "disabled";

export interface SpinnerProps {
  /** Visual mode — controls colour/appearance. */
  mode?: SpinnerMode;
  /** Optional tip text shown next to the spinner. */
  spinnerTip?: string;
  /** Override message replaces the default verb. */
  overrideMessage?: string | null;
  /** Additional suffix appended after the main label. */
  spinnerSuffix?: string | null;
  /** When true the spinner renders inline instead of as a block row. */
  inline?: boolean;
  /** Extra class names for the wrapper element. */
  className?: string;
}

// ─── Colour map ───────────────────────────────────────────────────────────────

const MODE_RING_CLASS: Record<SpinnerMode, string> = {
  queued:   "border-surface-500",
  loading:  "border-brand-400",
  thinking: "border-brand-500",
  auto:     "border-brand-400",
  disabled: "border-surface-600",
};

const MODE_TEXT_CLASS: Record<SpinnerMode, string> = {
  queued:   "text-surface-400",
  loading:  "text-brand-300",
  thinking: "text-brand-300",
  auto:     "text-brand-300",
  disabled: "text-surface-500",
};

const MODE_LABEL: Record<SpinnerMode, string> = {
  queued:   "Queued…",
  loading:  "Loading…",
  thinking: "Thinking…",
  auto:     "Working…",
  disabled: "",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function Spinner({
  mode = "loading",
  spinnerTip,
  overrideMessage,
  spinnerSuffix,
  inline = false,
  className,
}: SpinnerProps) {
  if (mode === "disabled") return null;

  const label =
    overrideMessage ??
    spinnerTip ??
    MODE_LABEL[mode];

  const ringClass = MODE_RING_CLASS[mode];
  const textClass = MODE_TEXT_CLASS[mode];

  return (
    <span
      role="status"
      aria-label={label || "Loading"}
      className={cn(
        "flex items-center gap-2",
        inline ? "inline-flex" : "flex",
        className
      )}
    >
      {/* CSS spinning ring */}
      <span
        className={cn(
          "block w-3.5 h-3.5 rounded-full border-2 border-transparent animate-spin flex-shrink-0",
          ringClass,
          // Top border only — creates the "gap" in the ring for the spinning effect
          "[border-top-color:currentColor]"
        )}
        style={{ borderTopColor: undefined }}
        aria-hidden
      >
        {/* Inner ring for the visible arc — achieved via box-shadow trick */}
      </span>

      {(label || spinnerSuffix) && (
        <span className={cn("text-sm font-mono", textClass)}>
          {label}
          {spinnerSuffix && (
            <span className="text-surface-500 ml-1">{spinnerSuffix}</span>
          )}
        </span>
      )}
    </span>
  );
}

// ─── Shimmer / glimmer variant ────────────────────────────────────────────────

/** Pulsing shimmer bar — web replacement for GlimmerMessage / ShimmerChar. */
export function ShimmerBar({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-2 rounded-full bg-gradient-to-r from-surface-700 via-surface-500 to-surface-700",
        "bg-[length:200%_100%] animate-shimmer",
        className
      )}
      aria-hidden
    />
  );
}

/** Inline flashing cursor dot — web replacement for FlashingChar. */
export function FlashingCursor({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block w-1.5 h-4 bg-current align-text-bottom ml-0.5",
        "animate-pulse-soft",
        className
      )}
      aria-hidden
    />
  );
}
