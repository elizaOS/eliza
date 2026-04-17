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
import { readAssignments, setAssignment } from "./assignments";
import { MODEL_CATALOG } from "./catalog";
import { Downloader } from "./downloader";
import { probeHardware } from "./hardware";
import { searchHuggingFaceGguf } from "./hf-search";
import {
  listInstalledModels,
  removeMiladyModel,
  upsertMiladyModel,
} from "./registry";
import { type VerifyResult, verifyInstalledModel } from "./verify";
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

  async getAssignments(): Promise<ModelAssignments> {
    return readAssignments();
  }

  async setSlotAssignment(
    slot: AgentModelSlot,
    modelId: string | null,
  ): Promise<ModelAssignments> {
    return setAssignment(slot, modelId);
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
   * Milady-download and there was no stored sha256 yet (legacy entry), the
   * computed hash is persisted so subsequent verifies have a baseline.
   */
  async verifyModel(id: string): Promise<VerifyResult> {
    const installed = await listInstalledModels();
    const model = installed.find((m) => m.id === id);
    if (!model) {
      throw new Error(`Model not installed: ${id}`);
    }
    const result = await verifyInstalledModel(model);

    // Self-heal: when a Milady-owned legacy entry has no sha256 yet and
    // the file passes the structural GGUF check, pin the computed hash as
    // the baseline. External models are never mutated.
    if (
      result.state === "unknown" &&
      result.currentSha256 &&
      model.source === "milady-download"
    ) {
      await upsertMiladyModel({
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
    if (result.state === "ok" && model.source === "milady-download") {
      await upsertMiladyModel({
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
    return removeMiladyModel(modelId);
  }
}

export const localInferenceService = new LocalInferenceService();
