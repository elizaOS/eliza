/**
 * Config redaction, first-run, and skill validation helpers extracted from server.ts.
 */

import type http from "node:http";
import path from "node:path";
import { ElizaError, logger, sendJsonError } from "@elizaos/core";
import {
  getDefaultStylePreset,
  getStylePresets,
  normalizeCharacterLanguage,
} from "@elizaos/shared/character-presets";
import {
  FIRST_RUN_CLOUD_PROVIDER_OPTIONS,
  FIRST_RUN_PROVIDER_CATALOG,
} from "@elizaos/shared/contracts/first-run-options";
import type { ElizaConfig } from "../config/config.ts";
import { isSensitiveConfigKey } from "../config/sensitive-keys.ts";
import { generateWalletKeys, setSolanaWalletEnv } from "./wallet-keygen.ts";

// ---------------------------------------------------------------------------
// Config redaction
// ---------------------------------------------------------------------------

export { isBlockedObjectKey } from "./blocked-object-keys.ts";

/** Honest GET /api/config and /api/connectors payloads are a handful of objects deep. */
export const MAX_CONFIG_SECRET_FILTER_DEPTH = 32;
/**
 * Node ceiling across the whole redaction / placeholder-strip walk, including
 * sparse array holes. Well above an ordinary character/config document; bounds
 * synthetic graphs that would otherwise RangeError or hang the authorized
 * config and connector routes.
 */
export const MAX_CONFIG_SECRET_FILTER_NODES = 100_000;
export const CONFIG_SECRET_FILTER_UNBOUNDED = "CONFIG_SECRET_FILTER_UNBOUNDED";

type FilterWalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failConfigSecretFilterUnbounded(
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new ElizaError(
    "Config response exceeds the secret-key filter walk budget",
    {
      code: CONFIG_SECRET_FILTER_UNBOUNDED,
      context,
      cause,
      severity: "fatal",
    },
  );
}

function reserveFilterVisits(ctx: FilterWalkContext, count: number): void {
  if (count > MAX_CONFIG_SECRET_FILTER_NODES - ctx.visits) {
    failConfigSecretFilterUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_CONFIG_SECRET_FILTER_NODES,
    });
  }
  ctx.visits += count;
}

function enterFilterContainer(value: object, ctx: FilterWalkContext): void {
  if (ctx.visiting.has(value)) {
    failConfigSecretFilterUnbounded({ cycle: true });
  }
  ctx.visiting.add(value);
}

function inspectFilter<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J2 Proxy inspection failures wrap with cause as unbounded.
    failConfigSecretFilterUnbounded({ inspection: operation }, cause);
  }
}

function ownEnumerableStringKeys(value: object): string[] {
  const keys: string[] = [];
  for (const key of inspectFilter("ownKeys", () => Reflect.ownKeys(value))) {
    if (typeof key !== "string") continue;
    const descriptor = inspectFilter("getOwnPropertyDescriptor", () =>
      Object.getOwnPropertyDescriptor(value, key),
    );
    if (!descriptor?.enumerable) continue;
    keys.push(key);
  }
  return keys;
}

function ownValueDescriptor(
  value: object,
  key: string,
): PropertyDescriptor | undefined {
  const descriptor = inspectFilter("getOwnPropertyDescriptor", () =>
    Object.getOwnPropertyDescriptor(value, key),
  );
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    failConfigSecretFilterUnbounded({ accessor: true, key });
  }
  return descriptor;
}

function ownArrayLength(value: unknown[]): number {
  const descriptor = ownValueDescriptor(value, "length");
  if (
    !descriptor ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0
  ) {
    failConfigSecretFilterUnbounded({ invalidArrayLength: true });
  }
  return descriptor.value;
}

function newFilterWalkContext(): FilterWalkContext {
  return { visits: 0, visiting: new WeakSet<object>() };
}

function redactLeaf(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 0 ? "[REDACTED]" : "";
  if (typeof value === "number" || typeof value === "boolean") {
    return "[REDACTED]";
  }
  return "[REDACTED]";
}

function walkConfigSecretFilter(
  value: unknown,
  depth: number,
  ctx: FilterWalkContext,
  redactAll: boolean,
  visitAlreadyReserved = false,
): unknown {
  if (depth > MAX_CONFIG_SECRET_FILTER_DEPTH) {
    failConfigSecretFilterUnbounded({
      depth,
      max: MAX_CONFIG_SECRET_FILTER_DEPTH,
    });
  }
  if (!visitAlreadyReserved) reserveFilterVisits(ctx, 1);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") {
    return redactAll ? redactLeaf(value) : value;
  }

  enterFilterContainer(value, ctx);
  try {
    if (Array.isArray(value)) {
      const length = ownArrayLength(value);
      reserveFilterVisits(ctx, length);
      const next: unknown[] = [];
      next.length = length;
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownValueDescriptor(value, String(index));
        if (!descriptor) continue;
        next[index] = walkConfigSecretFilter(
          descriptor.value,
          depth + 1,
          ctx,
          redactAll,
          true,
        );
      }
      return next;
    }

    const keys = ownEnumerableStringKeys(value);
    reserveFilterVisits(ctx, keys.length);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = ownValueDescriptor(value, key);
      if (!descriptor) continue;
      const childRedactAll = redactAll || isSensitiveConfigKey(key);
      out[key] = walkConfigSecretFilter(
        descriptor.value,
        depth + 1,
        ctx,
        childRedactAll,
        true,
      );
    }
    return out;
  } finally {
    ctx.visiting.delete(value);
  }
}

export function redactDeep(val: unknown): unknown {
  return walkConfigSecretFilter(val, 0, newFilterWalkContext(), false);
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

function walkStripRedactedPlaceholders(
  value: unknown,
  depth: number,
  ctx: FilterWalkContext,
  visitAlreadyReserved = false,
): void {
  if (depth > MAX_CONFIG_SECRET_FILTER_DEPTH) {
    failConfigSecretFilterUnbounded({
      depth,
      max: MAX_CONFIG_SECRET_FILTER_DEPTH,
      strip: true,
    });
  }
  if (!visitAlreadyReserved) reserveFilterVisits(ctx, 1);
  if (value === null || typeof value !== "object") return;

  enterFilterContainer(value, ctx);
  try {
    if (Array.isArray(value)) {
      const length = ownArrayLength(value);
      reserveFilterVisits(ctx, length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownValueDescriptor(value, String(index));
        if (!descriptor) continue;
        walkStripRedactedPlaceholders(descriptor.value, depth + 1, ctx, true);
      }
      return;
    }

    const keys = ownEnumerableStringKeys(value);
    reserveFilterVisits(ctx, keys.length);
    const obj = value as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = ownValueDescriptor(value, key);
      if (!descriptor) continue;
      if (isRedactedSecretValue(descriptor.value)) {
        delete obj[key];
      } else if (
        descriptor.value !== null &&
        typeof descriptor.value === "object"
      ) {
        walkStripRedactedPlaceholders(descriptor.value, depth + 1, ctx, true);
      }
    }
  } finally {
    ctx.visiting.delete(value);
  }
}

/** Remove UI round-trip placeholders so GET /api/config -> PUT never persists "[REDACTED]". */
export function stripRedactedPlaceholderValuesDeep(value: unknown): void {
  walkStripRedactedPlaceholders(value, 0, newFilterWalkContext());
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
// First-run helpers
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

export function resolveFirstRunStylePreset(
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

export function applyFirstRunVoicePreset(
  config: ElizaConfig,
  body: Record<string, unknown>,
  language: string,
) {
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!elevenLabsApiKey) {
    return;
  }

  const stylePreset = resolveFirstRunStylePreset(body, language);
  const voicePresetId = stylePreset.voicePresetId.trim();
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
  return FIRST_RUN_PROVIDER_CATALOG.map((provider) => ({
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
  return FIRST_RUN_CLOUD_PROVIDER_OPTIONS.map((provider) => ({
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

const RESET_STATE_ALLOWED_SEGMENTS = new Set(["eliza"]);

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
