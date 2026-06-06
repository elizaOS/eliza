import { getAppHeroThemeKey } from "@elizaos/shared";
import {
  Bot,
  Briefcase,
  Gamepad2,
  Globe2,
  type LucideIcon,
  Sparkles,
  Wallet,
  Wrench,
} from "lucide-react";
import { resolveApiUrl, resolveAppAssetUrl } from "../../utils/asset-url";
import type { AppIdentitySource } from "./app-identity";

export function iconImageSource(
  icon: string | null | undefined,
): string | null {
  const value = icon?.trim();
  if (!value) return null;
  if (
    /^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/|\.\/|\.\.\/)/i.test(
      value,
    )
  ) {
    return resolveRuntimeImageUrl(value);
  }
  return null;
}

/**
 * Convert a heroImage/icon src into a runtime-safe URL.
 *
 * Root-relative paths fail under non-http origins (electrobun://, file://)
 * because the page origin isn't the static asset host. Route them through
 * the appropriate runtime resolver so they hit the API/asset base instead.
 */
export function resolveRuntimeImageUrl(value: string): string {
  // Absolute URLs, data/blob URIs, and custom schemes are already runtime-safe.
  if (/^(https?:|data:|blob:|file:|capacitor:|electrobun:|app:)/i.test(value)) {
    return value;
  }
  // API-served hero endpoints must hit the API base, not the asset CDN.
  if (value.startsWith("/api/") || value.startsWith("api/")) {
    return resolveApiUrl(value.startsWith("/") ? value : `/${value}`);
  }
  // Static asset under apps/app/public/ — resolves to CDN base in releases.
  return resolveAppAssetUrl(value);
}

export function getAppCategoryIcon(app: AppIdentitySource): LucideIcon {
  switch (getAppHeroThemeKey(app)) {
    case "play":
      return Gamepad2;
    case "chat":
      return Bot;
    case "money":
      return Wallet;
    case "tools":
      return Wrench;
    case "world":
      return Globe2;
    case "ops":
      return Briefcase;
    default:
      return Sparkles;
  }
}
