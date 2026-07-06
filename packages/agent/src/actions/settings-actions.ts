/**
 * SETTINGS — single polymorphic owner-only action covering built-in settings
 * sections, provider, capability, training, owner-name, backend routing, and
 * worldSettings-registry mutations.
 *
 * Ops:
 *   - get/list           → section registry from @elizaos/plugin-app-control
 *   - update_ai_provider → applyFirstRunConnectionConfig + saveElizaConfig
 *   - toggle_capability  → config.ui.capabilities.{wallet|browser|computerUse}
 *   - toggle_training    → training plugin's TrainingConfigService (via registry)
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
  ModelType,
  type Setting,
  saltWorldSettings,
  unsaltWorldSettings,
  type WorldSettings,
} from "@elizaos/core";
import {
  createSettingsAction as createSectionSettingsAction,
  parseSettingsRequest,
} from "@elizaos/plugin-app-control/actions/settings";
import {
  getFirstRunProviderOption,
  normalizeFirstRunProviderId,
} from "@elizaos/shared";
import {
  applyFirstRunConnectionConfig,
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
  "get",
  "list",
  "update_ai_provider",
  "toggle_capability",
  "toggle_training",
  "set_owner_name",
  "set",
  "show_backends",
  "set_backend",
] as const;
export type SettingsOp = (typeof SETTINGS_OPS)[number];
const SECTION_SETTINGS_OPS = new Set(["get", "list"]);
const sectionSettingsAction = createSectionSettingsAction();

// Coding sub-agent adapters the orchestrator can route to. Mirrors
// KNOWN_ADAPTER_TYPES in plugin-agent-orchestrator (kept as a literal here so
// @elizaos/agent does not depend on the orchestrator plugin).
const CODING_BACKENDS = [
  "elizaos",
  "pi-agent",
  "claude",
  "codex",
  "opencode",
] as const;
const CODING_BACKEND_ALIASES: Record<string, string> = {
  "eliza-os": "elizaos",
  eliza: "elizaos",
  pi: "pi-agent",
  "open-code": "opencode",
  "claude-code": "claude",
  openai: "codex",
  "openai-codex": "codex",
};
const DIFFICULTY_TAGS = ["simple", "moderate", "hard"] as const;
const BRAIN_MODEL_KEYS = [
  ModelType.TEXT_NANO,
  ModelType.TEXT_SMALL,
  ModelType.TEXT_MEDIUM,
  ModelType.TEXT_LARGE,
  ModelType.TEXT_MEGA,
  ModelType.RESPONSE_HANDLER,
  ModelType.ACTION_PLANNER,
  ModelType.TEXT_REASONING_SMALL,
  ModelType.TEXT_REASONING_LARGE,
  ModelType.TEXT_COMPLETION,
] as const;

// ── Constants ────────────────────────────────────────────────────────────

const PROVIDER_API_KEY_MAX_LENGTH = 512;
const MODEL_SLOT_MAX_LENGTH = 256;

const CAPABILITY_KEYS = ["wallet", "browser", "computerUse"] as const;
type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

const MODEL_SLOTS = ["nano", "small", "medium", "large", "mega"] as const;

// `toggle_training` is contributed by the training plugin, which registers a
// TrainingConfigService under this name. The host dispatches to the service
// instead of importing the plugin (which @elizaos/agent does not depend on):
// the op is available only when the plugin is loaded, and reports unavailable
// otherwise. The structural shape below mirrors the plugin's
// TrainingConfigCapability so no import edge is created.
const TRAINING_CONFIG_SERVICE = "training_config_service";

interface AutoTrainToggleInput {
  enabled: boolean;
  threshold?: number;
  cooldownHours?: number;
}

interface TrainingConfigSummary {
  autoTrain: boolean;
  triggerThreshold: number;
  triggerCooldownHours: number;
}

interface TrainingConfigCapability {
  applyAutoTrainToggle: (
    input: AutoTrainToggleInput,
  ) => TrainingConfigSummary | Promise<TrainingConfigSummary>;
}

function isTrainingConfigCapability(
  service: unknown,
): service is TrainingConfigCapability {
  return (
    service != null &&
    typeof (service as { applyAutoTrainToggle?: unknown })
      .applyAutoTrainToggle === "function"
  );
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

function shouldUseSectionSettingsAction(
  options: HandlerOptions | undefined,
  params: Record<string, unknown>,
): boolean {
  const rawOp = params.action ?? params.subaction ?? params.op;
  const op = typeof rawOp === "string" ? rawOp.trim().toLowerCase() : "";
  if (SECTION_SETTINGS_OPS.has(op)) return true;
  if (op !== "set") return false;
  // A `set` belongs to the section registry only when it addresses a resolvable
  // built-in section. A legacy no-section set ({ action:"set", key, value })
  // parses non-null too (sectionId:null), and routing it to the section handler
  // would fail with "which section?" — it must stay on the worldSettings
  // registry branch below.
  return (
    parseSettingsRequest(options as Record<string, unknown> | undefined)
      ?.sectionId != null
  );
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

  const normalizedProvider = normalizeFirstRunProviderId(rawProvider);
  if (!normalizedProvider) {
    return fail(
      "UNKNOWN_PROVIDER",
      `Unknown AI provider: ${rawProvider}. Use one from the first-run catalog (anthropic, openai, openrouter, gemini, grok, groq, deepseek, mistral, together, ollama, zai, elizacloud).`,
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
    await applyFirstRunConnectionConfig(config, connection);

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

  const providerOption = getFirstRunProviderOption(normalizedProvider);
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
  runtime: IAgentRuntime,
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

  const service = runtime.getService(TRAINING_CONFIG_SERVICE);
  if (!isTrainingConfigCapability(service)) {
    return fail(
      "TRAINING_UNAVAILABLE",
      "Auto-training is unavailable — the training plugin is not loaded.",
    );
  }

  let summary: TrainingConfigSummary;
  try {
    summary = await service.applyAutoTrainToggle({
      enabled: params.enabled,
      ...(typeof threshold === "number" ? { threshold } : {}),
      ...(typeof cooldownHours === "number" ? { cooldownHours } : {}),
    });
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
    `Auto-training is now ${summary.autoTrain ? "enabled" : "disabled"} (threshold ${summary.triggerThreshold}, cooldown ${summary.triggerCooldownHours}h).`,
    {
      op: "toggle_training",
      autoTrain: summary.autoTrain,
      triggerThreshold: summary.triggerThreshold,
      triggerCooldownHours: summary.triggerCooldownHours,
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

    if (setting.dependsOn.length) {
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

// ── op: show_backends / set_backend ──────────────────────────────────────
//
// Owner-facing control over which backend handles coding sub-agents (per
// difficulty) and the chat brain — the "driver agent" routing surface. Coding
// routing is persisted as the `ELIZA_BACKEND_ROUTING` config-env JSON the
// orchestrator reads fresh per spawn; the brain provider is `ELIZA_BRAIN_PROVIDER`
// (read by the runtime's useModel override). Both take effect with no restart.

interface CodingAxisRouting {
  default?: string;
  byTag?: Record<string, string>;
  /** Operator lock-list constraining every resolved backend (orchestrator-side). */
  allow?: string[];
}

export function normalizeCodingBackend(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase().replace(/_/g, "-");
  if (!v) return undefined;
  const resolved = CODING_BACKEND_ALIASES[v] ?? v;
  return (CODING_BACKENDS as readonly string[]).includes(resolved)
    ? resolved
    : undefined;
}

/** Parse a `{ coding: {...} }`-shaped routing object into a CodingAxisRouting. */
function parseCodingAxisObject(parsed: unknown): CodingAxisRouting {
  const coding =
    isRecord(parsed) && isRecord(parsed.coding) ? parsed.coding : {};
  const out: CodingAxisRouting = {};
  if (typeof coding.default === "string") out.default = coding.default;
  if (isRecord(coding.byTag)) {
    const byTag: Record<string, string> = {};
    for (const [k, val] of Object.entries(coding.byTag)) {
      if (typeof val === "string") byTag[k.toLowerCase()] = val;
    }
    if (Object.keys(byTag).length > 0) out.byTag = byTag;
  }
  if (Array.isArray(coding.allow)) {
    const allow = coding.allow.filter(
      (v): v is string => typeof v === "string",
    );
    out.allow = allow;
  }
  return out;
}

export function readBackendRouting(config: {
  env?: Record<string, unknown>;
}): CodingAxisRouting {
  const raw = config.env?.ELIZA_BACKEND_ROUTING;
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  } else {
    parsed = raw;
  }
  return parseCodingAxisObject(parsed);
}

export function hasLoadedTextProvider(
  runtime: IAgentRuntime,
  provider: string,
): boolean {
  const models = (runtime as { models?: unknown }).models;
  if (!(models instanceof Map)) return false;
  return BRAIN_MODEL_KEYS.some((key) =>
    (models.get(key) as Array<{ provider?: unknown }> | undefined)?.some(
      (handler) => handler.provider === provider,
    ),
  );
}

/**
 * The EFFECTIVE coding routing the orchestrator actually uses — its resolver
 * reads `character.settings.routing.coding` first, then the
 * `ELIZA_BACKEND_ROUTING` config-env JSON. Mirror that precedence so show/set
 * report and mutate what truly takes effect (a character-declared policy would
 * otherwise silently shadow a config-env write).
 */
function readEffectiveCodingRouting(
  runtime: IAgentRuntime,
  config: { env?: Record<string, unknown> },
): { routing: CodingAxisRouting; source: "character" | "env" | "none" } {
  const fromCharacter = parseCodingAxisObject(
    runtime.character?.settings?.routing,
  );
  if (
    fromCharacter.default ||
    fromCharacter.byTag ||
    fromCharacter.allow !== undefined
  ) {
    return { routing: fromCharacter, source: "character" };
  }
  const fromEnv = readBackendRouting(config);
  if (fromEnv.default || fromEnv.byTag || fromEnv.allow !== undefined) {
    return { routing: fromEnv, source: "env" };
  }
  return { routing: {}, source: "none" };
}

function handleShowBackends(runtime: IAgentRuntime): ActionResult {
  const config = loadElizaConfig() as { env?: Record<string, unknown> };
  const { routing: coding } = readEffectiveCodingRouting(runtime, config);
  const brain =
    (typeof runtime.getSetting === "function"
      ? (runtime.getSetting("ELIZA_BRAIN_PROVIDER") as string | null)
      : null) ?? null;
  const codingLines = [
    `- coding default: ${coding.default ?? "(operator pin / planner choice)"}`,
  ];
  if (coding.byTag && Object.keys(coding.byTag).length > 0) {
    for (const [tag, backend] of Object.entries(coding.byTag)) {
      codingLines.push(`- coding when ${tag}: ${backend}`);
    }
  }
  if (coding.allow && coding.allow.length > 0) {
    codingLines.push(
      `- coding allowed (lock-list): ${coding.allow.join(", ")}`,
    );
  }
  const text = [
    "Current backend routing:",
    ...codingLines,
    `- chat brain: ${brain || "(boot default)"}`,
  ].join("\n");
  return ok(text, {
    op: "show_backends",
    coding,
    brain,
  });
}

function handleSetBackend(
  runtime: IAgentRuntime,
  params: Record<string, unknown>,
): ActionResult {
  const axisRaw =
    typeof params.axis === "string" ? params.axis.trim().toLowerCase() : "";
  const axis = axisRaw === "brain" ? "brain" : "coding";

  if (axis === "brain") {
    const provider = trimToString(params.backend, 64)?.toLowerCase();
    if (!provider) {
      return fail(
        "SETTINGS_BACKEND_INVALID",
        "set_backend for the brain needs a `backend` provider id (e.g. anthropic, openai, cerebras).",
      );
    }
    if (!hasLoadedTextProvider(runtime, provider)) {
      return fail(
        "SETTINGS_BACKEND_UNAVAILABLE",
        `Cannot set chat brain to \`${provider}\`: no loaded text-generation handler is registered for that provider.`,
        { provider },
      );
    }
    const config = loadElizaConfig() as { env?: Record<string, unknown> };
    config.env = { ...(config.env ?? {}), ELIZA_BRAIN_PROVIDER: provider };
    saveElizaConfig(config as Parameters<typeof saveElizaConfig>[0]);
    // Immediate effect: the runtime's useModel override reads this via getSetting.
    runtime.setSetting?.("ELIZA_BRAIN_PROVIDER", provider);
    return ok(
      `Chat brain provider set to \`${provider}\`. It takes effect on the next message (it falls back to the default if that provider has no loaded handler).`,
      { op: "set_backend", axis: "brain", provider },
    );
  }

  const backend = normalizeCodingBackend(params.backend);
  if (!backend) {
    return fail(
      "SETTINGS_BACKEND_INVALID",
      `set_backend for coding needs a known \`backend\`. One of: ${CODING_BACKENDS.join(", ")}.`,
      { provided: params.backend ?? null },
    );
  }
  const tagRaw =
    typeof params.tag === "string" ? params.tag.trim().toLowerCase() : "";
  const tag = (DIFFICULTY_TAGS as readonly string[]).includes(tagRaw)
    ? tagRaw
    : "";

  const config = loadElizaConfig() as { env?: Record<string, unknown> };
  // Start from the EFFECTIVE routing (character first, else env) so we mutate
  // whatever currently wins and preserve any operator allow lock-list.
  const { routing: coding } = readEffectiveCodingRouting(runtime, config);
  if (coding.allow !== undefined) {
    const allowed = coding.allow
      .map((value) => normalizeCodingBackend(value))
      .filter((value): value is string => Boolean(value));
    if (!allowed.includes(backend)) {
      return fail(
        "SETTINGS_BACKEND_DISALLOWED",
        `Cannot route coding tasks to \`${backend}\`: it is outside the configured coding backend allow-list.`,
        { backend, allow: allowed },
      );
    }
  }
  if (tag) {
    coding.byTag = { ...(coding.byTag ?? {}), [tag]: backend };
  } else {
    coding.default = backend;
  }

  // Persist to the config-env JSON for durability across restarts.
  config.env = {
    ...(config.env ?? {}),
    ELIZA_BACKEND_ROUTING: JSON.stringify({ coding }),
  };
  saveElizaConfig(config as Parameters<typeof saveElizaConfig>[0]);

  // Also write through to the in-memory character at the HIGHEST precedence the
  // orchestrator reads. Without this, a character that already declares
  // routing.coding would shadow the config-env write and the command would
  // report success with zero effect. Mutating the live character makes the
  // change effective on the next spawn with no restart, shadow-proof.
  const character = runtime.character as
    | { settings?: { routing?: { coding?: CodingAxisRouting } } }
    | undefined;
  if (character) {
    character.settings ??= {};
    const settings = character.settings as {
      routing?: { coding?: CodingAxisRouting };
    };
    settings.routing ??= {};
    settings.routing.coding = coding;
  }

  const scope = tag ? `${tag} coding tasks` : "coding tasks (default)";
  return ok(
    `Routing ${scope} to \`${backend}\`. Takes effect on the next sub-agent spawn — no restart.`,
    { op: "set_backend", axis: "coding", backend, tag: tag || null },
  );
}

// ── Action ───────────────────────────────────────────────────────────────

export const settingsAction: Action = {
  name: "SETTINGS",
  contexts: ["general", "settings", "admin", "system", "agent_internal"],
  contextGate: { anyOf: ["general", "settings", "admin", "system"] },
  roleGate: { minRole: "OWNER" },
  similes: [
    "CHANGE_SETTING",
    "UPDATE_SETTINGS",
    "SETTINGS_WRITE",
    "TOGGLE_SETTING",
    "GET_SETTING",
    "LIST_SETTINGS",
    "PERMISSIONS",
    "CHANGE_PERMISSION",
    "CHANGE_PERMISSIONS",
    "SET_PERMISSION",
    "TOGGLE_PERMISSION",
    "REVOKE_PERMISSION",
    "GRANT_PERMISSION",
    "SHELL_ACCESS",
    "SHELL_PERMISSION",
    "SHELL_PERMISSIONS",
    "TOGGLE_SHELL_ACCESS",
    "DISABLE_SHELL_ACCESS",
    "ENABLE_SHELL_ACCESS",
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
    // Backend routing control
    "SET_BACKEND",
    "SET_CODING_BACKEND",
    "SET_BRAIN_BACKEND",
    "SHOW_BACKENDS",
    "ROUTE_BACKEND",
  ],
  description:
    "Owner-only polymorphic settings action. Dispatches on `action` to read/list/change built-in settings sections (`get|set|list` with `section`/`key`/`value`, including permissions, app permissions, backups, and auto-training), update AI provider, toggle a capability, toggle/configure auto-training, set the owner display name, write to the world's settings registry, show the current backend routing (show_backends), or change which backend handles coding sub-agents / the chat brain (set_backend) — e.g. 'turn off shell access', 'what settings can you change', 'use codex for simple tasks and claude for hard ones', 'switch the brain to cerebras'. Opening a settings page without changing or reading a value is VIEWS, not SETTINGS.",
  descriptionCompressed:
    "owner settings action: get|set|list sections plus AI provider|capability|auto-train|display name|world registry|backend routing",
  routingHint:
    "Changing or reading a settings VALUE -> SETTINGS. Permissions/shell/app permissions/auto-training/backups use SETTINGS action=set section=<section> key=<key> value=on|off. Listing settings uses SETTINGS action=list. Legacy provider/capability/backend commands still use SETTINGS action=update_ai_provider|toggle_capability|toggle_training|set_owner_name|show_backends|set_backend. Pure navigation to a settings page is VIEWS.",

  validate: async () => true,

  parameters: [
    {
      name: "action",
      description: `Operation discriminator. One of: ${SETTINGS_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const, enum: [...SETTINGS_OPS] },
    },
    {
      name: "section",
      description:
        "[get | set] Canonical settings section id or alias (e.g. permissions, capabilities, app-permissions, ai-model, background, secrets).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "app",
      description:
        "[set, app-permissions] Registered app slug for app permission writes.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "namespace",
      description:
        "[set, app-permissions] Permission namespace, e.g. fs/filesystem or net/network.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "fileName",
      description:
        "[set, advanced restore-backup] Backup file name to restore.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirm",
      description:
        "[set, destructive settings operations] Explicit confirmation token, usually true.",
      required: false,
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
      schema: { type: "string" as const, enum: [...CAPABILITY_KEYS] },
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
      name: "axis",
      description:
        "[set_backend] Which backend to change: 'coding' (the coding sub-agent, default) or 'brain' (the chat/planner model).",
      required: false,
      schema: { type: "string" as const, enum: ["coding", "brain"] },
    },
    {
      name: "backend",
      description:
        "[set_backend] The backend to route to. For coding: elizaos, pi-agent, claude, codex, or opencode. For brain: a loaded provider id (e.g. anthropic, openai, cerebras).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "tag",
      description:
        "[set_backend, coding only] Optional difficulty this routing applies to: 'simple', 'moderate', or 'hard'. Omit to set the default coding backend for all difficulties.",
      required: false,
      schema: { type: "string" as const, enum: [...DIFFICULTY_TAGS] },
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

  handler: async (runtime, message, _state, options, callback) => {
    const params = readParams(options as HandlerOptions | undefined);
    const op = params.action ?? params.subaction ?? params.op;

    if (
      shouldUseSectionSettingsAction(
        options as HandlerOptions | undefined,
        params,
      )
    ) {
      return sectionSettingsAction.handler(
        runtime,
        message,
        _state,
        options,
        callback,
      );
    }

    switch (op) {
      case "update_ai_provider":
        return handleUpdateAiProvider(params);
      case "toggle_capability":
        return handleToggleCapability(params);
      case "toggle_training":
        return handleToggleTraining(runtime, params);
      case "set_owner_name":
        return handleSetOwnerName(params);
      case "set":
        return handleSet(runtime, message.entityId, params);
      case "show_backends":
        return handleShowBackends(runtime);
      case "set_backend":
        return handleSetBackend(runtime, params);
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
