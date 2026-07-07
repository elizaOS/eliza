/**
 * Liquid-glass recipe shared by the chat sheet (ContinuousChatOverlay) and the
 * notification cards (NotificationsHomeCenter).
 *
 * "Liquid glass" reads from the EDGE, not the fill. Three layers build it:
 *
 *   1. A directional specular RIM that traces the whole rounded border
 *      (`LIQUID_GLASS_RIM_CSS`, a mask-composite gradient ring): brightest at
 *      the top-left where the light sits, faint through the middle, glinting
 *      again at the bottom-right (the exit-light of a real glass slab). This
 *      replaces the old one-sided inset hairline that read as a flat vertical
 *      border line.
 *   2. A soft interior sheen + depth (`LIQUID_GLASS_SHEEN` background image and
 *      `LIQUID_GLASS_EDGE_SHADOW` inset box-shadow) so the surface catches a
 *      top-down highlight and has thickness.
 *   3. EDGE REFRACTION (`LiquidGlassRefractionDefs` + `LIQUID_GLASS_REFRACTION`)
 *      — an SVG `feDisplacementMap` on `backdrop-filter` that bends the
 *      background at the rim, the actual "liquid" cue. Only Chromium honors
 *      `backdrop-filter: url(#…)`, so it is additive under `@supports`; WebKit
 *      keeps the rim + frosted blur. Applied ONLY to the small notification
 *      cards — a full-bleed panel this size would visibly warp the text behind
 *      it (why the chat sheet keeps rim + blur only).
 *
 * Values are neutral white/black only (no accent, no blue), and depth is inset
 * light with no outer drop shadow per the shell's flat surface system. The
 * turbulence seed is fixed, so the refraction is static (no per-frame shimmer
 * over the live background) and screenshot-deterministic.
 */

/**
 * Inset edge stack: a bright specular top hairline + a faint bottom exit-glint
 * (glass thickness) + a soft bottom-interior vignette. The sides are carried by
 * the mask-composite rim ({@link LIQUID_GLASS_RIM_CSS}), not here, so there is
 * no one-sided vertical line. Applied as `box-shadow` so the sheet and the
 * cards share one token.
 */
export const LIQUID_GLASS_EDGE_SHADOW = [
  "inset 0 1px 0 0 rgb(255 255 255 / 50%)",
  "inset 0 -1px 0 0 rgb(255 255 255 / 14%)",
  "inset 0 -20px 40px -26px rgb(0 0 0 / 42%)",
].join(", ");

/**
 * Specular sheen for the surface `background-image`: a soft radial highlight
 * near the top-left corner, as if a light source sits above the panel, so the
 * glass catches light rather than just fading.
 */
export const LIQUID_GLASS_SHEEN =
  "radial-gradient(120% 60% at 30% -10%, rgba(255,255,255,0.16) 0%, transparent 55%)";

/**
 * A directional specular rim that traces the whole rounded border via a
 * mask-composite gradient ring on a `::before`. Brightest top-left (incident
 * light), faint through the middle, a softer glint bottom-right (exit light) —
 * the rounded rim of a real glass slab, following every corner instead of a
 * single vertical hairline. The caller supplies the selector; the element must
 * be `position: relative` with the matching `border-radius`. `[data-glass-rim]`
 * lets a bundler-scoped stylesheet target the same shape without a class clash.
 */
export function liquidGlassRimCss(selector: string): string {
  return `
${selector}::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(
    145deg,
    rgba(255, 255, 255, 0.6) 0%,
    rgba(255, 255, 255, 0.1) 26%,
    rgba(255, 255, 255, 0.02) 58%,
    rgba(255, 255, 255, 0.24) 100%
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}`;
}

/**
 * The `backdrop-filter` that refracts the background at the card rim. Chromium
 * only (`url(#…)` backdrop refs are unsupported on WebKit), so callers gate it
 * behind `@supports` and keep a plain `blur()+saturate()` fallback. The filter
 * id is defined by {@link LiquidGlassRefractionDefs}, which must be mounted once
 * in the same document.
 */
export const LIQUID_GLASS_REFRACTION_FILTER_ID =
  "eliza-liquid-glass-refraction";
export const LIQUID_GLASS_REFRACTION = `url(#${LIQUID_GLASS_REFRACTION_FILTER_ID}) blur(12px) saturate(1.5)`;
/** Fallback for WebKit / no-url-backdrop: the frosted blur without refraction. */
export const LIQUID_GLASS_BLUR = "blur(16px) saturate(1.4)";

/**
 * The SVG filter that drives the edge refraction. Mount ONCE per document
 * (hidden, zero-size). A low-frequency fractal-noise displacement, blurred and
 * applied at a modest scale, bends the frosted backdrop smoothly — a liquid
 * lens rather than frosted noise. The seed is fixed so the distortion is static
 * (no shimmer, deterministic screenshots).
 */
export function LiquidGlassRefractionDefs(): React.JSX.Element {
  return (
    <svg
      aria-hidden
      width="0"
      height="0"
      style={{ position: "absolute", width: 0, height: 0 }}
    >
      <title>Liquid glass refraction filter</title>
      <filter
        id={LIQUID_GLASS_REFRACTION_FILTER_ID}
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
        colorInterpolationFilters="sRGB"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.011 0.013"
          numOctaves={2}
          seed={17}
          result="noise"
        />
        <feGaussianBlur in="noise" stdDeviation="1.4" result="softNoise" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="softNoise"
          scale={26}
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}
