import {
  type BundledVrmAsset,
  getBootConfig,
  resolveAppAssetUrl,
  type UiTheme,
} from "@elizaos/ui";

const BUNDLED_VRM_FALLBACK_SLUG = "bundled-1";
const COMPANION_THEME_BACKGROUND_INDEX: Record<UiTheme, number> = {
  light: 3,
  dark: 4,
};

function getAssets(): BundledVrmAsset[] {
  const assets = getBootConfig().vrmAssets;
  return Array.isArray(assets) && assets.length > 0 ? assets : [];
}

export function getVrmCount(): number {
  return getAssets().length;
}

export const VRM_COUNT = 8;

export function normalizeAvatarIndex(index: number): number {
  if (!Number.isFinite(index)) return 1;
  const n = Math.trunc(index);
  if (n === 0) return 0;
  const count = getAssets().length;
  if (n < 1 || n > count) return 1;
  return n;
}

export function getVrmUrl(index: number): string {
  const assets = getAssets();
  if (assets.length === 0) {
    return resolveAppAssetUrl(`vrms/${BUNDLED_VRM_FALLBACK_SLUG}.vrm.gz`);
  }
  const n = normalizeAvatarIndex(index);
  const safe = n > 0 ? n : 1;
  const slug = assets[safe - 1]?.slug ?? assets[0]?.slug ?? "default";
  return resolveAppAssetUrl(`vrms/${slug}.vrm.gz`);
}

export function getVrmPreviewUrl(index: number): string {
  const assets = getAssets();
  if (assets.length === 0) {
    return resolveAppAssetUrl(`vrms/previews/${BUNDLED_VRM_FALLBACK_SLUG}.png`);
  }
  const n = normalizeAvatarIndex(index);
  const safe = n > 0 ? n : 1;
  const slug = assets[safe - 1]?.slug ?? assets[0]?.slug ?? "default";
  return resolveAppAssetUrl(`vrms/previews/${slug}.png`);
}

export function getVrmBackgroundUrl(index: number): string {
  const assets = getAssets();
  if (assets.length === 0) {
    return resolveAppAssetUrl(
      `vrms/backgrounds/${BUNDLED_VRM_FALLBACK_SLUG}.png`,
    );
  }
  const n = normalizeAvatarIndex(index);
  const safe = n > 0 ? n : 1;
  const slug = assets[safe - 1]?.slug ?? assets[0]?.slug ?? "default";
  return resolveAppAssetUrl(`vrms/backgrounds/${slug}.png`);
}

export function getCompanionBackgroundUrl(theme: UiTheme): string {
  return getVrmBackgroundUrl(COMPANION_THEME_BACKGROUND_INDEX[theme]);
}

export function getVrmTitle(index: number): string {
  const assets = getAssets();
  if (assets.length === 0) return "Avatar";
  const n = normalizeAvatarIndex(index);
  const safe = n > 0 ? n : 1;
  return assets[safe - 1]?.title ?? assets[0]?.title ?? "Avatar";
}
