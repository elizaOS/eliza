import { describe, expect, mock, test } from "bun:test";

const subscribe = mock();
const createFalClient = mock(() => ({ subscribe }));

mock.module("@fal-ai/client", () => ({
  createFalClient,
}));

const { buildFalVideoInput, falVideoProvider, generateFalVideo, normalizeFalVideoResult } =
  await import("./fal-video-generation");

describe("FAL video provider", () => {
  test("maps Cloud video request fields to FAL input aliases", () => {
    expect(
      buildFalVideoInput({
        model: "fal-ai/veo3",
        prompt: "city timelapse",
        referenceUrl: "https://example.com/ref.png",
        durationSeconds: 8,
        resolution: "1080p",
        audio: true,
        voiceControl: false,
        apiKeys: { FAL_KEY: "fal-key" },
      }),
    ).toEqual({
      prompt: "city timelapse",
      image_url: "https://example.com/ref.png",
      duration: 8,
      duration_seconds: 8,
      resolution: "1080p",
      audio: true,
      generate_audio: true,
      voice_control: false,
    });
  });

  test("normalizes FAL video responses with request id fallback", () => {
    expect(
      normalizeFalVideoResult(
        {
          videos: [
            {
              url: "https://fal.media/out.mp4",
              width: 1920,
              height: 1080,
              file_name: "out.mp4",
              file_size: 1234,
              content_type: "video/mp4",
            },
          ],
          seed: 99,
          timings: { inference: 1.25 },
          has_nsfw_concepts: [false],
        },
        "queued-id",
      ),
    ).toEqual({
      requestId: "queued-id",
      video: {
        url: "https://fal.media/out.mp4",
        width: 1920,
        height: 1080,
        file_name: "out.mp4",
        file_size: 1234,
        content_type: "video/mp4",
      },
      seed: 99,
      timings: { inference: 1.25 },
      hasNsfwConcepts: [false],
    });
  });

  test("generates through the registered FAL provider", async () => {
    createFalClient.mockClear();
    subscribe.mockClear();
    subscribe.mockImplementation(async (_model, options) => {
      options.onEnqueue("queued-id");
      return {
        request_id: "result-id",
        video: { url: "https://fal.media/out.mp4" },
      };
    });

    const result = await generateFalVideo({
      model: "fal-ai/veo3",
      prompt: "a lighthouse",
      durationSeconds: 5,
      apiKeys: { FAL_API_KEY: "fal-key" },
    });

    expect(falVideoProvider.billingSource).toBe("fal");
    expect(falVideoProvider.isConfigured?.({ FAL_KEY: " fal-key " })).toBe(true);
    expect(createFalClient).toHaveBeenCalledWith({
      credentials: "fal-key",
      suppressLocalCredentialsWarning: true,
    });
    expect(subscribe).toHaveBeenCalledWith("fal-ai/veo3", {
      input: {
        prompt: "a lighthouse",
        duration: 5,
        duration_seconds: 5,
      },
      onEnqueue: expect.any(Function),
    });
    expect(result).toEqual({
      requestId: "result-id",
      video: { url: "https://fal.media/out.mp4" },
      timings: null,
      hasNsfwConcepts: undefined,
      seed: undefined,
    });
  });

  test("rejects missing FAL credentials before calling upstream", async () => {
    createFalClient.mockClear();

    await expect(
      generateFalVideo({
        model: "fal-ai/veo3",
        prompt: "a lighthouse",
        apiKeys: {},
      }),
    ).rejects.toThrow("AI services are not configured on this deployment");
    expect(falVideoProvider.isConfigured?.({})).toBe(false);
    expect(createFalClient).not.toHaveBeenCalled();
  });
});
