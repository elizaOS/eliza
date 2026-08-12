import type {
  AudioProcessingParams,
  IAgentRuntime,
  JsonValue,
  VideoProcessingParams,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveCloudTimeoutMs } from "../utils/config";
import { createElizaCloudClient } from "../utils/sdk-client";

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
  };
}

type CloudMediaClientFactory = (runtime: IAgentRuntime) => CloudMediaClient;

let cloudMediaClientFactory: CloudMediaClientFactory = (runtime) =>
  createElizaCloudClient(runtime) as CloudMediaClient;

export function setCloudMediaClientFactoryForTesting(
  factory: CloudMediaClientFactory | null,
): void {
  cloudMediaClientFactory =
    factory ??
    ((runtime) => createElizaCloudClient(runtime) as CloudMediaClient);
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
  music?: {
    url?: string;
    content_type?: string;
    file_name?: string;
  };
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
  const postMusic = (json: Record<string, JsonValue>) =>
    retryMediaWarming(
      () =>
        cloudMediaClientFactory(
          runtime,
        ).routes.postApiV1GenerateMusic<CloudMusicResponse>({
          json,
          timeoutMs,
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
    status: response.status,
  });
}
