import { type CSSProperties, useState } from "react";
import { client } from "../../api";
import {
  isLimitedCloudAgentApiResourceUrl,
  supportsFullAppShellRoutes,
} from "../../api/app-shell-capabilities";
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import { resolveApiUrl } from "../../utils/asset-url";
import { emitViewInteraction } from "../../view-telemetry";
import { ViewIcon } from "./ViewIcon";

// Brand rule: no blue anywhere — the deterministic tile gradients stay in the
// warm/neutral/green range (former blue + indigo entries were recolored to
// gold + fuchsia).
const LAUNCHER_ICON_PALETTES: ReadonlyArray<{
  from: string;
  to: string;
  foreground: string;
}> = [
  { from: "#ff7a1a", to: "#f2c14e", foreground: "#fff7ed" },
  { from: "#0f766e", to: "#5eead4", foreground: "#ecfeff" },
  { from: "#a16207", to: "#fde047", foreground: "#fefce8" },
  { from: "#7c2d12", to: "#fb923c", foreground: "#fff7ed" },
  { from: "#334155", to: "#94a3b8", foreground: "#f8fafc" },
  { from: "#be123c", to: "#fda4af", foreground: "#fff1f2" },
  { from: "#166534", to: "#86efac", foreground: "#f0fdf4" },
  { from: "#86198f", to: "#f0abfc", foreground: "#fdf4ff" },
];

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function launcherIconStyle(entry: ViewEntry): CSSProperties {
  const palette =
    LAUNCHER_ICON_PALETTES[
      hashText(`${entry.id}:${entry.label}`) % LAUNCHER_ICON_PALETTES.length
    ];
  return {
    background: `linear-gradient(145deg, ${palette.from} 0%, ${palette.to} 100%)`,
    color: palette.foreground,
  };
}

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

  const primaryUrl =
    failure === "none" ? resolveTileImageUrl(entry.imageUrl) : undefined;
  const fallbackUrl =
    failure !== "all" ? resolveTileImageUrl(entry.fallbackImageUrl) : undefined;
  const url = primaryUrl ?? fallbackUrl;
  const hasFallback = Boolean(fallbackUrl && fallbackUrl !== primaryUrl);

  if (source === "launcher") {
    if (url) {
      return (
        <div
          className={cn(containerClassName, "relative overflow-hidden")}
          data-view-visual={entry.id}
          style={launcherIconStyle(entry)}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-4 -top-5 h-14 w-14 rounded-full bg-white/25"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.36)_0%,rgba(255,255,255,0.08)_42%,rgba(0,0,0,0.2)_100%)]"
          />
          <ViewIcon
            icon={entry.icon}
            label={entry.label}
            id={entry.id}
            className={cn(
              glyphClassName,
              "relative z-0 drop-shadow-[0_1px_3px_rgba(0,0,0,0.35)]",
            )}
          />
          <img
            src={url}
            alt=""
            draggable={false}
            loading="eager"
            decoding="async"
            onError={() => {
              emitViewInteraction({
                source,
                action: "hero-image-error",
                viewId: entry.id,
              });
              setFailure(primaryUrl && hasFallback ? "primary" : "all");
            }}
            className="absolute inset-0 z-10 h-full w-full object-cover"
            data-testid={imageTestId}
          />
        </div>
      );
    }

    return (
      <div
        className={cn(containerClassName, "relative overflow-hidden")}
        data-view-visual={entry.id}
        style={launcherIconStyle(entry)}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-4 -top-5 h-14 w-14 rounded-full bg-white/25"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.36)_0%,rgba(255,255,255,0.08)_42%,rgba(0,0,0,0.2)_100%)]"
        />
        <ViewIcon
          icon={entry.icon}
          label={entry.label}
          id={entry.id}
          className={cn(
            glyphClassName,
            "relative z-10 drop-shadow-[0_1px_3px_rgba(0,0,0,0.35)]",
          )}
        />
      </div>
    );
  }

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
