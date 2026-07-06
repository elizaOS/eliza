/**
 * The wallpaper GALLERY rendered inside the Background settings subview and the
 * home long-press quick sheet. It is a creative surface, not a settings form:
 * large live-preview tiles in a responsive grid (curated presets, animated
 * shaders, uploads, and generated images all as visual tiles), a first-class
 * "generate with AI" tile, and tool chips for uploading / picking a custom
 * color. The active wallpaper is clearly marked and a tap applies it live.
 *
 * Every tile writes to the shared background store (`useBackgroundConfig` /
 * `ui-preferences`) that drives Home, Launcher, chat, and every view, so choices
 * apply instantly. Every control stays agent-addressable via `useAgentElement`.
 *
 * Two layouts, one gallery:
 *  - `variant="gallery"` (default): a responsive tile grid for the full
 *    BackgroundView / Settings subview.
 *  - `variant="filmstrip"`: a single horizontal scroll row of tiles for the
 *    condensed home long-press sheet.
 */

import {
  ImagePlus,
  Loader2,
  Palette,
  RotateCcw,
  RotateCw,
  Sparkles,
} from "lucide-react";
import type { ChangeEvent, CSSProperties } from "react";
import { useCallback, useId, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import { getShaderPreset } from "../../backgrounds/shader-presets";
import { cn } from "../../lib/utils";
import { useAppSelectorShallow } from "../../state/app-store";
import {
  BACKGROUND_CATALOG,
  BACKGROUND_PRESETS,
  type BackgroundCatalogEntry,
  type BackgroundConfig,
  type BackgroundPreset,
  catalogEntryToConfig,
  DEFAULT_BACKGROUND_COLOR,
} from "../../state/ui-preferences";
import { useBackgroundConfig } from "../../state/useBackgroundConfig";
import {
  addUserBackgroundEntry,
  loadUserBackgroundCatalog,
} from "../../state/user-background-catalog";
import {
  BackgroundImageError,
  fileToBackgroundDataUrl,
} from "../pages/background-image";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** A live thumbnail for one shader-color preset (a full-bleed color field). */
function presetPreviewStyle(color: string) {
  return {
    // A soft top-to-bottom deepening so a flat color still reads as a lit field,
    // not a paint chip. Same-hue shading, tinted toward the field itself.
    backgroundImage: `linear-gradient(160deg, color-mix(in oklab, ${color} 88%, white 12%), ${color} 60%, color-mix(in oklab, ${color} 82%, black 18%))`,
  };
}

/** A live thumbnail for one catalog entry, drawn from its palette (no image load). */
function catalogPreviewStyle(entry: BackgroundCatalogEntry) {
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
 * come from the caller so presets, catalog entries, and generated images all
 * look like siblings.
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
        "ring-1 ring-inset ring-border/50 group-hover/btn:-translate-y-0.5 group-active/btn:scale-[0.98]",
        selected &&
          "ring-2 ring-inset ring-accent shadow-[0_8px_28px_-14px_var(--color-scrim)]",
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

/** A gallery tile for one shader-color preset. */
function PresetTile({
  preset,
  selected,
  onSelect,
}: {
  preset: BackgroundPreset;
  selected: boolean;
  onSelect: (color: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `background-preset-${preset.id}`,
    role: "button",
    label: `Set background to ${preset.label}`,
    group: "background-controls",
    description: `Use the ${preset.label.toLowerCase()} shader background`,
    onActivate: () => onSelect(preset.color),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(preset.color)}
      aria-label={`Set background to ${preset.label}`}
      aria-pressed={selected}
      className="group/btn block w-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      {...agentProps}
    >
      <TileFrame
        label={preset.label}
        selected={selected}
        style={presetPreviewStyle(preset.color)}
      />
    </button>
  );
}

/**
 * A gallery tile for one curated catalog entry (natural gradient or animated
 * GLSL preset). Agent-addressable so "use the misty-forest background" activates
 * it.
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
  const meta = entry.kind === "glsl" ? "animated" : entry.mood;
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(entry)}
      aria-label={`Set background to ${entry.label}`}
      aria-pressed={selected}
      title={`${entry.label}. ${entry.description}`}
      className="group/btn block w-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      {...agentProps}
    >
      <TileFrame
        label={entry.label}
        meta={meta}
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
   * condensed home long-press sheet.
   */
  variant?: "gallery" | "filmstrip";
}

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
  const { cloudConnected, cloudAuthRejected } = useAppSelectorShallow((s) => ({
    cloudConnected: s.elizaCloudConnected,
    cloudAuthRejected: s.elizaCloudAuthRejected,
  }));
  const cloudAvailable = Boolean(cloudConnected) && !cloudAuthRejected;
  const isFilmstrip = variant === "filmstrip";

  const fileInputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const promptInputId = useId();

  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  // The user's saved/generated catalog entries (persisted, newest first). Shown
  // in their own "yours" row so a generated background is re-selectable
  // (#13538). Loaded lazily so first paint stays cheap.
  const [userCatalog, setUserCatalog] = useState<BackgroundCatalogEntry[]>(() =>
    loadUserBackgroundCatalog(),
  );

  const config: BackgroundConfig =
    backgroundConfig && typeof backgroundConfig === "object"
      ? backgroundConfig
      : { mode: "shader", color: DEFAULT_BACKGROUND_COLOR };
  const activeColor = config.color ?? DEFAULT_BACKGROUND_COLOR;
  const isShader = config.mode === "shader";

  const selectColor = useCallback(
    (color: string) => {
      setError(null);
      setBackgroundConfig({ mode: "shader", color });
    },
    [setBackgroundConfig],
  );

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
  // selected-ring. Image entries match on imageUrl; glsl entries on presetId.
  const activeCatalogId = ((): string | null => {
    if (config.mode === "image" && config.imageUrl) {
      return (
        [...BACKGROUND_CATALOG, ...userCatalog].find(
          (e) => e.kind === "image" && e.source === config.imageUrl,
        )?.id ?? null
      );
    }
    if (config.mode === "glsl" && config.shader?.presetId) {
      return (
        BACKGROUND_CATALOG.find(
          (e) => e.kind === "glsl" && e.source === config.shader?.presetId,
        )?.id ?? null
      );
    }
    return null;
  })();

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
          // Keep the data-URL fallback.
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

  const runGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const { url } = await client.generateBackgroundImage(trimmed);
      setBackgroundConfig({ mode: "image", color: activeColor, imageUrl: url });
      // Save the generated background into the user catalog with its prompt as
      // metadata so it's re-selectable and describable later (#13538).
      setUserCatalog(
        addUserBackgroundEntry({
          id: `user-${Date.now().toString(36)}`,
          label: trimmed.slice(0, 40),
          description: `Generated from “${trimmed}”.`,
          kind: "image",
          source: url,
          mood: "custom",
          palette: [activeColor],
          tags: ["custom", "generated"],
          prompt: trimmed,
          author: "you",
        }),
      );
      setPromptOpen(false);
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Image generation failed.");
    } finally {
      setGenerating(false);
    }
  }, [activeColor, generating, prompt, setBackgroundConfig]);

  const generateTile = useAgentElement<HTMLButtonElement>({
    id: "background-generate",
    role: "button",
    label: "Generate a background image",
    group: "background-controls",
    description: "Generate a background image from a text prompt (cloud)",
    onActivate: () => setPromptOpen((open) => !open),
  });
  const uploadButton = useAgentElement<HTMLButtonElement>({
    id: "background-upload",
    role: "button",
    label: "Upload a background image",
    group: "background-controls",
    description: "Open the file picker to upload a background image",
    onActivate: onUploadClick,
  });
  const colorButton = useAgentElement<HTMLButtonElement>({
    id: "background-custom-color",
    role: "button",
    label: "Pick a custom background color",
    group: "background-controls",
    description: "Open the color picker to set a custom shader color",
    onActivate: () => colorInputRef.current?.click(),
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

  // The generate tile: a first-class, inviting entry to the AI path (the
  // Sparkles affordance). It sits at the head of the gallery, sized like a
  // wallpaper tile so "make one" reads as an equal choice, not a bolted-on field.
  const generateTileNode = cloudAvailable ? (
    <button
      ref={generateTile.ref}
      type="button"
      onClick={() => setPromptOpen((open) => !open)}
      aria-label="Generate a background image"
      aria-pressed={promptOpen}
      className="group/btn block w-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      {...generateTile.agentProps}
    >
      <span
        className={cn(
          "relative flex aspect-[3/4] w-full min-h-touch flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl px-2 text-center transition-transform duration-200 ease-out",
          "bg-accent-subtle ring-1 ring-inset ring-accent/40 group-hover/btn:-translate-y-0.5 group-active/btn:scale-[0.98]",
          promptOpen && "ring-2 ring-accent",
        )}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-accent-fg">
          <Sparkles className="h-5 w-5" aria-hidden />
        </span>
        <span className="text-xs font-semibold text-txt-strong">
          Make one with AI
        </span>
      </span>
    </button>
  ) : null;

  // Tool chips: upload + custom color. Rendered as pill tools, not settings
  // rows, so they read as ways to bring in your own wallpaper.
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
      <Button
        ref={colorButton.ref}
        type="button"
        variant="secondary"
        onClick={() => colorInputRef.current?.click()}
        aria-label="Pick a custom background color"
        className="h-11 gap-2 rounded-full px-4 text-sm"
        {...colorButton.agentProps}
      >
        <span
          className="h-4 w-4 shrink-0 rounded-full ring-1 ring-inset ring-border/60"
          style={{ backgroundColor: activeColor }}
          aria-hidden
        />
        <Palette className="h-4 w-4" aria-hidden />
        Color
      </Button>
      <Input
        ref={colorInputRef}
        type="color"
        value={activeColor}
        onChange={(e) => selectColor(e.target.value)}
        className="sr-only border-0 bg-transparent p-0"
        aria-label="Custom background color value"
        tabIndex={-1}
      />
    </>
  );

  // Revert affordance: a single subtle "revert" that undoes the last change,
  // with a redo companion only when there is something to restore. Native, not
  // a pair of utilitarian settings buttons.
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
        {canRedoBackground ? (
          <Button
            ref={redoButton.ref}
            type="button"
            variant="ghost"
            size="icon-lg"
            onClick={() => redoBackgroundConfig()}
            aria-label="Redo background change"
            className="h-11 w-11 rounded-full text-muted hover:text-txt"
            {...redoButton.agentProps}
          >
            <RotateCw className="h-4 w-4" aria-hidden />
          </Button>
        ) : (
          // Keep the redo control in the tree (disabled) so its agent hook and
          // the existing test contract hold even before anything is undone.
          <Button
            ref={redoButton.ref}
            type="button"
            variant="ghost"
            size="icon-lg"
            onClick={() => redoBackgroundConfig()}
            disabled
            aria-label="Redo background change"
            className="h-11 w-11 rounded-full text-muted disabled:opacity-40"
            {...redoButton.agentProps}
          >
            <RotateCw className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
    ) : null;

  // The prompt composer: revealed by the generate tile. A generous field, not a
  // cramped settings input.
  const promptComposer =
    cloudAvailable && promptOpen ? (
      <form
        className="flex w-full items-center gap-2 rounded-2xl bg-bg-accent/50 p-2 ring-1 ring-inset ring-border/40"
        onSubmit={(e) => {
          e.preventDefault();
          void runGenerate();
        }}
      >
        <label htmlFor={promptInputId} className="sr-only">
          Describe a background
        </label>
        <Sparkles className="ml-1.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <Input
          id={promptInputId}
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A misty pine forest at dawn"
          disabled={generating}
          autoFocus
          className="h-11 min-w-0 flex-1 border-0 bg-transparent px-1 text-sm text-txt placeholder:text-muted focus-visible:ring-0"
        />
        <Button
          type="submit"
          variant="default"
          disabled={generating || prompt.trim().length === 0}
          aria-label="Generate background from prompt"
          className="h-11 gap-2 rounded-xl px-4 text-sm"
        >
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden />
          )}
          {generating ? "Making" : "Make"}
        </Button>
      </form>
    ) : null;

  const curated = [...BACKGROUND_CATALOG];

  // ── Filmstrip layout: the condensed home long-press sheet ────────────────
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
          {generateTileNode ? (
            <div className="w-24 shrink-0 snap-start">{generateTileNode}</div>
          ) : null}
          {curated.map((entry) => (
            <div key={entry.id} className="w-24 shrink-0 snap-start">
              <CatalogTile
                entry={entry}
                selected={activeCatalogId === entry.id}
                onSelect={selectCatalog}
              />
            </div>
          ))}
          {BACKGROUND_PRESETS.map((preset) => (
            <div key={preset.id} className="w-24 shrink-0 snap-start">
              <PresetTile
                preset={preset}
                selected={isShader && activeColor === preset.color}
                onSelect={selectColor}
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

        {promptComposer}

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

      {promptComposer}

      <div
        data-testid="background-catalog-gallery"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
      >
        {generateTileNode}
        {curated.map((entry) => (
          <CatalogTile
            key={entry.id}
            entry={entry}
            selected={activeCatalogId === entry.id}
            onSelect={selectCatalog}
          />
        ))}
        {BACKGROUND_PRESETS.map((preset) => (
          <PresetTile
            key={preset.id}
            preset={preset}
            selected={isShader && activeColor === preset.color}
            onSelect={selectColor}
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
