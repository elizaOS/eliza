/**
 * BackgroundView — the "Background" view.
 *
 * A minimal, wordless surface for setting the unified app background: pick a
 * shader color, upload an image, or (when cloud is connected) generate one. The
 * view itself is transparent, so the live wallpaper shows behind the controls
 * and updates the instant a choice is made — the same background the home and
 * Views catalog share. Almost all controls are icons.
 */

import {
  ArrowUp,
  Check,
  ImagePlus,
  Loader2,
  Pipette,
  Sparkles,
} from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import { useAppSelectorShallow } from "../../state/app-store";
import {
  type BackgroundConfig,
  DEFAULT_BACKGROUND_COLOR,
} from "../../state/ui-preferences";
import { useBackgroundConfig } from "../../state/useBackgroundConfig";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import {
  BackgroundImageError,
  fileToBackgroundDataUrl,
} from "./background-image";

/** Curated shader colors. The user can pick any color via the custom picker. */
const PRESET_COLORS = [
  DEFAULT_BACKGROUND_COLOR, // warm orange (default)
  "#f59e0b", // amber
  "#e11d48", // rose
  "#7c3aed", // violet
  "#2563eb", // blue
  "#0891b2", // teal
  "#059669", // green
  "#334155", // slate
  "#0a0a0a", // near-black
  "#f4f4f5", // light
];

function ColorSwatch({
  color,
  selected,
  onSelect,
}: {
  color: string;
  selected: boolean;
  onSelect: (color: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `background-color-${color.replace("#", "")}`,
    role: "button",
    label: `Set background color ${color}`,
    group: "background-controls",
    description: `Use ${color} as the shader background color`,
    onActivate: () => onSelect(color),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(color)}
      title={color}
      aria-label={`Set background color ${color}`}
      aria-pressed={selected}
      className={`relative h-9 w-9 shrink-0 rounded-full ring-offset-2 ring-offset-bg/0 transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        selected ? "ring-2 ring-txt" : "ring-1 ring-border/60"
      }`}
      style={{ backgroundColor: color }}
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

export function BackgroundView() {
  const { backgroundConfig, setBackgroundConfig } = useBackgroundConfig();
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
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = ""; // allow re-picking the same file
      if (!file) return;
      try {
        const imageUrl = await fileToBackgroundDataUrl(file);
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

  return (
    <ShellViewAgentSurface viewId="background">
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-28 pt-6">
        <h1 className="sr-only">Background</h1>
        <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-3xl border border-border/40 bg-bg/55 p-6 shadow-xl backdrop-blur-2xl">
          {/* Shader colors */}
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            {PRESET_COLORS.map((color) => (
              <ColorSwatch
                key={color}
                color={color}
                selected={isShader && activeColor === color}
                onSelect={selectColor}
              />
            ))}
            {/* Custom color */}
            <button
              type="button"
              onClick={() => colorInputRef.current?.click()}
              title="Custom color"
              aria-label="Pick a custom background color"
              className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1 ring-border/60 transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                background:
                  "conic-gradient(from 0deg, #ef5a1f, #f59e0b, #059669, #2563eb, #7c3aed, #e11d48, #ef5a1f)",
              }}
            >
              <Pipette className="h-4 w-4 text-white drop-shadow" aria-hidden />
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

          <div className="h-px w-full bg-border/40" />

          {/* Image actions */}
          <div className="flex items-center justify-center gap-3">
            <button
              ref={uploadButton.ref}
              type="button"
              onClick={onUploadClick}
              title="Upload image"
              aria-label="Upload a background image"
              className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-accent/70 text-txt transition-colors hover:bg-bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                className={`flex h-12 w-12 items-center justify-center rounded-2xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  promptOpen
                    ? "bg-accent text-accent-foreground"
                    : "bg-bg-accent/70 text-txt hover:bg-bg-accent"
                }`}
                {...generateButton.agentProps}
              >
                <Sparkles className="h-5 w-5" aria-hidden />
              </button>
            ) : null}
          </div>

          {/* Generate prompt */}
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
                placeholder="Describe a background…"
                disabled={generating}
                // biome-ignore lint/a11y/noAutofocus: focus the field the user just opened
                autoFocus
                className="min-w-0 flex-1 rounded-xl border border-border/50 bg-bg/60 px-3 py-2 text-sm text-txt placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="submit"
                disabled={generating || prompt.trim().length === 0}
                title="Generate"
                aria-label="Generate background from prompt"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground transition-colors hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
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
      </div>
    </ShellViewAgentSurface>
  );
}
