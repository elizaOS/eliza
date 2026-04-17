import { WebPlugin } from "@capacitor/core";
import type {
  LlamaCapacitorPlugin,
  LlamaGenerateOptions,
  LlamaGenerateResult,
  LlamaHardwareInfo,
  LlamaLoadOptions,
} from "./definitions";

/**
 * Web / browser fallback. On-device inference is not available in the
 * browser context — all methods throw a consistent "unsupported" error so
 * callers can detect the case and fall back to the server-side engine.
 *
 * A future iteration could wire wllama (WebAssembly llama.cpp) here for
 * true browser inference; for now the desktop Bun runtime is the canonical
 * browser-backed path.
 */
export class LlamaCapacitorWeb
  extends WebPlugin
  implements LlamaCapacitorPlugin
{
  private unsupported(method: string): never {
    throw new Error(
      `[capacitor-llama] ${method} is not available on web; use the Milady server-side engine`,
    );
  }

  async getHardwareInfo(): Promise<LlamaHardwareInfo> {
    return {
      platform: "android",
      deviceModel: "web",
      totalRamGb: 0,
      availableRamGb: null,
      gpu: null,
      cpuCores: navigator.hardwareConcurrency ?? 0,
      gpuSupported: false,
    };
  }

  async isLoaded(): Promise<{ loaded: boolean; modelPath: string | null }> {
    return { loaded: false, modelPath: null };
  }

  async loadModel(_options: LlamaLoadOptions): Promise<void> {
    this.unsupported("loadModel");
  }

  async unloadModel(): Promise<void> {
    this.unsupported("unloadModel");
  }

  async generate(_options: LlamaGenerateOptions): Promise<LlamaGenerateResult> {
    this.unsupported("generate");
  }

  async cancelGenerate(): Promise<void> {
    this.unsupported("cancelGenerate");
  }
}
