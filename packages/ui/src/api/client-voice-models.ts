/**
 * Client-side helpers for `/api/local-inference/voice-models/*`.
 *
 * Backs the `ModelUpdatesPanel` UI (R5-versioning §5) — the panel lives in
 * `packages/ui/src/components/local-inference/ModelUpdatesPanel.tsx` and
 * was originally wired with inert handlers until the local-runtime compat
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
  // #12087 Item 25: the per-endpoint `isOwner` flag was dropped from the UI
  // contract — owner-tier gating now flows through the canonical `useRole()`
  // context, not a flag threaded from this endpoint. The server may still send
  // it for older clients; the UI no longer reads it.
}

export interface VoiceModelsSetPreferencesResponse {
  readonly ok: true;
  readonly preferences: NetworkPolicyPreferences;
}

/** List GET — existing 10s REST budget, independent hop. */
export const VOICE_MODELS_LIST_FETCH_TIMEOUT_MS = 10_000;
/** Check GET — existing 10s REST budget, independent hop. */
export const VOICE_MODELS_CHECK_FETCH_TIMEOUT_MS = 10_000;
/** Pin POST — existing 10s REST budget, independent hop. */
export const VOICE_MODELS_PIN_FETCH_TIMEOUT_MS = 10_000;
/** Preferences GET — existing 10s REST budget, independent hop. */
export const VOICE_MODELS_GET_PREFERENCES_FETCH_TIMEOUT_MS = 10_000;
/** Preferences POST — existing 10s REST budget, independent hop. */
export const VOICE_MODELS_SET_PREFERENCES_FETCH_TIMEOUT_MS = 10_000;

declare module "./client-base" {
  interface ElizaClient {
    listVoiceModels(
      timeoutMs?: number,
    ): Promise<VoiceModelsListResponse>;
    checkVoiceModelUpdates(
      options?: {
        force?: boolean;
      },
      timeoutMs?: number,
    ): Promise<VoiceModelsCheckResponse>;
    triggerVoiceModelUpdate(
      id: VoiceModelId,
    ): Promise<VoiceModelsUpdateResponse>;
    pinVoiceModel(
      id: VoiceModelId,
      pinned: boolean,
      timeoutMs?: number,
    ): Promise<VoiceModelsPinResponse>;
    getVoiceModelPreferences(
      timeoutMs?: number,
    ): Promise<VoiceModelsPreferencesResponse>;
    setVoiceModelPreferences(
      patch: Partial<NetworkPolicyPreferences>,
      timeoutMs?: number,
    ): Promise<VoiceModelsSetPreferencesResponse>;
  }
}

ElizaClient.prototype.listVoiceModels = async function (
  this: ElizaClient,
  timeoutMs: number = VOICE_MODELS_LIST_FETCH_TIMEOUT_MS,
) {
  return this.fetch("/api/local-inference/voice-models", undefined, {
    timeoutMs,
  });
};

ElizaClient.prototype.checkVoiceModelUpdates = async function (
  this: ElizaClient,
  options,
  timeoutMs: number = VOICE_MODELS_CHECK_FETCH_TIMEOUT_MS,
) {
  const query = options?.force ? "?force=1" : "";
  return this.fetch(`/api/local-inference/voice-models/check${query}`, undefined, {
    timeoutMs,
  });
};

ElizaClient.prototype.triggerVoiceModelUpdate = async function (
  this: ElizaClient,
  id: VoiceModelId,
) {
  // Model-download stay-off: this hop writes a GGUF/ONNX payload (version,
  // finalPath, sha256, sizeBytes). Do not attach a 10s REST timeout here.
  return this.fetch(
    `/api/local-inference/voice-models/${encodeURIComponent(id)}/update`,
    { method: "POST", body: JSON.stringify({}) },
  );
};

ElizaClient.prototype.pinVoiceModel = async function (
  this: ElizaClient,
  id: VoiceModelId,
  pinned: boolean,
  timeoutMs: number = VOICE_MODELS_PIN_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    `/api/local-inference/voice-models/${encodeURIComponent(id)}/pin`,
    { method: "POST", body: JSON.stringify({ pinned }) },
    { timeoutMs },
  );
};

ElizaClient.prototype.getVoiceModelPreferences = async function (
  this: ElizaClient,
  timeoutMs: number = VOICE_MODELS_GET_PREFERENCES_FETCH_TIMEOUT_MS,
) {
  return this.fetch("/api/local-inference/voice-models/preferences", undefined, {
    timeoutMs,
  });
};

ElizaClient.prototype.setVoiceModelPreferences = async function (
  this: ElizaClient,
  patch: Partial<NetworkPolicyPreferences>,
  timeoutMs: number = VOICE_MODELS_SET_PREFERENCES_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    "/api/local-inference/voice-models/preferences",
    {
      method: "POST",
      body: JSON.stringify(patch),
    },
    { timeoutMs },
  );
};
