/**
 * Public facade for the local-inference service.
 *
 * Single entry point used by the API routes, the settings UI, and any
 * future orchestration code. Holds singleton instances of the downloader
 * and active-model coordinator so subscribers receive the same event
 * stream across the process.
 */

import type { AgentRuntime } from "@elizaos/core";
import { ActiveModelCoordinator } from "./active-model";
import { readEffectiveAssignments, setAssignment } from "./assignments";
import { registerBundledModels } from "./bundled-models";
import { MODEL_CATALOG } from "./catalog";
import { Downloader } from "./downloader";
import { probeHardware } from "./hardware";
import { searchHuggingFaceGguf } from "./hf-search";
import {
  listInstalledModels,
  removeElizaModel,
  upsertElizaModel,
} from "./registry";
import type {
  ActiveModelState,
  AgentModelSlot,
  CatalogModel,
  DownloadEvent,
  DownloadJob,
  HardwareProbe,
  ModelAssignments,
  ModelHubSnapshot,
} from "./types";
import { type VerifyResult, verifyInstalledModel } from "./verify";

export class LocalInferenceService {
  private readonly downloader = new Downloader();
  private readonly activeModel = new ActiveModelCoordinator();
  private bundledBootstrap: Promise<void> | null = null;

  getCatalog() {
    return MODEL_CATALOG.filter((model) => !model.hiddenFromCatalog);
  }

  /**
   * Register any bundled GGUF files staged by the AOSP build (or any
   * other install path that drops a `manifest.json` next to the model
   * files) into the registry. Runs at most once per process; the
   * promise is cached so concurrent first callers wait on the same
   * work.
   */
  private bootstrapBundled(): Promise<void> {
    if (!this.bundledBootstrap) {
      this.bundledBootstrap = registerBundledModels()
        .then(() => undefined)
        .catch(() => undefined);
    }
    return this.bundledBootstrap;
  }

  async getInstalled() {
    await this.bootstrapBundled();
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

  async getAssignments(): Promise<ModelAssignments> {
    return readEffectiveAssignments();
  }

  async setSlotAssignment(
    slot: AgentModelSlot,
    modelId: string | null,
  ): Promise<ModelAssignments> {
    await setAssignment(slot, modelId);
    return readEffectiveAssignments();
  }

  async snapshot(): Promise<ModelHubSnapshot> {
    const [installed, hardware, assignments] = await Promise.all([
      this.getInstalled(),
      this.getHardware(),
      this.getAssignments(),
    ]);
    return {
      catalog: this.getCatalog(),
      installed,
      active: this.getActive(),
      downloads: this.getDownloads(),
      hardware,
      assignments,
    };
  }

  async startDownload(
    modelIdOrSpec: string | CatalogModel,
  ): Promise<DownloadJob> {
    return this.downloader.start(modelIdOrSpec);
  }

  async searchHuggingFace(
    query: string,
    limit?: number,
  ): Promise<CatalogModel[]> {
    return searchHuggingFaceGguf(query, limit);
  }

  /**
   * Verify an installed model's file integrity. When the model was a
   * Eliza-download and there was no stored sha256 yet (legacy entry), the
   * computed hash is persisted so subsequent verifies have a baseline.
   */
  async verifyModel(id: string): Promise<VerifyResult> {
    const installed = await listInstalledModels();
    const model = installed.find((m) => m.id === id);
    if (!model) {
      throw new Error(`Model not installed: ${id}`);
    }
    const result = await verifyInstalledModel(model);

    // Self-heal: when a Eliza-owned legacy entry has no sha256 yet and
    // the file passes the structural GGUF check, pin the computed hash as
    // the baseline. External models are never mutated.
    if (
      result.state === "unknown" &&
      result.currentSha256 &&
      model.source === "eliza-download"
    ) {
      await upsertElizaModel({
        ...model,
        sha256: result.currentSha256,
        lastVerifiedAt: new Date().toISOString(),
      });
      return {
        ...result,
        state: "ok",
        expectedSha256: result.currentSha256,
      };
    }
    if (result.state === "ok" && model.source === "eliza-download") {
      await upsertElizaModel({
        ...model,
        lastVerifiedAt: new Date().toISOString(),
      });
    }
    return result;
  }

  cancelDownload(modelId: string): boolean {
    return this.downloader.cancel(modelId);
  }

  subscribeDownloads(listener: (event: DownloadEvent) => void): () => void {
    return this.downloader.subscribe(listener);
  }

  subscribeActive(listener: (state: ActiveModelState) => void): () => void {
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
    return removeElizaModel(modelId);
  }
}

export const localInferenceService = new LocalInferenceService();
