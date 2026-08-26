/**
 * Paints launcher and catalog tile imagery with deterministic fallback glyph
 * styling and runtime-safe API URL resolution.
 *
 * Launcher tiles delegate to the shared smoked-glass `LauncherAppIcon` system
 * and never render generated hero art. Painting the per-view generated hero PNG
 * (`entry.imageUrl`) over the glyph is what produced a cartoon virus for
 * Settings, a ladybug for Memories, etc. Hero art belongs to the larger catalog
 * card surface, where a preview reads as a preview; on the small home-grid tile
 * it only muddies the legible glyph. The catalog branch keeps the image/fallback
 * order.
 */
import { useState } from "react";
import { client } from "../../api";
import {
  isLimitedCloudAgentApiResourceUrl,
  supportsFullAppShellRoutes,
} from "../../api/app-shell-capabilities";
import type { ViewEntry } from "../../hooks/view-catalog";
import { resolveApiUrl } from "../../utils/asset-url";
import { emitViewInteraction } from "../../view-telemetry";
import { LauncherAppIcon } from "./LauncherAppIcon";
import { ViewIcon } from "./ViewIcon";

/**
 * Resolve a tile hero URL into one reachable from the renderer. The hero source
 * is a root-relative API path (`/api/views/<id>/hero`) on built-in views, which
 * resolves correctly on the web (same origin) but NOT in native/desktop shells
 * that run on `file://` / `capacitor://` — there a bare `/api/...` path points at
 * the SPA, not the agent backend, so the image 404s and every tile falls back to
 * the bare glyph (the "no image icons" report). Routing root-relative paths
 * through `resolveApiUrl` prepends the runtime API base so the branded hero image
 * loads everywhere. Already-absolute URLs (http/https/data/blob) pass through.
 */
function resolveTileImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) {
    return isLimitedCloudAgentApiResourceUrl(url) ? undefined : url;
  }
  if (
    (url.startsWith("/api/") || url.startsWith("api/")) &&
    !supportsFullAppShellRoutes(client.getBaseUrl())
  ) {
    return undefined;
  }
  return resolveApiUrl(url);
}

/**
 * The shared visual core for view launch surfaces.
 *
 * Launcher tiles are app icons: paint the deterministic glyph tile
 * underneath the concrete hero or generated branded fallback so icons never
 * appear blank while image decoding catches up after a swipe. Catalog cards are
 * previews and use the same image/fallback order at their larger size.
 *
 * A load failure emits a `hero-image-error` interaction event (best-effort,
 * client-only) from preview surfaces so broken hero endpoints are observable
 * instead of silently swallowed by the glyph fallback.
 */
export function ViewTileImage({
  entry,
  source,
  containerClassName,
  glyphClassName = "h-6 w-6",
  imageTestId,
}: {
  entry: ViewEntry;
  /** Which surface is rendering — tags the hero-image-error telemetry. */
  source: "launcher" | "view-catalog";
  /** Styling for the image/glyph container (size, rounding, hover treatment). */
  containerClassName: string;
  /** Styling for the fallback glyph. */
  glyphClassName?: string;
  /** data-testid for the <img>, when a caller asserts on it. */
  imageTestId?: string;
}) {
  const [failure, setFailure] = useState<"none" | "primary" | "all">("none");

  // Launcher tiles never composite a hero image, they read the glyph directly,
  // so the image-URL resolution below is scoped to the catalog card surface.
  if (source === "launcher") {
    // Glyph-only app icon: the shared component owns squircle, plate, and glyph
    // optics. No decorative per-view palette or `<img>` hero; no
    // `entry.imageUrl` probe and no hero load/error state. A third-party URL
    // supplied as the actual `icon` still flows through the shared launcher
    // resolver, preserving that public contract.
    return (
      <LauncherAppIcon
        entry={entry}
        className={containerClassName}
        glyphClassName={glyphClassName}
      />
    );
  }

  const primaryUrl =
    failure === "none" ? resolveTileImageUrl(entry.imageUrl) : undefined;
  const fallbackUrl =
    failure !== "all" ? resolveTileImageUrl(entry.fallbackImageUrl) : undefined;
  const url = primaryUrl ?? fallbackUrl;
  const hasFallback = Boolean(fallbackUrl && fallbackUrl !== primaryUrl);

  if (url) {
    return (
      <div className={containerClassName}>
        <img
          src={url}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          // Decorative hero art must never compete with interactive work
          // (gesture frames, chat streaming) for network/decode bandwidth.
          fetchPriority="low"
          onError={() => {
            emitViewInteraction({
              source,
              action: "hero-image-error",
              viewId: entry.id,
            });
            setFailure(primaryUrl && hasFallback ? "primary" : "all");
          }}
          className="h-full w-full object-cover"
          data-testid={imageTestId}
        />
      </div>
    );
  }

  return (
    <div className={containerClassName} data-view-visual={entry.id}>
      <ViewIcon
        icon={entry.icon}
        label={entry.label}
        id={entry.id}
        className={glyphClassName}
      />
    </div>
  );
}
