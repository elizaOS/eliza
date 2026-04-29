/**
 * Provider registry.
 *
 * Treats every inference source the same way — cloud subscription, cloud
 * API, local llama.cpp engine, paired-device bridge, Capacitor on-device
 * — each is a `ProviderDefinition` with an `id`, a human label, a set of
 * supported model slots, and a pluggable `getEnableState()` that inspects
 * whatever underlying gate controls it (API key presence, subscription
 * status, env flag, file on disk).
 *
 * The cloud-provider status readers are intentionally permissive: they
 * report what they can introspect without depending on the specific
 * cloud-plugin internals, and hand off to the existing ProviderSwitcher
 * UI for actual enable/disable via `configureHref`. That avoids the
 * "combined enable matrix is an architectural project" problem by making
 * configuration navigable rather than centralised.
 */

import fs from "node:fs/promises";
import { getDefaultAccountPool } from "../account-pool";
import { deviceBridge } from "./device-bridge";
import { handlerRegistry } from "./handler-registry";
import { localInferenceRoot } from "./paths";
import type { AgentModelSlot } from "./types";

export type ProviderId =
  | "milady-local-inference"
  | "milady-device-bridge"
  | "capacitor-llama"
  | "anthropic-subscription"
  | "openai-codex"
  | "anthropic"
  | "openai"
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

/** Resolve which slots have at least one registered handler from this provider. */
export function getRegisteredSlotsForProvider(providerId: string): string[] {
  const regs = handlerRegistry.getAll();
  const slots = new Set<string>();
  for (const r of regs) {
    if (r.provider === providerId) slots.add(r.modelType);
  }
  return [...slots];
}

// ── Built-in provider definitions ────────────────────────────────────

const LOCAL_PROVIDER: ProviderDefinition = {
  id: "milady-local-inference",
  label: "Local llama.cpp",
  kind: "local",
  description:
    "On-device inference using node-llama-cpp. Free, private, runs on your machine's CPU/GPU.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    // Enabled when at least one model file lives under our root and the
    // binding is loadable. We don't force-load node-llama-cpp here — that
    // would tie up GPU memory just for a status probe.
    try {
      const entries = await fs.readdir(`${localInferenceRoot()}/models`, {
        withFileTypes: true,
      });
      const hasModel = entries.some(
        (e) => e.isFile() && e.name.toLowerCase().endsWith(".gguf"),
      );
      return hasModel
        ? { enabled: true, reason: "GGUF model installed" }
        : { enabled: false, reason: "No local model installed" };
    } catch {
      return { enabled: false, reason: "No local model installed" };
    }
  },
  configureHref: "#local-inference-panel",
};

const DEVICE_BRIDGE_PROVIDER: ProviderDefinition = {
  id: "milady-device-bridge",
  label: "Paired device bridge",
  kind: "device-bridge",
  description:
    "Inference on a paired mobile or desktop device over WebSocket. Useful when the agent runs in a container but the model lives on your phone or laptop.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    const bridgeEnabled =
      process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
    if (!bridgeEnabled) {
      return {
        enabled: false,
        reason: "Set ELIZA_DEVICE_BRIDGE_ENABLED=1 to enable",
      };
    }
    const status = deviceBridge.status();
    if (status.connected) {
      return {
        enabled: true,
        reason: `${status.devices.length} device(s) connected`,
      };
    }
    return {
      enabled: true,
      reason: "Waiting for a device to connect",
    };
  },
  configureHref: "#device-bridge-status",
};

const CAPACITOR_LLAMA_PROVIDER: ProviderDefinition = {
  id: "capacitor-llama",
  label: "On-device llama.cpp (mobile)",
  kind: "local",
  description:
    "Runs llama.cpp natively on iOS or Android via Capacitor. Only available in mobile builds.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    const cap = (globalThis as Record<string, unknown>).Capacitor as
      | { isNativePlatform?: () => boolean }
      | undefined;
    if (cap?.isNativePlatform?.()) {
      return {
        enabled: true,
        reason: "Native Capacitor runtime detected",
      };
    }
    return {
      enabled: false,
      reason: "Only available in iOS/Android builds",
    };
  },
  configureHref: null,
};

const ANTHROPIC_PROVIDER: ProviderDefinition = {
  id: "anthropic",
  label: "Anthropic API",
  kind: "cloud-api",
  description: "Claude models via the Anthropic API. Requires an API key.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "OBJECT_SMALL", "OBJECT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    return key
      ? { enabled: true, reason: "API key set" }
      : { enabled: false, reason: "No API key" };
  },
  configureHref: "#ai-model",
};

const OPENAI_PROVIDER: ProviderDefinition = {
  id: "openai",
  label: "OpenAI API",
  kind: "cloud-api",
  description: "GPT models via the OpenAI API. Requires an API key.",
  supportedSlots: [
    "TEXT_SMALL",
    "TEXT_LARGE",
    "TEXT_EMBEDDING",
    "OBJECT_SMALL",
    "OBJECT_LARGE",
  ],
  async getEnableState(): Promise<ProviderEnableState> {
    const key = process.env.OPENAI_API_KEY?.trim();
    return key
      ? { enabled: true, reason: "API key set" }
      : { enabled: false, reason: "No API key" };
  },
  configureHref: "#ai-model",
};

const GROK_PROVIDER: ProviderDefinition = {
  id: "grok",
  label: "Grok API",
  kind: "cloud-api",
  description: "xAI Grok models. Requires an API key.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    const key =
      process.env.GROK_API_KEY?.trim() ?? process.env.XAI_API_KEY?.trim();
    return key
      ? { enabled: true, reason: "API key set" }
      : { enabled: false, reason: "No API key" };
  },
  configureHref: "#ai-model",
};

const ELIZACLOUD_PROVIDER: ProviderDefinition = {
  id: "elizacloud",
  label: "Eliza Cloud",
  kind: "cloud-subscription",
  description:
    "Milady-hosted inference routed through your subscription. No API key to manage.",
  supportedSlots: [
    "TEXT_SMALL",
    "TEXT_LARGE",
    "TEXT_EMBEDDING",
    "OBJECT_SMALL",
    "OBJECT_LARGE",
  ],
  async getEnableState(): Promise<ProviderEnableState> {
    const token =
      process.env.ELIZA_CLOUD_TOKEN?.trim() ??
      process.env.ELIZACLOUD_TOKEN?.trim() ??
      process.env.ELIZAOS_API_KEY?.trim();
    return token
      ? { enabled: true, reason: "Cloud token set" }
      : { enabled: false, reason: "Not signed in" };
  },
  configureHref: "#ai-model",
};

const ANTHROPIC_SUBSCRIPTION_PROVIDER: ProviderDefinition = {
  id: "anthropic-subscription",
  label: "Claude subscription",
  kind: "cloud-subscription",
  description: "Claude Code task-agent access through linked accounts.",
  supportedSlots: [],
  async getEnableState(): Promise<ProviderEnableState> {
    return subscriptionEnableState("anthropic-subscription");
  },
  configureHref: "#ai-model",
};

const OPENAI_CODEX_PROVIDER: ProviderDefinition = {
  id: "openai-codex",
  label: "Codex subscription",
  kind: "cloud-subscription",
  description: "Codex and ChatGPT subscription access through linked accounts.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "OBJECT_SMALL", "OBJECT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    return subscriptionEnableState("openai-codex");
  },
  configureHref: "#ai-model",
};

const GOOGLE_PROVIDER: ProviderDefinition = {
  id: "google",
  label: "Google (Gemini)",
  kind: "cloud-api",
  description: "Gemini models via Google Generative AI. Requires an API key.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "OBJECT_SMALL", "OBJECT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    const key =
      process.env.GOOGLE_API_KEY?.trim() ?? process.env.GEMINI_API_KEY?.trim();
    return key
      ? { enabled: true, reason: "API key set" }
      : { enabled: false, reason: "No API key" };
  },
  configureHref: "#ai-model",
};

const MISTRAL_PROVIDER: ProviderDefinition = {
  id: "mistral",
  label: "Mistral API",
  kind: "cloud-api",
  description: "Mistral models via la Plateforme. Requires an API key.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    const key = process.env.MISTRAL_API_KEY?.trim();
    return key
      ? { enabled: true, reason: "API key set" }
      : { enabled: false, reason: "No API key" };
  },
  configureHref: "#ai-model",
};

export const BUILT_IN_PROVIDERS: readonly ProviderDefinition[] = [
  LOCAL_PROVIDER,
  DEVICE_BRIDGE_PROVIDER,
  CAPACITOR_LLAMA_PROVIDER,
  ANTHROPIC_SUBSCRIPTION_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  ELIZACLOUD_PROVIDER,
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  GOOGLE_PROVIDER,
  GROK_PROVIDER,
  MISTRAL_PROVIDER,
];

function subscriptionEnableState(providerId: ProviderId): ProviderEnableState {
  if (
    providerId !== "anthropic-subscription" &&
    providerId !== "openai-codex"
  ) {
    return { enabled: false, reason: "Unsupported subscription" };
  }
  const accounts = getDefaultAccountPool()
    .list(providerId)
    .filter((account) => account.enabled && account.health === "ok");
  if (accounts.length === 0) {
    return { enabled: false, reason: "No linked account" };
  }
  return {
    enabled: true,
    reason: `${accounts.length} linked account${accounts.length === 1 ? "" : "s"}`,
  };
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

export async function snapshotProviders(): Promise<ProviderStatus[]> {
  const entries = await Promise.all(
    BUILT_IN_PROVIDERS.map(async (def) => {
      const state = await def.getEnableState();
      return {
        id: def.id,
        label: def.label,
        kind: def.kind,
        description: def.description,
        supportedSlots: def.supportedSlots,
        configureHref: def.configureHref,
        enableState: state,
        registeredSlots: getRegisteredSlotsForProvider(def.id),
      } satisfies ProviderStatus;
    }),
  );
  return entries;
}
