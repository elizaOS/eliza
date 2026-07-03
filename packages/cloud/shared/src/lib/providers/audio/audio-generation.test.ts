import { beforeEach, describe, expect, mock, test } from "bun:test";
import { generateFalAudio } from "./fal-audio-generation";
import { normalizeAudioResult } from "./normalize";
import { DEFERRED_AUDIO_PROVIDERS, getAudioProvider } from "./registry";

const subscribe = mock();

mock.module("@fal-ai/client", () => ({
  createFalClient: () => ({ subscribe }),
}));

beforeEach(() => {
  subscribe.mockReset();
});

describe("audio provider registry", () => {
  test("registers existing music providers and documents SFX deferrals", () => {
    expect(getAudioProvider("fal").billingSource).toBe("fal");
    expect(getAudioProvider("elevenlabs").billingSource).toBe("elevenlabs");
    expect(getAudioProvider("suno").billingSource).toBe("suno");
    expect(DEFERRED_AUDIO_PROVIDERS.map((entry) => entry.modelFamily)).toEqual([
      "fal-ai/stable-audio",
      "fal-ai/mmaudio-v2",
      "elevenlabs/sound-effects",
    ]);
  });

  test("normalizes common audio provider response shapes", () => {
    expect(
      normalizeAudioResult({
        id: "req-1",
        audios: [{ audio_url: "https://cdn.test/out.wav", file_size: 123 }],
      }),
    ).toMatchObject({
      requestId: "req-1",
      audio: { url: "https://cdn.test/out.wav", file_size: 123 },
    });
  });

  test("fal provider passes music controls to fal input", async () => {
    subscribe.mockResolvedValue({
      request_id: "fal-req",
      audio: { url: "https://fal.test/out.mp3", content_type: "audio/mpeg" },
    });

    const result = await generateFalAudio({
      env: { FAL_KEY: "fal-test-key" } as never,
      user: { id: "user-1", organization_id: "org-1" },
      request: {
        model: "fal-ai/minimax-music/v2.6",
        prompt: "ambient intro",
        durationSeconds: 30,
        instrumental: true,
        referenceUrl: "https://example.com/ref.wav",
        audio: { format: "mp3", sampleRate: "44100", bitrate: "128000" },
      },
    });

    expect(result.audio.url).toBe("https://fal.test/out.mp3");
    expect(subscribe).toHaveBeenCalledWith(
      "fal-ai/minimax-music/v2.6",
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: "ambient intro",
          duration: 30,
          duration_seconds: 30,
          seconds_total: 30,
          is_instrumental: true,
          audio_url: "https://example.com/ref.wav",
          reference_audio_url: "https://example.com/ref.wav",
          audio_setting: {
            format: "mp3",
            sample_rate: "44100",
            bitrate: "128000",
          },
        }),
      }),
    );
  });
});
