/** Resolves and prices the guarded Seedance 2.5 controls exposed to Personal Shared chats. */

import type { MediaGenerationRequest } from "@elizaos/core/edge";

export const PERSONAL_SHARED_TEXT_VIDEO_MODEL_ID = "bytedance/seedance-2.5/text-to-video";
export const PERSONAL_SHARED_IMAGE_VIDEO_MODEL_ID = "bytedance/seedance-2.5/image-to-video";

const DEFAULT_DURATION_SECONDS = 5;
const DEFAULT_RESOLUTION = "720p";
const DEFAULT_ASPECT_RATIO = "auto";
const SEEDANCE_PRICE_PER_THOUSAND_TOKENS_USD = 0.0214;

const RESOLUTIONS = ["480p", "720p"] as const;
const ASPECT_RATIOS = ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

export type PersonalSharedSeedanceResolution = (typeof RESOLUTIONS)[number];
export type PersonalSharedSeedanceAspectRatio = (typeof ASPECT_RATIOS)[number];

export interface PersonalSharedSeedanceOptions {
  durationSeconds: number;
  resolution: PersonalSharedSeedanceResolution;
  aspectRatio: PersonalSharedSeedanceAspectRatio;
  audio: boolean;
  seed?: number;
}

function isResolution(value: string): value is PersonalSharedSeedanceResolution {
  return RESOLUTIONS.some((candidate) => candidate === value);
}

function isAspectRatio(value: string): value is PersonalSharedSeedanceAspectRatio {
  return ASPECT_RATIOS.some((candidate) => candidate === value);
}

export function resolvePersonalSharedSeedanceOptions(
  request: MediaGenerationRequest,
): PersonalSharedSeedanceOptions {
  const durationSeconds = request.duration ?? DEFAULT_DURATION_SECONDS;
  if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 30) {
    throw new Error("Seedance 2.5 duration must be a whole number from 4 to 30 seconds");
  }

  const resolution = request.resolution?.trim().toLowerCase() ?? DEFAULT_RESOLUTION;
  if (!isResolution(resolution)) {
    throw new Error("Seedance 2.5 resolution must be 480p or 720p");
  }

  const aspectRatio = request.aspectRatio?.trim().toLowerCase() ?? DEFAULT_ASPECT_RATIO;
  if (!isAspectRatio(aspectRatio)) {
    throw new Error("Seedance 2.5 aspect ratio must be auto, 21:9, 16:9, 4:3, 1:1, 3:4, or 9:16");
  }

  if (request.seed !== undefined && (!Number.isSafeInteger(request.seed) || request.seed < 0)) {
    throw new Error("Seedance 2.5 seed must be a non-negative whole number");
  }

  return {
    durationSeconds,
    resolution,
    aspectRatio,
    audio: request.audio ?? true,
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
}

const OUTPUT_DIMENSIONS: Record<
  PersonalSharedSeedanceResolution,
  Record<Exclude<PersonalSharedSeedanceAspectRatio, "auto">, readonly [number, number]>
> = {
  "480p": {
    "21:9": [992, 432],
    "16:9": [864, 496],
    "4:3": [752, 560],
    "1:1": [640, 640],
    "3:4": [560, 752],
    "9:16": [496, 864],
  },
  "720p": {
    "21:9": [1470, 630],
    "16:9": [1280, 720],
    "4:3": [1112, 834],
    "1:1": [960, 960],
    "3:4": [834, 1112],
    "9:16": [720, 1280],
  },
};

export function estimatePersonalSharedSeedanceCostUsd(
  options: PersonalSharedSeedanceOptions,
): number {
  // fal documents token billing by output area and duration. For automatic
  // framing, use the common 16:9 frame as a deterministic preflight estimate.
  const ratio = options.aspectRatio === "auto" ? "16:9" : options.aspectRatio;
  const [width, height] = OUTPUT_DIMENSIONS[options.resolution][ratio];
  const tokens = (width * height * options.durationSeconds * 24) / 1024;
  return (tokens / 1000) * SEEDANCE_PRICE_PER_THOUSAND_TOKENS_USD;
}
