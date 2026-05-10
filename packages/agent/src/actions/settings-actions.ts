/**
 * SETTINGS — single polymorphic owner-only action covering provider, capability,
 * training, owner-name, and worldSettings-registry mutations.
 *
 * Ops:
 *   - update_ai_provider → applyOnboardingConnectionConfig + saveElizaConfig
 *   - toggle_capability  → config.ui.capabilities.{wallet|browser|computerUse}
 *   - toggle_training    → app-training loadTrainingConfig/saveTrainingConfig
 *   - set_owner_name     → config.ui.ownerName via owner-name service
 *   - set                → worldSettings registry write (key/value list)
 *
 * Owner role gate is enforced action-wide. There is no chat-channel constraint
 * — the planner dispatches SETTINGS with explicit structured parameters.
 */

import {
  type Action,
  type ActionResult,
  findWorldsForOwner,
  getSalt,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Setting,
  saltWorldSettings,
  unsaltWorldSettings,
  type WorldSettings,
} from "@elizaos/core";
import {
  getOnboardingProviderOption,
  normalizeOnboardingProviderId,
} from "@elizaos/shared";
import {
  applyOnboardingConnectionConfig,
  createProviderSwitchConnection,
} from "../api/provider-switch-config.ts";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import {
  fetchConfiguredOwnerName,
  OWNER_NAME_MAX_LENGTH,
  persistConfiguredOwnerName,
} from "../services/owner-name.ts";

// ── Op catalog ────────────────────────────────────────────────────────────

export const SETTINGS_OPS = [
  "update_ai_provider",
  "toggle_capability",
  "toggle_training",
  "set_owner_name",
  "set",
] as const;
export type SettingsOp = (typeof SETTINGS_OPS)[number];

// ── Constants ────────────────────────────────────────────────────────────

const PROVIDER_API_KEY_MAX_LENGTH = 512;
const MODEL_SLOT_MAX_LENGTH = 256;

const CAPABILITY_KEYS = ["wallet", "browser", "computerUse"] as const;
type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

const MODEL_SLOTS = ["nano", "small", "medium", "large", "mega"] as const;

const TRAINING_CONFIG_MODULE = "@elizaos/app-training";

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

// ── Helpers ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function fail(
  error: string,
  text: string,
  extra?: Record<string, unknown>,
): ActionResult {
  return {
    text,
    success: false,
    values: { success: false, error },
    data: { actionName: "SETTINGS", error, ...(extra ?? {}) },
  };
}

function ok(text: string, data: Record<string, unknown>): ActionResult {
  return {
    text,
    success: true,
    values: { success: true },
    data: { actionName: "SETTINGS", ...data },
  };
}

function readParams(
  options: HandlerOptions | undefined,
): Record<string, unknown> {
  const raw = options?.parameters;
  return isRecord(raw) ? raw : {};
}

// ── op: update_ai_provider ────────────────────────────────────────────────

async function handleUpdateAiProvider(
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const rawProvider = params.provider;
  if (typeof rawProvider !== "string" || !rawProvider.trim()) {
    return fail(
      "MISSING_PROVIDER",
      "SETTINGS update_ai_provider requires a `provider` (e.g. anthropic, openai, elizacloud).",
    );
  }

  const normalizedProvider = normalizeOnboardingProviderId(rawProvider);
  if (!normalizedProvider) {
    return fail(
      "UNKNOWN_PROVIDER",
      `Unknown AI provider: ${rawProvider}. Use one from the onboarding catalog (anthropic, openai, openrouter, gemini, grok, groq, deepseek, mistral, together, ollama, zai, elizacloud).`,
      { provider: rawProvider },
    );
  }

  const apiKey = trimToString(params.apiKey, PROVIDER_API_KEY_MAX_LENGTH);
  const modelConfigs = isRecord(params.modelConfigs)
    ? params.modelConfigs
    : null;
  const primaryModel = trimToString(
    modelConfigs?.primary ?? modelConfigs?.large,
    MODEL_SLOT_MAX_LENGTH,
  );

  const config = loadElizaConfig();

  const connection =
    normalizedProvider === "elizacloud"
      ? {
          kind: "cloud-managed" as const,
          cloudProvider: "elizacloud" as const,
          ...(apiKey ? { apiKey } : {}),
        }
      : createProviderSwitchConnection({
          provider: normalizedProvider,
          ...(apiKey ? { apiKey } : {}),
          ...(primaryModel ? { primaryModel } : {}),
        });

  if (!connection) {
    return fail(
      "INVALID_PROVIDER",
      `Failed to build provider switch connection for ${normalizedProvider}.`,
      { provider: normalizedProvider },
    );
  }

  try {
    await applyOnboardingConnectionConfig(config, connection);

    if (modelConfigs) {
      const models = (config.models ?? {}) as Record<string, unknown>;
      for (const slot of MODEL_SLOTS) {
        const value = trimToString(modelConfigs[slot], MODEL_SLOT_MAX_LENGTH);
        if (value) models[slot] = value;
      }
      config.models = models as typeof config.models;
    }

    saveElizaConfig(config);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.stack : String(err) },
      "[SETTINGS] update_ai_provider failed",
    );
    return fail(
      "SETTINGS_UPDATE_AI_PROVIDER_FAILED",
      `Failed to apply provider config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const providerOption = getOnboardingProviderOption(normalizedProvider);
  return ok(
    `Switched AI provider to ${providerOption?.name ?? normalizedProvider}. Restart the agent to load the new provider.`,
    {
      op: "update_ai_provider",
      provider: normalizedProvider,
      providerName: providerOption?.name ?? normalizedProvider,
      ...(primaryModel ? { primaryModel } : {}),
      requiresRestart: true,
    },
  );
}

// ── op: toggle_capability ────────────────────────────────────────────────

function handleToggleCapability(params: Record<string, unknown>): ActionResult {
  const capability = params.capability;
  if (!isCapabilityKey(capability)) {
    return fail(
      "UNKNOWN_CAPABILITY",
      `Unknown capability: ${String(capability)}. Must be one of: ${CAPABILITY_KEYS.join(", ")}.`,
      { allowed: [...CAPABILITY_KEYS] },
    );
  }

  if (typeof params.enabled !== "boolean") {
    return fail(
      "MISSING_ENABLED",
      "SETTINGS toggle_capability requires `enabled: boolean`.",
    );
  }
  const enabled = params.enabled;

  try {
    const config = loadElizaConfig() as Record<string, unknown>;
    const ui = isRecord(config.ui) ? config.ui : {};
    const capabilities = isRecord(ui.capabilities) ? ui.capabilities : {};
    capabilities[capability] = enabled;
    ui.capabilities = capabilities;
    config.ui = ui;
    saveElizaConfig(config as Parameters<typeof saveElizaConfig>[0]);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.stack : String(err) },
      "[SETTINGS] toggle_capability failed",
    );
    return fail(
      "SETTINGS_TOGGLE_CAPABILITY_FAILED",
      `Failed to persist capability toggle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return ok(
    `Capability ${capability} is now ${enabled ? "enabled" : "disabled"}.`,
    { op: "toggle_capability", capability, enabled },
  );
}

// ── op: toggle_training ──────────────────────────────────────────────────

async function handleToggleTraining(
  params: Record<string, unknown>,
): Promise<ActionResult> {
  if (typeof params.enabled !== "boolean") {
    return fail(
      "MISSING_ENABLED",
      "SETTINGS toggle_training requires `enabled: boolean`.",
    );
  }

  const threshold = params.threshold;
  if (
    threshold !== undefined &&
    (typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold <= 0)
  ) {
    return fail(
      "INVALID_THRESHOLD",
      "`threshold` must be a positive finite number when provided.",
    );
  }

  const cooldownHours = params.cooldownHours;
  if (
    cooldownHours !== undefined &&
    (typeof cooldownHours !== "number" ||
      !Number.isFinite(cooldownHours) ||
      cooldownHours < 0)
  ) {
    return fail(
      "INVALID_COOLDOWN",
      "`cooldownHours` must be a non-negative finite number when provided.",
    );
  }

  let next: TrainingConfig;
  try {
    const mod = (await import(TRAINING_CONFIG_MODULE)) as TrainingConfigModule;
    const current = mod.loadTrainingConfig();
    next = {
      ...current,
      autoTrain: params.enabled,
      ...(typeof threshold === "number"
        ? { triggerThreshold: Math.floor(threshold) }
        : {}),
      ...(typeof cooldownHours === "number"
        ? { triggerCooldownHours: cooldownHours }
        : {}),
    };
    mod.saveTrainingConfig(next);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.stack : String(err) },
      "[SETTINGS] toggle_training failed",
    );
    return fail(
      "SETTINGS_TOGGLE_TRAINING_FAILED",
      `Failed to update auto-training config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return ok(
    `Auto-training is now ${next.autoTrain ? "enabled" : "disabled"} (threshold ${next.triggerThreshold}, cooldown ${next.triggerCooldownHours}h).`,
    {
      op: "toggle_training",
      autoTrain: next.autoTrain,
      triggerThreshold: next.triggerThreshold,
      triggerCooldownHours: next.triggerCooldownHours,
    },
  );
}

// ── op: set_owner_name ───────────────────────────────────────────────────

async function handleSetOwnerName(
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const raw = typeof params.name === "string" ? params.name.trim() : "";
  const name = raw.slice(0, OWNER_NAME_MAX_LENGTH);
  if (!name) {
    return fail(
      "INVALID_PARAMETERS",
      "SETTINGS set_owner_name requires a non-empty `name` parameter.",
    );
  }

  const previous = await fetchConfiguredOwnerName();
  const saved = await persistConfiguredOwnerName(name);
  if (!saved) {
    return fail(
      "SETTINGS_SET_OWNER_NAME_FAILED",
      `Failed to persist owner name "${name}".`,
      { name },
    );
  }

  return ok(
    previous
      ? `Owner name updated from "${previous}" to "${name}".`
      : `Owner name set to "${name}".`,
    { op: "set_owner_name", name, previous: previous ?? null },
  );
}

// ── op: set (worldSettings registry) ─────────────────────────────────────

interface SettingUpdate {
  key: string;
  value: string | boolean;
}

function normalizeSettingValue(value: unknown): string | boolean | null {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  return null;
}

function readSettingUpdates(params: Record<string, unknown>): SettingUpdate[] {
  const updates: SettingUpdate[] = [];
  const push = (rawKey: unknown, rawValue: unknown) => {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    const value = normalizeSettingValue(rawValue);
    if (key && value !== null) updates.push({ key, value });
  };

  if (typeof params.key === "string" && params.value !== undefined) {
    push(params.key, params.value);
  }

  if (Array.isArray(params.updates)) {
    for (const entry of params.updates) {
      if (isRecord(entry)) push(entry.key, entry.value);
    }
  }

  return updates;
}

async function handleSet(
  runtime: IAgentRuntime,
  ownerEntityId: string | undefined,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const updates = readSettingUpdates(params);
  if (!updates.length) {
    return fail(
      "INVALID_PARAMETERS",
      "SETTINGS set requires `key` + `value`, or an `updates: [{ key, value }]` array.",
    );
  }

  if (!ownerEntityId) {
    return fail(
      "NO_OWNER_ENTITY",
      "SETTINGS set requires the calling message's entityId to resolve the owner world.",
    );
  }

  const worlds = await findWorldsForOwner(
    runtime,
    ownerEntityId as Parameters<typeof findWorldsForOwner>[1],
  );
  const world = worlds?.find((w) => w.metadata?.settings);
  if (!world) {
    return fail(
      "NO_OWNER_WORLD",
      "No world with a settings registry was found for the calling owner.",
    );
  }

  const salt = getSalt();
  const rawSettings = world.metadata?.settings as WorldSettings | undefined;
  const worldSettings = rawSettings
    ? unsaltWorldSettings(rawSettings, salt)
    : undefined;
  if (!worldSettings) {
    return fail(
      "NO_SETTINGS_REGISTRY",
      "The owner world has no settings registry.",
    );
  }

  const registry = worldSettings.settings ?? {};
  const next: Record<string, Setting> = { ...registry };
  const applied: SettingUpdate[] = [];
  const skipped: { key: string; reason: string }[] = [];

  for (const update of updates) {
    const setting = next[update.key];
    if (!setting) {
      skipped.push({ key: update.key, reason: "UNKNOWN_KEY" });
      continue;
    }

    if (setting.dependsOn?.length) {
      const depsMet = setting.dependsOn.every(
        (dep) => next[dep] && next[dep].value !== null,
      );
      if (!depsMet) {
        skipped.push({ key: update.key, reason: "DEPENDENCY_NOT_MET" });
        continue;
      }
    }

    next[update.key] = { ...setting, value: update.value };
    applied.push(update);

    if (typeof setting.onSetAction === "function") {
      setting.onSetAction(update.value);
    }
  }

  if (!applied.length) {
    return fail("NO_VALID_UPDATES", "No valid setting updates were applied.", {
      skipped,
    });
  }

  const merged: WorldSettings = { ...worldSettings, settings: next };
  if (!world.metadata) world.metadata = {};
  world.metadata.settings = saltWorldSettings(merged, salt);

  try {
    await runtime.updateWorld(world);
  } catch (err) {
    logger.error(
      {
        error: err instanceof Error ? err.stack : String(err),
        worldId: world.id,
      },
      "[SETTINGS] set failed to persist world settings",
    );
    return fail(
      "SETTINGS_SET_FAILED",
      `Failed to persist setting updates: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return ok(
    `Updated ${applied.length} setting${applied.length === 1 ? "" : "s"}.`,
    {
      op: "set",
      applied,
      skipped,
      worldId: world.id,
    },
  );
}

// ── Action ───────────────────────────────────────────────────────────────

export const settingsAction: Action = {
  name: "SETTINGS",
  contexts: ["settings", "admin", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    // Old leaf action names
    "UPDATE_AI_PROVIDER",
    "TOGGLE_CAPABILITY",
    "TOGGLE_AUTO_TRAINING",
    "SET_USER_NAME",
    "SET_OWNER_NAME",
    "UPDATE_OWNER_NAME",
    // Common aliases
    "REMEMBER_NAME",
    "SAVE_NAME",
    "SET_NAME",
  ],
  description:
    "Owner-only polymorphic settings mutation. Dispatches on `action` to update " +
    "AI provider, toggle a capability, toggle/configure auto-training, set " +
    "the owner display name, or write to the world's settings registry.",
  descriptionCompressed:
    "owner-only settings mutation dispatch on action update AI provider, toggle capability, toggle/configure auto-train, set owner display name, write world settings registry",

  validate: async () => true,

  parameters: [
    {
      name: "action",
      description: `Operation discriminator. One of: ${SETTINGS_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "provider",
      description:
        "[update_ai_provider] AI provider id (anthropic, openai, openrouter, gemini, grok, groq, deepseek, mistral, together, ollama, zai, elizacloud).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "apiKey",
      description: "[update_ai_provider] Optional API key for the provider.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "modelConfigs",
      description:
        "[update_ai_provider] Optional model slot overrides — `nano|small|medium|large|mega` or `primary`.",
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "capability",
      description: `[toggle_capability] Capability key. One of: ${CAPABILITY_KEYS.join(", ")}.`,
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "enabled",
      description: "[toggle_capability | toggle_training] Boolean enable flag.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "threshold",
      description:
        "[toggle_training] Optional positive integer — trajectories per task that triggers a run.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "cooldownHours",
      description:
        "[toggle_training] Optional non-negative number — minimum hours between runs for the same task.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "name",
      description: `[set_owner_name] New owner display name (1–${OWNER_NAME_MAX_LENGTH} chars after trim).`,
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "key",
      description: "[set] Setting registry key.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "value",
      description: "[set] Setting value (string | boolean | number).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "updates",
      description: "[set] Optional array of `{ key, value }` for bulk writes.",
      required: false,
      schema: { type: "array" as const },
    },
  ],

  handler: async (runtime, message, _state, options) => {
    const params = readParams(options as HandlerOptions | undefined);
    const op = params.action ?? params.subaction ?? params.op;

    switch (op) {
      case "update_ai_provider":
        return handleUpdateAiProvider(params);
      case "toggle_capability":
        return handleToggleCapability(params);
      case "toggle_training":
        return handleToggleTraining(params);
      case "set_owner_name":
        return handleSetOwnerName(params);
      case "set":
        return handleSet(runtime, message?.entityId, params);
      default:
        return fail(
          "SETTINGS_INVALID",
          `SETTINGS requires \`action\`. One of: ${SETTINGS_OPS.join(", ")}.`,
          { op: typeof op === "string" ? op : null },
        );
    }
  },

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
        content: { text: "Change my display name to Sam." },
      },
      {
        name: "{{agentName}}",
        content: { text: 'Owner name set to "Sam".' },
      },
    ],
  ],
};
