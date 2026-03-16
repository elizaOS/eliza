import { resolveAppAssetUrl } from "../utils/asset-url";
import type { UiTheme } from "./ui-preferences";

/** Number of bundled VRM avatars shipped with the app. */
const BASE_VRM_COUNT = 4;

export const VRM_COUNT = BASE_VRM_COUNT;

/**
 * Maps logical avatar indices (1-4) to the original source file numbers.
 * Index 1 → milady-1, Index 2 → milady-4, Index 3 → milady-5, Index 4 → milady-9.
 */
const VRM_INDEX_MAP: readonly number[] = [1, 4, 5, 9];

function resolveSourceIndex(logicalIndex: number): number {
  const normalized = normalizeAvatarIndex(logicalIndex);
  const safe = normalized > 0 ? normalized : 1;
  return VRM_INDEX_MAP[safe - 1] ?? VRM_INDEX_MAP[0];
}

function normalizeAvatarIndex(index: number): number {
  if (!Number.isFinite(index)) return 1;
  const n = Math.trunc(index);
  if (n === 0) return 0;
  if (n < 1 || n > VRM_COUNT) return 1;
  return n;
}

/** Resolve a bundled VRM index (1–N) to its public asset URL. */
export function getVrmUrl(index: number): string {
  const sourceIndex = resolveSourceIndex(index);
  return resolveAppAssetUrl(`vrms/milady-${sourceIndex}.vrm.gz`);
}

/** Resolve a bundled VRM index (1–N) to its preview thumbnail URL. */
export function getVrmPreviewUrl(index: number): string {
  const sourceIndex = resolveSourceIndex(index);
  return resolveAppAssetUrl(`vrms/previews/milady-${sourceIndex}.png`);
}

/** Resolve a bundled VRM index (1-N) to its custom background URL. */
export function getVrmBackgroundUrl(index: number): string {
  const sourceIndex = resolveSourceIndex(index);
  const EXT = "png";
  return resolveAppAssetUrl(`vrms/backgrounds/milady-${sourceIndex}.${EXT}`);
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
  const sourceIndex = resolveSourceIndex(index);
  return `MILADY-${String(sourceIndex).padStart(2, "0")}`;
}

/** Whether a bundled index points to the official Milady avatar set. */
export function isOfficialVrmIndex(_index: number): boolean {
  return false;
}

/** Whether a VRM index requires an explicit 180° face-camera flip instead of auto-detection. */
export function getVrmNeedsFlip(index: number): boolean {
  const normalized = normalizeAvatarIndex(index);
  if (normalized <= BASE_VRM_COUNT) return false;
  return false;
}

export { normalizeAvatarIndex };
