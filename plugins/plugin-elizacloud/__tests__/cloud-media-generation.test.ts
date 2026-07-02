import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAudioGeneration,
  handleVideoGeneration,
  setCloudMediaClientFactoryForTesting,
} from "../src/models/media";

function runtime(): IAgentRuntime {
  return {} as IAgentRuntime;
}

describe("Eliza Cloud media model handlers", () => {
  afterEach(() => {
    setCloudMediaClientFactoryForTesting(null);
  });

  it("posts video generation to /generate-video through the SDK route", async () => {
    const postApiV1GenerateVideo = vi.fn(async () => ({
      success: true,
      id: "gen_video",
      requestId: "req_video",
      video: {
        url: "https://cdn.example/video.mp4",
        content_type: "video/mp4",
      },
      seed: 7,
    }));
    setCloudMediaClientFactoryForTesting(() => ({
      routes: {
        postApiV1GenerateVideo,
        postApiV1GenerateMusic: vi.fn(),
      },
    }));

    await expect(
      handleVideoGeneration(runtime(), {
        prompt: "glass lighthouse pan",
        durationSeconds: 6,
        imageUrl: "https://example.com/ref.png",
        aspectRatio: "16:9",
      })
    ).resolves.toMatchObject({
      url: "https://cdn.example/video.mp4",
      videoUrl: "https://cdn.example/video.mp4",
      mimeType: "video/mp4",
      duration: 6,
      requestId: "req_video",
      id: "gen_video",
      seed: 7,
    });

    expect(postApiV1GenerateVideo).toHaveBeenCalledWith({
      json: {
        prompt: "glass lighthouse pan",
        referenceUrl: "https://example.com/ref.png",
        durationSeconds: 6,
        resolution: "16:9",
      },
      timeoutMs: expect.any(Number),
    });
  });

  it("posts music generation to /generate-music through the SDK route", async () => {
    const postApiV1GenerateMusic = vi.fn(async () => ({
      success: true,
      id: "gen_music",
      requestId: "req_music",
      status: "completed",
      music: {
        url: "https://cdn.example/song.mp3",
        content_type: "audio/mpeg",
        file_name: "song.mp3",
      },
    }));
    setCloudMediaClientFactoryForTesting(() => ({
      routes: {
        postApiV1GenerateVideo: vi.fn(),
        postApiV1GenerateMusic,
      },
    }));

    await expect(
      handleAudioGeneration(runtime(), {
        prompt: "ambient synth pulse",
        audioKind: "music",
        durationSeconds: 12,
        instrumental: true,
        genre: "ambient",
      })
    ).resolves.toMatchObject({
      url: "https://cdn.example/song.mp3",
      audioUrl: "https://cdn.example/song.mp3",
      mimeType: "audio/mpeg",
      title: "song.mp3",
      duration: 12,
      requestId: "req_music",
      id: "gen_music",
      status: "completed",
    });

    expect(postApiV1GenerateMusic).toHaveBeenCalledWith({
      json: {
        prompt: "ambient synth pulse",
        durationSeconds: 12,
        instrumental: true,
        extraInput: { genre: "ambient" },
      },
      timeoutMs: expect.any(Number),
    });
  });

  it("fails cloud SFX clearly instead of calling the music route", async () => {
    const postApiV1GenerateMusic = vi.fn();
    setCloudMediaClientFactoryForTesting(() => ({
      routes: {
        postApiV1GenerateVideo: vi.fn(),
        postApiV1GenerateMusic,
      },
    }));

    await expect(
      handleAudioGeneration(runtime(), {
        prompt: "glass chime",
        audioKind: "sfx",
      })
    ).rejects.toThrow(/direct SFX provider/);
    expect(postApiV1GenerateMusic).not.toHaveBeenCalled();
  });
});
