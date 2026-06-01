import type * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Shared chat-composer chrome: a well-defined refractive-glass bar plus
 * xs-cornered white "negative-space" icon buttons (the glyph is cut OUT of the
 * white so the glass/background shows through it, matching the negative-space
 * face art). Used by both the homescreen composer and the overlay ChatSurface
 * so the mic and send controls read as one consistent set.
 */

/** Class for the glass composer bar — translucent, blurred, edge-highlighted; no plain borders. */
export const GLASS_COMPOSER_CLASS =
  "flex items-center gap-1.5 rounded-[6px] border border-txt/15 bg-txt/5 p-1.5 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.25),inset_0_-1px_0_rgba(0,0,0,0.06),0_10px_30px_rgba(0,0,0,0.18)]";

// xs-cornered button rect + filled glyphs, combined under fillRule=evenodd so
// the glyph becomes a transparent hole in the white button.
const BTN_RECT =
  "M6 0H30A6 6 0 0 1 36 6V30A6 6 0 0 1 30 36H6A6 6 0 0 1 0 30V6A6 6 0 0 1 6 0Z";
// Up arrow — shaft + head, pointing up (send).
const SEND_GLYPH = "M18 10L25 18H21V27H15V18H11Z";
// Five-bar waveform — tallest in the center, like OpenAI's voice indicator.
const MIC_GLYPH =
  "M6 14H9V22H6Z" +
  "M11.5 10H14.5V26H11.5Z" +
  "M16.5 7H19.5V29H16.5Z" +
  "M22 10H25V26H22Z" +
  "M27 14H30V22H27Z";

export function GlassIconButton({
  icon,
  label,
  disabled,
  active,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
}: {
  icon: "mic" | "send";
  label: string;
  disabled?: boolean;
  /** Mic only: reflects recording state (adds a pulse + aria-pressed). */
  active?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={icon === "mic" ? active : undefined}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center transition-transform",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-0",
        disabled ? "opacity-40" : "hover:scale-105",
        active && "animate-pulse",
      )}
    >
      <svg
        viewBox="0 0 36 36"
        className="h-full w-full drop-shadow-[0_1px_4px_rgba(0,0,0,0.3)]"
        aria-hidden="true"
      >
        <path
          fill="#ffffff"
          fillRule="evenodd"
          d={`${BTN_RECT}${icon === "mic" ? MIC_GLYPH : SEND_GLYPH}`}
        />
      </svg>
    </button>
  );
}
