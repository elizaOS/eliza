/**
 * Cloud TTS helpers — proxy to Eliza Cloud (`elizacloud.ai`).
 *
 * Upstream routes (see eliza-cloud-v2): `POST /api/v1/voice/tts` and legacy
 * `POST /api/elevenlabs/tts`. Both accept `{ text, voiceId?, modelId? }` with
 * **ElevenLabs** voice and model ids; the cloud runs ElevenLabs server-side.
 *
 * Pure / config-driven helpers live here so consumers in app-core and the
 * agent can resolve cloud TTS configuration without importing the
 * `@elizaos/plugin-elizacloud` package (reverse-dep boundary). The full
 * upstream proxy request handler (`handleCloudTtsPreviewRoute`) stays in the
 * plugin because it ties together the agent runtime route surface.
 */
import fs from "node:fs";
import path from "node:path";
import {
  getElizaNamespace,
  resolveStateDir,
  resolveUserPath,
} from "@elizaos/core";
import { isElizaCloudServiceSelectedInConfig } from "../contracts/cloud-topology.js";
import { getCloudSecret } from "./cloud-secrets.js";

// Re-import retained here (no module-level side-effects) so the tts-debug helpers
// shipped in `utils/tts-debug` remain the single source of truth.
// Consumers that want to log should import them via the package barrel.

type ConfigLike = Record<string, unknown> & {
  cloud?: {
    apiKey?: unknown;
    baseUrl?: unknown;
  };
};

function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDirPath: string = resolveStateDir(env),
): string {
  const override = env.ELIZA_CONFIG_PATH?.trim();
  if (override) return resolveUserPath(override);

  const namespace = getElizaNamespace(env);
  const primaryPath = path.join(stateDirPath, `${namespace}.json`);
  if (fs.existsSync(primaryPath)) return primaryPath;

  if (namespace !== "eliza") {
    const legacyPath = path.join(stateDirPath, "eliza.json");
    if (fs.existsSync(legacyPath)) return legacyPath;
  }

  return primaryPath;
}

function loadElizaConfig(): ConfigLike {
  const raw = fs.readFileSync(resolveConfigPath(), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as ConfigLike)
    : {};
}

function normalizeSecretEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (
    trimmed === "REDACTED" ||
    trimmed === "[REDACTED]" ||
    /^\*+$/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function resolveCloudApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const envKey = normalizeSecretEnvValue(env.ELIZAOS_CLOUD_API_KEY);
  if (envKey) {
    return envKey;
  }

  try {
    const config = loadElizaConfig();
    const configKey = normalizeSecretEnvValue(
      typeof config.cloud?.apiKey === "string"
        ? config.cloud.apiKey
        : undefined,
    );
    if (configKey) {
      return configKey;
    }
  } catch {
    // ignore config load errors and continue with secret store fallback
  }

  const sealedKey = normalizeSecretEnvValue(
    getCloudSecret("ELIZAOS_CLOUD_API_KEY"),
  );
  if (sealedKey) {
    return sealedKey;
  }

  return null;
}

let cachedCloudBaseUrlFromConfig: string | null | undefined;
let hasResolvedCloudBaseUrlFromConfig = false;

export function __resetCloudBaseUrlCache(): void {
  cachedCloudBaseUrlFromConfig = undefined;
  hasResolvedCloudBaseUrlFromConfig = false;
}

function resolveCloudBaseUrlFromConfig(): string | null {
  if (hasResolvedCloudBaseUrlFromConfig) {
    return cachedCloudBaseUrlFromConfig ?? null;
  }

  try {
    const config = loadElizaConfig();
    const raw =
      typeof config.cloud?.baseUrl === "string"
        ? config.cloud.baseUrl.trim()
        : "";
    cachedCloudBaseUrlFromConfig = raw.length > 0 ? raw : null;
    hasResolvedCloudBaseUrlFromConfig = true;
    return cachedCloudBaseUrlFromConfig;
  } catch {
    // On failure, remember that we attempted resolution to avoid repeated I/O.
    cachedCloudBaseUrlFromConfig = null;
    hasResolvedCloudBaseUrlFromConfig = true;
    return null;
  }
}

export function resolveElevenLabsApiKeyForCloudMode(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const directKey = normalizeSecretEnvValue(env.ELEVENLABS_API_KEY);
  if (directKey) {
    return directKey;
  }
  let configWantsCloudTts = false;
  try {
    configWantsCloudTts = isElizaCloudServiceSelectedInConfig(
      loadElizaConfig() as Record<string, unknown>,
      "tts",
    );
  } catch {
    configWantsCloudTts = false;
  }
  const cloudTtsEnabled =
    env.ELIZAOS_CLOUD_USE_TTS === "true" ||
    (env.ELIZAOS_CLOUD_USE_TTS === undefined && configWantsCloudTts);
  if (!cloudTtsEnabled) {
    return null;
  }
  if (env.ELIZA_CLOUD_TTS_DISABLED === "true") {
    return null;
  }
  return resolveCloudApiKey(env);
}

export function ensureCloudTtsApiKeyAlias(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const directKey = normalizeSecretEnvValue(env.ELEVENLABS_API_KEY);
  if (directKey) {
    return false;
  }
  const cloudBackedKey = resolveElevenLabsApiKeyForCloudMode(env);
  if (!cloudBackedKey) {
    return false;
  }
  env.ELEVENLABS_API_KEY = cloudBackedKey;
  return true;
}

export function resolveCloudTtsBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.ELIZAOS_CLOUD_BASE_URL?.trim() ?? "";
  const fromConfig =
    fromEnv.length > 0 ? null : resolveCloudBaseUrlFromConfig();
  const configured = fromEnv.length > 0 ? fromEnv : (fromConfig?.trim() ?? "");
  const fallback = "https://www.elizacloud.ai/api/v1";
  const base = configured.length > 0 ? configured : fallback;

  try {
    const parsed = new URL(base);
    let pathName = parsed.pathname.replace(/\/+$/, "");
    if (!pathName || pathName === "/") {
      pathName = "/api/v1";
    }
    parsed.pathname = pathName;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

export function resolveCloudTtsCandidateUrls(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const base = resolveCloudTtsBaseUrl(env).replace(/\/+$/, "");
  const candidates = new Set<string>();

  const addEndpointsForApiV1Base = (baseUrl: string): void => {
    const trimmed = baseUrl.replace(/\/+$/, "");
    candidates.add(`${trimmed}/voice/tts`);
    try {
      const u = new URL(trimmed);
      const pathName = u.pathname.replace(/\/+$/, "");
      if (pathName.endsWith("/api/v1")) {
        // Preserve the ElevenLabs-shaped compat route; `/audio/speech` would
        // require OpenAI-style model/voice ids and is intentionally not used.
        candidates.add(`${u.origin}/api/elevenlabs/tts`);
      }
    } catch {
      /* ignore */
    }
  };

  addEndpointsForApiV1Base(base);
  try {
    const parsed = new URL(base);
    if (parsed.hostname.startsWith("www.")) {
      parsed.hostname = parsed.hostname.slice(4);
      addEndpointsForApiV1Base(parsed.toString().replace(/\/$/, ""));
    } else {
      parsed.hostname = `www.${parsed.hostname}`;
      addEndpointsForApiV1Base(parsed.toString().replace(/\/$/, ""));
    }
  } catch {
    // no-op
  }

  return [...candidates];
}

/**
 * After a non-OK upstream response, only try the next URL for likely-transient /
 * wrong-route issues. Avoid retrying 401/402/429 etc. so we do not double-charge TTS.
 */
export function shouldRetryCloudTtsUpstream(status: number): boolean {
  return status === 404 || status === 502 || status === 503;
}

/** OpenAI-style names — not valid ElevenLabs `voiceId`; map to default voice. */
const OPENAI_STYLE_VOICE_ALIASES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "nova",
  "sage",
  "shimmer",
  "verse",
]);

/** Eliza Cloud default premade voice (matches eliza-cloud-v2 ElevenLabs service). */
const DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
const DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID = "eleven_flash_v2_5";

/** Matches `MAX_TEXT_LENGTH` in eliza-cloud-v2 `app/api/v1/voice/tts/route.ts`. */
export const ELIZA_CLOUD_TTS_MAX_TEXT_CHARS = 5000;

function isLikelyEdgeOrAzureNeuralVoiceId(raw: string): boolean {
  const t = raw.trim();
  return /^[a-z]{2}-[A-Z]{2}-/i.test(t) && /Neural$/i.test(t);
}

function normalizeElizaCloudVoiceId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID;
  const lower = trimmed.toLowerCase();
  if (OPENAI_STYLE_VOICE_ALIASES.has(lower)) {
    return DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID;
  }
  if (isLikelyEdgeOrAzureNeuralVoiceId(trimmed)) {
    return DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID;
  }
  return trimmed;
}

export function resolveElizaCloudTtsVoiceId(
  bodyVoiceId: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof bodyVoiceId === "string" && bodyVoiceId.trim()) {
    return normalizeElizaCloudVoiceId(bodyVoiceId);
  }
  const envVoice = env.ELIZAOS_CLOUD_TTS_VOICE?.trim() ?? "";
  if (envVoice) {
    return normalizeElizaCloudVoiceId(envVoice);
  }
  return DEFAULT_ELIZA_CLOUD_TTS_VOICE_ID;
}

export function normalizeElizaCloudTtsModelId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
  const lower = trimmed.toLowerCase();
  if (OPENAI_STYLE_VOICE_ALIASES.has(lower)) {
    return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
  }
  if (/^gpt-/i.test(trimmed)) {
    return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
  }
  if (/^tts-1/i.test(trimmed)) {
    return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
  }
  if (/mini-tts/i.test(trimmed)) {
    return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
  }
  return trimmed;
}

export function resolveCloudProxyTtsModel(
  bodyModel: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envModel = env.ELIZAOS_CLOUD_TTS_MODEL?.trim() ?? "";
  const raw =
    typeof bodyModel === "string" && bodyModel.trim() ? bodyModel.trim() : "";
  const chosen = raw || envModel;
  if (!chosen) return DEFAULT_ELIZA_CLOUD_TTS_MODEL_ID;
  return normalizeElizaCloudTtsModelId(chosen);
}

export function mirrorCompatHeaders(req: {
  headers: Record<string, string | string[] | undefined>;
}): void {
  const HEADER_ALIASES = [
    ["x-elizaos-token", "x-eliza-token"],
    ["x-elizaos-export-token", "x-eliza-export-token"],
    ["x-elizaos-client-id", "x-eliza-client-id"],
    ["x-elizaos-terminal-token", "x-eliza-terminal-token"],
    ["x-elizaos-ui-language", "x-eliza-ui-language"],
    ["x-elizaos-agent-action", "x-eliza-agent-action"],
  ] as const;

  for (const [appHeader, elizaHeader] of HEADER_ALIASES) {
    const appValue = req.headers[appHeader];
    const elizaValue = req.headers[elizaHeader];

    if (appValue != null && elizaValue == null) {
      req.headers[elizaHeader] = appValue;
    }

    if (elizaValue != null && appValue == null) {
      req.headers[appHeader] = elizaValue;
    }
  }
}

/** Internal: expose the resolved cloud API key for the route handler that lives in plugin-elizacloud. */
export function _internalResolveCloudApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveCloudApiKey(env);
}
