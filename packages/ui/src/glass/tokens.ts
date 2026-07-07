/**
 * Canonical glass-surface tokens: the single vocabulary every glassmorphic
 * chrome element draws from. Before this module the shell had ten divergent
 * surface recipes (four blur strengths, five translucent fills, three border
 * idioms — see the fragmentation inventory in
 * `packages/docs/ongoing-development/liquid-glass-unification.md`); a surface
 * now picks a VARIANT here instead of hand-rolling backdrop-filter values.
 *
 * The optical layers themselves (rim ring, sheen, edge shadow, Chromium edge
 * refraction) live in `../components/shell/liquid-glass.tsx` and are
 * re-exported through `./index.ts`; this file only fixes the per-variant
 * numbers. Variants deliberately map 1:1 onto the physical role of a surface,
 * not onto components, so two components sharing a role render identical glass:
 *
 *   sheet   — large panel (chat sheet): heavy blur, NO saturate (saturate over
 *             the warm theme reads brown — measured, not taste), no refraction
 *             (a panel this size would visibly warp text behind it).
 *   card    — small floating card (notification): medium blur + saturate,
 *             refraction-eligible on Chromium, rim ring.
 *   pill    — compact control (composer pill, back-button chip, buttons):
 *             light blur, rim ring, interactive hover lift.
 *   menu    — popover chrome (the + menu, dropdowns, slash menu): same optical
 *             stack as card but a darker fill so hit targets stay legible over
 *             any wallpaper.
 *   banner  — transient toast/banner: card fill at higher opacity, no rim (it
 *             lives for seconds; the ring reads as noise at toast scale).
 *
 * `backdropFilter` values are the CSS tier; native tiers replace the fill +
 * blur with a real system material behind a transparent element (see
 * `useNativeGlass`), keeping ONLY the rim/sheen overlays so the branded edge
 * survives on top of the OS material.
 */

import {
  LIQUID_GLASS_BLUR,
  LIQUID_GLASS_EDGE_SHADOW,
  LIQUID_GLASS_REFRACTION,
  LIQUID_GLASS_SHEEN,
} from "../components/shell/liquid-glass";

export type GlassVariant = "sheet" | "card" | "pill" | "menu" | "banner";

export interface GlassRecipe {
  /** Translucent fill painted under the backdrop filter. */
  background: string;
  /** CSS-tier backdrop filter (WebKit-safe). */
  backdropFilter: string;
  /** Chromium upgrade under `@supports (backdrop-filter: url(#x))`; null = keep base. */
  refraction: string | null;
  /** Whether the mask-composite specular rim ring is drawn. */
  rim: boolean;
  /** Inset edge shadow + sheen (the "thickness" layers). */
  edgeShadow: string;
  sheen: string;
  /** Corner radius token (CSS length). */
  radius: string;
}

/** Fill used by the chat sheet: theme-aware card at 86%. */
export const GLASS_SHEET_FILL =
  "color-mix(in srgb, var(--card) 86%, transparent)";
/** Fill used by floating cards (notifications). */
export const GLASS_CARD_FILL = "rgb(12 12 14 / 34%)";
/** Darker menu fill so labels stay readable over any wallpaper. */
export const GLASS_MENU_FILL = "rgb(10 10 12 / 62%)";
/** Banner/toast fill — brief lifetime, higher opacity for instant legibility. */
export const GLASS_BANNER_FILL = "rgb(10 10 12 / 55%)";
/** Compact-control fill — lightest, the control's icon carries the contrast. */
export const GLASS_PILL_FILL = "rgb(20 20 24 / 30%)";

export const GLASS_RECIPES: Record<GlassVariant, GlassRecipe> = {
  sheet: {
    background: GLASS_SHEET_FILL,
    // No saturate: over the orange-accented theme, saturate() muddies to brown.
    backdropFilter: "blur(20px)",
    refraction: null,
    rim: false,
    edgeShadow: LIQUID_GLASS_EDGE_SHADOW,
    sheen: LIQUID_GLASS_SHEEN,
    radius: "1.5rem",
  },
  card: {
    background: GLASS_CARD_FILL,
    backdropFilter: LIQUID_GLASS_BLUR,
    refraction: LIQUID_GLASS_REFRACTION,
    rim: true,
    edgeShadow: LIQUID_GLASS_EDGE_SHADOW,
    sheen: LIQUID_GLASS_SHEEN,
    radius: "1rem",
  },
  pill: {
    background: GLASS_PILL_FILL,
    backdropFilter: "blur(12px) saturate(1.2)",
    refraction: null,
    rim: true,
    edgeShadow: LIQUID_GLASS_EDGE_SHADOW,
    sheen: LIQUID_GLASS_SHEEN,
    radius: "9999px",
  },
  menu: {
    background: GLASS_MENU_FILL,
    backdropFilter: LIQUID_GLASS_BLUR,
    refraction: LIQUID_GLASS_REFRACTION,
    rim: true,
    edgeShadow: LIQUID_GLASS_EDGE_SHADOW,
    sheen: LIQUID_GLASS_SHEEN,
    radius: "0.75rem",
  },
  banner: {
    background: GLASS_BANNER_FILL,
    backdropFilter: LIQUID_GLASS_BLUR,
    refraction: null,
    rim: false,
    edgeShadow: LIQUID_GLASS_EDGE_SHADOW,
    sheen: LIQUID_GLASS_SHEEN,
    radius: "0.75rem",
  },
};
