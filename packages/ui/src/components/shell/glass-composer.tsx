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
  "flex items-center gap-1.5 rounded-xs border border-white/25 bg-white/10 p-1.5 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.45),inset_0_-1px_0_rgba(255,255,255,0.06),0_10px_30px_rgba(0,0,0,0.22)]";

// xs-cornered button rect + filled glyphs, combined under fillRule=evenodd so
// the glyph becomes a transparent hole in the white button.
const BTN_RECT =
  "M3 0H33A3 3 0 0 1 36 3V33A3 3 0 0 1 33 36H3A3 3 0 0 1 0 33V3A3 3 0 0 1 3 0Z";
const SEND_GLYPH = "M9 9L29 18L9 27L13 18Z";
const MIC_GLYPH =
  "M18 7A4 4 0 0 0 14 11V15A4 4 0 0 0 22 15V11A4 4 0 0 0 18 7Z" +
  "M12 15A6 6 0 0 0 24 15H22A4 4 0 0 1 14 15Z" +
  "M17 21H19V27H17ZM13 27H23V29H13Z";

export function GlassIconButton({
  icon,
  label,
  disabled,
  active,
  onClick,
}: {
  icon: "mic" | "send";
  label: string;
  disabled?: boolean;
  /** Mic only: reflects recording state (adds a pulse + aria-pressed). */
  active?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={icon === "mic" ? active : undefined}
      disabled={disabled}
      onClick={onClick}
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
