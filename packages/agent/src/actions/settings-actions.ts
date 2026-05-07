/**
 * Settings actions — agent-driven counterparts to the in-app Settings page.
 *
 * Each action wraps the same persistence path that the SettingsView UI uses
 * so the agent can adjust identity, AI provider, capability toggles, and
 * auto-training without going through the chat-as-keyboard path.
 *
 * Persistence routes (all server-side):
 *   - UPDATE_IDENTITY        → runtime.character + ElizaCharacterPersistenceService
 *   - UPDATE_AI_PROVIDER     → applyOnboardingConnectionConfig + saveElizaConfig
 *   - TOGGLE_CAPABILITY      → config.ui.capabilities.{wallet|browser|computerUse}
 *   - TOGGLE_AUTO_TRAINING   → app-training loadTrainingConfig/saveTrainingConfig
 *
 * Voice/TTS configuration is owned by the upstream `setVoiceConfigAction`
 * (`@elizaos/core` advanced-capabilities/personality), which already lists
 * `UPDATE_VOICE_CONFIG` as a simile. We deliberately do not duplicate it
 * here — both action names route to the upstream handler.
 *
 * All four actions gate on owner access and refuse to act otherwise.
 *
 * @module actions/settings-actions
 */

import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  getOnboardingProviderOption,
  normalizeOnboardingProviderId,
} from "@elizaos/shared";
import {
  applyOnboardingConnectionConfig,
  createProviderSwitchConnection,
} from "../api/provider-switch-config.js";
import { loadElizaConfig, saveElizaConfig } from "../config/config.js";
import {
  CHARACTER_PERSISTENCE_SERVICE,
  type ElizaCharacterPersistenceService,
} from "../services/character-persistence.js";

// ── Shared helpers ────────────────────────────────────────────────────────

const IDENTITY_NAME_MAX_LENGTH = 120;
const IDENTITY_SYSTEM_MAX_LENGTH = 100_000;
const PROVIDER_API_KEY_MAX_LENGTH = 512;

const CAPABILITY_KEYS = ["wallet", "browser", "computerUse"] as const;
type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

const TRAINING_CONFIG_MODULE = "@elizaos/app-training/core/training-config";

interface TrainingConfig {
  autoTrain: boolean;
  triggerThreshold: number;
  triggerCooldownHours: number;
  backends?: string[];
  perTaskOverrides?: Record<string, unknown>;
}

interface TrainingConfigModule {
  loadTrainingConfig: () => TrainingConfig;
  saveTrainingConfig: (config: TrainingConfig) => void;
}

async function loadTrainingConfigModule(): Promise<TrainingConfigModule> {
  return import(TRAINING_CONFIG_MODULE) as Promise<TrainingConfigModule>;
}

function _denyPermission() {
  return {
    text: "Permission denied: only the owner may change Settings.",
    success: false,
    data: { error: "PERMISSION_DENIED" },
  };
}

function getCharacterPersistenceService(
  runtime: IAgentRuntime,
): ElizaCharacterPersistenceService | null {
  const svc = runtime.getService(CHARACTER_PERSISTENCE_SERVICE);
  if (!svc) return null;
  return svc as unknown as ElizaCharacterPersistenceService;
}

function isCapabilityKey(value: unknown): value is CapabilityKey {
  return (
    typeof value === "string" &&
    (CAPABILITY_KEYS as readonly string[]).includes(value)
  );
}

function trimToString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function readCharacterField(
  runtime: IAgentRuntime,
  field: "name" | "system",
): string {
  const character = runtime.character as { name?: unknown; system?: unknown };
  const value = character[field];
  return typeof value === "string" ? value : "";
}

// ── UPDATE_IDENTITY ──────────────────────────────────────────────────────

interface UpdateIdentityParams {
  name?: string;
  system?: string;
}

export const updateIdentityAction: Action = {
  name: "UPDATE_IDENTITY",
  contexts: ["settings", "admin", "agent_internal"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "SET_IDENTITY",
    "UPDATE_AGENT_NAME",
    "UPDATE_SYSTEM_PROMPT",
    "SET_AGENT_NAME",
    "SET_SYSTEM_PROMPT",
    "RENAME_AGENT",
  ],

  description:
    "Update the agent's display name and/or system prompt. Mirrors the " +
    "Basics section of the Settings page. At least one of `name` or " +
    "`system` must be provided. The change is persisted to runtime " +
    "character, agent metadata, and the on-disk config.",
  descriptionCompressed:
    "update agent display name and/or system prompt mirror Basics section Settings page least one name system provide change persist runtime character, agent metadata, on-disk config",

  validate: async () => true,

  handler: async (runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | UpdateIdentityParams
      | undefined;

    const name = trimToString(params?.name, IDENTITY_NAME_MAX_LENGTH);
    const systemPrompt = trimToString(
      params?.system,
      IDENTITY_SYSTEM_MAX_LENGTH,
    );

    if (!name && !systemPrompt) {
      return {
        text: "Either `name` or `system` must be provided to UPDATE_IDENTITY.",
        success: false,
        data: { error: "MISSING_PARAMETERS" },
      };
    }

    const previousName = readCharacterField(runtime, "name");
    const previousSystem = readCharacterField(runtime, "system");

    const character = runtime.character as { name?: string; system?: string };
    if (name) character.name = name;
    if (systemPrompt) character.system = systemPrompt;

    const persistence = getCharacterPersistenceService(runtime);
    if (!persistence) {
      // Roll back the in-memory mutation so we don't drift from disk.
      if (name) character.name = previousName;
      if (systemPrompt) character.system = previousSystem;
      return {
        text: "Character persistence service is not available.",
        success: false,
        data: { error: "PERSISTENCE_SERVICE_UNAVAILABLE" },
      };
    }

    const result = await persistence.persistCharacter({
      previousName,
      source: "agent",
    });

    if (!result.success) {
      if (name) character.name = previousName;
      if (systemPrompt) character.system = previousSystem;
      return {
        text: `Failed to persist identity: ${result.error ?? "unknown error"}`,
        success: false,
        data: { error: "PERSIST_FAILED", detail: result.error },
      };
    }

    const updated: Record<string, string> = {};
    if (name) updated.name = name;
    if (systemPrompt) updated.system = systemPrompt;

    return {
      text: name
        ? `Identity updated. Name is now ${name}.`
        : "System prompt updated.",
      success: true,
      data: { updated },
    };
  },

  parameters: [
    {
      name: "name",
      description: "New display name for the agent (optional).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "system",
      description:
        "New system prompt for the agent. Replaces the previous prompt entirely (optional).",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Rename yourself to Atlas." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Identity updated. Name is now Atlas." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Update your system prompt to focus on technical research.",
        },
      },
      {
        name: "{{agentName}}",
        content: { text: "System prompt updated." },
      },
    ],
  ] as ActionExample[][],
};

// ── UPDATE_AI_PROVIDER ───────────────────────────────────────────────────

interface UpdateAiProviderParams {
  provider?: string;
  apiKey?: string;
  modelConfigs?: Record<string, unknown>;
}

export const updateAiProviderAction: Action = {
  name: "UPDATE_AI_PROVIDER",
  contexts: ["settings", "secrets", "admin"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "SWITCH_PROVIDER",
    "SET_AI_PROVIDER",
    "CHANGE_PROVIDER",
    "SET_LLM_PROVIDER",
    "SWITCH_AI_PROVIDER",
  ],

  description:
    "Switch the active AI/LLM provider (e.g. anthropic, openai, " +
    "openrouter, gemini, groq, ollama, elizacloud). Mirrors the Providers " +
    "section of the Settings page. Optionally accepts an API key and " +
    "model overrides. The runtime restarts to pick up the new provider.",
  descriptionCompressed:
    "switch active AI/LLM provider (e g anthropic, openai, openrouter, gemini, groq, ollama, elizacloud) mirror Providers section Settings page optionally accept API key model override runtime restart pick up new provider",

  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | UpdateAiProviderParams
      | undefined;

    const rawProvider = params?.provider;
    if (typeof rawProvider !== "string" || !rawProvider.trim()) {
      return {
        text: "UPDATE_AI_PROVIDER requires a `provider` (e.g. anthropic, openai, elizacloud).",
        success: false,
        data: { error: "MISSING_PROVIDER" },
      };
    }

    const normalizedProvider = normalizeOnboardingProviderId(rawProvider);
    if (!normalizedProvider) {
      return {
        text: `Unknown AI provider: ${rawProvider}. Use one from the onboarding catalog (anthropic, openai, openrouter, gemini, grok, groq, deepseek, mistral, together, ollama, zai, elizacloud).`,
        success: false,
        data: { error: "UNKNOWN_PROVIDER", provider: rawProvider },
      };
    }

    const apiKey = trimToString(params?.apiKey, PROVIDER_API_KEY_MAX_LENGTH);

    // modelConfigs maps slot → model id (e.g. { large: "claude-sonnet-4.6" })
    const modelConfigs =
      params?.modelConfigs &&
      typeof params.modelConfigs === "object" &&
      !Array.isArray(params.modelConfigs)
        ? (params.modelConfigs as Record<string, unknown>)
        : null;
    const primaryModel = trimToString(
      modelConfigs?.primary ?? modelConfigs?.large,
      256,
    );

    const config = loadElizaConfig();

    let connection:
      | ReturnType<typeof createProviderSwitchConnection>
      | {
          kind: "cloud-managed";
          cloudProvider: "elizacloud";
          apiKey?: string;
        }
      | null;
    if (normalizedProvider === "elizacloud") {
      connection = {
        kind: "cloud-managed" as const,
        cloudProvider: "elizacloud" as const,
        ...(apiKey ? { apiKey } : {}),
      };
    } else {
      connection = createProviderSwitchConnection({
        provider: normalizedProvider,
        ...(apiKey ? { apiKey } : {}),
        ...(primaryModel ? { primaryModel } : {}),
      });
    }

    if (!connection) {
      return {
        text: `Failed to build provider switch connection for ${normalizedProvider}.`,
        success: false,
        data: { error: "INVALID_PROVIDER", provider: normalizedProvider },
      };
    }

    try {
      await applyOnboardingConnectionConfig(config, connection);

      // Apply caller-supplied model slot overrides on top of the connection.
      if (modelConfigs) {
        const models = (config.models ?? {}) as Record<string, unknown>;
        for (const slot of [
          "nano",
          "small",
          "medium",
          "large",
          "mega",
        ] as const) {
          const value = trimToString(modelConfigs[slot], 256);
          if (value) models[slot] = value;
        }
        config.models = models;
      }

      saveElizaConfig(config);
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.stack : String(err) },
        "[settings-actions] UPDATE_AI_PROVIDER failed",
      );
      return {
        text: `Failed to apply provider config: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        data: { error: "APPLY_FAILED" },
      };
    }

    const providerOption = getOnboardingProviderOption(normalizedProvider);
    return {
      text: `Switched AI provider to ${providerOption?.name ?? normalizedProvider}. Restart the agent to load the new provider.`,
      success: true,
      data: {
        provider: normalizedProvider,
        providerName: providerOption?.name ?? normalizedProvider,
        primaryModel,
        requiresRestart: true,
      },
    };
  },

  parameters: [
    {
      name: "provider",
      description:
        "AI provider id (e.g. 'anthropic', 'openai', 'openrouter', 'gemini', 'grok', 'groq', 'deepseek', 'mistral', 'together', 'ollama', 'zai', 'elizacloud').",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "apiKey",
      description:
        "Optional API key for the new provider. Persisted to the provider's signal env key.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "modelConfigs",
      description:
        "Optional model slot overrides — supply any of `nano`, `small`, `medium`, `large`, `mega`, or `primary`/`large` for the headline model.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Switch to Anthropic with my API key sk-ant-xxx." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Switched AI provider to Anthropic. Restart the agent to load the new provider.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Use Eliza Cloud as the LLM provider." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Switched AI provider to Eliza Cloud. Restart the agent to load the new provider.",
        },
      },
    ],
  ] as ActionExample[][],
};

// ── TOGGLE_CAPABILITY ────────────────────────────────────────────────────

interface ToggleCapabilityParams {
  capability?: string;
  enabled?: boolean;
}

export const toggleCapabilityAction: Action = {
  name: "TOGGLE_CAPABILITY",
  contexts: ["settings", "admin", "agent_internal"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "ENABLE_CAPABILITY",
    "DISABLE_CAPABILITY",
    "SET_CAPABILITY",
    "TOGGLE_FEATURE",
    "ENABLE_FEATURE",
    "DISABLE_FEATURE",
  ],

  description:
    "Enable or disable a high-level capability surface (wallet, browser, " +
    "computerUse). Mirrors the Capabilities section of the Settings page. " +
    "Persists to `config.ui.capabilities.{capability}` so the preference " +
    "survives restarts.",
  descriptionCompressed:
    "enable disable high-level capability surface (wallet, browser, computeruse) mirror Capabilities section Settings page persist config ui capability capability preference survive restart",

  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ToggleCapabilityParams
      | undefined;

    const capabilityValue = params?.capability;
    if (!isCapabilityKey(capabilityValue)) {
      return {
        text: `Unknown capability: ${String(capabilityValue)}. Must be one of: ${CAPABILITY_KEYS.join(", ")}.`,
        success: false,
        data: {
          error: "UNKNOWN_CAPABILITY",
          allowed: [...CAPABILITY_KEYS],
        },
      };
    }

    if (typeof params?.enabled !== "boolean") {
      return {
        text: "TOGGLE_CAPABILITY requires `enabled: boolean`.",
        success: false,
        data: { error: "MISSING_ENABLED" },
      };
    }

    const enabled = params.enabled;

    try {
      const config = loadElizaConfig() as Record<string, unknown>;
      const ui = (
        typeof config.ui === "object" &&
        config.ui !== null &&
        !Array.isArray(config.ui)
          ? config.ui
          : {}
      ) as Record<string, unknown>;
      const capabilities = (
        typeof ui.capabilities === "object" &&
        ui.capabilities !== null &&
        !Array.isArray(ui.capabilities)
          ? ui.capabilities
          : {}
      ) as Record<string, unknown>;

      capabilities[capabilityValue] = enabled;
      ui.capabilities = capabilities;
      config.ui = ui;
      saveElizaConfig(config as Parameters<typeof saveElizaConfig>[0]);
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.stack : String(err) },
        "[settings-actions] TOGGLE_CAPABILITY failed",
      );
      return {
        text: `Failed to persist capability toggle: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        data: { error: "PERSIST_FAILED" },
      };
    }

    return {
      text: `Capability ${capabilityValue} is now ${enabled ? "enabled" : "disabled"}.`,
      success: true,
      data: { capability: capabilityValue, enabled },
    };
  },

  parameters: [
    {
      name: "capability",
      description: `Capability key. One of: ${CAPABILITY_KEYS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "enabled",
      description: "True to enable the capability, false to disable it.",
      required: true,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Turn off the wallet capability." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Capability wallet is now disabled." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Enable computer use." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Capability computerUse is now enabled." },
      },
    ],
  ] as ActionExample[][],
};

// UPDATE_VOICE_CONFIG is intentionally NOT defined here. The upstream
// `setVoiceConfigAction` (`@elizaos/core` advanced-capabilities/personality)
// already owns the canonical TTS-voice persistence path and lists
// `UPDATE_VOICE_CONFIG`, `SET_VOICE`, `UPDATE_VOICE`, and similar names as
// similes. Defining a second action here would create a duplicate handler
// and conflict with the existing simile resolution. If the upstream action
// is ever removed, port its handler into this file and re-introduce
// `updateVoiceConfigAction`.

// ── TOGGLE_AUTO_TRAINING ─────────────────────────────────────────────────

interface ToggleAutoTrainingParams {
  enabled?: boolean;
  threshold?: number;
  cooldownHours?: number;
}

export const toggleAutoTrainingAction: Action = {
  name: "TOGGLE_AUTO_TRAINING",
  contexts: ["settings", "admin", "agent_internal", "automation"],
  roleGate: { minRole: "OWNER" },

  similes: [
    "ENABLE_AUTO_TRAINING",
    "DISABLE_AUTO_TRAINING",
    "SET_AUTO_TRAINING",
    "CONFIGURE_AUTO_TRAINING",
  ],

  description:
    "Enable or disable auto-training, and optionally tune the trigger " +
    "threshold (trajectories per task) and cooldown (hours). Mirrors the " +
    "Capabilities → Auto-training row in the Settings page.",
  descriptionCompressed:
    "enable disable auto-train, optionally tune trigger threshold (trajectory per task) cooldown (hour) mirror Capabilities Auto-training row Settings page",

  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ToggleAutoTrainingParams
      | undefined;

    if (typeof params?.enabled !== "boolean") {
      return {
        text: "TOGGLE_AUTO_TRAINING requires `enabled: boolean`.",
        success: false,
        data: { error: "MISSING_ENABLED" },
      };
    }

    const threshold = params.threshold;
    if (
      threshold !== undefined &&
      (!Number.isFinite(threshold) || threshold <= 0)
    ) {
      return {
        text: "`threshold` must be a positive finite number when provided.",
        success: false,
        data: { error: "INVALID_THRESHOLD" },
      };
    }

    const cooldownHours = params.cooldownHours;
    if (
      cooldownHours !== undefined &&
      (!Number.isFinite(cooldownHours) || cooldownHours < 0)
    ) {
      return {
        text: "`cooldownHours` must be a non-negative finite number when provided.",
        success: false,
        data: { error: "INVALID_COOLDOWN" },
      };
    }

    let next: TrainingConfig;
    try {
      const { loadTrainingConfig, saveTrainingConfig } =
        await loadTrainingConfigModule();
      const current = loadTrainingConfig();
      next = {
        ...current,
        autoTrain: params.enabled,
        ...(threshold !== undefined
          ? { triggerThreshold: Math.floor(threshold) }
          : {}),
        ...(cooldownHours !== undefined
          ? { triggerCooldownHours: cooldownHours }
          : {}),
      };
      saveTrainingConfig(next);
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.stack : String(err) },
        "[settings-actions] TOGGLE_AUTO_TRAINING failed",
      );
      return {
        text: `Failed to update auto-training config: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        data: { error: "PERSIST_FAILED" },
      };
    }

    return {
      text: `Auto-training is now ${next.autoTrain ? "enabled" : "disabled"} (threshold ${next.triggerThreshold}, cooldown ${next.triggerCooldownHours}h).`,
      success: true,
      data: {
        autoTrain: next.autoTrain,
        triggerThreshold: next.triggerThreshold,
        triggerCooldownHours: next.triggerCooldownHours,
      },
    };
  },

  parameters: [
    {
      name: "enabled",
      description: "True to enable auto-training, false to disable it.",
      required: true,
      schema: { type: "boolean" as const },
    },
    {
      name: "threshold",
      description:
        "Optional positive integer — trajectory count per task that triggers a run.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "cooldownHours",
      description:
        "Optional non-negative number — minimum hours between consecutive runs for the same task.",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Turn on auto-training." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Auto-training is now enabled (threshold 100, cooldown 12h).",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Disable auto-training for now.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Auto-training is now disabled (threshold 100, cooldown 12h).",
        },
      },
    ],
  ] as ActionExample[][],
};
