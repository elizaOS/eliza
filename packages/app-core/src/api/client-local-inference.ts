/**
 * Client-side helpers for the local-inference endpoints. Mirrors the
 * structure used by `client-computeruse.ts`: augments `ElizaClient` via
 * declaration merging so callers get typed methods without reaching into
 * raw `fetch` from UI code.
 */

import { ElizaClient } from "./client-base";
import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelBucket,
  ModelHubSnapshot,
} from "../services/local-inference/types";

export type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelBucket,
  ModelHubSnapshot,
};

declare module "./client-base" {
  interface ElizaClient {
    getLocalInferenceHub(): Promise<ModelHubSnapshot>;
    getLocalInferenceHardware(): Promise<HardwareProbe>;
    getLocalInferenceCatalog(): Promise<{ models: CatalogModel[] }>;
    getLocalInferenceInstalled(): Promise<{ models: InstalledModel[] }>;
    startLocalInferenceDownload(modelId: string): Promise<{ job: DownloadJob }>;
    cancelLocalInferenceDownload(
      modelId: string,
    ): Promise<{ cancelled: boolean }>;
    getLocalInferenceActive(): Promise<ActiveModelState>;
    setLocalInferenceActive(modelId: string): Promise<ActiveModelState>;
    clearLocalInferenceActive(): Promise<ActiveModelState>;
    uninstallLocalInferenceModel(id: string): Promise<{ removed: boolean }>;
  }
}

ElizaClient.prototype.getLocalInferenceHub = async function (this: ElizaClient) {
  return this.fetch("/api/local-inference/hub");
};

ElizaClient.prototype.getLocalInferenceHardware = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/hardware");
};

ElizaClient.prototype.getLocalInferenceCatalog = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/catalog");
};

ElizaClient.prototype.getLocalInferenceInstalled = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/installed");
};

ElizaClient.prototype.startLocalInferenceDownload = async function (
  this: ElizaClient,
  modelId: string,
) {
  return this.fetch("/api/local-inference/downloads", {
    method: "POST",
    body: JSON.stringify({ modelId }),
  });
};

ElizaClient.prototype.cancelLocalInferenceDownload = async function (
  this: ElizaClient,
  modelId: string,
) {
  return this.fetch(
    `/api/local-inference/downloads/${encodeURIComponent(modelId)}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.getLocalInferenceActive = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/active");
};

ElizaClient.prototype.setLocalInferenceActive = async function (
  this: ElizaClient,
  modelId: string,
) {
  return this.fetch("/api/local-inference/active", {
    method: "POST",
    body: JSON.stringify({ modelId }),
  });
};

ElizaClient.prototype.clearLocalInferenceActive = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/active", {
    method: "DELETE",
  });
};

ElizaClient.prototype.uninstallLocalInferenceModel = async function (
  this: ElizaClient,
  id: string,
) {
  return this.fetch(
    `/api/local-inference/installed/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
};
