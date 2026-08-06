import { generateImage, experimental_generateVideo as generateVideo } from "ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, extname, isAbsolute, join, resolve } from "path";
import type { MediaAsset, ToolResult } from "../types/index";
import type { XaiProvider } from "./client";

const GENERATED_MEDIA_DIR = ".grok/generated-media";
const IMAGE_MODEL_ID = "grok-imagine-image";
const VIDEO_MODEL_ID = "grok-imagine-video";

export const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "auto",
] as const;

export const VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const IMAGE_RESOLUTIONS = ["1k", "2k"] as const;
export const VIDEO_RESOLUTIONS = ["480p", "720p"] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export interface GenerateImageToolInput {
  prompt: string;
  source?: string;
  aspect_ratio?: ImageAspectRatio;
  resolution?: ImageResolution;
  n?: number;
  output_path?: string;
}

export interface GenerateVideoToolInput {
  prompt: string;
  source?: string;
  duration?: number;
  aspect_ratio?: VideoAspectRatio;
  resolution?: VideoResolution;
  output_path?: string;
  poll_interval_ms?: number;
  poll_timeout_ms?: number;
}

interface ResolvedImageSource {
  data: Uint8Array;
  dataUrl: string;
  mediaType: string;
  sourcePath?: string;
  sourceUrl?: string;
}

export async function generateImageTool(
  provider: XaiProvider,
  input: GenerateImageToolInput,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  try {
    if (!provider.image) {
      return failureResult(
        "Image generation failed",
        new Error("Image generation requires the native xAI provider."),
      );
    }
    const source = input.source ? await resolveImageSource(input.source, cwd, abortSignal) : null;
    const prompt = source ? { text: input.prompt, images: [source.data] } : input.prompt;
    const response = await generateImage({
      model: provider.image(IMAGE_MODEL_ID),
      prompt,
      n: input.n,
      aspectRatio: toSdkAspectRatio(input.aspect_ratio),
      abortSignal,
      providerOptions: {
        xai: {
          ...(input.resolution ? { resolution: input.resolution } : {}),
        },
      },
    });

    const modelId = getResponseModelId(response.responses, IMAGE_MODEL_ID);
    const urls = extractImageUrls(response.providerMetadata, response.images.length);
    const runId = createRunId();
    const media = response.images.map((image, index) => {
      const path = buildOutputPath({
        cwd,
        kind: "image",
        mediaType: image.mediaType,
        outputPath: input.output_path,
        index,
        total: response.images.length,
        runId,
      });
      writeFileSync(path, image.uint8Array);
      return {
        kind: "image",
        path,
        url: urls[index],
        mediaType: image.mediaType,
        prompt: input.prompt,
        sourcePath: source?.sourcePath,
        sourceUrl: source?.sourceUrl,
        modelId,
      } satisfies MediaAsset;
    });

    return {
      success: true,
      output: summarizeMediaResult("image", media, response.warnings),
      media,
    };
  } catch (err: unknown) {
    return failureResult("Image generation failed", err);
  }
}

export async function generateVideoTool(
  provider: XaiProvider,
  input: GenerateVideoToolInput,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  try {
    if (!provider.video) {
      return failureResult(
        "Video generation failed",
        new Error("Video generation requires the native xAI provider."),
      );
    }
    const source = input.source ? await resolveImageSource(input.source, cwd, abortSignal) : null;
    const prompt = source ? { text: input.prompt, image: source.dataUrl } : input.prompt;
    const response = await generateVideo({
      model: provider.video(VIDEO_MODEL_ID),
      prompt,
      duration: input.duration,
      aspectRatio: input.aspect_ratio,
      abortSignal,
      providerOptions: {
        xai: {
          ...(input.resolution ? { resolution: input.resolution } : {}),
          ...(input.poll_interval_ms ? { pollIntervalMs: input.poll_interval_ms } : {}),
          ...(input.poll_timeout_ms ? { pollTimeoutMs: input.poll_timeout_ms } : {}),
        },
      },
    });

    const modelId = getResponseModelId(response.responses, VIDEO_MODEL_ID);
    const videoUrl = extractVideoUrl(response.providerMetadata);
    const runId = createRunId();
    const media = response.videos.map((video, index) => {
      const path = buildOutputPath({
        cwd,
        kind: "video",
        mediaType: video.mediaType,
        outputPath: input.output_path,
        index,
        total: response.videos.length,
        runId,
      });
      writeFileSync(path, video.uint8Array);
      return {
        kind: "video",
        path,
        url: videoUrl,
        mediaType: video.mediaType,
        prompt: input.prompt,
        sourcePath: source?.sourcePath,
        sourceUrl: source?.sourceUrl,
        durationSeconds: input.duration,
        modelId,
      } satisfies MediaAsset;
    });

    return {
      success: true,
      output: summarizeMediaResult("video", media, response.warnings),
      media,
    };
  } catch (err: unknown) {
    return failureResult("Video generation failed", err);
  }
}

function summarizeMediaResult(kind: "image" | "video", media: MediaAsset[], warnings?: unknown[]): string {
  const label = `${media.length} ${kind}${media.length === 1 ? "" : "s"}`;
  const lines = [`Generated ${label}.`];
  for (const asset of media) {
    const extra: string[] = [];
    if (asset.url) extra.push(`url: ${asset.url}`);
    if (asset.sourcePath) extra.push(`source: ${asset.sourcePath}`);
    if (asset.sourceUrl) extra.push(`source_url: ${asset.sourceUrl}`);
    lines.push(`- ${asset.path}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`);
  }
  const warningLines = (warnings ?? []).map(formatWarning).filter((warning): warning is string => Boolean(warning));
  if (warningLines.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of warningLines) {
      lines.push(`- ${warning}`);
    }
  }
  return lines.join("\n");
}

function failureResult(prefix: string, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    error: `${prefix}: ${message}`,
    output: `${prefix}: ${message}`,
  };
}

async function resolveImageSource(
  source: string,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<ResolvedImageSource> {
  if (isUrl(source)) {
    const response = await fetch(source, { signal: abortSignal });
    if (!response.ok) {
      throw new Error(`Source image download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    const mediaType = response.headers.get("content-type") || guessMediaType(source, "image/png");
    return {
      data: buffer,
      dataUrl: toDataUrl(buffer, mediaType),
      mediaType,
      sourceUrl: source,
    };
  }

  const fullPath = isAbsolute(source) ? source : resolve(cwd, source);
  if (!existsSync(fullPath)) {
    throw new Error(`Source image not found: ${source}`);
  }
  const buffer = readFileSync(fullPath);
  const mediaType = guessMediaType(fullPath, "image/png");
  return {
    data: buffer,
    dataUrl: toDataUrl(buffer, mediaType),
    mediaType,
    sourcePath: fullPath,
  };
}

function buildOutputPath({
  cwd,
  kind,
  mediaType,
  outputPath,
  index,
  total,
  runId,
}: {
  cwd: string;
  kind: "image" | "video";
  mediaType: string | undefined;
  outputPath?: string;
  index: number;
  total: number;
  runId: string;
}): string {
  const extension = extensionForMediaType(kind, mediaType);
  const requested = outputPath ? (isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath)) : null;
  let fullPath = requested;

  if (!fullPath) {
    fullPath = join(resolve(cwd, GENERATED_MEDIA_DIR), `${kind}-${runId}.${extension}`);
  }

  const currentExt = extname(fullPath);
  if (total > 1) {
    const basePath = currentExt ? fullPath.slice(0, -currentExt.length) : fullPath;
    fullPath = `${basePath}-${index + 1}.${extension}`;
  } else if (!currentExt) {
    fullPath = `${fullPath}.${extension}`;
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  return fullPath;
}

function extensionForMediaType(kind: "image" | "video", mediaType?: string): string {
  const normalized = (mediaType || "").toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    default:
      return kind === "image" ? "png" : "mp4";
  }
}

function guessMediaType(pathLike: string, fallback: string): string {
  const extension = extname(pathLike).toLowerCase();
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    default:
      return fallback;
  }
}

function toDataUrl(data: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`;
}

function extractImageUrls(providerMetadata: unknown, count: number): Array<string | undefined> {
  const xai = getRecord(getRecord(providerMetadata)?.xai);
  const images = Array.isArray(xai?.images) ? xai.images : [];
  return Array.from({ length: count }, (_, index) => extractUrl(images[index]));
}

function extractVideoUrl(providerMetadata: unknown): string | undefined {
  const xai = getRecord(getRecord(providerMetadata)?.xai);
  return readString(xai, "videoUrl") ?? extractUrl(xai?.video);
}

function extractUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = getRecord(value);
  return readString(record, "url") ?? readString(record, "videoUrl");
}

function getResponseModelId(responses: unknown, fallback: string): string {
  if (!Array.isArray(responses) || responses.length === 0) {
    return fallback;
  }
  const first = getRecord(responses[0]);
  return readString(first, "modelId") ?? fallback;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function createRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function toSdkAspectRatio(aspectRatio?: ImageAspectRatio): `${number}:${number}` | undefined {
  return aspectRatio ? (aspectRatio as unknown as `${number}:${number}`) : undefined;
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatWarning(warning: unknown): string | undefined {
  if (typeof warning === "string") {
    return warning.trim() || undefined;
  }
  const record = getRecord(warning);
  const message = readString(record, "message");
  if (message) return message.trim() || undefined;
  const details = readString(record, "details");
  const feature = readString(record, "feature");
  const type = readString(record, "type");
  if (feature && details) return `${feature}: ${details}`;
  if (feature) return feature;
  if (details) return details;
  return type;
}
