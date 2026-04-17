/**
 * Public facade for the local-inference service.
 *
 * Single entry point used by the API routes, the settings UI, and any
 * future orchestration code. Holds singleton instances of the downloader
 * and active-model coordinator so subscribers receive the same event
 * stream across the process.
 */

import type { AgentRuntime } from "@elizaos/core";
import { MODEL_CATALOG } from "./catalog";
import { Downloader } from "./downloader";
import { probeHardware } from "./hardware";
import { listInstalledModels, removeMiladyModel } from "./registry";
import { ActiveModelCoordinator } from "./active-model";
import type {
  ActiveModelState,
  DownloadEvent,
  DownloadJob,
  HardwareProbe,
  ModelHubSnapshot,
} from "./types";

export class LocalInferenceService {
  private readonly downloader = new Downloader();
  private readonly activeModel = new ActiveModelCoordinator();

  getCatalog() {
    return MODEL_CATALOG;
  }

  async getInstalled() {
    return listInstalledModels();
  }

  async getHardware(): Promise<HardwareProbe> {
    return probeHardware();
  }

  getDownloads(): DownloadJob[] {
    return this.downloader.snapshot();
  }

  getActive(): ActiveModelState {
    return this.activeModel.snapshot();
  }

  async snapshot(): Promise<ModelHubSnapshot> {
    const [installed, hardware] = await Promise.all([
      this.getInstalled(),
      this.getHardware(),
    ]);
    return {
      catalog: this.getCatalog(),
      installed,
      active: this.getActive(),
      downloads: this.getDownloads(),
      hardware,
    };
  }

  async startDownload(modelId: string): Promise<DownloadJob> {
    return this.downloader.start(modelId);
  }

  cancelDownload(modelId: string): boolean {
    return this.downloader.cancel(modelId);
  }

  subscribeDownloads(listener: (event: DownloadEvent) => void): () => void {
    return this.downloader.subscribe(listener);
  }

  subscribeActive(
    listener: (state: ActiveModelState) => void,
  ): () => void {
    return this.activeModel.subscribe(listener);
  }

  async setActive(
    runtime: AgentRuntime | null,
    modelId: string,
  ): Promise<ActiveModelState> {
    const installed = (await this.getInstalled()).find((m) => m.id === modelId);
    if (!installed) {
      throw new Error(`Model not installed: ${modelId}`);
    }
    return this.activeModel.switchTo(runtime, installed);
  }

  async clearActive(runtime: AgentRuntime | null): Promise<ActiveModelState> {
    return this.activeModel.unload(runtime);
  }

  async uninstall(
    modelId: string,
  ): Promise<{ removed: boolean; reason?: "external" | "not-found" }> {
    // If the user is uninstalling the active model, unload it first so we
    // don't leave the plugin holding a handle to a deleted file.
    if (this.activeModel.snapshot().modelId === modelId) {
      await this.activeModel.unload(null);
    }
    return removeMiladyModel(modelId);
  }
}

export const localInferenceService = new LocalInferenceService();
