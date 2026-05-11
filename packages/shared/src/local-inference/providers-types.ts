/**
 * Provider-registry type contracts shared between the agent server and
 * UI clients. The runtime side of provider enumeration
 * (`BUILT_IN_PROVIDERS`, `snapshotProviders`, the per-provider
 * `getEnableState()` implementations) lives in `@elizaos/app-core` only
 * — it is the authoritative source for `/api/local-inference/providers`.
 *
 * The UI consumes these types in two places (`client-local-inference.ts`
 * and `ios-local-agent-kernel.ts`) but never instantiates the runtime —
 * the iOS local-agent kernel ships its own one-provider response via
 * `capacitorLlamaProviderStatus()`.
 */

import type { AgentModelSlot } from "./types.js";

export type ProviderId =
  | "eliza-local-inference"
  | "eliza-device-bridge"
  | "capacitor-llama"
  | "anthropic-subscription"
  | "openai-codex"
  | "gemini-cli"
  | "zai-coding"
  | "kimi-coding"
  | "deepseek-coding"
  | "anthropic"
  | "openai"
  | "deepseek"
  | "zai"
  | "moonshot"
  | "grok"
  | "elizacloud"
  | "google"
  | "mistral";

export interface ProviderEnableState {
  enabled: boolean;
  /** Short reason, e.g. "API key set", "Device connected", "No API key". */
  reason: string;
}

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  kind: "cloud-api" | "cloud-subscription" | "local" | "device-bridge";
  /** Short blurb shown in the UI. */
  description: string;
  /** Agent slots this provider can plausibly serve. */
  supportedSlots: AgentModelSlot[];
  /**
   * Read the current enable state. For cloud providers we inspect env
   * vars or config fragments; for local we check file presence; for
   * device-bridge we check connected-device count.
   */
  getEnableState(): Promise<ProviderEnableState>;
  /**
   * Link to the settings UI where enable/configure actually happens.
   * UI sends the user here via anchor-scroll when they click "Configure".
   * `null` means the provider has no separate config surface.
   */
  configureHref: string | null;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  kind: ProviderDefinition["kind"];
  description: string;
  supportedSlots: AgentModelSlot[];
  configureHref: string | null;
  enableState: ProviderEnableState;
  /** Registered model types this provider has handlers for, right now. */
  registeredSlots: string[];
}
