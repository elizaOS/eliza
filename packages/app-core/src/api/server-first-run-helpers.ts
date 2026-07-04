/**
 * First-run helpers — API key persistence, setup defaults,
 * cloud-mode detection, and cloud-provisioned container detection.
 */

import {
  applyFirstRunCredentialPersistence,
  loadElizaConfig,
  saveElizaConfig,
} from "@elizaos/agent";
import { logger, stringToUuid } from "@elizaos/core";
import {
  type DeploymentTargetConfig,
  deriveFirstRunCredentialPersistencePlan,
  getDefaultStylePreset,
  getStylePresets,
  type LinkedAccountFlagsConfig,
  migrateLegacyRuntimeConfig,
  normalizeCharacterLanguage,
  normalizeDeploymentTargetConfig,
  normalizeFirstRunCredentialInputs,
  normalizeLinkedAccountFlagsConfig,
  normalizeServiceRoutingConfig,
  PREMADE_VOICES,
  type ServiceRoutingConfig,
} from "@elizaos/shared";
import { getCompatApiToken } from "./auth.ts";
import { resolveProviderCredential } from "./credential-resolver";

// ---------------------------------------------------------------------------
// First-run API key persistence
// ---------------------------------------------------------------------------

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
const ELEVENLABS_VOICE_ID_BY_PRESET = new Map(
  PREMADE_VOICES.map((voice) => [voice.id, voice.voiceId]),
);

function resolveCompatFirstRunStyle(
  body: Record<string, unknown>,
  language: string,
) {
  const presets = getStylePresets(language);
  const requestedPresetId = trimToUndefined(body.presetId);
  if (requestedPresetId) {
    const byId = presets.find((preset) => preset.id === requestedPresetId);
    if (byId) return byId;
  }

  if (
    typeof body.avatarIndex === "number" &&
    Number.isFinite(body.avatarIndex)
  ) {
    const byAvatar = presets.find(
      (preset) => preset.avatarIndex === Number(body.avatarIndex),
    );
    if (byAvatar) return byAvatar;
  }

  const requestedName = trimToUndefined(body.name);
  if (requestedName) {
    const byName = presets.find((preset) => preset.name === requestedName);
    if (byName) return byName;
  }

  return getDefaultStylePreset(language);
}

const DEPRECATED_FIRST_RUN_REQUEST_KEYS = [
  "connection",
  "runMode",
  "cloudProvider",
  "provider",
  "providerApiKey",
  "primaryModel",
  "smallModel",
  "largeModel",
] as const;

export function hasDeprecatedFirstRunRequestFields(
  body: Record<string, unknown>,
): boolean {
  return DEPRECATED_FIRST_RUN_REQUEST_KEYS.some((key) =>
    Object.hasOwn(body, key),
  );
}

/**
 * Extract canonical first-run credential inputs from an first-run request body
 * and persist them to config + process.env. Returns the env key name if a local
 * provider API key was persisted, or null.
 */
export async function extractAndPersistFirstRunApiKey(
  body: Record<string, unknown>,
): Promise<string | null> {
  const credentialInputs = normalizeFirstRunCredentialInputs(
    body.credentialInputs,
  );
  const explicitDeploymentTarget = normalizeDeploymentTargetConfig(
    body.deploymentTarget,
  );
  const explicitServiceRouting = normalizeServiceRoutingConfig(
    body.serviceRouting,
  );
  logger.info(
    `[first-run] extractAndPersistFirstRunApiKey: credentialInputs=${credentialInputs ? "present" : "missing"}, keys=${Object.keys(body).join(",")}`,
  );
  const initialPlan = deriveFirstRunCredentialPersistencePlan({
    credentialInputs,
    deploymentTarget: explicitDeploymentTarget,
    serviceRouting: explicitServiceRouting,
  });
  let effectiveCredentialInputs = credentialInputs;
  let effectiveServiceRouting = explicitServiceRouting;
  let llmSelection = initialPlan.llmSelection;

  if (!llmSelection && !initialPlan.cloudApiKey) {
    logger.warn(
      "[first-run] No first-run credentials resolved from request body",
    );
    return null;
  }
  logger.info(
    `[first-run] Resolved selection: transport=${llmSelection?.transport ?? "none"}, provider=${llmSelection?.backend ?? "N/A"}, hasKey=${Boolean(llmSelection?.apiKey)}, hasCloudKey=${Boolean(initialPlan.cloudApiKey)}`,
  );

  // If the key is masked (from IPC) or missing, try to resolve the real
  // key from local credential stores (files, keychain, env). A "****xxxx"
  // value is the server's own GET-response masking echoed back by the
  // client — never a real credential — so it must be replaced by a resolved
  // key or dropped, not persisted (persisting it clobbers a working key
  // with an unusable placeholder).
  const llmApiKeyMasked = Boolean(llmSelection?.apiKey?.startsWith("****"));
  if (
    llmSelection?.transport === "direct" &&
    llmSelection.backend !== "elizacloud"
  ) {
    const resolved = resolveProviderCredential(llmSelection.backend);
    if (resolved && resolved.authType === "subscription") {
      effectiveCredentialInputs = {
        ...(effectiveCredentialInputs ?? {}),
        llmApiKey: resolved.apiKey,
      };
      effectiveServiceRouting = normalizeServiceRoutingConfig({
        ...(effectiveServiceRouting ?? {}),
        llmText: {
          ...(effectiveServiceRouting?.llmText ?? {}),
          backend: resolved.providerId,
          transport: "direct",
        },
      });
      logger.info(
        `[first-run] Using subscription auth for ${resolved.providerId}`,
      );
    } else if (resolved) {
      effectiveCredentialInputs = {
        ...(effectiveCredentialInputs ?? {}),
        llmApiKey: resolved.apiKey,
      };
      logger.info(
        `[first-run] Resolved real key for ${llmSelection.backend} via credential-resolver`,
      );
    } else if (!llmSelection.apiKey || llmApiKeyMasked) {
      logger.warn(
        `[first-run] No real key available for ${llmSelection.backend} (input key ${llmApiKeyMasked ? "masked" : "missing"}) — cannot persist`,
      );
      return null;
    }

    llmSelection = deriveFirstRunCredentialPersistencePlan({
      credentialInputs: effectiveCredentialInputs,
      deploymentTarget: explicitDeploymentTarget,
      serviceRouting: effectiveServiceRouting,
    }).llmSelection;
  }

  const config = loadElizaConfig();
  const result = await applyFirstRunCredentialPersistence(config, {
    credentialInputs: effectiveCredentialInputs,
    deploymentTarget: explicitDeploymentTarget,
    serviceRouting: effectiveServiceRouting,
  });
  saveElizaConfig(config);

  if (result) {
    logger.info(`[first-run] Persisted ${result} from first-run credentials`);
  }
  return result;
}

export function persistFirstRunDefaults(
  body: Record<string, unknown>,
): string | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return null;
  }

  const config = loadElizaConfig();
  const language = normalizeCharacterLanguage(body.language);
  const stylePreset = resolveCompatFirstRunStyle(body, language);
  if (!config.agents || typeof config.agents !== "object") {
    (config as Record<string, unknown>).agents = {};
  }
  const agents = config.agents as NonNullable<typeof config.agents>;
  if (!agents.defaults || typeof agents.defaults !== "object") {
    agents.defaults = {};
  }

  const adminEntityId = stringToUuid(`${name}-admin-entity`);
  agents.defaults.adminEntityId = adminEntityId;

  if (!Array.isArray(agents.list) || agents.list.length === 0) {
    (agents as Record<string, unknown>).list = [{ id: "main", default: true }];
  }
  const agentEntry = (agents.list as Record<string, unknown>[])[0];
  agentEntry.name = name;
  if (Array.isArray(body.bio)) {
    agentEntry.bio = body.bio;
  }
  if (typeof body.systemPrompt === "string" && body.systemPrompt.trim()) {
    agentEntry.system = body.systemPrompt.trim();
  }
  if (body.style && typeof body.style === "object") {
    agentEntry.style = body.style;
  }
  if (Array.isArray(body.adjectives)) {
    agentEntry.adjectives = body.adjectives;
  }
  if (Array.isArray(body.topics)) {
    agentEntry.topics = body.topics;
  }
  if (Array.isArray(body.postExamples)) {
    agentEntry.postExamples = body.postExamples;
  }
  if (Array.isArray(body.messageExamples)) {
    agentEntry.messageExamples = body.messageExamples;
  }

  if (!config.ui || typeof config.ui !== "object") {
    (config as Record<string, unknown>).ui = {};
  }
  const ui = config.ui as Record<string, unknown>;
  ui.assistant = {
    ...(ui.assistant && typeof ui.assistant === "object"
      ? (ui.assistant as Record<string, unknown>)
      : {}),
    name,
  };
  ui.language = language;
  if (
    typeof body.avatarIndex === "number" &&
    Number.isFinite(body.avatarIndex)
  ) {
    ui.avatarIndex = Number(body.avatarIndex);
  } else if (typeof stylePreset.avatarIndex === "number") {
    ui.avatarIndex = stylePreset.avatarIndex;
  }
  if (trimToUndefined(body.presetId)) {
    ui.presetId = trimToUndefined(body.presetId);
  } else if (stylePreset.id) {
    ui.presetId = stylePreset.id;
  }

  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voicePresetId = stylePreset.voicePresetId.trim();
  const voiceId = voicePresetId
    ? ELEVENLABS_VOICE_ID_BY_PRESET.get(voicePresetId)
    : undefined;
  if (elevenLabsApiKey && voiceId) {
    if (!config.messages || typeof config.messages !== "object") {
      (config as Record<string, unknown>).messages = {};
    }
    const messages = config.messages as Record<string, unknown>;
    const existingTts =
      messages.tts && typeof messages.tts === "object"
        ? (messages.tts as Record<string, unknown>)
        : {};
    const existingElevenlabs =
      existingTts.elevenlabs && typeof existingTts.elevenlabs === "object"
        ? (existingTts.elevenlabs as Record<string, unknown>)
        : {};

    messages.tts = {
      ...existingTts,
      provider: "elevenlabs",
      elevenlabs: {
        ...existingElevenlabs,
        voiceId,
        modelId:
          typeof existingElevenlabs.modelId === "string" &&
          existingElevenlabs.modelId.trim()
            ? existingElevenlabs.modelId.trim()
            : DEFAULT_ELEVENLABS_TTS_MODEL,
      },
    };
  }

  migrateLegacyRuntimeConfig(config as Record<string, unknown>);
  saveElizaConfig(config);
  return adminEntityId;
}

export function deriveFirstRunReplayBody(body: Record<string, unknown>): {
  isCloudMode: boolean;
  replayBody: Record<string, unknown>;
} {
  const explicitDeploymentTarget = normalizeDeploymentTargetConfig(
    body.deploymentTarget,
  );
  const explicitCredentialInputs = normalizeFirstRunCredentialInputs(
    body.credentialInputs,
  );
  const deploymentTarget: DeploymentTargetConfig | undefined =
    explicitDeploymentTarget ?? undefined;
  const linkedAccounts: LinkedAccountFlagsConfig | undefined =
    normalizeLinkedAccountFlagsConfig(body.linkedAccounts) ?? undefined;
  const serviceRouting: ServiceRoutingConfig | undefined =
    normalizeServiceRoutingConfig(body.serviceRouting) ?? undefined;
  const isCloudMode = deploymentTarget?.runtime === "cloud";

  const replayBody = { ...body };

  if (deploymentTarget) {
    replayBody.deploymentTarget = deploymentTarget;
  }
  if (linkedAccounts) {
    replayBody.linkedAccounts = linkedAccounts;
  }
  if (serviceRouting) {
    replayBody.serviceRouting = serviceRouting;
  }
  if (explicitCredentialInputs) {
    replayBody.credentialInputs = explicitCredentialInputs;
  }

  return { isCloudMode, replayBody };
}

/**
 * Check if this is a cloud-provisioned container.
 *
 * METADATA-ONLY. This function exists so routes like `/api/cloud/status` can
 * branch on cloud-provisioned shape. It does NOT authorise anything: callers
 * must still pass through `ensureCompatApiAuthorized` (bearer token) or
 * `ensureAuthSessionOrBootstrap`.
 */
export function isCloudProvisioned(): boolean {
  const hasCloudFlag = process.env.ELIZA_CLOUD_PROVISIONED === "1";

  const hasCloudApiKeyProvisioning =
    process.env.ELIZAOS_CLOUD_ENABLED === "true" &&
    Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim());

  const hasPlatformToken = Boolean(
    process.env.STEWARD_AGENT_TOKEN?.trim() ||
      getCompatApiToken() ||
      hasCloudApiKeyProvisioning,
  );

  return hasCloudFlag && hasPlatformToken;
}
