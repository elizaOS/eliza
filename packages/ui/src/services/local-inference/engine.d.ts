/**
 * Standalone llama.cpp engine.
 *
 * Owns one `Llama` binding instance, at most one loaded `LlamaModel`, and
 * a cached `LlamaChatSession` that wraps it. Model swap is unload-then-load
 * so we never double-allocate VRAM.
 *
 * Two consumption paths:
 *   1. The Model Hub UI calls `load()` / `unload()` to make "Activate" work.
 *   2. The agent runtime calls `generate()` via the registered
 *      `ModelType.TEXT_SMALL` / `TEXT_LARGE` handlers (see
 *      `ensure-local-inference-handler.ts`).
 *
 * Dynamic import keeps the binding optional: if `node-llama-cpp` is not
 * installed, `available()` returns false and callers surface a clear error
 * instead of crashing the process.
 */
import type { LocalInferenceLoadArgs } from "./active-model";

type ResolvedGpuLayers = number | "max" | "auto";
export declare function gpuLayersForKvOffload(
  mode: NonNullable<LocalInferenceLoadArgs["kvOffload"]>,
): ResolvedGpuLayers;
export declare function resolveGpuLayersForLoad(
  resolved?: LocalInferenceLoadArgs,
): ResolvedGpuLayers;
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
export declare class LocalInferenceEngine {
  private llama;
  private loadedModel;
  private loadedContext;
  private loadedSession;
  private loadedPath;
  private bindingChecked;
  private bindingModule;
  /** Serialises generate calls so concurrent requests don't corrupt session state. */
  private generationQueue;
  available(): Promise<boolean>;
  currentModelPath(): string | null;
  hasLoadedModel(): boolean;
  unload(): Promise<void>;
  load(modelPath: string, resolved?: LocalInferenceLoadArgs): Promise<void>;
  /**
   * Generate text from the loaded model. Serialised — a new call waits for
   * any in-flight generation to finish so the chat session's internal state
   * stays consistent.
   */
  generate(args: GenerateArgs): Promise<string>;
  private loadBinding;
  private resolveDflashPlan;
}
export declare const localInferenceEngine: LocalInferenceEngine;
//# sourceMappingURL=engine.d.ts.map
