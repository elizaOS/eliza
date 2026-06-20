/**
 * Local-inference engine surface for the shared UI library.
 *
 * Text inference runs in the bun AGENT — reached from the renderer through
 * the device-bridge / API client, or in-process through a runtime-registered
 * `localInferenceLoader` service (the AOSP bun:ffi loader or the device-bridge
 * loader). The shared `@elizaos/ui` library ships in the WebView/browser where
 * no Node-native llama binding can load, so this module owns NO inference
 * binding. It is a typed no-op surface kept so `active-model.ts` and its
 * consumers (the Settings UI, the active-model SSE) keep a stable fallback to
 * resolve against when no runtime loader is registered.
 *
 * The fallback always reports unavailable; `load()` / `generate()` fail with a
 * clear message instead of pretending to run a model in the renderer.
 */

import type { LocalInferenceLoadArgs } from "./load-args";

const UNAVAILABLE_MESSAGE =
  "Local inference runs in the Eliza agent, not the UI renderer. " +
  "Register a `localInferenceLoader` service (AOSP bun:ffi or device-bridge) " +
  "to drive local models.";

type ResolvedGpuLayers = number | "max" | "auto";

export function gpuLayersForKvOffload(
  mode: NonNullable<LocalInferenceLoadArgs["kvOffload"]>,
): ResolvedGpuLayers {
  if (mode === "cpu") return 0;
  if (mode === "gpu") return "max";
  if (mode === "split") return "auto";
  return mode.gpuLayers;
}

export function resolveGpuLayersForLoad(
  resolved?: LocalInferenceLoadArgs,
): ResolvedGpuLayers {
  if (resolved?.gpuLayers !== undefined) return resolved.gpuLayers;
  if (resolved?.kvOffload !== undefined) {
    return gpuLayersForKvOffload(resolved.kvOffload);
  }
  if (resolved?.useGpu === false) return 0;
  return "auto";
}

export interface GenerateArgs {
  prompt: string;
  stopSequences?: string[];
  /** Upper bound on output tokens; defaults to 2048. */
  maxTokens?: number;
  /** 0..1; 0.7 default. */
  temperature?: number;
  /** nucleus sampling; defaults to 0.9. */
  topP?: number;
}

export class LocalInferenceEngine {
  available(): Promise<boolean> {
    return Promise.resolve(false);
  }

  currentModelPath(): string | null {
    return null;
  }

  hasLoadedModel(): boolean {
    return false;
  }

  unload(): Promise<void> {
    return Promise.resolve();
  }

  load(_modelPath: string, _resolved?: LocalInferenceLoadArgs): Promise<void> {
    return Promise.reject(new Error(UNAVAILABLE_MESSAGE));
  }

  generate(_args: GenerateArgs): Promise<string> {
    return Promise.reject(new Error(UNAVAILABLE_MESSAGE));
  }
}

export const localInferenceEngine = new LocalInferenceEngine();
