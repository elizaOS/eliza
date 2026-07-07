/**
 * Animated shader field for the unified app background: a flat base color with a
 * gentle rim pulse.
 */
import type * as React from "react";
import {
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_BACKGROUND_GLOW,
} from "../state/ui-preferences";

export interface ShaderBackgroundProps {
  /** Base hex color (6-digit) for the deep warm field. */
  color?: string;
  /** Ember glow hex (6-digit). Defaults to the brand orange. */
  glow?: string;
}

// "Midnight ember." A deep warm near-black field with a single low orange glow
// breathing up from the bottom, like a fire banked low in a dark room. The
// center and top stay a clean dark field so content reads cleanly; only the
// low glow drifts in brightness. This is the opposite of the prior "flat bright
// color fills the whole viewport" wall: the field is dark, the warmth is an
// accent that pools at the bottom near the composer, never a wash over the UI.
//
// Two stacked radial pools (a wide low ambient and a tighter hot core) crossfade
// in opacity only (compositor-cheap, no per-frame repaint of the gradients) so
// the ember "breathes" without ever animating layout or filters. A faint top
// vignette keeps the status bar legible. Fully stilled under reduced-motion.
const EMBER_CSS = `
@keyframes app-ember-breathe-a { 0%{opacity:0.92} 50%{opacity:0.62} 100%{opacity:0.92} }
@keyframes app-ember-breathe-b { 0%{opacity:0.55} 50%{opacity:0.9} 100%{opacity:0.55} }
.app-ember-layer { position:absolute; inset:0; }
.app-ember-a { animation: app-ember-breathe-a 26s ease-in-out infinite; }
.app-ember-b { animation: app-ember-breathe-b 26s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .app-ember-a, .app-ember-b { animation: none; }
  .app-ember-a { opacity: 0.8; }
  .app-ember-b { opacity: 0.72; }
}
`;

/** Mix two 6-digit hex colors by `t` (0 = a, 1 = b). Used to derive the warm
 *  field tones from the base + glow without hardcoding intermediate hexes. */
function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => Number.parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => Number.parseInt(b.slice(i, i + 2), 16));
  const out = pa.map((v, i) =>
    Math.round(v + (pb[i] - v) * t)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${out.join("")}`;
}

/**
 * The unified app background: a deep warm field with a low, living ember glow.
 * No flat color wall, no text. The glow is the accent pooled at the bottom
 * where the conversation lives, fading to a clean dark field up top.
 */
export function ShaderBackground({
  color = DEFAULT_BACKGROUND_COLOR,
  glow = DEFAULT_BACKGROUND_GLOW,
}: ShaderBackgroundProps = {}): React.JSX.Element {
  // A subtle vertical settle from the base into a hair-warmer floor tone, so the
  // dark field itself isn't perfectly flat (perfectly flat reads as cheap).
  const floor = mixHex(color, glow, 0.14);
  // The ember pools: a wide ambient warmth and a tighter hotter core, both
  // anchored low-center. Alpha keeps them as a glow, never an opaque fill.
  const emberWide = `${glow}33`; // ~0.20
  const emberCore = `${glow}4d`; // ~0.30
  return (
    <div
      aria-hidden="true"
      data-testid="app-background-shader"
      data-eliza-bg="shader"
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{
        zIndex: 0,
        backgroundImage: `linear-gradient(to bottom, ${color} 0%, ${color} 52%, ${floor} 100%)`,
      }}
    >
      <style>{EMBER_CSS}</style>
      {/* Wide ambient ember, low and broad. */}
      <div
        className="app-ember-layer app-ember-a"
        style={{
          backgroundImage: `radial-gradient(120% 75% at 50% 116%, ${emberWide} 0%, transparent 60%)`,
        }}
      />
      {/* Hotter core, tighter and brighter, the heart of the banked fire. */}
      <div
        className="app-ember-layer app-ember-b"
        style={{
          backgroundImage: `radial-gradient(85% 52% at 50% 120%, ${emberCore} 0%, transparent 58%)`,
        }}
      />
      {/* Faint top settle so the status bar / clock never sits on raw glow. */}
      <div
        className="app-ember-layer"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, transparent 18%)",
        }}
      />
    </div>
  );
}
