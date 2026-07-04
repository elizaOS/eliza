import { describe, expect, test } from "bun:test";
import { logger } from "../../utils/logger";
import { generateAtlasCloudVideo } from "./atlascloud-video-generation";

const hasCredentials = Boolean(process.env.ATLASCLOUD_API_KEY);

if (!hasCredentials) {
  logger.warn(
    "[AtlasCloudVideoRealTest] SKIPPED: set ATLASCLOUD_API_KEY to run the live Atlas Cloud video generation lane",
  );
}

describe("Atlas Cloud video provider live", () => {
  (hasCredentials ? test : test.skip)("generates a real Atlas-hosted video", async () => {
    const result = await generateAtlasCloudVideo({
      model: process.env.ATLASCLOUD_VIDEO_MODEL ?? "vidu/q3-turbo/text-to-video",
      prompt: "A five second product-style shot of a matte orange cube rotating on a white table",
      durationSeconds: 5,
      resolution: "720p",
      audio: false,
      apiKeys: {
        ATLASCLOUD_API_KEY: process.env.ATLASCLOUD_API_KEY as string,
        ATLASCLOUD_BASE_URL: process.env.ATLASCLOUD_BASE_URL,
      },
    });

    expect(result.video.url).toMatch(/^https?:\/\//);
    expect(result.video.content_type ?? "video/mp4").toMatch(/^video\//);
  });
});
