/**
 * Animated shader field for the unified app background: a flat base color with a
 * gentle rim pulse.
 */
import type * as React from "react";
import { DEFAULT_BACKGROUND_COLOR } from "../state/ui-preferences";

export interface ShaderBackgroundProps {
  /** Base hex color (6-digit) for the flat field and its rim pulse. */
  color?: string;
}

// A flat warm field whose EDGE slowly breathes between warm-white and the
// chosen color — a soft inset glow from the screen perimeter inward. The
// center stays a clean flat field; only the rim shifts. Generalized from the
// original /chat orange home so any color drives the same gentle pulse.
//
// Each rim color is a SEPARATE layer with a STATIC inset box-shadow (painted
// once) and the breathing is a pure `opacity` crossfade between them. opacity is
// compositor-only, so the rim animates without repainting the full-viewport
// box-shadow every frame. Fully stilled under prefers-reduced-motion.
const EDGE_CSS = `
@keyframes app-bg-shader-0 { 0%{opacity:1} 50%{opacity:0} 100%{opacity:1} }
@keyframes app-bg-shader-1 { 0%{opacity:0} 50%{opacity:1} 100%{opacity:0} }
.app-bg-shader-layer {
  position: absolute;
  inset: 0;
  animation-duration: 30s;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
.app-bg-shader-0 { box-shadow: inset 0 0 170px 10px rgba(255, 250, 244, 0.42); animation-name: app-bg-shader-0; }
.app-bg-shader-1 { animation-name: app-bg-shader-1; }
@media (prefers-reduced-motion: reduce) {
  .app-bg-shader-layer { animation: none; opacity: 0; }
  .app-bg-shader-1 { opacity: 1; }
}
`;

/**
 * The animated shader field for the unified app background. Flat base color
 * with a gentle, living rim pulse — no gradient, no vignette, no text. The rim
 * glow is the base color at low alpha, so the whole field reads as one hue.
 */
export function ShaderBackground({
  color = DEFAULT_BACKGROUND_COLOR,
}: ShaderBackgroundProps = {}): React.JSX.Element {
  // Rim glow = the chosen color at ~0.30 alpha (8-digit hex). `color` is a
  // validated 6-digit hex, so the suffix always yields a valid CSS color.
  const rim = `${color}4d`;
  return (
    <div
      aria-hidden="true"
      data-testid="app-background-shader"
      data-eliza-bg="shader"
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 0, backgroundColor: color }}
    >
      <style>{EDGE_CSS}</style>
      <div className="app-bg-shader-layer app-bg-shader-0" />
      <div
        className="app-bg-shader-layer app-bg-shader-1"
        style={{ boxShadow: `inset 0 0 150px 6px ${rim}` }}
      />
    </div>
  );
}
