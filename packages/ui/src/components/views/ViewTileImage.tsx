import { useState } from "react";
import type { ViewEntry } from "../../hooks/view-catalog";
import { resolveApiUrl } from "../../utils/asset-url";
import { emitViewInteraction } from "../../view-telemetry";
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
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return url;
  return resolveApiUrl(url);
}

/**
 * The shared visual core for a launcher tile: render the view's hero
 * (`entry.imageUrl`, which the agent serves as a real image or a deterministic
 * branded SVG) and fall back to the Lucide glyph if the image is absent OR fails
 * to load — so a tile is never blank. This is the single hero-resolution path
 * used by both the Springboard tile and the catalog "Get" card; callers supply
 * only the container/glyph styling that genuinely differs between surfaces.
 *
 * A load failure emits a `hero-image-error` interaction event (best-effort,
 * client-only) so broken hero endpoints are observable instead of silently
 * swallowed by the glyph fallback.
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
  source: "springboard" | "view-catalog";
  /** Styling for the image/glyph container (size, rounding, hover treatment). */
  containerClassName: string;
  /** Styling for the fallback glyph. */
  glyphClassName?: string;
  /** data-testid for the <img>, when a caller asserts on it. */
  imageTestId?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = failed ? undefined : resolveTileImageUrl(entry.imageUrl);

  if (url) {
    return (
      <div className={containerClassName}>
        <img
          src={url}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={() => {
            emitViewInteraction({
              source,
              action: "hero-image-error",
              viewId: entry.id,
            });
            setFailed(true);
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
