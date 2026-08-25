/** Tests deterministic Seedance 2.5 defaults, controls, validation, and cost estimation. */

import { describe, expect, test } from "bun:test";
import {
  estimatePersonalSharedSeedanceCostUsd,
  PERSONAL_SHARED_IMAGE_VIDEO_MODEL_ID,
  PERSONAL_SHARED_TEXT_VIDEO_MODEL_ID,
  resolvePersonalSharedSeedanceOptions,
} from "./personal-shared-seedance";

function videoRequest(overrides: Record<string, unknown> = {}) {
  return {
    mediaType: "video" as const,
    prompt: "a puppy wags its tail",
    ...overrides,
  };
}

describe("Personal Shared Seedance 2.5 controls", () => {
  test("uses the exact fal endpoints and conservative chat defaults", () => {
    expect(PERSONAL_SHARED_TEXT_VIDEO_MODEL_ID).toBe("bytedance/seedance-2.5/text-to-video");
    expect(PERSONAL_SHARED_IMAGE_VIDEO_MODEL_ID).toBe("bytedance/seedance-2.5/image-to-video");
    expect(resolvePersonalSharedSeedanceOptions(videoRequest())).toEqual({
      durationSeconds: 5,
      resolution: "720p",
      aspectRatio: "auto",
      audio: true,
    });
  });

  test("preserves explicit supported controls", () => {
    expect(
      resolvePersonalSharedSeedanceOptions(
        videoRequest({
          duration: 12,
          resolution: "480P",
          aspectRatio: "9:16",
          audio: false,
          seed: 7,
        }),
      ),
    ).toEqual({
      durationSeconds: 12,
      resolution: "480p",
      aspectRatio: "9:16",
      audio: false,
      seed: 7,
    });
  });

  test("rejects invalid controls instead of silently changing them", () => {
    expect(() => resolvePersonalSharedSeedanceOptions(videoRequest({ duration: 3 }))).toThrow(
      "4 to 30",
    );
    expect(() => resolvePersonalSharedSeedanceOptions(videoRequest({ resolution: "4k" }))).toThrow(
      "480p or 720p",
    );
    expect(() =>
      resolvePersonalSharedSeedanceOptions(videoRequest({ aspectRatio: "2:1" })),
    ).toThrow("aspect ratio");
  });

  test("estimates fal token cost from resolution, aspect ratio, and duration", () => {
    expect(
      estimatePersonalSharedSeedanceCostUsd({
        durationSeconds: 5,
        resolution: "720p",
        aspectRatio: "16:9",
        audio: true,
      }),
    ).toBeCloseTo(2.3112, 4);
  });
});
