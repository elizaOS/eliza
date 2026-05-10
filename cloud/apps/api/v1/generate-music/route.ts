import { createFalClient } from "@fal-ai/client";
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { calculateMusicGenerationCostFromCatalog } from "@/lib/services/ai-pricing";
import {
  getSupportedMusicModelDefinition,
  SUPPORTED_MUSIC_MODEL_IDS,
} from "@/lib/services/ai-pricing-definitions";
import { creditsService, InsufficientCreditsError } from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { putPublicObject } from "@/lib/storage/r2-public-object";
import { logger } from "@/lib/utils/logger";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";

const DEFAULT_MUSIC_MODEL = "fal-ai/minimax-music/v2.6";
const MAX_PROMPT_LENGTH = 4100;
const MAX_LYRICS_LENGTH = 3500;

const audioFormatSchema = z.enum(["mp3", "wav", "pcm", "flac"]).optional();
const audioSampleRateSchema = z.enum(["16000", "24000", "32000", "44100"]).optional();
const audioBitrateSchema = z.enum(["32000", "64000", "128000", "256000"]).optional();

const musicRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().trim().default(DEFAULT_MUSIC_MODEL),
  provider: z.enum(["fal", "elevenlabs", "suno"]).optional(),
  lyrics: z.string().max(MAX_LYRICS_LENGTH).optional(),
  lyricsOptimizer: z.boolean().optional(),
  instrumental: z.boolean().optional(),
  durationSeconds: z.coerce.number().int().min(3).max(600).optional(),
  referenceUrl: z.string().trim().url().optional(),
  seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
  outputFormat: z.string().trim().max(64).optional(),
  audio: z
    .object({
      format: audioFormatSchema,
      sampleRate: audioSampleRateSchema,
      bitrate: audioBitrateSchema,
    })
    .strict()
    .optional(),
  extraInput: z.record(z.string(), z.unknown()).optional(),
});

type MusicRequest = z.infer<typeof musicRequestSchema>;

interface MusicObject {
  url?: string;
  file_name?: string;
  file_size?: number;
  content_type?: string;
}

interface NormalizedMusicResult {
  requestId?: string;
  status?: string;
  music: MusicObject;
  raw?: unknown;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

function envString(env: Bindings, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function falKey(env: Bindings): string | null {
  return envString(env, "FAL_KEY") ?? envString(env, "FAL_API_KEY");
}

function elevenLabsKey(env: Bindings): string | null {
  return envString(env, "ELEVENLABS_API_KEY");
}

function sunoKey(env: Bindings): string | null {
  return envString(env, "SUNO_API_KEY");
}

function sunoBaseUrl(env: Bindings): string {
  return (envString(env, "SUNO_BASE_URL") ?? "https://api.suno.ai/v1").replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeMusicObject(value: unknown): MusicObject | null {
  if (!isRecord(value)) return null;
  const url =
    stringValue(value.url) ??
    stringValue(value.audio_url) ??
    stringValue(value.output_url) ??
    stringValue(value.file_url);
  if (!url) return null;
  return {
    url,
    file_name: stringValue(value.file_name),
    file_size: numberValue(value.file_size),
    content_type: stringValue(value.content_type),
  };
}

function normalizeMusicResult(result: unknown, requestId?: string): NormalizedMusicResult {
  if (!isRecord(result)) {
    throw new Error("Music provider returned an invalid response");
  }

  const direct =
    normalizeMusicObject(result.audio) ??
    normalizeMusicObject(result.music) ??
    normalizeMusicObject(result.file) ??
    normalizeMusicObject(result.output) ??
    normalizeMusicObject(result);
  const fromArray = Array.isArray(result.audios)
    ? normalizeMusicObject(result.audios[0])
    : Array.isArray(result.data)
      ? normalizeMusicObject(result.data[0])
      : null;
  const music = direct ?? fromArray;
  if (!music?.url) {
    throw new Error("Music provider returned no audio URL");
  }

  return {
    requestId:
      stringValue(result.requestId) ??
      stringValue(result.request_id) ??
      stringValue(result.id) ??
      requestId,
    status: stringValue(result.status),
    music,
    raw: result,
  };
}

function contentTypeForOutputFormat(outputFormat: string | undefined): string {
  if (!outputFormat) return "audio/mpeg";
  if (outputFormat.startsWith("pcm_")) return "audio/L16";
  if (outputFormat.startsWith("ulaw_")) return "audio/basic";
  if (outputFormat.startsWith("wav_")) return "audio/wav";
  if (outputFormat.startsWith("mp3_")) return "audio/mpeg";
  return "application/octet-stream";
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("L16") || contentType.includes("pcm")) return "pcm";
  if (contentType.includes("basic")) return "ulaw";
  return "mp3";
}

function buildFalInput(request: MusicRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt: request.prompt,
  };

  if (request.lyrics !== undefined) input.lyrics = request.lyrics;
  if (request.instrumental !== undefined) input.is_instrumental = request.instrumental;
  if (request.lyricsOptimizer !== undefined) {
    input.lyrics_optimizer = request.lyricsOptimizer;
  } else if (!request.lyrics && request.instrumental !== true) {
    input.lyrics_optimizer = true;
  }
  if (request.referenceUrl) {
    input.audio_url = request.referenceUrl;
    input.reference_audio_url = request.referenceUrl;
  }
  if (request.durationSeconds) {
    input.duration = request.durationSeconds;
    input.duration_seconds = request.durationSeconds;
    input.seconds_total = request.durationSeconds;
  }
  if (request.audio) {
    input.audio_setting = {
      ...(request.audio.sampleRate ? { sample_rate: request.audio.sampleRate } : {}),
      ...(request.audio.bitrate ? { bitrate: request.audio.bitrate } : {}),
      ...(request.audio.format ? { format: request.audio.format } : {}),
    };
  }

  return {
    ...input,
    ...(request.extraInput ?? {}),
  };
}

async function runFalMusic(env: Bindings, request: MusicRequest): Promise<NormalizedMusicResult> {
  const key = falKey(env);
  if (!key) {
    throw new Error("Fal music generation is not configured");
  }

  let requestId: string | undefined;
  const fal = createFalClient({
    credentials: key,
    suppressLocalCredentialsWarning: true,
  });
  const result = await fal.subscribe(request.model, {
    input: buildFalInput(request),
    onEnqueue: (id) => {
      requestId = id;
    },
  });
  return normalizeMusicResult(result, requestId);
}

async function runElevenLabsMusic(
  env: Bindings,
  request: MusicRequest,
  user: { id: string; organization_id?: string | null },
): Promise<NormalizedMusicResult> {
  const key = elevenLabsKey(env);
  if (!key) {
    throw new Error("ElevenLabs music generation is not configured");
  }
  if (!env.BLOB) {
    throw new Error("R2 storage is not configured");
  }

  const outputFormat = request.outputFormat ?? "mp3_44100_128";
  const url = new URL("https://api.elevenlabs.io/v1/music");
  url.searchParams.set("output_format", outputFormat);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": key,
    },
    body: JSON.stringify({
      prompt: request.prompt,
      ...(request.durationSeconds ? { music_length_ms: request.durationSeconds * 1000 } : {}),
      model_id: request.model.replace(/^elevenlabs\//, ""),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.extraInput ?? {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ElevenLabs music generation failed (${response.status}): ${text}`);
  }

  const contentType =
    response.headers.get("content-type") ?? contentTypeForOutputFormat(outputFormat);
  const bytes = await response.arrayBuffer();
  const ext = extensionForContentType(contentType);
  const organizationId = user.organization_id ?? "unknown";
  const keyPath = `generations/music/${organizationId}/${user.id}/${crypto.randomUUID()}.${ext}`;
  const stored = await putPublicObject(env, {
    key: keyPath,
    body: bytes,
    contentType,
    customMetadata: {
      userId: user.id,
      organizationId,
      model: request.model,
      source: "generate-music",
    },
  });

  return {
    music: {
      url: stored.url,
      file_name: keyPath.split("/").at(-1),
      file_size: bytes.byteLength,
      content_type: contentType,
    },
    raw: { r2Key: stored.key },
  };
}

async function runSunoMusic(env: Bindings, request: MusicRequest): Promise<NormalizedMusicResult> {
  const key = sunoKey(env);
  if (!key) {
    throw new Error("Suno-compatible music generation is not configured");
  }

  const response = await fetch(`${sunoBaseUrl(env)}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: request.prompt,
      ...(request.durationSeconds ? { duration: request.durationSeconds } : {}),
      ...(request.lyrics ? { lyrics: request.lyrics } : {}),
      ...(request.instrumental !== undefined ? { instrumental: request.instrumental } : {}),
      ...(request.extraInput ?? {}),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Suno-compatible music generation failed (${response.status})`);
  }
  return normalizeMusicResult(data);
}

app.post("/", async (c) => {
  let reservation: Awaited<ReturnType<typeof creditsService.reserve>> | null = null;

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const request = musicRequestSchema.parse(await c.req.json());
    const definition = getSupportedMusicModelDefinition(request.model);
    if (!definition) {
      return jsonError(c, 400, `Unsupported music model: ${request.model}`, "validation_error", {
        supportedModels: SUPPORTED_MUSIC_MODEL_IDS,
      });
    }

    const provider = request.provider ?? definition.provider;
    if (provider !== definition.provider) {
      return jsonError(
        c,
        400,
        `Model ${request.model} is served by ${definition.provider}, not ${provider}`,
        "validation_error",
      );
    }
    if (provider === "fal" && request.prompt.length > 2000) {
      return jsonError(
        c,
        400,
        "Fal music prompts must be 2000 characters or fewer",
        "validation_error",
      );
    }

    const durationSeconds = request.durationSeconds ?? definition.defaultParameters.durationSeconds;
    const cost = await calculateMusicGenerationCostFromCatalog({
      model: request.model,
      provider: definition.provider,
      billingSource: definition.billingSource,
      durationSeconds,
      dimensions: {
        ...(durationSeconds ? { durationSeconds } : {}),
        ...(request.instrumental !== undefined ? { instrumental: request.instrumental } : {}),
      },
    });

    try {
      reservation = await creditsService.reserve({
        organizationId: user.organization_id,
        userId: user.id,
        amount: cost.totalCost,
        description: `Music generation: ${request.model}`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return c.json(
          { success: false, error: "Insufficient credits", required: error.required },
          402,
        );
      }
      throw error;
    }

    const normalized =
      provider === "fal"
        ? await runFalMusic(c.env, request)
        : provider === "elevenlabs"
          ? await runElevenLabsMusic(c.env, request, user)
          : await runSunoMusic(c.env, request);

    await reservation.reconcile(cost.totalCost);

    const generation = await generationsService.create({
      organization_id: user.organization_id,
      user_id: user.id,
      type: "music",
      model: request.model,
      provider: definition.provider,
      prompt: request.prompt,
      result: {
        requestId: normalized.requestId,
        status: normalized.status,
        billingSource: definition.billingSource,
        raw: normalized.raw,
      },
      status: "completed",
      storage_url: normalized.music.url,
      thumbnail_url: null,
      file_size: normalized.music.file_size ? BigInt(normalized.music.file_size) : undefined,
      mime_type: normalized.music.content_type ?? "audio/mpeg",
      parameters: {
        durationSeconds,
        hasLyrics: Boolean(request.lyrics),
        lyricsOptimizer: request.lyricsOptimizer,
        instrumental: request.instrumental,
        referenceUrl: request.referenceUrl,
        outputFormat: request.outputFormat,
      },
      dimensions: {
        duration: durationSeconds,
      },
      cost: String(cost.totalCost),
      credits: String(cost.totalCost),
      job_id: normalized.requestId,
      completed_at: new Date(),
    });

    return c.json({
      success: true,
      id: generation.id,
      requestId: normalized.requestId,
      status: normalized.status ?? "completed",
      music: normalized.music,
      cost,
    });
  } catch (error) {
    if (reservation) {
      await reservation.reconcile(0).catch((reconcileError) => {
        logger.error("[GenerateMusic] Failed to refund reservation", {
          error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
        });
      });
    }
    return failureResponse(c, error);
  }
});

app.all("*", (c) => c.json({ success: false, error: "Method not allowed" }, 405));

export default app;
