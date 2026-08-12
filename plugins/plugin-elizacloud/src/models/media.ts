import type {
  AudioProcessingParams,
  IAgentRuntime,
  JsonValue,
  VideoProcessingParams,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveCloudTimeoutMs } from "../utils/config";
import { createElizaCloudClient } from "../utils/sdk-client";

interface CloudGenerationStatusResponse {
  success?: boolean;
  id?: string;
  status?: string;
  storage_url?: string | null;
  mime_type?: string | null;
  file_name?: string | null;
  error?: string | null;
  job_id?: string | null;
  requestId?: string | null;
}

interface CloudMediaClient {
  routes: {
    postApiV1GenerateVideo<T = unknown>(options: {
      json: Record<string, unknown>;
      timeoutMs?: number;
    }): Promise<T>;
    postApiV1GenerateMusic<T = unknown>(options: {
      json: Record<string, unknown>;
      timeoutMs?: number;
    }): Promise<T>;
    /** Optional: generated after GET /api/v1/gallery/{id} is registered. */
    getApiV1GalleryById?<T = unknown>(options: {
      path?: { id: string | number };
      id?: string | number;
      timeoutMs?: number;
    }): Promise<T>;
  };
  /** Fallback poll when generated gallery-by-id route helper is unavailable. */
  getGenerationStatus?(
    id: string,
    options?: { timeoutMs?: number },
  ): Promise<CloudGenerationStatusResponse>;
}

type CloudMediaClientFactory = (runtime: IAgentRuntime) => CloudMediaClient;

function defaultCloudMediaClient(runtime: IAgentRuntime): CloudMediaClient {
  const client = createElizaCloudClient(runtime);
  return {
    routes: client.routes as CloudMediaClient["routes"],
    getGenerationStatus: async (id, options) => {
      // CloudApiClient is scoped to /api/v1.
      return await client.v1.get<CloudGenerationStatusResponse>(
        `/gallery/${encodeURIComponent(id)}`,
        { timeoutMs: options?.timeoutMs },
      );
    },
  };
}

let cloudMediaClientFactory: CloudMediaClientFactory = defaultCloudMediaClient;

export function setCloudMediaClientFactoryForTesting(
  factory: CloudMediaClientFactory | null,
): void {
  cloudMediaClientFactory = factory ?? defaultCloudMediaClient;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

type CloudMediaModelResult = Record<string, JsonValue>;

function cleanRecord(
  record: Record<string, JsonValue | undefined>,
): CloudMediaModelResult {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as CloudMediaModelResult;
}

interface CloudVideoResponse {
  success?: boolean;
  id?: string;
  requestId?: string;
  video?: {
    url?: string;
    content_type?: string;
    width?: number;
    height?: number;
  };
  seed?: number;
}

/**
 * Ride through the cloud's transient cold-cache warming for a media call. This
 * box runs text on Cerebras, so the cloud's per-model generative admission
 * cache goes cold between rare video/music calls; the first one throws
 * "Generative admission cache is warming; retry shortly" (or a
 * billing/auth-cache warming message) that clears within ~1s on retry — the
 * client companion to the server escape in #18249, mirroring the image
 * handlers (#18323/#18325). A non-warming error still fails fast.
 */
async function retryMediaWarming<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let warmingRetries = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Prefer the structured warming code the cloud sets on the thrown API
      // error (billing_cache_warming / auth_cache_warming / service_unavailable);
      // fall back to the message text for SDK shapes that don't surface a code.
      const errRecord = err as {
        code?: unknown;
        error?: { code?: unknown; type?: unknown };
      };
      const code = String(
        errRecord?.code ?? errRecord?.error?.code ?? errRecord?.error?.type ?? "",
      );
      const isWarming =
        code === "billing_cache_warming" ||
        code === "auth_cache_warming" ||
        code === "service_unavailable" ||
        /warming|admission cache/i.test(message);
      if (isWarming && warmingRetries < 2) {
        warmingRetries++;
        logger.warn(
          `[ELIZAOS_CLOUD] ${label} cold-cache warming, retry ${warmingRetries}/2...`,
        );
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
}

export async function handleVideoGeneration(
  runtime: IAgentRuntime,
  params: VideoProcessingParams,
): Promise<CloudMediaModelResult> {
  const prompt = stringValue(params.prompt);
  if (!prompt) {
    throw new Error("Cloud video generation requires a prompt");
  }

  const referenceUrl =
    stringValue(params.referenceUrl) ?? stringValue(params.imageUrl);
  const durationSeconds =
    numberValue(params.durationSeconds) ?? numberValue(params.duration);

  logger.log("[ELIZAOS_CLOUD] Using VIDEO model via /generate-video");
  const response = await retryMediaWarming(
    () =>
      cloudMediaClientFactory(
        runtime,
      ).routes.postApiV1GenerateVideo<CloudVideoResponse>({
        json: cleanRecord({
          prompt,
          model: stringValue(params.model),
          referenceUrl,
          durationSeconds,
          resolution: stringValue(params.resolution ?? params.aspectRatio),
          audio: booleanValue(params.audio),
          voiceControl: booleanValue(params.voiceControl),
        }),
        timeoutMs: resolveCloudTimeoutMs(
          "ELIZAOS_CLOUD_VIDEO_TIMEOUT_MS",
          300_000,
        ),
      }),
    "Video generation",
  );

  const videoUrl = response.video?.url;
  if (!videoUrl) {
    throw new Error("Eliza Cloud video generation returned no video URL");
  }

  return cleanRecord({
    url: videoUrl,
    videoUrl,
    mimeType: response.video?.content_type ?? "video/mp4",
    duration: durationSeconds,
    requestId: response.requestId,
    id: response.id,
    seed: response.seed,
  });
}

interface CloudMusicResponse {
  success?: boolean;
  id?: string;
  requestId?: string;
  status?: string;
  error?: string;
  music?: {
    url?: string;
    content_type?: string;
    file_name?: string;
  };
}

const MUSIC_PENDING_POLL_INTERVAL_MS = 2_000;

function isPendingMusicResponse(response: CloudMusicResponse): boolean {
  if (response.music?.url) return false;
  const status = stringValue(response.status)?.toLowerCase();
  // 202 body: { success:false, status:"pending", id, requestId }
  return status === "pending" && Boolean(stringValue(response.id));
}

async function fetchGenerationStatus(
  client: CloudMediaClient,
  id: string,
  timeoutMs: number,
): Promise<CloudGenerationStatusResponse> {
  if (client.routes.getApiV1GalleryById) {
    return await client.routes.getApiV1GalleryById<CloudGenerationStatusResponse>(
      {
        path: { id },
        id,
        timeoutMs,
      },
    );
  }
  if (client.getGenerationStatus) {
    return await client.getGenerationStatus(id, { timeoutMs });
  }
  throw new Error(
    "Cloud media client cannot poll generation status (missing gallery GET)",
  );
}

/**
 * After a 202 pending generate-music response, poll GET /gallery/:id until the
 * reconcile path completes the generation or the remaining client budget ends.
 */
async function resolvePendingMusicResponse(
  client: CloudMediaClient,
  pending: CloudMusicResponse,
  totalTimeoutMs: number,
  startedAt: number,
): Promise<CloudMusicResponse> {
  const id = stringValue(pending.id);
  if (!id) {
    throw new Error(
      "Eliza Cloud music generation returned pending without a generation id",
    );
  }

  logger.log(
    `[ELIZAOS_CLOUD] Music generation pending upstream (id=${id}); polling for completion`,
  );

  for (;;) {
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw new Error(
        `Music generation still pending after ${totalTimeoutMs}ms (id=${id}). Try again shortly or check gallery status.`,
      );
    }

    const status = await fetchGenerationStatus(
      client,
      id,
      Math.min(30_000, remaining),
    );
    const state = stringValue(status.status)?.toLowerCase();
    if (state === "completed" && stringValue(status.storage_url)) {
      return {
        success: true,
        id: stringValue(status.id) ?? id,
        requestId:
          stringValue(status.requestId) ??
          stringValue(status.job_id) ??
          pending.requestId,
        status: "completed",
        music: {
          url: stringValue(status.storage_url),
          content_type: stringValue(status.mime_type) ?? "audio/mpeg",
          file_name: stringValue(status.file_name),
        },
      };
    }
    if (state === "failed" || state === "deleted") {
      throw new Error(
        stringValue(status.error) ||
          `Music generation failed upstream (id=${id}, status=${state})`,
      );
    }

    await new Promise((r) =>
      setTimeout(r, Math.min(MUSIC_PENDING_POLL_INTERVAL_MS, remaining)),
    );
  }
}

export async function handleAudioGeneration(
  runtime: IAgentRuntime,
  params: AudioProcessingParams,
): Promise<CloudMediaModelResult> {
  const kind = stringValue(params.audioKind) ?? "music";
  if (kind !== "music") {
    throw new Error(
      "Eliza Cloud AUDIO generation supports music. Use TEXT_TO_SPEECH for speech or configure a direct SFX provider.",
    );
  }

  const prompt = stringValue(params.prompt ?? params.text);
  if (!prompt) {
    throw new Error("Cloud music generation requires a prompt");
  }

  const durationSeconds =
    numberValue(params.durationSeconds) ?? numberValue(params.duration);

  logger.log("[ELIZAOS_CLOUD] Using AUDIO model via /generate-music");
  const requestJson = cleanRecord({
    prompt,
    model: stringValue(params.model),
    provider: stringValue(params.provider),
    durationSeconds,
    referenceUrl: stringValue(params.referenceUrl ?? params.audioUrl),
    seed: numberValue(params.seed),
    outputFormat: stringValue(params.outputFormat),
    instrumental: booleanValue(params.instrumental),
    extraInput: params.genre ? { genre: params.genre } : undefined,
  });
  const timeoutMs = resolveCloudTimeoutMs(
    "ELIZAOS_CLOUD_MUSIC_TIMEOUT_MS",
    300_000,
  );
  const client = cloudMediaClientFactory(runtime);
  const startedAt = Date.now();
  const postMusic = (json: Record<string, JsonValue>) =>
    retryMediaWarming(
      () =>
        client.routes.postApiV1GenerateMusic<CloudMusicResponse>({
          json,
          // First hop can return 202 quickly; keep budget for status polling.
          timeoutMs: Math.min(timeoutMs, 120_000),
        }),
      "Music generation",
    );
  let response: CloudMusicResponse;
  let outputDurationSeconds = durationSeconds;
  try {
    response = await postMusic(requestJson);
  } catch (err) {
    // error-policy:J2 fixed-price music models 400 with an explicitly
    // machine-actionable hint ("...omit durationSeconds and bill it as a
    // fixed-price generation" — generate-music route). Observed live: "make
    // me a 10 second synthwave loop" set durationSeconds=10 against the
    // default fal-ai/minimax-music model and the whole turn failed. Honour
    // the server's instruction with ONE retry minus the param; any other
    // failure rethrows unchanged.
    const message = err instanceof Error ? err.message : String(err);
    if (
      requestJson.durationSeconds === undefined ||
      !/does not support durationSeconds/i.test(message)
    ) {
      throw err;
    }
    logger.warn(
      "[ELIZAOS_CLOUD] Music model rejects durationSeconds; retrying as a fixed-price generation",
    );
    const { durationSeconds: _omitted, ...fixedPriceJson } = requestJson;
    response = await postMusic(fixedPriceJson);
    outputDurationSeconds = undefined;
  }

  if (isPendingMusicResponse(response)) {
    response = await resolvePendingMusicResponse(
      client,
      response,
      timeoutMs,
      startedAt,
    );
  }

  const audioUrl = response.music?.url;
  if (!audioUrl) {
    throw new Error("Eliza Cloud music generation returned no audio URL");
  }

  return cleanRecord({
    url: audioUrl,
    audioUrl,
    mimeType: response.music?.content_type ?? "audio/mpeg",
    title: response.music?.file_name,
    duration: outputDurationSeconds,
    requestId: response.requestId,
    id: response.id,
    status: response.status ?? "completed",
  });
}
