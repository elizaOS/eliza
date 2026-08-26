/**
 * Renders the single reusable launcher-icon system for first- and third-party
 * views: one phone-native squircle, one smoked-glass plate, and one semantic
 * glyph.
 */
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import { Card } from "../ui/card";
import { resolveLauncherIconAsset } from "./launcher-ionicons";

type LauncherIconEntry = Pick<ViewEntry, "id" | "label" | "icon">;

export interface LauncherAppIconProps {
  entry: LauncherIconEntry;
  className?: string;
  glyphClassName?: string;
}

const SHAPE_CLASS = "grid aspect-square shrink-0 place-items-center";

// Filled Ionicons share a 512px canvas, but open silhouettes carry less visual
// mass than closed symbols. Keep the correction to size only so the grid stays
// centered and completely static.
const OPTICAL_GLYPH_SIZE: Readonly<Record<string, string>> = {
  cloud: "!size-[50%]",
  radio: "!size-[50%]",
  sparkles: "!size-[50%]",
  compass: "!size-[55%]",
  "document-text": "!size-[55%]",
  "person-circle": "!size-[55%]",
  reader: "!size-[55%]",
  server: "!size-[55%]",
  time: "!size-[55%]",
  "git-branch": "!size-[58%]",
  "trending-up": "!size-[58%]",
};

/**
 * Shared launcher icon. It intentionally has no active, transform, or
 * state-driven filter classes: pointer-down must never make the icon sink,
 * slide, scale, or flash.
 */
export function LauncherAppIcon({
  entry,
  className,
  glyphClassName,
}: LauncherAppIconProps) {
  const asset = resolveLauncherIconAsset(entry);
  return (
    <Card asChild variant="launcherIcon">
      <div
        className={cn(SHAPE_CLASS, className)}
        data-launcher-icon=""
        data-launcher-icon-variant={asset.kind}
        data-view-visual={entry.id}
      >
        <img
          src={asset.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          className={cn(
            "pointer-events-none relative z-10 !size-[52%] select-none object-contain",
            asset.kind === "ionicon"
              ? [
                  OPTICAL_GLYPH_SIZE[asset.name],
                  // The official SVG assets are black-filled. A static inversion
                  // brings them onto the chat panel's off-white contrast ladder;
                  // third-party image colors remain untouched.
                  "brightness-0 invert opacity-[0.92]",
                ]
              : undefined,
            glyphClassName,
          )}
          data-launcher-glyph=""
          data-launcher-glyph-kind={asset.kind}
          data-ionicon={asset.kind === "ionicon" ? asset.name : undefined}
        />
      </div>
    </Card>
  );
}

/** Loading placeholder locked to the exact same continuous-corner geometry. */
export function LauncherAppIconSkeleton({ className }: { className?: string }) {
  return (
    <Card asChild variant="launcherIcon">
      <div
        aria-hidden="true"
        className={cn(SHAPE_CLASS, "opacity-50", className)}
        data-launcher-icon=""
      />
    </Card>
  );
}
