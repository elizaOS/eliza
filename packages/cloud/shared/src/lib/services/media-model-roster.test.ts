// Exercises media model roster behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { MEDIA_MODEL_ROSTER, mediaRosterModelIndexes } from "./media-model-roster";

describe("media model roster", () => {
  test("documents every family with source links and rationale", () => {
    expect(MEDIA_MODEL_ROSTER.length).toBeGreaterThan(0);

    const requiredFamilies = [
      "FLUX",
      "Atlas-hosted GPT Image 2",
      "Atlas-hosted Seedream",
      "Atlas-hosted Qwen Image",
      "Recraft",
      "Ideogram",
      "Kling",
      "MiniMax / Hailuo",
      "ElevenLabs Music",
      "Suno-compatible music",
      "Luma",
      "Runway",
      "Stable Audio",
      "ElevenLabs sound effects",
      "MMAudio",
      "Google Nano Banana image generation",
      "Google Imagen 4 direct",
      "Google direct Veo 3 / Veo 3.1",
      "Gemini Omni / direct Gemini media",
    ];

    for (const family of requiredFamilies) {
      expect(MEDIA_MODEL_ROSTER.some((entry) => entry.family === family)).toBe(true);
    }

    for (const entry of MEDIA_MODEL_ROSTER) {
      expect(entry.sourceUrls.length).toBeGreaterThan(0);
      expect(entry.rationale.length).toBeGreaterThan(20);
      for (const sourceUrl of entry.sourceUrls) {
        expect(sourceUrl).toMatch(/^https:\/\//);
      }
    }
  });

  test("keeps wired models indexed by supported pricing definitions", () => {
    const indexes = mediaRosterModelIndexes();

    for (const entry of MEDIA_MODEL_ROSTER) {
      if (entry.status !== "wired") {
        expect(entry.wiredModelIds).toBeUndefined();
        continue;
      }

      expect(entry.wiredModelIds?.length).toBeGreaterThan(0);
      for (const modelId of entry.wiredModelIds ?? []) {
        const isIndexed =
          (entry.surfaces.includes("image") && indexes.image.has(modelId)) ||
          (entry.surfaces.includes("video") && indexes.video.has(modelId)) ||
          (entry.surfaces.includes("music") && indexes.music.has(modelId)) ||
          (entry.surfaces.includes("sfx") && indexes.sfx.has(modelId));
        expect(isIndexed, `${entry.family}: ${modelId}`).toBe(true);
      }
    }
  });

  test("catalogs every supported media pricing model", () => {
    const indexes = mediaRosterModelIndexes();
    const wiredModelIds = new Set(
      MEDIA_MODEL_ROSTER.flatMap((entry) => [...(entry.wiredModelIds ?? [])]),
    );

    for (const modelId of [...indexes.image, ...indexes.video, ...indexes.music, ...indexes.sfx]) {
      expect(wiredModelIds.has(modelId), modelId).toBe(true);
    }
  });
});
