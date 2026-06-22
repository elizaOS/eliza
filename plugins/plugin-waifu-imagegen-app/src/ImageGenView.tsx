/**
 * ImageGenView — the single GUI/XR data wrapper for the image-gen surface.
 *
 * It owns the live invoke state (prompt/aspect/model form, the busy/error/result
 * lifecycle via {@link useImageGenState}) and renders the one presentational
 * {@link ImageGenSpatialView} inside a {@link SpatialSurface}. Omitting the
 * `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The TUI
 * surface renders the same `ImageGenSpatialView` through the terminal registry
 * (see `register-terminal-view.tsx`).
 */

import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback } from "react";
import {
  type ImageGenSnapshot,
  ImageGenSpatialView,
} from "./ImageGenSpatialView.tsx";
import {
  type ImageGenAspect,
  imageGenMarkupPct,
  imageGenModelLabel,
  IMAGE_GEN_MODELS,
} from "./imagegen-contracts";
import { useImageGenState } from "./useImageGenState";

/**
 * Host props for the unified image-gen surface. All optional: the spatial
 * wrapper is mounted as an in-process app-shell page / bundled view, not the
 * full-screen overlay, so it needs none of the `OverlayAppContext` callbacks the
 * legacy {@link import("./ImageGenAppView").ImageGenAppView} consumed. It only
 * forwards the optional host overrides into the invoke state.
 */
export interface ImageGenViewProps {
  /** Optional host override for which agent's image-gen app to invoke. */
  agentTokenAddress?: string;
  /** Optional host-supplied app metadata bag (markup pct, metered model). */
  metadata?: unknown;
  /** Raised when the backend reports the app is no longer available (404). */
  onUnavailable?: () => void;
}

/** Resolve the human label for a model id, falling back to the configured one. */
function resolveModelLabel(modelId: string, metadata: unknown): string {
  const known = IMAGE_GEN_MODELS.find((m) => m.id === modelId);
  if (known) return known.label;
  return imageGenModelLabel(metadata) ?? modelId;
}

export function ImageGenView({
  agentTokenAddress,
  metadata,
  onUnavailable,
}: ImageGenViewProps = {}) {
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

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("prompt:")) {
        setPrompt(action.slice("prompt:".length));
        return;
      }
      if (action.startsWith("model:")) {
        setModel(action.slice("model:".length));
        return;
      }
      if (action.startsWith("aspect:")) {
        setAspect(action.slice("aspect:".length) as ImageGenAspect);
        return;
      }
      if (action === "generate") {
        void generate();
      }
    },
    [setPrompt, setModel, setAspect, generate],
  );

  const snapshot: ImageGenSnapshot = {
    prompt,
    aspect,
    model,
    modelLabel: resolveModelLabel(model, config.metadata),
    busy,
    error: error ? { message: error.message } : null,
    result: result?.imageUrl
      ? {
          imageUrl: result.imageUrl,
          prompt: result.prompt,
          aspect: result.aspect,
          charge: {
            totalCost: result.charge?.totalCost,
            currency: result.charge?.currency,
            balance: result.charge?.balance,
          },
        }
      : null,
    promptValid,
    canGenerate,
    markupPct: imageGenMarkupPct(config.metadata),
  };

  return (
    <SpatialSurface>
      <ImageGenSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
