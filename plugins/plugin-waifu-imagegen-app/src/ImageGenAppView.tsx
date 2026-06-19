import type { OverlayAppContext } from "@elizaos/app-core";
import { Button, PagePanel, Spinner } from "@elizaos/app-core";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { ArrowLeft, ImageIcon, Sparkles } from "lucide-react";
import { useId } from "react";
import {
  IMAGE_GEN_ASPECTS,
  IMAGE_GEN_MODELS,
  IMAGE_GEN_PROMPT_MAX,
  imageGenMarkupPct,
  imageGenModelLabel,
} from "./imagegen-contracts";
import { useImageGenState } from "./useImageGenState";

function SettlementPill() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-ok/35 bg-ok/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ok"
      role="status"
      aria-label="Settled in credits"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-ok" />
      credits
    </span>
  );
}

function PriceStrip({ metadata }: { metadata: unknown }) {
  const markupPct = imageGenMarkupPct(metadata);
  const meteredModel = imageGenModelLabel(metadata);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        settlement <SettlementPill />
      </span>
      <span>
        markup{" "}
        <span className="font-medium text-txt">
          {markupPct === null ? "n/a" : `+${markupPct}%`}
        </span>
      </span>
      {meteredModel ? (
        <span>
          model <span className="font-medium text-txt">{meteredModel}</span>
        </span>
      ) : null}
      <span>
        price <span className="font-medium text-txt">billed on generate</span>
      </span>
    </div>
  );
}

function formatUsd(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

export interface ImageGenAppViewProps extends OverlayAppContext {
  /** Optional host override for which agent's image-gen app to invoke. */
  agentTokenAddress?: string;
  /** Optional host-supplied app metadata bag (markup pct, metered model). */
  metadata?: unknown;
  /** Raised when the backend reports the app is no longer available (404). */
  onUnavailable?: () => void;
}

export function ImageGenAppView({
  exitToApps,
  agentTokenAddress,
  metadata,
  onUnavailable,
}: ImageGenAppViewProps) {
  const promptId = useId();
  const {
    config,
    prompt,
    setPrompt,
    aspect,
    setAspect,
    model,
    setModel,
    busy,
    error,
    result,
    promptValid,
    canGenerate,
    generate,
  } = useImageGenState({ agentTokenAddress, metadata, onUnavailable });

  const trimmedLength = prompt.trim().length;
  const settledTotal = formatUsd(result?.charge?.totalCost);

  const backButton = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: "Back to apps",
    group: "imagegen-header",
    description:
      "Exit the image generation view and return to the apps overlay",
  });
  const generateButton = useAgentElement<HTMLButtonElement>({
    id: "action-generate",
    role: "button",
    label: "Generate image",
    group: "imagegen-form",
    description: "Generate an image from the current prompt, aspect, and model",
    status: busy ? "active" : "inactive",
  });
  const promptField = useAgentElement<HTMLTextAreaElement>({
    id: "field-prompt",
    role: "textarea",
    label: "Prompt",
    group: "imagegen-form",
    description: "Describe the image to generate",
  });

  return (
    <div
      data-testid="imagegen-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg supports-[height:100dvh]:h-[100dvh]"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <Button
          ref={backButton.ref}
          {...backButton.agentProps}
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-muted hover:text-txt"
          onClick={exitToApps}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="min-w-0">
          <h1 className="text-base font-semibold text-txt">Image Generation</h1>
        </div>
      </div>

      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {!config.agentTokenAddress && (
            <PagePanel.Notice tone="warning">
              No agent is configured for image generation.
            </PagePanel.Notice>
          )}

          <PriceStrip metadata={config.metadata} />

          <section className="rounded-lg border border-border/24 bg-card/50 p-4">
            <label
              htmlFor={promptId}
              className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-muted"
            >
              prompt
            </label>
            <textarea
              ref={promptField.ref}
              {...promptField.agentProps}
              id={promptId}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={IMAGE_GEN_PROMPT_MAX}
              rows={3}
              placeholder="describe the image you want"
              disabled={busy}
              className="w-full resize-none rounded-md border border-border bg-bg-accent px-3 py-2 text-sm text-txt outline-none transition-colors placeholder:text-muted focus:border-accent/50 disabled:opacity-60"
            />
            <div className="mt-1 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-muted">
              <span>aspect</span>
              <span>
                {trimmedLength}/{IMAGE_GEN_PROMPT_MAX}
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {IMAGE_GEN_ASPECTS.map((option) => (
                <Button
                  key={option}
                  type="button"
                  variant={option === aspect ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2 font-mono text-xs tabular-nums"
                  disabled={busy}
                  onClick={() => setAspect(option)}
                  aria-pressed={option === aspect}
                >
                  {option}
                </Button>
              ))}
            </div>

            <div className="mt-3 text-[11px] uppercase tracking-[0.12em] text-muted">
              model
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {IMAGE_GEN_MODELS.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant={option.id === model ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={busy}
                  onClick={() => setModel(option.id)}
                  aria-pressed={option.id === model}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            <Button
              ref={generateButton.ref}
              {...generateButton.agentProps}
              type="button"
              variant="default"
              className="mt-4 w-full gap-2"
              disabled={!canGenerate}
              onClick={() => void generate()}
            >
              {busy ? (
                <>
                  <Spinner className="h-4 w-4" />
                  generating
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  generate
                </>
              )}
            </Button>

            {!promptValid && trimmedLength > 0 && (
              <p className="mt-2 text-xs text-muted">
                prompt must be between 3 and {IMAGE_GEN_PROMPT_MAX} characters
              </p>
            )}
          </section>

          {error && (
            <PagePanel.Notice
              tone={error.kind === "auth" ? "accent" : "danger"}
            >
              {error.message}
            </PagePanel.Notice>
          )}

          {busy && !result && (
            <div className="flex items-center justify-center py-12 text-sm text-muted">
              <Spinner className="mr-3 h-5 w-5" />
              generating image
            </div>
          )}

          {result?.imageUrl && (
            <figure className="rounded-lg border border-border/24 bg-card/50 p-3">
              <img
                src={result.imageUrl}
                alt={result.prompt}
                className="w-full rounded-md border border-border object-contain"
              />
              <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs uppercase tracking-[0.12em] text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <ImageIcon className="h-3.5 w-3.5" />
                  {result.aspect}
                </span>
                {settledTotal ? (
                  <span>
                    charged{" "}
                    <span className="font-medium text-txt">{settledTotal}</span>
                  </span>
                ) : null}
              </figcaption>
            </figure>
          )}
        </div>
      </div>
    </div>
  );
}
