/**
 * Client-side helpers for the local-inference endpoints. Mirrors the
 * structure used by `client-computeruse.ts`: augments `ElizaClient` via
 * declaration merging so callers get typed methods without reaching into
 * raw `fetch` from UI code.
 */
import type { ProviderStatus } from "@elizaos/shared";
import type { DeviceBridgeStatus } from "../services/local-inference/device-bridge";
import type { PublicRegistration } from "../services/local-inference/handler-registry";
import type {
  RoutingPolicy,
  RoutingPreferences,
} from "../services/local-inference/routing-preferences";
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
  ProviderStatus,
  PublicRegistration,
  RoutingPolicy,
  RoutingPreferences,
  VerifyResult,
};

declare module "./client-base" {
  interface ElizaClient {
    getLocalInferenceHub(): Promise<ModelHubSnapshot>;
    getLocalInferenceHardware(): Promise<HardwareProbe>;
    getLocalInferenceCatalog(): Promise<{
      models: CatalogModel[];
    }>;
    getLocalInferenceInstalled(): Promise<{
      models: InstalledModel[];
    }>;
    startLocalInferenceDownload(modelIdOrSpec: string | CatalogModel): Promise<{
      job: DownloadJob;
    }>;
    searchHuggingFaceGguf(
      query: string,
      limit?: number,
      hub?: "huggingface" | "modelscope",
    ): Promise<{
      models: CatalogModel[];
    }>;
    cancelLocalInferenceDownload(modelId: string): Promise<{
      cancelled: boolean;
    }>;
    getLocalInferenceActive(): Promise<ActiveModelState>;
    setLocalInferenceActive(modelId: string): Promise<ActiveModelState>;
    clearLocalInferenceActive(): Promise<ActiveModelState>;
    uninstallLocalInferenceModel(id: string): Promise<{
      removed: boolean;
    }>;
    getLocalInferenceDeviceStatus(): Promise<DeviceBridgeStatus>;
    getLocalInferenceProviders(): Promise<{
      providers: ProviderStatus[];
    }>;
    getLocalInferenceAssignments(): Promise<{
      assignments: ModelAssignments;
    }>;
    setLocalInferenceAssignment(
      slot: AgentModelSlot,
      modelId: string | null,
    ): Promise<{
      assignments: ModelAssignments;
    }>;
    verifyLocalInferenceModel(id: string): Promise<VerifyResult>;
    getLocalInferenceRouting(): Promise<{
      registrations: PublicRegistration[];
      preferences: RoutingPreferences;
    }>;
    setLocalInferencePreferredProvider(
      slot: AgentModelSlot,
      provider: string | null,
    ): Promise<{
      preferences: RoutingPreferences;
    }>;
    setLocalInferencePolicy(
      slot: AgentModelSlot,
      policy: RoutingPolicy | null,
    ): Promise<{
      preferences: RoutingPreferences;
    }>;
  }
}
//# sourceMappingURL=client-local-inference.d.ts.map
