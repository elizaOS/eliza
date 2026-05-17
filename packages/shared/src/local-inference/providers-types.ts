/**
 * Provider-registry **data-only** contracts shared between the agent
 * server and UI clients. Everything in this file must remain free of
 * runtime-only capabilities (no methods, no callables) so the same types
 * can be referenced by mobile/browser UI bundles without implying Node.js
 * I/O.
 *
 * The runtime-side `ProviderDefinition` (which adds a callable
 * `getEnableState()` reading env vars / fs / device-bridge sockets)
 * extends `ProviderMeta` and lives in
 * `@elizaos/app-core/src/services/local-inference/providers.ts` — it is
 * the authoritative source for `/api/local-inference/providers`.
 *
 * UI consumers (`client-local-inference.ts`, `ios-local-agent-kernel.ts`)
 * only see `ProviderStatus` (the response shape) and `ProviderMeta` /
 * `ProviderEnableState` / `ProviderId` — never the runtime definition.
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

/**
 * Data-only provider descriptor. UI-safe — contains no runtime methods.
 * The server-side `ProviderDefinition` (in `@elizaos/app-core`) extends
 * this with a `getEnableState()` callable.
 */
export interface ProviderMeta {
  id: ProviderId;
  label: string;
  kind: "cloud-api" | "cloud-subscription" | "local" | "device-bridge";
  /** Short blurb shown in the UI. */
  description: string;
  /** Agent slots this provider can plausibly serve. */
  supportedSlots: AgentModelSlot[];
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
  kind: ProviderMeta["kind"];
  description: string;
  supportedSlots: AgentModelSlot[];
  configureHref: string | null;
  enableState: ProviderEnableState;
  /** Registered model types this provider has handlers for, right now. */
  registeredSlots: string[];
}
