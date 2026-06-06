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
import { ElizaClient } from "./client-base";

let localInferenceHubRequest: Promise<ModelHubSnapshot> | null = null;

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

/** Hardware classification tier (mirrors the plugin `DeviceTier`). */
export type DeviceTier = "MAX" | "GOOD" | "OKAY" | "POOR";

/**
 * Resolved device tier for the UI. `reason` is a short human line explaining
 * the classification (e.g. "16.0 GB free · dGPU"); `cpuOnly` and `mobile` drive
 * the "Auto: on-device vs cloud" resolution shown next to per-slot routing.
 */
export interface DeviceTierResult {
  tier: DeviceTier;
  reason: string;
  /** True when no supported GPU is present (CPU-only host). */
  cpuOnly: boolean;
  /** True on iOS/Android (clamped to OKAY at best). */
  mobile: boolean;
  /**
   * Authoritative fields populated when this came from the server
   * `/api/local-inference/device-tier` endpoint (the same assessment the router's
   * AUTO policy uses). Absent when falling back to the coarse client estimate.
   */
  recommendedMode?: "local" | "cloud-with-local-voice" | "cloud-only";
  canRunLocalLm?: boolean;
  canRunLocalVoice?: boolean;
  /** The biggest eliza-1 tier (+128k QJL context) that fits, or null → Cloud. */
  recommendedFit?: {
    tierId: string;
    contextLength: number;
    kvQuant: string;
    contextDownscaled: boolean;
  } | null;
}

/**
 * Classify a `HardwareProbe` into a coarse device tier for UI display.
 *
 * This is a deliberately small client-side approximation of the plugin's
 * `classifyDeviceTier` (which carries the authoritative R9 thresholds). The UI
 * only needs the tier label + a one-line reason to render the banner and the
 * per-slot "Auto" resolution; it does not gate runtime behaviour, so the full
 * server classifier is not required on the client.
 */
export function classifyDeviceTierFromProbe(
  probe: HardwareProbe,
): DeviceTierResult {
  const mobile =
    probe.mobile?.platform === "ios" || probe.mobile?.platform === "android";
  const cpuOnly = !probe.gpu && !probe.appleSilicon;
  const vramGb = probe.gpu?.totalVramGb ?? 0;
  const effectiveMemoryGb = probe.appleSilicon
    ? probe.totalRamGb
    : probe.gpu
      ? Math.max(vramGb, probe.totalRamGb * 0.5)
      : probe.totalRamGb * 0.5;

  const accelerator = probe.appleSilicon
    ? `Apple Silicon ${probe.totalRamGb.toFixed(0)} GB`
    : probe.gpu
      ? `${vramGb.toFixed(0)} GB VRAM`
      : `${probe.totalRamGb.toFixed(0)} GB RAM, ${probe.cpuCores} cores`;
  const reason = `${effectiveMemoryGb.toFixed(1)} GB effective · ${probe.freeRamGb.toFixed(1)} GB free · ${accelerator}`;

  const tier = ((): DeviceTier => {
    // Mobile clamps to OKAY at best (OS background-task limits).
    if (mobile) {
      return probe.freeRamGb >= 3 ? "OKAY" : "POOR";
    }
    if (probe.cpuCores < 4) return "POOR";
    const meetsMax =
      effectiveMemoryGb >= 24 &&
      probe.freeRamGb >= 16 &&
      (vramGb >= 16 || (probe.appleSilicon && probe.totalRamGb >= 32));
    if (meetsMax) return "MAX";
    const meetsGood =
      effectiveMemoryGb >= 12 &&
      probe.freeRamGb >= 8 &&
      (vramGb >= 8 ||
        (probe.appleSilicon && probe.totalRamGb >= 16) ||
        (cpuOnly && probe.totalRamGb >= 32));
    if (meetsGood) return "GOOD";
    const meetsOkay = effectiveMemoryGb >= 6 && probe.freeRamGb >= 3;
    return meetsOkay ? "OKAY" : "POOR";
  })();

  return { tier, reason, cpuOnly, mobile };
}

declare module "./client-base" {
  interface ElizaClient {
    getLocalInferenceHub(): Promise<ModelHubSnapshot>;
    getLocalInferenceHardware(): Promise<HardwareProbe>;
    /**
     * Resolve the live device tier by probing hardware and classifying it.
     * Backs the Settings → Voice tier banner and the per-slot "Auto"
     * resolution in the routing matrix.
     */
    getLocalInferenceDeviceTier(): Promise<DeviceTierResult>;
    getLocalInferenceCatalog(): Promise<{ models: CatalogModel[] }>;
    getLocalInferenceInstalled(): Promise<{ models: InstalledModel[] }>;
    startLocalInferenceDownload(modelId: string): Promise<{ job: DownloadJob }>;
    searchHuggingFaceGguf(
      query: string,
      limit?: number,
      hub?: "huggingface" | "modelscope",
    ): Promise<{ models: CatalogModel[] }>;
    cancelLocalInferenceDownload(
      modelId: string,
    ): Promise<{ cancelled: boolean }>;
    getLocalInferenceActive(): Promise<ActiveModelState>;
    setLocalInferenceActive(modelId: string): Promise<ActiveModelState>;
    clearLocalInferenceActive(): Promise<ActiveModelState>;
    uninstallLocalInferenceModel(id: string): Promise<{ removed: boolean }>;
    getLocalInferenceDeviceStatus(): Promise<DeviceBridgeStatus>;
    getLocalInferenceProviders(): Promise<{ providers: ProviderStatus[] }>;
    getLocalInferenceAssignments(): Promise<{
      assignments: ModelAssignments;
    }>;
    setLocalInferenceAssignment(
      slot: AgentModelSlot,
      modelId: string | null,
    ): Promise<{ assignments: ModelAssignments }>;
    verifyLocalInferenceModel(id: string): Promise<VerifyResult>;
    getLocalInferenceRouting(): Promise<{
      registrations: PublicRegistration[];
      preferences: RoutingPreferences;
    }>;
    setLocalInferencePreferredProvider(
      slot: AgentModelSlot,
      provider: string | null,
    ): Promise<{ preferences: RoutingPreferences }>;
    setLocalInferencePolicy(
      slot: AgentModelSlot,
      policy: RoutingPolicy | null,
    ): Promise<{ preferences: RoutingPreferences }>;
  }
}

ElizaClient.prototype.getLocalInferenceHub = async function (
  this: ElizaClient,
) {
  localInferenceHubRequest ??= this.fetch<ModelHubSnapshot>(
    "/api/local-inference/hub",
    undefined,
    { timeoutMs: 30_000 },
  ).finally(() => {
    localInferenceHubRequest = null;
  });
  return localInferenceHubRequest;
};

ElizaClient.prototype.getLocalInferenceHardware = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/hardware");
};

ElizaClient.prototype.getLocalInferenceDeviceTier = async function (
  this: ElizaClient,
) {
  // Prefer the authoritative server assessment (same one the router's AUTO policy
  // consumes) so the UI's tier/recommendedMode/recommendedFit cannot disagree with
  // the actual routing decision. Fall back to the coarse client estimate only when
  // the endpoint is unavailable (older agent, transient error).
  try {
    const res = (await this.fetch("/api/local-inference/device-tier")) as {
      tier?: {
        tier?: DeviceTier;
        reasons?: string[];
        canRunLocalLm?: boolean;
        canRunLocalVoice?: boolean;
        recommendedMode?: DeviceTierResult["recommendedMode"];
        recommendedFit?: DeviceTierResult["recommendedFit"];
        numericContext?: {
          vramGb?: number | null;
          appleSilicon?: boolean;
          mobile?: boolean;
        };
      };
    };
    const a = res?.tier;
    if (a && typeof a.tier === "string") {
      const nc = a.numericContext ?? {};
      return {
        tier: a.tier,
        reason: a.reasons?.[0] ?? "",
        cpuOnly: !nc.vramGb && !nc.appleSilicon,
        mobile: Boolean(nc.mobile),
        recommendedMode: a.recommendedMode,
        canRunLocalLm: a.canRunLocalLm,
        canRunLocalVoice: a.canRunLocalVoice,
        recommendedFit: a.recommendedFit ?? null,
      };
    }
  } catch {
    // fall through to the client-side approximation
  }
  const probe = await this.getLocalInferenceHardware();
  return classifyDeviceTierFromProbe(probe);
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

ElizaClient.prototype.searchHuggingFaceGguf = async function (
  this: ElizaClient,
  query: string,
  limit?: number,
  hub: "huggingface" | "modelscope" = "huggingface",
) {
  const params = new URLSearchParams({ q: query });
  if (limit != null) params.set("limit", String(limit));
  params.set("hub", hub);
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

ElizaClient.prototype.getLocalInferenceProviders = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/providers");
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

ElizaClient.prototype.getLocalInferenceRouting = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/local-inference/routing");
};

ElizaClient.prototype.setLocalInferencePreferredProvider = async function (
  this: ElizaClient,
  slot: AgentModelSlot,
  provider: string | null,
) {
  return this.fetch("/api/local-inference/routing/preferred", {
    method: "POST",
    body: JSON.stringify({ slot, provider }),
  });
};

ElizaClient.prototype.setLocalInferencePolicy = async function (
  this: ElizaClient,
  slot: AgentModelSlot,
  policy: RoutingPolicy | null,
) {
  return this.fetch("/api/local-inference/routing/policy", {
    method: "POST",
    body: JSON.stringify({ slot, policy }),
  });
};
