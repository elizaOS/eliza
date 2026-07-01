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
  const response = await cloudMediaClientFactory(
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
    timeoutMs: resolveCloudTimeoutMs("ELIZAOS_CLOUD_VIDEO_TIMEOUT_MS", 300_000),
  });

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
  const response = await cloudMediaClientFactory(
    runtime,
  ).routes.postApiV1GenerateMusic<CloudMusicResponse>({
    json: cleanRecord({
      prompt,
      model: stringValue(params.model),
      provider: stringValue(params.provider),
      durationSeconds,
      referenceUrl: stringValue(params.referenceUrl ?? params.audioUrl),
      seed: numberValue(params.seed),
      outputFormat: stringValue(params.outputFormat),
      instrumental: booleanValue(params.instrumental),
      extraInput: params.genre ? { genre: params.genre } : undefined,
    }),
    timeoutMs: resolveCloudTimeoutMs("ELIZAOS_CLOUD_MUSIC_TIMEOUT_MS", 300_000),
  });

  const audioUrl = response.music?.url;
  if (!audioUrl) {
    throw new Error("Eliza Cloud music generation returned no audio URL");
  }

  return cleanRecord({
    url: audioUrl,
    audioUrl,
    mimeType: response.music?.content_type ?? "audio/mpeg",
    title: response.music?.file_name,
    duration: durationSeconds,
    requestId: response.requestId,
    id: response.id,
    status: response.status,
  });
}
