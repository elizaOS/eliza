/**
 * Onboarding compat helpers — API key persistence, onboarding defaults,
 * cloud-mode detection, and cloud-provisioned container detection.
 */

import {
  applyOnboardingCredentialPersistence,
  loadElizaConfig,
  saveElizaConfig,
} from "@elizaos/agent";
import { logger, stringToUuid } from "@elizaos/core";
import {
  type DeploymentTargetConfig,
  deriveOnboardingCredentialPersistencePlan,
  getDefaultStylePreset,
  getStylePresets,
  type LinkedAccountFlagsConfig,
  migrateLegacyRuntimeConfig,
  normalizeCharacterLanguage,
  normalizeDeploymentTargetConfig,
  normalizeLinkedAccountFlagsConfig,
  normalizeOnboardingCredentialInputs,
  normalizeServiceRoutingConfig,
  type ServiceRoutingConfig,
} from "@elizaos/shared";
import { PREMADE_VOICES } from "/ui";
import { resolveProviderCredential } from "./credential-resolver";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the API token using app-first priority. */
function getCompatApiToken(): string | null {
  const token = process.env.ELIZA_API_TOKEN?.trim();
  return token ? token : null;
}

// ---------------------------------------------------------------------------
// Onboarding API key persistence
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

function resolveCompatOnboardingStyle(
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

const LEGACY_ONBOARDING_REQUEST_KEYS = [
  "connection",
  "runMode",
  "cloudProvider",
  "provider",
  "providerApiKey",
  "primaryModel",
  "smallModel",
  "largeModel",
] as const;

export function hasLegacyOnboardingRequestFields(
  body: Record<string, unknown>,
): boolean {
  return LEGACY_ONBOARDING_REQUEST_KEYS.some((key) => Object.hasOwn(body, key));
}

/**
 * Extract canonical onboarding credential inputs from an onboarding request body
 * and persist them to config + process.env. Returns the env key name if a local
 * provider API key was persisted, or null.
 */
export async function extractAndPersistOnboardingApiKey(
  body: Record<string, unknown>,
): Promise<string | null> {
  const credentialInputs = normalizeOnboardingCredentialInputs(
    body.credentialInputs,
  );
  const explicitDeploymentTarget = normalizeDeploymentTargetConfig(
    body.deploymentTarget,
  );
  const explicitServiceRouting = normalizeServiceRoutingConfig(
    body.serviceRouting,
  );
  logger.info(
    `[onboarding] extractAndPersistOnboardingApiKey: credentialInputs=${credentialInputs ? "present" : "missing"}, keys=${Object.keys(body).join(",")}`,
  );
  const initialPlan = deriveOnboardingCredentialPersistencePlan({
    credentialInputs,
    deploymentTarget: explicitDeploymentTarget,
    serviceRouting: explicitServiceRouting,
  });
  let effectiveCredentialInputs = credentialInputs;
  let effectiveServiceRouting = explicitServiceRouting;
  let llmSelection = initialPlan.llmSelection;

  if (!llmSelection && !initialPlan.cloudApiKey) {
    logger.warn(
      "[onboarding] No onboarding credentials resolved from request body",
    );
    return null;
  }
  logger.info(
    `[onboarding] Resolved selection: transport=${llmSelection?.transport ?? "none"}, provider=${llmSelection?.backend ?? "N/A"}, hasKey=${Boolean(llmSelection?.apiKey)}, hasCloudKey=${Boolean(initialPlan.cloudApiKey)}`,
  );

  // If the key is masked (from IPC) or missing, try to resolve the real
  // key from local credential stores (files, keychain, env).
  if (
    llmSelection?.transport === "direct" &&
    llmSelection.backend !== "elizacloud" &&
    !llmSelection.apiKey?.startsWith("****")
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
        `[onboarding] Using subscription auth for ${resolved.providerId}`,
      );
    } else if (resolved) {
      effectiveCredentialInputs = {
        ...(effectiveCredentialInputs ?? {}),
        llmApiKey: resolved.apiKey,
      };
      logger.info(
        `[onboarding] Resolved real key for ${llmSelection.backend} via credential-resolver`,
      );
    } else if (!llmSelection.apiKey) {
      logger.warn(
        `[onboarding] No key found for ${llmSelection.backend} — cannot persist`,
      );
      return null;
    }

    llmSelection = deriveOnboardingCredentialPersistencePlan({
      credentialInputs: effectiveCredentialInputs,
      deploymentTarget: explicitDeploymentTarget,
      serviceRouting: effectiveServiceRouting,
    }).llmSelection;
  }

  const config = loadElizaConfig();
  const result = await applyOnboardingCredentialPersistence(config, {
    credentialInputs: effectiveCredentialInputs,
    deploymentTarget: explicitDeploymentTarget,
    serviceRouting: effectiveServiceRouting,
  });
  saveElizaConfig(config);

  if (result) {
    logger.info(`[onboarding] Persisted ${result} from onboarding credentials`);
  }
  return result;
}

export function persistCompatOnboardingDefaults(
  body: Record<string, unknown>,
): string | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return null;
  }

  const config = loadElizaConfig();
  const language = normalizeCharacterLanguage(body.language);
  const stylePreset = resolveCompatOnboardingStyle(body, language);
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
  } else if (typeof stylePreset?.avatarIndex === "number") {
    ui.avatarIndex = stylePreset.avatarIndex;
  }
  if (trimToUndefined(body.presetId)) {
    ui.presetId = trimToUndefined(body.presetId);
  } else if (stylePreset?.id) {
    ui.presetId = stylePreset.id;
  }

  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voicePresetId = stylePreset?.voicePresetId?.trim();
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

export function deriveCompatOnboardingReplayBody(
  body: Record<string, unknown>,
): {
  isCloudMode: boolean;
  replayBody: Record<string, unknown>;
} {
  const explicitDeploymentTarget = normalizeDeploymentTargetConfig(
    body.deploymentTarget,
  );
  const explicitCredentialInputs = normalizeOnboardingCredentialInputs(
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
  for (const key of LEGACY_ONBOARDING_REQUEST_KEYS) {
    delete replayBody[key];
  }

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
 * METADATA-ONLY as of P0 of the remote-auth hardening. This function now
 * exists strictly so unrelated routes (e.g. `/api/cloud/status`) can branch
 * on cloud-provisioned shape. It does NOT authorise anything: callers must
 * still pass through `ensureCompatApiAuthorized` (bearer token) or — once
 * the dashboard mints sessions — `ensureAuthSessionOrBootstrap`. The
 * audited bypasses at `auth-pairing-compat-routes.ts:124,140` and the
 * onboarding-skip used to read this; both have been removed.
 *
 * See `docs/security/remote-auth-hardening-plan.md` §3.4.
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
