/**
 * Icon/image resolution helpers for the app-identity tiles: maps an app's
 * category to a Lucide icon, resolves a raw icon/hero value to a renderable
 * source, and rewrites runtime-relative image paths to a fetchable URL. The
 * runtime resolver routes API-resource paths to `resolveApiUrl` vs asset paths
 * to `resolveAppAssetUrl` based on the host's app-shell capability flags, so
 * limited cloud-agent hosts don't request routes they can't serve.
 */

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
import { client } from "../../api";
import {
  isLimitedCloudAgentApiResourceUrl,
  supportsFullAppShellRoutes,
} from "../../api/app-shell-capabilities";
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
    if (isLimitedCloudAgentApiResourceUrl(value)) {
      return "";
    }
    return value;
  }
  // API-served hero endpoints must hit the API base, not the asset CDN.
  if (value.startsWith("/api/") || value.startsWith("api/")) {
    if (!supportsFullAppShellRoutes(client.getBaseUrl())) {
      return "";
    }
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
