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
import { cn } from "../../lib/utils";
import { useAppSelectorShallow } from "../../state/app-store";
import {
  BACKGROUND_PRESETS,
  type BackgroundConfig,
  type BackgroundPreset,
  DEFAULT_BACKGROUND_COLOR,
} from "../../state/ui-preferences";
import { useBackgroundConfig } from "../../state/useBackgroundConfig";
import {
  BackgroundImageError,
  fileToBackgroundDataUrl,
} from "../pages/background-image";

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
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(preset.color)}
      title={preset.label}
      aria-label={`Set background to ${preset.label}`}
      aria-pressed={selected}
      className="relative h-12 w-12 shrink-0 rounded-full transition-transform hover:scale-105"
      style={{ backgroundColor: preset.color }}
      {...agentProps}
    >
      {selected ? (
        <Check
          className="absolute inset-0 m-auto h-4 w-4 text-white mix-blend-difference"
          aria-hidden
        />
      ) : null}
    </button>
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
        <button
          type="button"
          onClick={() => colorInputRef.current?.click()}
          title="Custom color"
          aria-label="Pick a custom background color"
          className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105"
          style={{
            background:
              "conic-gradient(from 0deg, #ef5a1f, #f59e0b, #65a30d, #059669, #57534e, #e11d48, #dc2626, #ef5a1f)",
          }}
        >
          <Pipette className="h-4 w-4 text-white" aria-hidden />
        </button>
        <input
          ref={colorInputRef}
          type="color"
          value={activeColor}
          onChange={(e) => selectColor(e.target.value)}
          className="sr-only"
          aria-label="Custom background color value"
          tabIndex={-1}
        />
      </div>

      <div className="flex items-center justify-center gap-3">
        <button
          ref={uploadButton.ref}
          type="button"
          onClick={onUploadClick}
          title="Upload image"
          aria-label="Upload a background image"
          className="flex h-12 w-12 items-center justify-center rounded-lg bg-bg-accent/70 text-txt transition-colors hover:bg-bg-accent"
          {...uploadButton.agentProps}
        >
          <ImagePlus className="h-5 w-5" aria-hidden />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onFileChange}
          className="sr-only"
          aria-label="Background image file"
          tabIndex={-1}
        />
        {cloudAvailable ? (
          <button
            ref={generateButton.ref}
            type="button"
            onClick={() => setPromptOpen((open) => !open)}
            title="Generate image"
            aria-label="Generate a background image"
            aria-pressed={promptOpen}
            className={cn(
              "flex h-12 w-12 items-center justify-center rounded-lg transition-colors",
              promptOpen
                ? "bg-accent text-accent-foreground"
                : "bg-bg-accent/70 text-txt hover:bg-bg-accent",
            )}
            {...generateButton.agentProps}
          >
            <Sparkles className="h-5 w-5" aria-hidden />
          </button>
        ) : null}
        {canUndoBackground || canRedoBackground ? (
          <>
            <button
              ref={undoButton.ref}
              type="button"
              onClick={() => undoBackgroundConfig()}
              disabled={!canUndoBackground}
              title="Undo"
              aria-label="Undo background change"
              className="flex h-12 w-12 items-center justify-center rounded-lg bg-bg-accent/70 text-txt transition-colors hover:bg-bg-accent disabled:opacity-50"
              {...undoButton.agentProps}
            >
              <Undo2 className="h-5 w-5" aria-hidden />
            </button>
            <button
              ref={redoButton.ref}
              type="button"
              onClick={() => redoBackgroundConfig()}
              disabled={!canRedoBackground}
              title="Redo"
              aria-label="Redo background change"
              className="flex h-12 w-12 items-center justify-center rounded-lg bg-bg-accent/70 text-txt transition-colors hover:bg-bg-accent disabled:opacity-50"
              {...redoButton.agentProps}
            >
              <Redo2 className="h-5 w-5" aria-hidden />
            </button>
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
          <input
            id={promptInputId}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe a background..."
            disabled={generating}
            // biome-ignore lint/a11y/noAutofocus: focus the field the user just opened
            autoFocus
            className="min-w-0 flex-1 rounded-lg border border-border/50 bg-bg/60 px-3 py-2 text-sm text-txt placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={generating || prompt.trim().length === 0}
            title="Generate"
            aria-label="Generate background from prompt"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <ArrowUp className="h-4 w-4" aria-hidden />
            )}
          </button>
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
