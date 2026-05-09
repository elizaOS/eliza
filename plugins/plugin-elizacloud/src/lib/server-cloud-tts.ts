/**
 * Cloud TTS helpers — proxy to Eliza Cloud (`elizacloud.ai`).
 *
 * Upstream routes (see eliza-cloud-v2): `POST /api/v1/voice/tts` and legacy
 * `POST /api/elevenlabs/tts`. Both accept `{ text, voiceId?, modelId? }` with
 * **ElevenLabs** voice and model ids; the cloud runs ElevenLabs server-side.
 */
import fs from "node:fs";
import type http from "node:http";
import { isElizaCloudServiceSelectedInConfig, sanitizeSpeechText } from "@elizaos/core";
import { getCloudSecret } from "./cloud-secrets";
import { resolveConfigPath } from "./state-paths";
import { ttsDebug, ttsDebugTextPreview } from "./tts-debug";

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

type ConfigLike = Record<string, unknown> & {
  cloud?: {
    apiKey?: unknown;
    baseUrl?: unknown;
  };
};

function loadElizaConfig(): ConfigLike {
  const raw = fs.readFileSync(resolveConfigPath(), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as ConfigLike)
    : {};
}

/** Browser → API correlation (never forwarded to Eliza Cloud). */
export function readTtsDebugClientHeaders(
  req: Pick<http.IncomingMessage, "headers">,
): {
  messageId?: string;
  clipSegment?: string;
  hearingFull?: string;
} {
  const pick = (name: string): string | undefined => {
    const raw = req.headers[name];
    if (raw == null) return undefined;
    const v = Array.isArray(raw) ? raw[0] : raw;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const decode = (enc: string | undefined): string | undefined => {
    if (!enc) return undefined;
    try {
      return decodeURIComponent(enc);
    } catch {
      return enc;
    }
  };
  return {
    messageId: decode(pick("x-elizaos-tts-message-id")),
    clipSegment: decode(pick("x-elizaos-tts-clip-segment")),
    hearingFull: decode(pick("x-elizaos-tts-full-preview")),
  };
}

function ttsClientDbgFields(
  hdr: ReturnType<typeof readTtsDebugClientHeaders>,
): Record<string, string> {
  const o: Record<string, string> = {};
  if (hdr.messageId) o.messageId = hdr.messageId;
  if (hdr.clipSegment) o.clipSegment = hdr.clipSegment;
  if (hdr.hearingFull) o.hearingFull = hdr.hearingFull;
  return o;
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

/** Edge / Azure neural ids (e.g. `en-US-AriaNeural`) are not ElevenLabs `voiceId`s. */
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

/**
 * Resolve `voiceId` for Eliza Cloud TTS (ElevenLabs ids). OpenAI-style names
 * in the request are replaced with the default premade voice.
 */
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

function pickBodyString(
  body: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  const a = body[camel];
  if (typeof a === "string" && a.trim()) return a;
  const b = body[snake];
  if (typeof b === "string" && b.trim()) return b;
  return undefined;
}

async function readRawRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function sendJsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendJsonErrorResponse(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJsonResponse(res, status, { error: message });
}

/**
 * After a non-OK upstream response, only try the next URL for likely-transient /
 * wrong-route issues. Avoid retrying 401/402/429 etc. so we do not double-charge TTS.
 */
export function shouldRetryCloudTtsUpstream(status: number): boolean {
  return status === 404 || status === 502 || status === 503;
}

function forwardCloudTtsUpstreamError(
  res: http.ServerResponse,
  status: number,
  bodyText: string,
): void {
  if (res.headersSent) return;
  const trimmed = bodyText.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      sendJsonResponse(res, status, parsed);
      return;
    } catch {
      /* fall through */
    }
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({ error: trimmed || "Eliza Cloud TTS request failed" }),
  );
}

/**
 * Coerce stored/configured values to an ElevenLabs model id Eliza Cloud accepts.
 * Maps OpenAI TTS ids and common copy-paste mistakes; passes through real `eleven_*` ids.
 */
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

/** Eliza Cloud TTS `modelId` (ElevenLabs), from body or env or default. */
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

// ---------------------------------------------------------------------------
// Exported Cloud TTS functions
// ---------------------------------------------------------------------------

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
    let path = parsed.pathname.replace(/\/+$/, "");
    if (!path || path === "/") {
      path = "/api/v1";
    }
    parsed.pathname = path;
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
      const path = u.pathname.replace(/\/+$/, "");
      if (path.endsWith("/api/v1")) {
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

export async function handleCloudTtsPreviewRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const clientTtsDbg = readTtsDebugClientHeaders(req);
  const dbgExtra = ttsClientDbgFields(clientTtsDbg);

  const cloudApiKey = resolveCloudApiKey();
  if (!cloudApiKey) {
    ttsDebug("server:cloud-tts:reject", {
      reason: "no_api_key",
      ...dbgExtra,
    });
    sendJsonErrorResponse(
      res,
      401,
      "Eliza Cloud is not connected. Connect your Eliza Cloud account first.",
    );
    return true;
  }

  const rawBody = await readRawRequestBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendJsonErrorResponse(res, 400, "Invalid JSON request body");
    return true;
  }

  const text = sanitizeSpeechText(
    typeof body.text === "string" ? body.text : "",
  );
  if (!text) {
    sendJsonErrorResponse(res, 400, "Missing text");
    return true;
  }

  if (text.length > ELIZA_CLOUD_TTS_MAX_TEXT_CHARS) {
    sendJsonErrorResponse(
      res,
      400,
      `Text too long. Maximum length is ${ELIZA_CLOUD_TTS_MAX_TEXT_CHARS} characters`,
    );
    return true;
  }

  const cloudModel = resolveCloudProxyTtsModel(
    pickBodyString(body, "modelId", "model_id"),
  );
  const cloudVoice = resolveElizaCloudTtsVoiceId(
    pickBodyString(body, "voiceId", "voice_id"),
  );
  const cloudUrls = resolveCloudTtsCandidateUrls();

  const ttsPreview = ttsDebugTextPreview(text);
  ttsDebug("server:cloud-tts:proxy", {
    textChars: text.length,
    preview: ttsPreview,
    modelId: cloudModel,
    voiceId: cloudVoice,
    urlCandidates: cloudUrls.length,
    ...dbgExtra,
  });

  try {
    let lastStatus = 0;
    let lastDetails = "unknown error";
    let cloudResponse: Response | null = null;
    for (let i = 0; i < cloudUrls.length; i++) {
      const cloudUrl = cloudUrls[i];
      if (cloudUrl === undefined) {
        continue;
      }
      const attempt = await fetch(cloudUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cloudApiKey}`,
          "x-api-key": cloudApiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          voiceId: cloudVoice,
          modelId: cloudModel,
        }),
      });

      if (attempt.ok) {
        cloudResponse = attempt;
        ttsDebug("server:cloud-tts:upstream-ok", {
          urlIndex: i,
          status: attempt.status,
          preview: ttsPreview,
          ...dbgExtra,
        });
        break;
      }

      lastStatus = attempt.status;
      lastDetails = await attempt.text().catch(() => "unknown error");
      ttsDebug("server:cloud-tts:upstream-retry", {
        urlIndex: i,
        status: attempt.status,
        preview: ttsPreview,
        ...dbgExtra,
      });

      const hasMoreCandidates = i < cloudUrls.length - 1;
      if (!hasMoreCandidates || !shouldRetryCloudTtsUpstream(attempt.status)) {
        break;
      }
    }
    if (!cloudResponse) {
      ttsDebug("server:cloud-tts:reject", {
        reason: "upstream_failed",
        lastStatus,
        preview: ttsPreview,
        ...dbgExtra,
      });
      if (
        lastStatus === 400 ||
        lastStatus === 401 ||
        lastStatus === 402 ||
        lastStatus === 403 ||
        lastStatus === 429
      ) {
        forwardCloudTtsUpstreamError(res, lastStatus, lastDetails);
        return true;
      }
      sendJsonErrorResponse(
        res,
        502,
        `Eliza Cloud TTS failed (${lastStatus || 502}): ${lastDetails}`,
      );
      return true;
    }

    const audioBuffer = Buffer.from(await cloudResponse.arrayBuffer());
    ttsDebug("server:cloud-tts:success", {
      bytes: audioBuffer.length,
      preview: ttsPreview,
      ...dbgExtra,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.end(audioBuffer);
    return true;
  } catch (err) {
    sendJsonErrorResponse(
      res,
      502,
      `Eliza Cloud TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

export function mirrorCompatHeaders(
  req: Pick<http.IncomingMessage, "headers">,
): void {
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
