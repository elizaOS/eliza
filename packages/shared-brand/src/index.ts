/**
 * @elizaos/shared-brand
 *
 * Canonical brand tokens and asset paths. Every elizaOS surface — homepages,
 * cloud frontend, docs, app, electrobun — sources its logos, cloud video,
 * and color palette from here so the look stays in sync.
 *
 * Asset *bytes* are duplicated into each consumer's `public/` at sync time
 * (see `scripts/sync-to-public.mjs`). This module exports only the constants
 * needed at runtime: colors, font stacks, and the on-disk paths the sync
 * script will produce.
 */

export const BRAND_COLORS = {
  blue: "#0B35F1",
  orange: "#FF5800",
  white: "#FFFFFF",
  black: "#000000",
  gray: "#D1D0D4",
} as const;

export type BrandColor = keyof typeof BRAND_COLORS;

/**
 * Per-surface theme. Each maps to a `.theme-*` class defined in
 * `packages/ui/src/styles/base.css`.
 */
export const SURFACE_THEMES = {
  cloud: { themeClass: "theme-cloud", background: BRAND_COLORS.black, text: BRAND_COLORS.white },
  os: { themeClass: "theme-os", background: BRAND_COLORS.blue, text: BRAND_COLORS.white },
  app: { themeClass: "theme-app", background: BRAND_COLORS.orange, text: BRAND_COLORS.black },
} as const;

export type Surface = keyof typeof SURFACE_THEMES;

export const FONT_STACK =
  '"Poppins", system-ui, -apple-system, "Segoe UI", Arial, sans-serif';

export const FONT_WEIGHTS = [400, 500, 600, 700, 800] as const;

/**
 * Default public-relative paths for the synced assets. Each consumer that
 * runs the sync script ends up with files at exactly these paths.
 */
export const BRAND_PATHS = {
  logos: "/brand/logos",
  clouds: "/clouds",
  poster: "/clouds/poster.jpg",
} as const;

/**
 * Cloud video manifest — one entry per (speed, height, codec). Used by the
 * `<CloudVideoBackground>` component in `@elizaos/ui` to build a `<source>`
 * list with media queries.
 */
export const CLOUD_VIDEO_VARIANTS = {
  "1x": [
    { src: "clouds_1x_1080p.webm", type: "video/webm", minWidth: 1280 },
    { src: "clouds_1x_1080p.mp4", type: "video/mp4", minWidth: 1280 },
    { src: "clouds_1x_720p.webm", type: "video/webm", minWidth: 768 },
    { src: "clouds_1x_720p.mp4", type: "video/mp4", minWidth: 768 },
    { src: "clouds_1x_480p.webm", type: "video/webm" },
    { src: "clouds_1x_480p.mp4", type: "video/mp4" },
  ],
  "4x": [
    { src: "clouds_4x_1080p.webm", type: "video/webm", minWidth: 1280 },
    { src: "clouds_4x_1080p.mp4", type: "video/mp4", minWidth: 1280 },
    { src: "clouds_4x_720p.webm", type: "video/webm", minWidth: 768 },
    { src: "clouds_4x_720p.mp4", type: "video/mp4", minWidth: 768 },
    { src: "clouds_4x_480p.webm", type: "video/webm" },
    { src: "clouds_4x_480p.mp4", type: "video/mp4" },
  ],
  "8x": [
    { src: "clouds_8x_1080p.webm", type: "video/webm", minWidth: 1280 },
    { src: "clouds_8x_1080p.mp4", type: "video/mp4", minWidth: 1280 },
    { src: "clouds_8x_720p.webm", type: "video/webm", minWidth: 768 },
    { src: "clouds_8x_720p.mp4", type: "video/mp4", minWidth: 768 },
    { src: "clouds_8x_480p.webm", type: "video/webm" },
    { src: "clouds_8x_480p.mp4", type: "video/mp4" },
  ],
} as const;

export type CloudVideoSpeed = keyof typeof CLOUD_VIDEO_VARIANTS;

/**
 * The canonical logo variants. File names match `assets/logos/`. Pick the
 * one that fits the surface theme contrast.
 */
export const LOGO_FILES = {
  cloudBlack: "elizacloud_logotext_black.svg",
  cloudWhite: "elizacloud_logotext.svg",
  cloudTextBlack: "elizacloud_text_black.svg",
  cloudTextWhite: "elizacloud_text_white.svg",
  osBlack: "elizaOS_text_black.svg",
  osWhite: "elizaOS_text_white.svg",
  osLockupBlack: "elizaos_logotext_black.svg",
  osLockupWhite: "elizaos_logotext.svg",
  elizaBlack: "eliza_text_black.svg",
  elizaWhite: "eliza_text_white.svg",
  elizaLockupBlack: "eliza_logotext_black.svg",
  elizaLockupWhite: "eliza_logotext.svg",
  markBlueNoBg: "logo_blue_nobg.svg",
  markBlueBlackBg: "logo_blue_blackbg.svg",
  markOrangeNoBg: "logo_orange_nobg.svg",
  markOrangeBlackBg: "logo_orange_blackbg.svg",
  markWhiteNoBg: "logo_white_nobg.svg",
  markWhiteBlackBg: "logo_white_blackbg.svg",
  markWhiteBlueBg: "logo_white_bluebg.svg",
  markWhiteOrangeBg: "logo_white_orangebg.svg",
  markWhiteGrayBg: "logo_white_graybg.svg",
} as const;

export type LogoVariant = keyof typeof LOGO_FILES;
