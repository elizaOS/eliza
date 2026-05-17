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
//# sourceMappingURL=client-voice-models.d.ts.map
