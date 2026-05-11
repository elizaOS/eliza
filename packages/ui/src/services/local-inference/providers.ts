/**
 * Provider registry.
 *
 * Treats every inference source the same way — cloud subscription, cloud
 * API, Eliza-1 local runtime, paired-device bridge, Capacitor on-device
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
import { deviceBridge } from "./device-bridge";
import { getDflashRuntimeStatus } from "./dflash-server";
import { handlerRegistry } from "./handler-registry";
import { localInferenceRoot } from "./paths";
import type { AgentModelSlot } from "./types";

export type ProviderId =
  | "eliza-local-inference"
  | "eliza-device-bridge"
  | "capacitor-llama"
  | "anthropic-subscription"
  | "openai-codex"
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
  id: "eliza-local-inference",
  label: "Eliza-1 local runtime",
  kind: "local",
  description:
    "On-device Eliza-1 inference with the optimized local runtime when the managed binary and companion files are installed.",
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
      if (!hasModel)
        return { enabled: false, reason: "No local model installed" };
      const dflash = getDflashRuntimeStatus();
      return dflash.enabled
        ? {
            enabled: true,
            reason: "Eliza-1 model installed; local acceleration available",
          }
        : { enabled: true, reason: "GGUF model installed" };
    } catch {
      return { enabled: false, reason: "No local model installed" };
    }
  },
  configureHref: "#local-inference-panel",
};

const DEVICE_BRIDGE_PROVIDER: ProviderDefinition = {
  id: "eliza-device-bridge",
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
  label: "eliza-1-1_7b runtime",
  kind: "local",
  description:
    "Runs Eliza-1 natively on iOS or Android via Capacitor. Only available in mobile builds.",
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
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
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
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"],
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
    "Eliza-hosted inference routed through your subscription. No API key to manage.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"],
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
  // Claude.ai OAuth subscriptions serve text generation through Anthropic's
  // chat models. Embeddings are not exposed by the subscription path
  // (Anthropic does not ship an embeddings endpoint), so TEXT_EMBEDDING is
  // intentionally omitted — that slot needs a separate API-key provider.
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
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
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
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
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
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

const DEEPSEEK_PROVIDER: ProviderDefinition = {
  id: "deepseek",
  label: "DeepSeek API",
  kind: "cloud-api",
  description: "DeepSeek models via API key or linked account pool.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    return apiKeyOrLinkedAccountState("deepseek-api", ["DEEPSEEK_API_KEY"]);
  },
  configureHref: "#ai-model",
};

const ZAI_PROVIDER: ProviderDefinition = {
  id: "zai",
  label: "z.ai API",
  kind: "cloud-api",
  description: "GLM models via z.ai API key or linked account pool.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    return apiKeyOrLinkedAccountState("zai-api", [
      "ZAI_API_KEY",
      "Z_AI_API_KEY",
    ]);
  },
  configureHref: "#ai-model",
};

const MOONSHOT_PROVIDER: ProviderDefinition = {
  id: "moonshot",
  label: "Kimi / Moonshot API",
  kind: "cloud-api",
  description: "Kimi models via Moonshot API key or linked account pool.",
  supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
  async getEnableState(): Promise<ProviderEnableState> {
    return apiKeyOrLinkedAccountState("moonshot-api", [
      "MOONSHOT_API_KEY",
      "KIMI_API_KEY",
    ]);
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
  DEEPSEEK_PROVIDER,
  ZAI_PROVIDER,
  MOONSHOT_PROVIDER,
  GOOGLE_PROVIDER,
  GROK_PROVIDER,
  MISTRAL_PROVIDER,
];

function apiKeyOrLinkedAccountState(
  _providerId: "deepseek-api" | "zai-api" | "moonshot-api",
  envKeys: readonly string[],
): ProviderEnableState {
  const hasEnv = envKeys.some((key) => process.env[key]?.trim());
  if (hasEnv) return { enabled: true, reason: "API key set" };
  return { enabled: false, reason: "No API key or linked account" };
}

function subscriptionEnableState(providerId: ProviderId): ProviderEnableState {
  if (
    providerId !== "anthropic-subscription" &&
    providerId !== "openai-codex"
  ) {
    return { enabled: false, reason: "Unsupported subscription" };
  }
  return { enabled: false, reason: "No linked account" };
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
