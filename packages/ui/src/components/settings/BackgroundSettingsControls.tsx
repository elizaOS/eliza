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
