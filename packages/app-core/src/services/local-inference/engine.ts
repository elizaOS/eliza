/**
 * Minimal standalone llama.cpp engine.
 *
 * Owns one `Llama` binding instance and at most one loaded `LlamaModel`.
 * Model swap is unload-then-load so we never double-allocate VRAM. This
 * engine does not (yet) expose generation — that wiring depends on how
 * plugin-local-ai integrates with the agent runtime. The value it provides
 * now is:
 *   - making "Activate model" actually load the GGUF into memory
 *   - giving the coordinator a real `currentModelPath()` signal
 *   - proving the full pipe from Model Hub → service → binding works
 *
 * Dynamic import keeps the binding optional: if `node-llama-cpp` is not
 * installed, `available()` returns false and the coordinator surfaces a
 * clear error instead of crashing the process.
 */

interface LlamaModel {
  dispose(): Promise<void>;
}

interface Llama {
  loadModel(args: { modelPath: string }): Promise<LlamaModel>;
}

interface LlamaBindingModule {
  getLlama(): Promise<Llama>;
}

export class LocalInferenceEngine {
  private llama: Llama | null = null;
  private loadedModel: LlamaModel | null = null;
  private loadedPath: string | null = null;
  private bindingChecked = false;
  private bindingModule: LlamaBindingModule | null = null;

  async available(): Promise<boolean> {
    if (!this.bindingChecked) {
      this.bindingModule = await this.loadBinding();
      this.bindingChecked = true;
    }
    return this.bindingModule !== null;
  }

  currentModelPath(): string | null {
    return this.loadedPath;
  }

  async unload(): Promise<void> {
    if (!this.loadedModel) return;
    const model = this.loadedModel;
    this.loadedModel = null;
    this.loadedPath = null;
    await model.dispose();
  }

  async load(modelPath: string): Promise<void> {
    if (this.loadedPath === modelPath && this.loadedModel) return;

    if (!(await this.available()) || !this.bindingModule) {
      throw new Error(
        "node-llama-cpp is not installed in this build; add it as a dependency to enable local inference",
      );
    }

    if (this.loadedModel) {
      await this.unload();
    }

    if (!this.llama) {
      this.llama = await this.bindingModule.getLlama();
    }

    this.loadedModel = await this.llama.loadModel({ modelPath });
    this.loadedPath = modelPath;
  }

  private async loadBinding(): Promise<LlamaBindingModule | null> {
    try {
      const mod = (await import("node-llama-cpp")) as unknown;
      if (
        mod &&
        typeof mod === "object" &&
        "getLlama" in mod &&
        typeof (mod as { getLlama: unknown }).getLlama === "function"
      ) {
        return mod as LlamaBindingModule;
      }
      return null;
    } catch {
      return null;
    }
  }
}

export const localInferenceEngine = new LocalInferenceEngine();
