/**
 * Client-side helpers for `/api/local-inference/voice-models/*`.
 *
 * Backs the `ModelUpdatesPanel` UI (R5-versioning §5) — the panel lives in
 * `packages/ui/src/components/local-inference/ModelUpdatesPanel.tsx` and
 * was originally wired with no-op handlers until the local-runtime compat
 * routes landed.
 *
 * Augments `ElizaClient` via declaration merging, same pattern as
 * `client-local-inference.ts`.
 */

import type {
  NetworkPolicyPreferences,
  VoiceModelId,
  VoiceModelVersion,
} from "@elizaos/shared";
import { ElizaClient } from "./client-base";

export interface VoiceModelInstallationView {
  readonly id: VoiceModelId;
  readonly installedVersion: string | null;
  readonly pinned: boolean;
  readonly lastError: string | null;
}

export interface VoiceModelCheckStatus {
  readonly id: VoiceModelId;
  readonly installedVersion: string | null;
  readonly pinned: boolean;
  readonly latestKnown: VoiceModelVersion | null;
  readonly allow: boolean;
  readonly reason:
    | "up-to-date"
    | "pinned"
    | "not-installed"
    | "net-regression"
    | "bundle-incompatible"
    | "update-available";
}

export interface VoiceModelsListResponse {
  readonly installations: ReadonlyArray<VoiceModelInstallationView>;
}

export interface VoiceModelsCheckResponse {
  readonly lastCheckedAt: string;
  readonly statuses: ReadonlyArray<VoiceModelCheckStatus>;
}

export interface VoiceModelsUpdateResponse {
  readonly ok: true;
  readonly id: VoiceModelId;
  readonly version: string;
  readonly finalPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface VoiceModelsPinResponse {
  readonly ok: true;
  readonly id: VoiceModelId;
  readonly pinned: boolean;
}

export interface VoiceModelsPreferencesResponse {
  readonly preferences: NetworkPolicyPreferences;
  readonly isOwner: boolean;
}

export interface VoiceModelsSetPreferencesResponse {
  readonly ok: true;
  readonly preferences: NetworkPolicyPreferences;
}

declare module "./client-base" {
  interface ElizaClient {
    listVoiceModels(): Promise<VoiceModelsListResponse>;
    checkVoiceModelUpdates(options?: {
      force?: boolean;
    }): Promise<VoiceModelsCheckResponse>;
    triggerVoiceModelUpdate(
      id: VoiceModelId,
    ): Promise<VoiceModelsUpdateResponse>;
    pinVoiceModel(
      id: VoiceModelId,
      pinned: boolean,
    ): Promise<VoiceModelsPinResponse>;
    getVoiceModelPreferences(): Promise<VoiceModelsPreferencesResponse>;
    setVoiceModelPreferences(
      patch: Partial<NetworkPolicyPreferences>,
    ): Promise<VoiceModelsSetPreferencesResponse>;
  }
}

ElizaClient.prototype.listVoiceModels = async function (this: ElizaClient) {
  return this.fetch("/api/local-inference/voice-models");
};

ElizaClient.prototype.checkVoiceModelUpdates = async function (
  this: ElizaClient,
  options,
) {
  const query = options?.force ? "?force=1" : "";
  return this.fetch(`/api/local-inference/voice-models/check${query}`);
};

ElizaClient.prototype.triggerVoiceModelUpdate = async function (
  this: ElizaClient,
  id: VoiceModelId,
) {
  return this.fetch(
    `/api/local-inference/voice-models/${encodeURIComponent(id)}/update`,
    { method: "POST", body: JSON.stringify({}) },
  );
};

ElizaClient.prototype.pinVoiceModel = async function (
  this: ElizaClient,
  id: VoiceModelId,
  pinned: boolean,
) {
  return this.fetch(
    `/api/local-inference/voice-models/${encodeURIComponent(id)}/pin`,
    { method: "POST", body: JSON.stringify({ pinned }) },
  );
};

ElizaClient.prototype.getVoiceModelPreferences = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/voice-models/preferences");
};

ElizaClient.prototype.setVoiceModelPreferences = async function (
  this: ElizaClient,
  patch: Partial<NetworkPolicyPreferences>,
) {
  return this.fetch("/api/local-inference/voice-models/preferences", {
    method: "POST",
    body: JSON.stringify(patch),
  });
};
