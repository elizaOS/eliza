/**
 * State hook for the image-gen AppView. Owns the prompt/aspect/model form
 * state, the invoke lifecycle (busy / error / result), and resolves the waifu
 * runtime config once on mount. Kept separate from the view so the .tsx file
 * exports only React components (Fast-Refresh friendly).
 */

import { useCallback, useMemo, useState } from "react";
import { invokeImageGen } from "./imagegen-client";
import {
  resolveWaifuImageGenConfig,
  type WaifuImageGenRuntimeConfig,
} from "./imagegen-config";
import {
  DEFAULT_IMAGE_GEN_ASPECT,
  DEFAULT_IMAGE_GEN_MODEL_ID,
  IMAGE_GEN_PROMPT_MAX,
  IMAGE_GEN_PROMPT_MIN,
  type ImageGenAspect,
  type ImageGenError,
  type ImageGenModelId,
  type ImageGenResult,
  isImageGenError,
} from "./imagegen-contracts";

export interface ImageGenStateOptions {
  /** Host-supplied agent token address (wins over ambient config). */
  agentTokenAddress?: string;
  /** Host-supplied app metadata bag (markup pct, metered model). */
  metadata?: unknown;
  /** Called when the backend reports the app is no longer available (404). */
  onUnavailable?: () => void;
}

export interface ImageGenState {
  config: WaifuImageGenRuntimeConfig;
  prompt: string;
  setPrompt: (next: string) => void;
  aspect: ImageGenAspect;
  setAspect: (next: ImageGenAspect) => void;
  model: ImageGenModelId;
  setModel: (next: ImageGenModelId) => void;
  busy: boolean;
  error: ImageGenError | null;
  result: ImageGenResult | null;
  promptValid: boolean;
  canGenerate: boolean;
  generate: () => Promise<void>;
}

function freshIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useImageGenState(
  options: ImageGenStateOptions = {},
): ImageGenState {
  const config = useMemo(
    () =>
      resolveWaifuImageGenConfig({
        agentTokenAddress: options.agentTokenAddress,
        metadata: options.metadata,
      }),
    [options.agentTokenAddress, options.metadata],
  );

  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<ImageGenAspect>(
    DEFAULT_IMAGE_GEN_ASPECT,
  );
  const [model, setModel] = useState<ImageGenModelId>(
    DEFAULT_IMAGE_GEN_MODEL_ID,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ImageGenError | null>(null);
  const [result, setResult] = useState<ImageGenResult | null>(null);

  const trimmed = prompt.trim();
  const promptValid =
    trimmed.length >= IMAGE_GEN_PROMPT_MIN &&
    trimmed.length <= IMAGE_GEN_PROMPT_MAX;
  const canGenerate = promptValid && !busy;

  const onUnavailable = options.onUnavailable;

  const generate = useCallback(async () => {
    if (busy || !promptValid) return;
    setBusy(true);
    setError(null);
    // Drop any prior image so a failed retry never leaves stale output (and a
    // stale settled charge) rendered under a fresh error.
    setResult(null);
    try {
      const next = await invokeImageGen(config, {
        prompt: trimmed,
        aspect,
        model,
        idempotencyKey: freshIdempotencyKey(),
      });
      setResult(next);
    } catch (caught) {
      if (isImageGenError(caught)) {
        // A 404 means the registry row went stale (paused/unpublished). Tell the
        // host so it can flip the surface to an unavailable state.
        if (caught.kind === "not-available") onUnavailable?.();
        setError(caught);
      } else {
        setError({
          kind: "unknown",
          status: 500,
          message:
            caught instanceof Error
              ? caught.message
              : "image generation failed",
        });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, promptValid, config, trimmed, aspect, model, onUnavailable]);

  return {
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
  };
}
