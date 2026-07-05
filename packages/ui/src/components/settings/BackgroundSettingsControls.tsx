/**
 * The wallpaper picker rendered inside the Background settings subview: shader
 * color presets + custom picker, image upload, and cloud image generation, with
 * undo/redo. Writes to the shared background store (`useBackgroundConfig` /
 * `ui-preferences`) that drives Home, Launcher, chat, and every view, so choices
 * apply live. Every control is agent-addressable via `useAgentElement`.
 */

import {
  ArrowUp,
  Check,
  ImagePlus,
  Loader2,
  Pipette,
  Redo2,
  Sparkles,
  Undo2,
} from "lucide-react";
import type { ChangeEvent } from "react";
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

function ColorSwatch({
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
    <Button
      ref={ref}
      variant="ghost"
      size="icon-sm"
      onClick={() => onSelect(preset.color)}
      title={preset.label}
      aria-label={`Set background to ${preset.label}`}
      aria-pressed={selected}
      className="relative h-11 w-11 shrink-0 rounded-full p-0 transition-transform hover:scale-110"
      style={{ backgroundColor: preset.color }}
      {...agentProps}
    >
      {selected ? (
        <Check
          className="absolute inset-0 m-auto h-4 w-4 text-white mix-blend-difference"
          aria-hidden
        />
      ) : null}
    </Button>
  );
}

/**
 * A gallery tile for one curated catalog entry (natural gradient or animated
 * GLSL preset). The thumbnail is drawn from the entry's palette (a code-free CSS
 * gradient), so no image loads to render the picker. Agent-addressable via
 * `useAgentElement` so "use the misty-forest background" can activate it.
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
  const [c0, c1, c2] = [
    entry.palette[0] ?? DEFAULT_BACKGROUND_COLOR,
    entry.palette[1] ?? entry.palette[0] ?? DEFAULT_BACKGROUND_COLOR,
    entry.palette[2] ??
      entry.palette[entry.palette.length - 1] ??
      DEFAULT_BACKGROUND_COLOR,
  ];
  return (
    <Button
      ref={ref}
      variant="ghost"
      onClick={() => onSelect(entry)}
      title={`${entry.label} — ${entry.description}`}
      aria-label={`Set background to ${entry.label}`}
      aria-pressed={selected}
      className={cn(
        "relative h-16 w-24 shrink-0 overflow-hidden rounded-lg p-0 transition-transform hover:scale-105",
        selected ? "ring-2 ring-accent" : "ring-1 ring-border/40",
      )}
      style={{
        backgroundImage: `linear-gradient(to bottom, ${c0}, ${c1} 55%, ${c2})`,
      }}
      {...agentProps}
    >
      <span className="absolute inset-x-0 bottom-0 truncate bg-bg/55 px-1.5 py-0.5 text-left text-[10px] font-medium text-txt">
        {entry.label}
      </span>
      {selected ? (
        <Check
          className="absolute right-1 top-1 h-3.5 w-3.5 text-white mix-blend-difference"
          aria-hidden
        />
      ) : null}
    </Button>
  );
}

export interface BackgroundSettingsControlsProps {
  className?: string;
}

export function BackgroundSettingsControls({
  className,
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const promptInputId = useId();

  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  // The user's saved/generated catalog entries (persisted, newest first). The
  // gallery shows them after the curated set so a generated background is
  // re-selectable (#13538). Loaded lazily so SSR/first paint stays cheap.
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

  const uploadButton = useAgentElement<HTMLButtonElement>({
    id: "background-upload",
    role: "button",
    label: "Upload a background image",
    group: "background-controls",
    description: "Open the file picker to upload a background image",
    onActivate: onUploadClick,
  });
  const generateButton = useAgentElement<HTMLButtonElement>({
    id: "background-generate",
    role: "button",
    label: "Generate a background image",
    group: "background-controls",
    description: "Generate a background image from a text prompt (cloud)",
    onActivate: () => setPromptOpen((open) => !open),
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

  return (
    <div
      data-testid="background-settings-controls"
      className={cn(
        "flex w-full max-w-sm flex-col items-center gap-5 p-2",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        {BACKGROUND_PRESETS.map((preset) => (
          <ColorSwatch
            key={preset.id}
            preset={preset}
            selected={isShader && activeColor === preset.color}
            onSelect={selectColor}
          />
        ))}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => colorInputRef.current?.click()}
          title="Custom color"
          aria-label="Pick a custom background color"
          className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full p-0 transition-transform hover:scale-110"
          style={{
            background:
              "conic-gradient(from 0deg, #ef5a1f, #f59e0b, #65a30d, #059669, #57534e, #e11d48, #dc2626, #ef5a1f)",
          }}
        >
          <Pipette className="h-4 w-4 text-white" aria-hidden />
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
      </div>

      <fieldset
        data-testid="background-catalog-gallery"
        className="flex max-h-52 w-full flex-wrap items-center justify-center gap-2.5 overflow-y-auto border-0 p-0"
      >
        <legend className="sr-only">Curated backgrounds</legend>
        {[...BACKGROUND_CATALOG, ...userCatalog].map((entry) => (
          <CatalogTile
            key={entry.id}
            entry={entry}
            selected={activeCatalogId === entry.id}
            onSelect={selectCatalog}
          />
        ))}
      </fieldset>

      <div className="flex items-center justify-center gap-3">
        <Button
          ref={uploadButton.ref}
          variant="ghost"
          size="icon-lg"
          onClick={onUploadClick}
          title="Upload image"
          aria-label="Upload a background image"
          className="h-12 w-12 rounded-lg bg-transparent text-txt transition-colors hover:bg-bg-accent/45"
          {...uploadButton.agentProps}
        >
          <ImagePlus className="h-5 w-5" aria-hidden />
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
        {cloudAvailable ? (
          <Button
            ref={generateButton.ref}
            variant={promptOpen ? "default" : "secondary"}
            size="icon-lg"
            onClick={() => setPromptOpen((open) => !open)}
            title="Generate image"
            aria-label="Generate a background image"
            aria-pressed={promptOpen}
            className={cn(
              "h-12 w-12 rounded-lg transition-colors",
              promptOpen
                ? "bg-accent text-accent-foreground"
                : "bg-bg-accent/70 text-txt hover:bg-bg-accent",
            )}
            {...generateButton.agentProps}
          >
            <Sparkles className="h-5 w-5" aria-hidden />
          </Button>
        ) : null}
        {canUndoBackground || canRedoBackground ? (
          <>
            <Button
              ref={undoButton.ref}
              variant="secondary"
              size="icon-lg"
              onClick={() => undoBackgroundConfig()}
              disabled={!canUndoBackground}
              title="Undo"
              aria-label="Undo background change"
              className="h-12 w-12 rounded-lg bg-bg-accent/70 text-txt transition-colors hover:bg-bg-accent disabled:opacity-50"
              {...undoButton.agentProps}
            >
              <Undo2 className="h-5 w-5" aria-hidden />
            </Button>
            <Button
              ref={redoButton.ref}
              variant="secondary"
              size="icon-lg"
              onClick={() => redoBackgroundConfig()}
              disabled={!canRedoBackground}
              title="Redo"
              aria-label="Redo background change"
              className="h-12 w-12 rounded-lg bg-bg-accent/70 text-txt transition-colors hover:bg-bg-accent disabled:opacity-50"
              {...redoButton.agentProps}
            >
              <Redo2 className="h-5 w-5" aria-hidden />
            </Button>
          </>
        ) : null}
      </div>

      {cloudAvailable && promptOpen ? (
        <form
          className="flex w-full items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runGenerate();
          }}
        >
          <label htmlFor={promptInputId} className="sr-only">
            Describe a background
          </label>
          <Input
            id={promptInputId}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe a background..."
            disabled={generating}
            autoFocus
            className="h-11 min-w-0 flex-1 rounded-lg border border-border/50 bg-bg/60 px-3 text-sm text-txt placeholder:text-muted"
          />
          <Button
            type="submit"
            variant="default"
            size="icon-sm"
            disabled={generating || prompt.trim().length === 0}
            title="Generate"
            aria-label="Generate background from prompt"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <ArrowUp className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </form>
      ) : null}

      {error ? (
        <p className="text-center text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
