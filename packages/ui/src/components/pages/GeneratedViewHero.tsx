/**
 * GeneratedViewHero — deterministic generative hero artwork for view cards that
 * lack a real preview image.
 *
 * Each view id is hashed into a stable seed that picks a curated, token-safe
 * palette entry (orange family + warm neutrals + greens for status — never
 * blue), a gradient geometry (linear / radial / conic), and a subtle SVG
 * pattern overlay (dots / grid / diagonal). The view's lucide icon is rendered
 * oversized, low-opacity, and offset into a corner so the card reads as
 * intentional artwork rather than a missing image.
 *
 * This is presentation-only: colors are emitted as inline gradients (the curated
 * stop colors are hard hex, but every accent the surrounding card chrome uses
 * still comes from CSS vars). No business logic, no fallbacks that hide data.
 */

import { ViewIcon } from "../views/ViewIcon";

/**
 * Curated, brand-safe gradient palettes. Orange-forward, warm neutrals, and a
 * couple of greens reserved for status-y views — deliberately no blue so the
 * grid stays on-brand. Each palette is a pair of gradient stops plus a tint for
 * the oversized icon glyph.
 */
const PALETTES: ReadonlyArray<{
  from: string;
  to: string;
  glyph: string;
}> = [
  // Signature orange
  { from: "#ff5800", to: "#ffb070", glyph: "#7a2600" },
  // Ember / deep orange-red
  { from: "#e23c00", to: "#ff8a3d", glyph: "#5e1f00" },
  // Amber / gold
  { from: "#ff9500", to: "#ffd99e", glyph: "#7a4a00" },
  // Warm sand neutral
  { from: "#c9956b", to: "#f3dcc4", glyph: "#5c3d22" },
  // Terracotta
  { from: "#d2612f", to: "#f0a878", glyph: "#5a2810" },
  // Warm stone (neutral)
  { from: "#8c7d70", to: "#ddd0c4", glyph: "#3f352c" },
  // Moss green (status / active surfaces)
  { from: "#5c8a3a", to: "#bcd99a", glyph: "#2c441a" },
  // Olive / warm green
  { from: "#7a8c3a", to: "#d6dd9a", glyph: "#3c451a" },
  // Peach
  { from: "#ff7a4d", to: "#ffceb3", glyph: "#7a3318" },
  // Clay
  { from: "#b5563a", to: "#e7a98f", glyph: "#52201288" },
];

type GradientShape = "linear" | "radial" | "conic";
const SHAPES: ReadonlyArray<GradientShape> = ["linear", "radial", "conic"];

type PatternKind = "dots" | "grid" | "diagonal" | "none";
const PATTERNS: ReadonlyArray<PatternKind> = [
  "dots",
  "grid",
  "diagonal",
  "none",
];

type IconCorner = "tr" | "br" | "bl" | "tl";
const CORNERS: ReadonlyArray<IconCorner> = ["tr", "br", "bl", "tl"];

/** Deterministic 32-bit hash (FNV-1a) of the view id → stable per-view seed. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function gradientCss(
  shape: GradientShape,
  angle: number,
  from: string,
  to: string,
): string {
  switch (shape) {
    case "radial":
      return `radial-gradient(120% 120% at ${angle % 100}% ${(angle * 7) % 100}%, ${from} 0%, ${to} 100%)`;
    case "conic":
      return `conic-gradient(from ${angle}deg at 35% 30%, ${from} 0%, ${to} 45%, ${from} 100%)`;
    default:
      return `linear-gradient(${angle}deg, ${from} 0%, ${to} 100%)`;
  }
}

const CORNER_CLASS: Record<IconCorner, string> = {
  tr: "-right-5 -top-6 rotate-12",
  br: "-bottom-7 -right-6 -rotate-6",
  bl: "-bottom-6 -left-6 rotate-6",
  tl: "-left-6 -top-6 -rotate-12",
};

function PatternOverlay({ kind, seed }: { kind: PatternKind; seed: number }) {
  if (kind === "none") return null;
  const patternId = `vp-${kind}-${seed.toString(36)}`;
  return (
    <svg
      className="absolute inset-0 h-full w-full mix-blend-overlay opacity-40"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        {kind === "dots" && (
          <pattern
            id={patternId}
            width="16"
            height="16"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="3" cy="3" r="1.4" fill="rgba(255,255,255,0.9)" />
          </pattern>
        )}
        {kind === "grid" && (
          <pattern
            id={patternId}
            width="22"
            height="22"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M22 0H0V22"
              fill="none"
              stroke="rgba(255,255,255,0.8)"
              strokeWidth="1"
            />
          </pattern>
        )}
        {kind === "diagonal" && (
          <pattern
            id={patternId}
            width="14"
            height="14"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="14" fill="rgba(255,255,255,0.7)" />
          </pattern>
        )}
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}

/**
 * Renders the deterministic generative hero fill. Sits inside the card's
 * aspect-ratio box (the parent owns sizing/overflow). `group-hover` deepens the
 * tint slightly via an orange-resting darker-orange wash — never to black.
 */
export function GeneratedViewHero({
  viewId,
  icon,
  label,
  compact = false,
}: {
  viewId: string;
  icon?: string | null;
  label: string;
  compact?: boolean;
}) {
  const seed = hashId(viewId);
  const palette = PALETTES[seed % PALETTES.length];
  const shape = SHAPES[(seed >> 4) % SHAPES.length];
  const pattern = PATTERNS[(seed >> 8) % PATTERNS.length];
  const corner = CORNERS[(seed >> 12) % CORNERS.length];
  const angle = (seed >> 2) % 360;

  return (
    <div
      className="relative h-full w-full overflow-hidden transition-transform duration-200 group-hover:scale-[1.03]"
      style={{
        background: gradientCss(shape, angle, palette.from, palette.to),
      }}
    >
      <PatternOverlay kind={pattern} seed={seed} />
      {/* Oversized, cropped icon as artwork. */}
      <div
        className={`pointer-events-none absolute ${CORNER_CLASS[corner]}`}
        style={{ color: palette.glyph, opacity: 0.26 }}
        aria-hidden="true"
      >
        <ViewIcon
          icon={icon}
          label={label}
          className={compact ? "h-24 w-24" : "h-40 w-40"}
        />
      </div>
      {/* Centered foreground glyph on a soft disc so it reads on any palette. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <span
          className={`flex items-center justify-center rounded-full bg-white/15 text-white shadow-[0_2px_8px_rgba(0,0,0,0.18)] ring-1 ring-white/25 backdrop-blur-[2px] ${
            compact ? "h-10 w-10" : "h-14 w-14"
          }`}
        >
          <ViewIcon
            icon={icon}
            label={label}
            className={compact ? "h-5 w-5" : "h-7 w-7"}
          />
        </span>
      </div>
      {/* Subtle bottom scrim so the label area below stays readable. */}
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/15 to-transparent" />
    </div>
  );
}
