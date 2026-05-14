import type http from "node:http";
import {
  type IAgentRuntime,
  ModelType,
  type ReadJsonBodyOptions,
  sanitizeSpeechText,
} from "@elizaos/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TtsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: { config: Record<string, unknown>; runtime?: IAgentRuntime | null };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  isRedactedSecretValue: (value: unknown) => boolean;
  fetchWithTimeoutGuard: (
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ) => Promise<Response>;
  streamResponseBodyWithByteLimit: (
    upstream: Response,
    res: http.ServerResponse,
    maxBytes: number,
    timeoutMs: number,
  ) => Promise<void>;
  responseContentLength: (headers: Pick<Headers, "get">) => number | null;
  isAbortError: (error: unknown) => boolean;
  ELEVENLABS_FETCH_TIMEOUT_MS: number;
  ELEVENLABS_AUDIO_MAX_BYTES: number;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleTtsRoutes(ctx: TtsRouteContext): Promise<boolean> {
  const { req, res, method, pathname, state, json, error, readJsonBody } = ctx;

  // ── GET /api/tts/config ───────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/tts/config") {
    const messages =
      state.config && typeof state.config === "object"
        ? ((state.config as Record<string, unknown>).messages as
            | Record<string, unknown>
            | undefined)
        : undefined;
    const tts =
      messages && typeof messages === "object"
        ? ((messages.tts as Record<string, unknown>) ?? undefined)
        : undefined;

    const elevenlabs =
      tts && typeof tts === "object"
        ? ((tts.elevenlabs as Record<string, unknown>) ?? undefined)
        : undefined;
    const edge =
      tts && typeof tts === "object"
        ? ((tts.edge as Record<string, unknown>) ?? undefined)
        : undefined;
    const openai =
      tts && typeof tts === "object"
        ? ((tts.openai as Record<string, unknown>) ?? undefined)
        : undefined;

    json(res, {
      provider: typeof tts?.provider === "string" ? tts.provider : undefined,
      mode: typeof tts?.mode === "string" ? tts.mode : undefined,
      auto: typeof tts?.auto === "string" ? tts.auto : undefined,
      enabled: tts?.enabled === true,
      elevenlabs: elevenlabs
        ? {
            apiKey:
              typeof elevenlabs.apiKey === "string" &&
              elevenlabs.apiKey.trim() &&
              !ctx.isRedactedSecretValue(elevenlabs.apiKey)
                ? "[REDACTED]"
                : undefined,
            voiceId:
              typeof elevenlabs.voiceId === "string"
                ? elevenlabs.voiceId
                : undefined,
            modelId:
              typeof elevenlabs.modelId === "string"
                ? elevenlabs.modelId
                : undefined,
            stability:
              typeof (
                elevenlabs.voiceSettings as Record<string, unknown> | undefined
              )?.stability === "number"
                ? ((elevenlabs.voiceSettings as Record<string, unknown>)
                    .stability as number)
                : undefined,
            similarityBoost:
              typeof (
                elevenlabs.voiceSettings as Record<string, unknown> | undefined
              )?.similarityBoost === "number"
                ? ((elevenlabs.voiceSettings as Record<string, unknown>)
                    .similarityBoost as number)
                : undefined,
            speed:
              typeof (
                elevenlabs.voiceSettings as Record<string, unknown> | undefined
              )?.speed === "number"
                ? ((elevenlabs.voiceSettings as Record<string, unknown>)
                    .speed as number)
                : undefined,
          }
        : undefined,
      edge: edge
        ? {
            voice: typeof edge.voice === "string" ? edge.voice : undefined,
            lang: typeof edge.lang === "string" ? edge.lang : undefined,
            rate: typeof edge.rate === "string" ? edge.rate : undefined,
            pitch: typeof edge.pitch === "string" ? edge.pitch : undefined,
            volume: typeof edge.volume === "string" ? edge.volume : undefined,
          }
        : undefined,
      openai: openai
        ? {
            apiKey:
              typeof openai.apiKey === "string" &&
              openai.apiKey.trim() &&
              !ctx.isRedactedSecretValue(openai.apiKey)
                ? "[REDACTED]"
                : undefined,
            model: typeof openai.model === "string" ? openai.model : undefined,
            voice: typeof openai.voice === "string" ? openai.voice : undefined,
          }
        : undefined,
    });
    return true;
  }

  // ── POST /api/tts/local-inference ──────────────────────────────────────
  if (method === "POST" && pathname === "/api/tts/local-inference") {
    const body = await readJsonBody<{ text?: string }>(req, res);
    if (!body) return true;

    const text =
      typeof body.text === "string"
        ? sanitizeLocalInferenceSpeechText(body.text)
        : "";
    if (!text) {
      error(res, "Missing text", 400);
      return true;
    }

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Local inference TEXT_TO_SPEECH is not available", 503);
      return true;
    }

    try {
      const audio = await useLocalInferenceTts(runtime, text);
      const bytes = normalizeAudioBytes(audio);
      if (bytes.length === 0) {
        error(res, "Local inference TEXT_TO_SPEECH returned empty audio", 502);
        return true;
      }
      res.writeHead(200, {
        "Content-Type": sniffAudioContentType(bytes),
        "Cache-Control": "no-store",
        "Content-Length": String(bytes.byteLength),
      });
      res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return true;
    } catch (err) {
      error(
        res,
        `Local inference TTS error: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
      return true;
    }
  }

  // ── POST /api/tts/elevenlabs ─────────────────────────────────────────
  if (method === "POST" && pathname === "/api/tts/elevenlabs") {
    const body = await readJsonBody<{
      text?: string;
      voiceId?: string;
      modelId?: string;
      outputFormat?: string;
      apiKey?: string;
      apply_text_normalization?: "auto" | "on" | "off";
      voice_settings?: {
        stability?: number;
        similarity_boost?: number;
        speed?: number;
      };
    }>(req, res);
    if (!body) return true;

    const text =
      typeof body.text === "string" ? sanitizeSpeechText(body.text) : "";
    if (!text) {
      error(res, "Missing text", 400);
      return true;
    }

    const messages =
      state.config && typeof state.config === "object"
        ? ((state.config as Record<string, unknown>).messages as
            | Record<string, unknown>
            | undefined)
        : undefined;
    const tts =
      messages && typeof messages === "object"
        ? ((messages.tts as Record<string, unknown>) ?? undefined)
        : undefined;
    const eleven =
      tts && typeof tts === "object"
        ? ((tts.elevenlabs as Record<string, unknown>) ?? undefined)
        : undefined;

    const requestedApiKey =
      typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const configuredApiKey =
      typeof eleven?.apiKey === "string" ? eleven.apiKey.trim() : "";
    const envApiKey =
      typeof process.env.ELEVENLABS_API_KEY === "string"
        ? process.env.ELEVENLABS_API_KEY.trim()
        : "";

    const resolvedApiKey =
      requestedApiKey && !ctx.isRedactedSecretValue(requestedApiKey)
        ? requestedApiKey
        : configuredApiKey && !ctx.isRedactedSecretValue(configuredApiKey)
          ? configuredApiKey
          : envApiKey && !ctx.isRedactedSecretValue(envApiKey)
            ? envApiKey
            : "";

    if (!resolvedApiKey) {
      error(
        res,
        "ElevenLabs API key is not available. Set ELEVENLABS_API_KEY in Secrets.",
        400,
      );
      return true;
    }

    const voiceId =
      (typeof body.voiceId === "string" && body.voiceId.trim()) ||
      (typeof eleven?.voiceId === "string" && eleven.voiceId.trim()) ||
      "EXAVITQu4vr4xnSDxMaL";
    const modelId =
      (typeof body.modelId === "string" && body.modelId.trim()) ||
      (typeof eleven?.modelId === "string" && eleven.modelId.trim()) ||
      "eleven_flash_v2_5";
    const outputFormat =
      (typeof body.outputFormat === "string" && body.outputFormat.trim()) ||
      "mp3_22050_32";

    const requestedVoiceSettings =
      body.voice_settings &&
      typeof body.voice_settings === "object" &&
      !Array.isArray(body.voice_settings)
        ? body.voice_settings
        : undefined;

    const voiceSettings: Record<string, number> = {};
    const stability = requestedVoiceSettings?.stability;
    if (typeof stability === "number" && stability >= 0 && stability <= 1) {
      voiceSettings.stability = stability;
    }
    const similarityBoost = requestedVoiceSettings?.similarity_boost;
    if (
      typeof similarityBoost === "number" &&
      similarityBoost >= 0 &&
      similarityBoost <= 1
    ) {
      voiceSettings.similarity_boost = similarityBoost;
    }
    const speed = requestedVoiceSettings?.speed;
    if (typeof speed === "number" && speed >= 0.5 && speed <= 2) {
      voiceSettings.speed = speed;
    }

    const payload: Record<string, unknown> = {
      text,
      model_id: modelId,
      apply_text_normalization:
        body.apply_text_normalization === "on" ||
        body.apply_text_normalization === "off"
          ? body.apply_text_normalization
          : "auto",
    };
    if (Object.keys(voiceSettings).length > 0) {
      payload.voice_settings = voiceSettings;
    }

    try {
      const upstreamUrl = new URL(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
      );
      upstreamUrl.searchParams.set("output_format", outputFormat);

      const upstream = await ctx.fetchWithTimeoutGuard(
        upstreamUrl.toString(),
        {
          method: "POST",
          headers: {
            "xi-api-key": resolvedApiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify(payload),
        },
        ctx.ELEVENLABS_FETCH_TIMEOUT_MS,
      );

      if (!upstream.ok) {
        const upstreamBody = await upstream.text().catch(() => "");
        error(
          res,
          `ElevenLabs request failed (${upstream.status}): ${upstreamBody.slice(0, 240)}`,
          upstream.status === 429 ? 429 : 502,
        );
        return true;
      }

      const contentType = upstream.headers.get("content-type") || "audio/mpeg";
      const contentLength = ctx.responseContentLength(upstream.headers);
      if (
        contentLength !== null &&
        contentLength > ctx.ELEVENLABS_AUDIO_MAX_BYTES
      ) {
        error(
          res,
          `ElevenLabs response exceeds maximum size of ${ctx.ELEVENLABS_AUDIO_MAX_BYTES} bytes`,
          502,
        );
        return true;
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        ...(contentLength !== null
          ? { "Content-Length": String(contentLength) }
          : {}),
      });

      await ctx.streamResponseBodyWithByteLimit(
        upstream,
        res,
        ctx.ELEVENLABS_AUDIO_MAX_BYTES,
        ctx.ELEVENLABS_FETCH_TIMEOUT_MS,
      );
      res.end();
      return true;
    } catch (err) {
      if (res.headersSent) {
        res.destroy(
          err instanceof Error
            ? err
            : new Error(
                `ElevenLabs proxy error: ${typeof err === "string" ? err : String(err)}`,
              ),
        );
        return true;
      }
      error(
        res,
        `ElevenLabs proxy error: ${err instanceof Error ? err.message : String(err)}`,
        ctx.isAbortError(err) ? 504 : 502,
      );
      return true;
    }
  }

  return false;
}

const LOCAL_TTS_PROVIDER_IDS = [
  "eliza-local-inference",
  "capacitor-llama",
  "eliza-device-bridge",
  "eliza-aosp-llama",
] as const;

async function useLocalInferenceTts(
  runtime: IAgentRuntime,
  text: string,
): Promise<Buffer | Uint8Array | ArrayBuffer> {
  let lastError: unknown;
  for (const provider of LOCAL_TTS_PROVIDER_IDS) {
    try {
      return await runtime.useModel(
        ModelType.TEXT_TO_SPEECH,
        { text },
        provider,
      );
    } catch (err) {
      lastError = err;
      if (!isMissingProviderError(err)) {
        throw err;
      }
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("No local-inference TEXT_TO_SPEECH provider is registered");
}

function isMissingProviderError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /No handler found for delegate type: TEXT_TO_SPEECH/.test(error.message)
  );
}

function normalizeAudioBytes(
  value: Buffer | Uint8Array | ArrayBuffer,
): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

function sniffAudioContentType(bytes: Uint8Array): string {
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return "audio/wav";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    return "audio/mpeg";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  return "application/octet-stream";
}

function sanitizeLocalInferenceSpeechText(input: string): string {
  let text = input.normalize("NFKC");
  text = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, " ");
  text = text.replace(
    /<(analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi,
    " ",
  );
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/<[^>\n]+>/g, " ");
  text = text.replace(/\bhttps?:\/\/\S+/gi, " ");
  return text.replace(/\s+/g, " ").trim();
}
