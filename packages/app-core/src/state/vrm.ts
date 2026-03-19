import { resolveAppAssetUrl } from "../utils/asset-url";
import type { UiTheme } from "./ui-preferences";

// ---------------------------------------------------------------------------
// Bundled VRM asset roster
// ---------------------------------------------------------------------------

interface BundledVrmAsset {
  title: string;
  slug: string;
}

/**
 * Default Eliza avatar roster (4 slots).
 * Apps can override this at startup by setting window.__APP_VRM_ASSETS__
 * before mounting the React tree.
 */
const DEFAULT_ASSETS: BundledVrmAsset[] = [
  { title: "ELIZA-01", slug: "eliza-1" },
  { title: "ELIZA-04", slug: "eliza-4" },
  { title: "ELIZA-05", slug: "eliza-5" },
  { title: "ELIZA-09", slug: "eliza-9" },
];

declare global {
  interface Window {
    __APP_VRM_ASSETS__?: BundledVrmAsset[];
  }
}

function getAssets(): BundledVrmAsset[] {
  if (typeof window !== "undefined" && Array.isArray(window.__APP_VRM_ASSETS__)) {
    return window.__APP_VRM_ASSETS__;
  }
  return DEFAULT_ASSETS;
}

/** Number of bundled VRM avatars shipped with the app. */
export function getVrmCount(): number {
  return getAssets().length;
}

// Legacy constant — prefer getVrmCount() for dynamic rosters.
export const VRM_COUNT = DEFAULT_ASSETS.length;

export function normalizeAvatarIndex(index: number): number {
  if (!Number.isFinite(index)) return 1;
  const n = Math.trunc(index);
  if (n === 0) return 0;
  const count = getAssets().length;
  if (n < 1 || n > count) return 1;
  return n;
}

/** Resolve a bundled VRM index (1–N) to its public asset URL. */
export function getVrmUrl(index: number): string {
  const assets = getAssets();
  const n = normalizeAvatarIndex(index);
  const safe = n > 0 ? n : 1;
  const slug = assets[safe - 1]?.slug ?? assets[0].slug;
  return resolveAppAssetUrl(`vrms/${slug}.vrm.gz`);
}

/** Resolve a bundled VRM index (1–N) to its preview thumbnail URL. */
export function getVrmPreviewUrl(index: number): string {
  const assets = getAssets();
  const n = normalizeAvatarIndex(index);
  const safe = n > 0 ? n : 1;
  const slug = assets[safe - 1]?.slug ?? assets[0].slug;
  return resolveAppAssetUrl(`vrms/previews/${slug}.png`);
}

/** Resolve a bundled VRM index (1-N) to its custom background URL. */
export function getVrmBackgroundUrl(index: number): string {
  const assets = getAssets();
  const n = normalizeAvatarIndex(index);
  const safe = n > 0 ? n : 1;
  const slug = assets[safe - 1]?.slug ?? assets[0].slug;
  return resolveAppAssetUrl(`vrms/backgrounds/${slug}.png`);
}

const COMPANION_THEME_BACKGROUND_INDEX: Record<UiTheme, number> = {
  light: 3,
  dark: 4,
};

/** Resolve the fixed companion-mode background for the current UI theme. */
export function getCompanionBackgroundUrl(theme: UiTheme): string {
  return getVrmBackgroundUrl(COMPANION_THEME_BACKGROUND_INDEX[theme]);
}

/** Human-readable roster title for bundled avatars. */
export function getVrmTitle(index: number): string {
  const assets = getAssets();
  const n = normalizeAvatarIndex(index);
  const safe = n > 0 ? n : 1;
  return assets[safe - 1]?.title ?? assets[0].title;
}

/** Whether a bundled index points to the official Eliza avatar set. */
export function isOfficialVrmIndex(_index: number): boolean {
  return false;
}

/** Whether a VRM index requires an explicit 180° face-camera flip instead of auto-detection. */
export function getVrmNeedsFlip(_index: number): boolean {
  return false;
}
