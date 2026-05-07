/**
 * Config redaction, onboarding, and skill validation helpers extracted from server.ts.
 */

import type http from "node:http";
import path from "node:path";
import { logger } from "@elizaos/core";
import {
  getDefaultStylePreset,
  getStylePresets,
  normalizeCharacterLanguage,
  ONBOARDING_CLOUD_PROVIDER_OPTIONS,
  ONBOARDING_PROVIDER_CATALOG,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.js";
import { sendJsonError } from "./http-helpers.js";
import { generateWalletKeys, setSolanaWalletEnv } from "./wallet.js";

// ---------------------------------------------------------------------------
// Config redaction
// ---------------------------------------------------------------------------

/**
 * Key patterns that indicate a value is sensitive and must be redacted.
 */
export const SENSITIVE_KEY_RE =
  /password|secret|api.?key|private.?key|seed.?phrase|authorization|connection.?string|credential|(?<!max)tokens?$/i;

export function isBlockedObjectKey(key: string): boolean {
  return (
    key === "__proto__" ||
    key === "constructor" ||
    key === "prototype" ||
    key === "$include"
  );
}

function redactValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") return val.length > 0 ? "[REDACTED]" : "";
  if (typeof val === "number" || typeof val === "boolean") return "[REDACTED]";
  if (Array.isArray(val)) return val.map(redactValue);
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return "[REDACTED]";
}

export function redactDeep(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(redactDeep);
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = redactValue(child);
      } else {
        out[key] = redactDeep(child);
      }
    }
    return out;
  }
  return val;
}

export function redactConfigSecrets(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactDeep(config) as Record<string, unknown>;
}

export function isRedactedSecretValue(value: unknown): boolean {
  return (
    typeof value === "string" && value.trim().toUpperCase() === "[REDACTED]"
  );
}

/** Remove UI round-trip placeholders so GET /api/config -> PUT never persists "[REDACTED]". */
export function stripRedactedPlaceholderValuesDeep(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) {
      stripRedactedPlaceholderValuesDeep(item);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (isRedactedSecretValue(v)) {
      delete obj[key];
    } else if (v !== null && typeof v === "object") {
      stripRedactedPlaceholderValuesDeep(v);
    }
  }
}

// ---------------------------------------------------------------------------
// Skill-ID path-traversal guard
// ---------------------------------------------------------------------------

const SAFE_SKILL_ID_RE = /^[a-zA-Z0-9._-]+$/;

export function validateSkillId(
  skillId: string,
  res: http.ServerResponse,
): string | null {
  if (
    !skillId ||
    !SAFE_SKILL_ID_RE.test(skillId) ||
    skillId === "." ||
    skillId.includes("..")
  ) {
    const safeDisplay = skillId.slice(0, 80).replace(/[^\x20-\x7e]/g, "?");
    sendJsonError(res, `Invalid skill ID: "${safeDisplay}"`, 400);
    return null;
  }
  return skillId;
}

// ---------------------------------------------------------------------------
// Onboarding helpers
// ---------------------------------------------------------------------------

const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
const ELEVENLABS_VOICE_ID_BY_PRESET: Record<string, string> = {
  rachel: "21m00Tcm4TlvDq8ikWAM",
  sarah: "EXAVITQu4vr4xnSDxMaL",
  matilda: "XrExE9yKIg1WjnnlVkGX",
  lily: "pFZP5JQG7iQjIQuC4Bku",
  alice: "Xb7hH8MSUJpSbSDYk0k2",
  brian: "nPczCjzI2devNBz1zQrb",
  adam: "pNInz6obpgDQGcFmaJgB",
  josh: "TxGEqnHWrfWFTfGW9XjX",
  daniel: "onwK4e9ZLuTAKqWW03F9",
  liam: "TX3LPaxmHKxFdv7VOQHJ",
  gigi: "jBpfuIE2acCO8z3wKNLl",
  mimi: "zrHiDhphv9ZnVXBqCLjz",
  dorothy: "ThT5KcBeYPX3keUQqHPh",
  glinda: "z9fAnlkpzviPz146aGWa",
  charlotte: "XB0fDUnXU5powFXDhCwa",
  callum: "N2lVS1w4EtoT3dr4eOWO",
  momo: "n7Wi4g1bhpw4Bs8HK5ph",
  yuki: "4tRn1lSkEn13EVTuqb0g",
  rin: "cNYrMw9glwJZXR8RwbuR",
  kei: "eadgjmk4R4uojdsheG9t",
  jin: "6IwYbsNENZgAB1dtBZDp",
  satoshi: "7cOBG34AiHrAzs842Rdi",
  ryu: "QzTKubutNn9TjrB7Xb2Q",
};

export function readUiLanguageHeader(
  req: http.IncomingMessage | undefined,
): string | undefined {
  if (!req) {
    return undefined;
  }
  const header =
    req.headers["x-eliza-ui-language"] ?? req.headers["x-eliza-ui-language"];
  if (Array.isArray(header)) {
    return header.find((value) => value.trim())?.trim();
  }
  return typeof header === "string" && header.trim()
    ? header.trim()
    : undefined;
}

export function resolveConfiguredCharacterLanguage(
  config?: ElizaConfig,
  req?: http.IncomingMessage,
) {
  const uiLanguage =
    readUiLanguageHeader(req) ??
    ((config?.ui as { language?: unknown } | undefined)?.language as
      | string
      | undefined);
  return normalizeCharacterLanguage(uiLanguage);
}

export function resolveOnboardingStylePreset(
  body: Record<string, unknown>,
  language: string,
) {
  const presets = getStylePresets(language);
  const requestedPresetId =
    typeof body.presetId === "string" ? body.presetId.trim() : "";
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

  const requestedName = typeof body.name === "string" ? body.name.trim() : "";
  if (requestedName) {
    const byName = presets.find((preset) => preset.name === requestedName);
    if (byName) return byName;
  }

  return getDefaultStylePreset(language);
}

export function applyOnboardingVoicePreset(
  config: ElizaConfig,
  body: Record<string, unknown>,
  language: string,
) {
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!elevenLabsApiKey) {
    return;
  }

  const stylePreset = resolveOnboardingStylePreset(body, language);
  const voicePresetId = stylePreset?.voicePresetId?.trim();
  if (!voicePresetId) {
    return;
  }

  const voiceId = ELEVENLABS_VOICE_ID_BY_PRESET[voicePresetId];
  if (!voiceId) {
    return;
  }

  if (!config.messages || typeof config.messages !== "object") {
    config.messages = {};
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

export function resolveDefaultAgentName(
  config?: ElizaConfig,
  req?: http.IncomingMessage,
): string {
  const configuredName =
    config?.ui?.assistant?.name?.trim() ??
    config?.agents?.list?.[0]?.name?.trim();
  if (configuredName) {
    return configuredName;
  }

  return getDefaultStylePreset(resolveConfiguredCharacterLanguage(config, req))
    .name;
}

export function getProviderOptions(): Array<{
  id: string;
  name: string;
  envKey: string | null;
  pluginName: string;
  keyPrefix: string | null;
  description: string;
}> {
  return ONBOARDING_PROVIDER_CATALOG.map((provider) => ({
    id: provider.id,
    name: provider.name,
    envKey: provider.envKey,
    pluginName: provider.pluginName,
    keyPrefix: provider.keyPrefix,
    description: provider.description,
  }));
}

export function getCloudProviderOptions(): Array<{
  id: string;
  name: string;
  description: string;
}> {
  return ONBOARDING_CLOUD_PROVIDER_OPTIONS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    description: provider.description,
  }));
}

export function ensureWalletKeysInEnvAndConfig(config: ElizaConfig): boolean {
  const missingEvm =
    typeof process.env.EVM_PRIVATE_KEY !== "string" ||
    !process.env.EVM_PRIVATE_KEY.trim();
  const missingSolana =
    typeof process.env.SOLANA_PRIVATE_KEY !== "string" ||
    !process.env.SOLANA_PRIVATE_KEY.trim();

  if (!missingEvm && !missingSolana) {
    return false;
  }

  try {
    const walletKeys = generateWalletKeys();
    if (
      !config.env ||
      typeof config.env !== "object" ||
      Array.isArray(config.env)
    ) {
      config.env = {};
    }
    const envConfig = config.env as Record<string, string>;

    if (missingEvm) {
      envConfig.EVM_PRIVATE_KEY = walletKeys.evmPrivateKey;
      process.env.EVM_PRIVATE_KEY = walletKeys.evmPrivateKey;
      logger.info(`[eliza-api] Generated EVM wallet: ${walletKeys.evmAddress}`);
    }

    if (missingSolana) {
      envConfig.SOLANA_PRIVATE_KEY = walletKeys.solanaPrivateKey;
      setSolanaWalletEnv(walletKeys.solanaPrivateKey);
      logger.info(
        `[eliza-api] Generated Solana wallet: ${walletKeys.solanaAddress}`,
      );
    }

    return true;
  } catch (err) {
    logger.warn(
      `[eliza-api] Failed to generate wallet keys: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// State dir safety
// ---------------------------------------------------------------------------

const RESET_STATE_ALLOWED_SEGMENTS = new Set([
  ".eliza",
  "eliza",
  ".eliza",
  "eliza",
]);

function hasAllowedResetSegment(resolvedState: string): boolean {
  return resolvedState
    .split(path.sep)
    .some((segment) =>
      RESET_STATE_ALLOWED_SEGMENTS.has(segment.trim().toLowerCase()),
    );
}

export function isSafeResetStateDir(
  resolvedState: string,
  homeDir: string,
): boolean {
  const normalizedState = path.resolve(resolvedState);
  const normalizedHome = path.resolve(homeDir);
  const parsedRoot = path.parse(normalizedState).root;

  if (normalizedState === parsedRoot) return false;
  if (normalizedState === normalizedHome) return false;

  const relativeToHome = path.relative(normalizedHome, normalizedState);
  const isUnderHome =
    relativeToHome.length > 0 &&
    !relativeToHome.startsWith("..") &&
    !path.isAbsolute(relativeToHome);
  if (!isUnderHome) return false;

  return hasAllowedResetSegment(normalizedState);
}
