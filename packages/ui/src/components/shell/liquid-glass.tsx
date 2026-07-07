/**
 * Liquid-glass recipe for the chat sheet: a specular rim + inner bevel on top
 * of the existing frosted (blur/saturate) surface.
 *
 * "Liquid glass" reads from the edge, not the fill: a bright specular hairline
 * along the top rim, a soft interior bevel, and a gentle bottom vignette give
 * the panel the depth of a real glass slab lit from above. Full-surface SVG
 * displacement (feTurbulence -> feDisplacementMap) on `backdrop-filter` smears
 * a panel this large into a dark wobble and shimmers over the live ember field.
 * Edge-only refraction needs an edge-masked displacement or a real normal map;
 * until that exists, the rim + bevel + sheen carry the look without per-frame
 * filter cost.
 *
 * Consumed by ContinuousChatOverlay (the inset sheet surface) and the notification cards (NotificationsHomeCenter). Values are
 * neutral white/black only (no accent, no blue), and depth is inset light with
 * no outer drop shadow per the shell's flat surface system.
 */

/**
 * Inset edge stack for the frosted surface: a bright specular top hairline, a
 * faint left rim, and a soft bottom-interior vignette. Applied as `box-shadow`
 * on the panel so the whole recipe is one token the sheet and any future glass
 * surface can share.
 */
export const LIQUID_GLASS_EDGE_SHADOW = [
  "inset 0 1px 0 0 rgb(255 255 255 / 55%)",
  "inset 1.5px 0 0 0 rgb(255 255 255 / 12%)",
  "inset 0 -20px 40px -24px rgb(0 0 0 / 45%)",
].join(", ");

/**
 * Specular sheen for the surface `background-image`: a soft radial highlight
 * near the top-left corner, as if a light source sits above the panel. Replaces
 * the flat top-sheen gradient so the glass catches light rather than just
 * fading.
 */
export const LIQUID_GLASS_SHEEN =
  "radial-gradient(120% 60% at 30% -10%, rgba(255,255,255,0.16) 0%, transparent 55%)";
