/**
 * Coordinates which model is currently loaded into the plugin-local-ai
 * runtime. Eliza runs one inference model at a time; switching models
 * unloads the previous one first so we don't double-allocate VRAM.
 *
 * This module *does not* talk to `node-llama-cpp` directly. The plugin
 * owns the native binding; we ask it to swap via a small runtime service
 * registered under the name "localInferenceLoader". When the plugin is not
 * enabled, we still track the user's preferred active model so the
 * preference survives enabling the plugin later.
 */

import type { AgentRuntime } from "@elizaos/core";
import { localInferenceEngine } from "./engine";
import { touchElizaModel } from "./registry";
import type { ActiveModelState, InstalledModel } from "./types";

export interface LocalInferenceLoader {
  loadModel(args: { modelPath: string }): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  /**
   * Optional generation surface. When a loader implements this, the runtime
   * handler (`ensure-local-inference-handler.ts`) routes TEXT_SMALL /
   * TEXT_LARGE requests through it instead of the standalone engine. Mobile
   * builds populate this via the Capacitor adapter; desktop leaves it
   * unimplemented and falls back to the `LocalInferenceEngine`.
   */
  generate?(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
  /**
   * Optional embedding surface. When a loader implements this, the runtime
   * handler routes `TEXT_EMBEDDING` requests through it. The AOSP bun:ffi
   * loader populates this directly via `llama_get_embeddings_seq`; the
   * device-bridge loader populates it by dispatching an `embed` frame to
   * the connected device. Loaders that cannot embed leave this undefined,
   * and the runtime falls back to its non-local embedding provider chain.
   */
  embed?(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }>;
}

function isLoader(value: unknown): value is LocalInferenceLoader {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalInferenceLoader>;
  return (
    typeof candidate.loadModel === "function" &&
    typeof candidate.unloadModel === "function" &&
    typeof candidate.currentModelPath === "function"
  );
}

export class ActiveModelCoordinator {
  private state: ActiveModelState = {
    modelId: null,
    loadedAt: null,
    status: "idle",
  };

  private readonly listeners = new Set<(state: ActiveModelState) => void>();

  snapshot(): ActiveModelState {
    return { ...this.state };
  }

  subscribe(listener: (state: ActiveModelState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const current = { ...this.state };
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  /** Return the loader service from the current runtime, if registered. */
  private getLoader(runtime: AgentRuntime | null): LocalInferenceLoader | null {
    if (!runtime) return null;
    const candidate = (
      runtime as {
        getService?: (name: string) => unknown;
      }
    ).getService?.("localInferenceLoader");
    return isLoader(candidate) ? candidate : null;
  }

  async switchTo(
    runtime: AgentRuntime | null,
    installed: InstalledModel,
  ): Promise<ActiveModelState> {
    this.state = {
      modelId: installed.id,
      loadedAt: null,
      status: "loading",
    };
    this.emit();

    // Prefer a runtime-registered loader (plugin-local-ai or equivalent)
    // when present — it will already have warmed up the right configuration.
    // Otherwise, fall back to the standalone engine, which is the default
    // path for users who haven't separately enabled plugin-local-ai.
    const loader = this.getLoader(runtime);

    try {
      if (loader) {
        await loader.unloadModel();
        await loader.loadModel({ modelPath: installed.path });
      } else {
        await localInferenceEngine.load(installed.path);
      }
      this.state = {
        modelId: installed.id,
        loadedAt: new Date().toISOString(),
        status: "ready",
      };
      if (installed.source === "eliza-download") {
        await touchElizaModel(installed.id);
      }
    } catch (err) {
      this.state = {
        modelId: installed.id,
        loadedAt: null,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this.emit();
    return this.snapshot();
  }

  async unload(runtime: AgentRuntime | null): Promise<ActiveModelState> {
    const loader = this.getLoader(runtime);
    try {
      if (loader) {
        await loader.unloadModel();
      } else {
        await localInferenceEngine.unload();
      }
    } catch (err) {
      this.state = {
        modelId: null,
        loadedAt: null,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      this.emit();
      return this.snapshot();
    }
    this.state = { modelId: null, loadedAt: null, status: "idle" };
    this.emit();
    return this.snapshot();
  }
}
