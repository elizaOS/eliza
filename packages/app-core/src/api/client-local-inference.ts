/**
 * Client-side helpers for the local-inference endpoints. Mirrors the
 * structure used by `client-computeruse.ts`: augments `ElizaClient` via
 * declaration merging so callers get typed methods without reaching into
 * raw `fetch` from UI code.
 */

import type { DeviceBridgeStatus } from "../services/local-inference/device-bridge";
import type {
  ActiveModelState,
  AgentModelSlot,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelAssignments,
  ModelBucket,
  ModelHubSnapshot,
} from "../services/local-inference/types";
import type { VerifyResult } from "../services/local-inference/verify";
import { ElizaClient } from "./client-base";

export type {
  ActiveModelState,
  AgentModelSlot,
  CatalogModel,
  DeviceBridgeStatus,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelAssignments,
  ModelBucket,
  ModelHubSnapshot,
  VerifyResult,
};

declare module "./client-base" {
  interface ElizaClient {
    getLocalInferenceHub(): Promise<ModelHubSnapshot>;
    getLocalInferenceHardware(): Promise<HardwareProbe>;
    getLocalInferenceCatalog(): Promise<{ models: CatalogModel[] }>;
    getLocalInferenceInstalled(): Promise<{ models: InstalledModel[] }>;
    startLocalInferenceDownload(
      modelIdOrSpec: string | CatalogModel,
    ): Promise<{ job: DownloadJob }>;
    searchHuggingFaceGguf(
      query: string,
      limit?: number,
    ): Promise<{ models: CatalogModel[] }>;
    cancelLocalInferenceDownload(
      modelId: string,
    ): Promise<{ cancelled: boolean }>;
    getLocalInferenceActive(): Promise<ActiveModelState>;
    setLocalInferenceActive(modelId: string): Promise<ActiveModelState>;
    clearLocalInferenceActive(): Promise<ActiveModelState>;
    uninstallLocalInferenceModel(id: string): Promise<{ removed: boolean }>;
    getLocalInferenceDeviceStatus(): Promise<DeviceBridgeStatus>;
    getLocalInferenceAssignments(): Promise<{
      assignments: ModelAssignments;
    }>;
    setLocalInferenceAssignment(
      slot: AgentModelSlot,
      modelId: string | null,
    ): Promise<{ assignments: ModelAssignments }>;
    verifyLocalInferenceModel(id: string): Promise<VerifyResult>;
  }
}

ElizaClient.prototype.getLocalInferenceHub = async function (
  this: ElizaClient,
) {
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
  modelIdOrSpec: string | CatalogModel,
) {
  const body =
    typeof modelIdOrSpec === "string"
      ? { modelId: modelIdOrSpec }
      : { spec: modelIdOrSpec };
  return this.fetch("/api/local-inference/downloads", {
    method: "POST",
    body: JSON.stringify(body),
  });
};

ElizaClient.prototype.searchHuggingFaceGguf = async function (
  this: ElizaClient,
  query: string,
  limit?: number,
) {
  const params = new URLSearchParams({ q: query });
  if (limit != null) params.set("limit", String(limit));
  return this.fetch(`/api/local-inference/hf-search?${params.toString()}`);
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

ElizaClient.prototype.getLocalInferenceDeviceStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/device");
};

ElizaClient.prototype.getLocalInferenceAssignments = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/assignments");
};

ElizaClient.prototype.setLocalInferenceAssignment = async function (
  this: ElizaClient,
  slot: AgentModelSlot,
  modelId: string | null,
) {
  return this.fetch("/api/local-inference/assignments", {
    method: "POST",
    body: JSON.stringify({ slot, modelId }),
  });
};

ElizaClient.prototype.verifyLocalInferenceModel = async function (
  this: ElizaClient,
  id: string,
) {
  return this.fetch(
    `/api/local-inference/installed/${encodeURIComponent(id)}/verify`,
    { method: "POST" },
  );
};
