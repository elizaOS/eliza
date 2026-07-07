/**
 * The wallpaper GALLERY rendered inside the Appearance settings subview and the
 * in-chat BACKGROUND widget. Deliberately simple for MVP: the curated image
 * wallpapers we ship, the user's own uploads, and an Upload chip — no color
 * swatches, no custom color picker, no shader presets, no AI generation. The
 * active wallpaper is clearly marked and a tap applies it live.
 *
 * Every tile writes to the shared background store (`useBackgroundConfig` /
 * `ui-preferences`) that drives Home, Launcher, chat, and every view, so choices
 * apply instantly. Every control stays agent-addressable via `useAgentElement`.
 *
 * Two layouts, one gallery:
 *  - `variant="gallery"` (default): a responsive tile grid for the full
 *    BackgroundView / Settings subview.
 *  - `variant="filmstrip"`: a single horizontal scroll row of tiles for the
 *    condensed in-chat BACKGROUND widget.
 */

import { ImagePlus, RotateCcw, RotateCw } from "lucide-react";
import type { ChangeEvent, CSSProperties } from "react";
import { useCallback, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import { getShaderPreset } from "../../backgrounds/shader-presets";
import { cn } from "../../lib/utils";
import {
  BACKGROUND_CATALOG,
  type BackgroundCatalogEntry,
  type BackgroundConfig,
  catalogEntryToConfig,
  DEFAULT_BACKGROUND_COLOR,
} from "../../state/ui-preferences";
import { useBackgroundConfig } from "../../state/useBackgroundConfig";
import {
  addUserBackgroundEntry,
  loadUserBackgroundCatalog,
} from "../../state/user-background-catalog";
import { resolveApiUrl, resolveAppAssetUrl } from "../../utils/asset-url";
import {
  BackgroundImageError,
  fileToBackgroundDataUrl,
} from "../pages/background-image";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function resolvePreviewImageUrl(url: string): string {
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    /^[a-z][a-z0-9+.-]*:/i.test(url) ||
    url.startsWith("//")
  ) {
    return url;
  }
  if (url.startsWith("/api/") || url.startsWith("api/")) {
    return resolveApiUrl(url);
  }
  return resolveAppAssetUrl(url);
}

/** A live thumbnail for one catalog entry. Image entries paint the real source. */
function catalogPreviewStyle(entry: BackgroundCatalogEntry) {
  if (entry.kind === "image") {
    return {
      backgroundImage: `url("${resolvePreviewImageUrl(entry.source)}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    };
  }
  const c0 = entry.palette[0] ?? DEFAULT_BACKGROUND_COLOR;
  const c1 = entry.palette[1] ?? c0;
  const c2 = entry.palette[2] ?? entry.palette[entry.palette.length - 1] ?? c1;
  return {
    backgroundImage: `linear-gradient(165deg, ${c0}, ${c1} 55%, ${c2})`,
  };
}

/**
 * The visual chrome shared by every gallery tile: the aspect frame, the
 * selected ring, and the corner check. The tile's paint (`style`) and label
 * come from the caller so curated entries and uploads look like siblings.
 */
function TileFrame({
  label,
  meta,
  selected,
  style,
  className,
}: {
  label: string;
  meta?: string;
  selected: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "group/tile relative flex aspect-[3/4] w-full min-h-touch flex-col justify-end overflow-hidden rounded-2xl text-left transition-transform duration-200 ease-out",
        "border border-border/50 group-hover/btn:-translate-y-0.5 group-active/btn:scale-[0.98]",
        selected &&
          "border-2 border-accent shadow-[0_8px_28px_-14px_var(--color-scrim)]",
        className,
      )}
      style={style}
    >
      {/* A low legibility gradient so the label reads over any wallpaper, tinted
          toward the field rather than a flat black bar. */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-scrim/80 to-transparent" />
      {selected ? (
        <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-fg shadow-[0_2px_8px_-2px_var(--color-scrim)]">
          <span className="text-2xs font-semibold uppercase tracking-wide">
            on
          </span>
        </span>
      ) : null}
      <span className="relative flex flex-col gap-0.5 px-2.5 pb-2.5">
        <span className="truncate text-xs font-semibold text-white drop-shadow-[0_1px_2px_var(--color-scrim)]">
          {label}
        </span>
        {meta ? (
          <span className="truncate text-2xs text-white/70">{meta}</span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * A gallery tile for one curated catalog entry. Agent-addressable so "use the
 * misty-forest background" activates it.
 */
function CatalogTile({
  entry,
  selected,
  onSelect,
}: {
  entry: BackgroundCatalogEntry;
  selected: boolean;
  onSelect: (entry: BackgroundCatalogEntry) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `background-catalog-${entry.id}`,
    role: "button",
    label: `Set background to ${entry.label}`,
    group: "background-controls",
    description: `${entry.description} (${entry.mood})`,
    onActivate: () => onSelect(entry),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(entry)}
      aria-label={`Set background to ${entry.label}`}
      aria-pressed={selected}
      title={`${entry.label}. ${entry.description}`}
      className="group/btn block w-full rounded-2xl outline-none"
      {...agentProps}
    >
      <TileFrame
        label={entry.label}
        meta={entry.mood}
        selected={selected}
        style={catalogPreviewStyle(entry)}
      />
    </button>
  );
}

export interface BackgroundSettingsControlsProps {
  className?: string;
  /**
   * `gallery` (default) lays the tiles out in a responsive grid for the full
   * view. `filmstrip` lays them in a single horizontal scroll row for the
   * condensed in-chat BACKGROUND widget.
   */
  variant?: "gallery" | "filmstrip";
}

// The MVP wallpaper set: only the shipped image wallpapers. Shader-color and
// GLSL entries stay in the catalog data (old persisted configs still render)
// but are not offered as new choices here.
const CURATED_IMAGE_CATALOG = BACKGROUND_CATALOG.filter(
  (entry) => entry.kind === "image",
);

export function BackgroundSettingsControls({
  className,
  variant = "gallery",
}: BackgroundSettingsControlsProps) {
  const {
    backgroundConfig,
    setBackgroundConfig,
    undoBackgroundConfig,
    redoBackgroundConfig,
    canUndoBackground,
    canRedoBackground,
  } = useBackgroundConfig();
  const isFilmstrip = variant === "filmstrip";

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  // The user's saved catalog entries (persisted, newest first). Shown in their
  // own "yours" row so an upload is re-selectable (#13538). Loaded lazily so
  // first paint stays cheap.
  const [userCatalog, setUserCatalog] = useState<BackgroundCatalogEntry[]>(() =>
    loadUserBackgroundCatalog(),
  );

  const config: BackgroundConfig =
    backgroundConfig && typeof backgroundConfig === "object"
      ? backgroundConfig
      : { mode: "shader", color: DEFAULT_BACKGROUND_COLOR };
  const activeColor = config.color ?? DEFAULT_BACKGROUND_COLOR;

  const selectCatalog = useCallback(
    (entry: BackgroundCatalogEntry) => {
      setError(null);
      const next = catalogEntryToConfig(
        entry,
        (id) => getShaderPreset(id)?.source,
      );
      if (next) setBackgroundConfig(next);
    },
    [setBackgroundConfig],
  );

  // Which catalog entry (if any) the live config matches — for the tile
  // selected-ring. Image entries match on imageUrl.
  const activeCatalogId =
    config.mode === "image" && config.imageUrl
      ? ([...CURATED_IMAGE_CATALOG, ...userCatalog].find(
          (e) => e.kind === "image" && e.source === config.imageUrl,
        )?.id ?? null)
      : null;

  const onUploadClick = useCallback(() => {
    setError(null);
    fileInputRef.current?.click();
  }, []);

  const onFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try {
        const dataUrl = await fileToBackgroundDataUrl(file);
        // Re-host into the media store so the persisted config (and the undo
        // history) carries a tiny /api/media/<hash> URL instead of a multi-MB
        // data URL that silently blows the localStorage quota. Offline or
        // server-less, fall back to the data URL — the wallpaper still works,
        // it just persists fat.
        let imageUrl = dataUrl;
        try {
          const { url } = await client.uploadBackgroundImage(dataUrl);
          if (url) imageUrl = url;
        } catch {
          // error-policy:J4 designed degrade — offline/server-less keeps the
          // data-URL wallpaper live; only re-host persistence is skipped.
        }
        setBackgroundConfig({ mode: "image", color: activeColor, imageUrl });
        // Save the upload into the user catalog so it's re-selectable (#13538).
        // The store persists ONLY re-hosted /api/media URLs (a data-URL offline
        // fallback is applied live but not saved — quota guard), so this is a
        // no-op when the re-host failed.
        setUserCatalog(
          addUserBackgroundEntry({
            id: `user-${Date.now().toString(36)}`,
            label: file.name.replace(/\.[^.]+$/, "") || "My upload",
            description: "An image you uploaded.",
            kind: "image",
            source: imageUrl,
            mood: "custom",
            palette: [activeColor],
            tags: ["custom", "upload"],
            author: "you",
          }),
        );
        setError(null);
      } catch (err) {
        setError(
          err instanceof BackgroundImageError
            ? err.message
            : "Could not load that image.",
        );
      }
    },
    [activeColor, setBackgroundConfig],
  );

  const uploadButton = useAgentElement<HTMLButtonElement>({
    id: "background-upload",
    role: "button",
    label: "Upload a background image",
    group: "background-controls",
    description: "Open the file picker to upload a background image",
    onActivate: onUploadClick,
  });
  const undoButton = useAgentElement<HTMLButtonElement>({
    id: "background-undo",
    role: "button",
    label: "Undo background change",
    group: "background-controls",
    description: "Revert to the previous background",
    onActivate: () => undoBackgroundConfig(),
  });
  const redoButton = useAgentElement<HTMLButtonElement>({
    id: "background-redo",
    role: "button",
    label: "Redo background change",
    group: "background-controls",
    description: "Restore the background change that was undone",
    onActivate: () => redoBackgroundConfig(),
  });

  // The upload chip: the one way to bring in your own wallpaper.
  const toolChips = (
    <>
      <Button
        ref={uploadButton.ref}
        type="button"
        variant="secondary"
        onClick={onUploadClick}
        aria-label="Upload a background image"
        className="h-11 gap-2 rounded-full px-4 text-sm"
        {...uploadButton.agentProps}
      >
        <ImagePlus className="h-4 w-4" aria-hidden />
        Upload
      </Button>
      <Input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={onFileChange}
        className="sr-only border-0 bg-transparent p-0"
        aria-label="Background image file"
        tabIndex={-1}
      />
    </>
  );

  // Revert affordance: a single subtle "revert" that undoes the last change,
  // with a redo companion only when there is something to restore.
  const revertNode =
    canUndoBackground || canRedoBackground ? (
      <div className="flex items-center gap-1">
        <Button
          ref={undoButton.ref}
          type="button"
          variant="ghost"
          onClick={() => undoBackgroundConfig()}
          disabled={!canUndoBackground}
          aria-label="Undo background change"
          className="h-11 gap-1.5 rounded-full px-3 text-sm text-muted hover:text-txt disabled:opacity-40"
          {...undoButton.agentProps}
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          Revert
        </Button>
        <Button
          ref={redoButton.ref}
          type="button"
          variant="ghost"
          size="icon-lg"
          onClick={() => redoBackgroundConfig()}
          disabled={!canRedoBackground}
          aria-label="Redo background change"
          className="h-11 w-11 rounded-full text-muted hover:text-txt disabled:opacity-40"
          {...redoButton.agentProps}
        >
          <RotateCw className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    ) : null;

  // ── Filmstrip layout: the condensed in-chat BACKGROUND widget ────────────────
  if (isFilmstrip) {
    return (
      <div
        data-testid="background-settings-controls"
        data-variant="filmstrip"
        className={cn("flex w-full flex-col gap-3", className)}
      >
        <div
          data-testid="background-catalog-gallery"
          className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {CURATED_IMAGE_CATALOG.map((entry) => (
            <div key={entry.id} className="w-24 shrink-0 snap-start">
              <CatalogTile
                entry={entry}
                selected={activeCatalogId === entry.id}
                onSelect={selectCatalog}
              />
            </div>
          ))}
          {userCatalog.map((entry) => (
            <div key={entry.id} className="w-24 shrink-0 snap-start">
              <CatalogTile
                entry={entry}
                selected={activeCatalogId === entry.id}
                onSelect={selectCatalog}
              />
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">{toolChips}</div>
          {revertNode}
        </div>

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  // ── Gallery layout: the full BackgroundView / Settings subview ────────────
  return (
    <div
      data-testid="background-settings-controls"
      data-variant="gallery"
      className={cn("flex w-full max-w-2xl flex-col gap-5", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">{toolChips}</div>
        {revertNode}
      </div>

      <div
        data-testid="background-catalog-gallery"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
      >
        {CURATED_IMAGE_CATALOG.map((entry) => (
          <CatalogTile
            key={entry.id}
            entry={entry}
            selected={activeCatalogId === entry.id}
            onSelect={selectCatalog}
          />
        ))}
      </div>

      {userCatalog.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Yours
            </h3>
            <span className="h-px flex-1 bg-border/40" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {userCatalog.map((entry) => (
              <CatalogTile
                key={entry.id}
                entry={entry}
                selected={activeCatalogId === entry.id}
                onSelect={selectCatalog}
              />
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
