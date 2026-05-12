import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaSchema } from "../config/zod-schema";
import {
  type AudioGenerationProvider,
  createAudioProvider,
} from "./media-provider";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
};

function stubAudioFetch(response: Response, calls: FetchCall[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        init,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {},
      });
      return response.clone();
    }),
  );
}

describe("media audio provider routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes sfx requests to ElevenLabs sound generation", async () => {
    const calls: FetchCall[] = [];
    stubAudioFetch(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-type": "audio/mpeg",
          "song-id": "song_123",
        },
      }),
      calls,
    );

    const provider = createAudioProvider(
      {
        mode: "own-key",
        providers: { sfx: "elevenlabs" },
        elevenlabs: {
          apiKey: "eleven-key",
          duration: 2,
          promptInfluence: 0.7,
          outputFormat: "mp3_44100_128",
        },
      },
      { cloudMediaDisabled: true },
    );

    const result = await provider.generate({
      prompt: "glass chime",
      audioKind: "sfx",
    });

    expect(result.success).toBe(true);
    expect(result.data?.audioUrl).toBe("data:audio/mpeg;base64,AQID");
    expect(result.data?.id).toBe("song_123");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
    );
    expect(calls[0].init?.headers).toMatchObject({
      "xi-api-key": "eleven-key",
    });
    expect(calls[0].body).toMatchObject({
      text: "glass chime",
      duration_seconds: 2,
      prompt_influence: 0.7,
      model_id: "eleven_text_to_sound_v2",
    });
  });

  it("routes tts requests to ElevenLabs text-to-speech", async () => {
    const calls: FetchCall[] = [];
    stubAudioFetch(
      new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "audio/mpeg" },
      }),
      calls,
    );

    const provider = createAudioProvider(
      {
        mode: "own-key",
        providers: { tts: "elevenlabs" },
        elevenlabs: {
          apiKey: "eleven-key",
          voiceId: "voice-1",
          ttsModelId: "eleven_multilingual_v2",
        },
      },
      { cloudMediaDisabled: true },
    );

    const result = await provider.generate({
      prompt: "hello world",
      kind: "tts",
    });

    expect(result.success).toBe(true);
    expect(calls[0].url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice-1",
    );
    expect(calls[0].body).toMatchObject({
      text: "hello world",
      model_id: "eleven_multilingual_v2",
    });
  });

  it("routes music requests to FAL audio generation", async () => {
    const calls: FetchCall[] = [];
    stubAudioFetch(
      Response.json({
        audio_file: {
          url: "https://cdn.example/audio.wav",
          content_type: "audio/wav",
          file_name: "audio.wav",
        },
        duration: 6,
      }),
      calls,
    );

    const provider = createAudioProvider(
      {
        mode: "own-key",
        providers: { music: "fal" },
        fal: {
          apiKey: "fal-key",
          model: "fal-ai/stable-audio",
          steps: 50,
        },
      },
      { cloudMediaDisabled: true },
    );

    const result = await provider.generate({
      prompt: "ambient synth pulse",
      kind: "music",
      duration: 6,
    });

    expect(result.success).toBe(true);
    expect(result.data?.audioUrl).toBe("https://cdn.example/audio.wav");
    expect(result.data?.mimeType).toBe("audio/wav");
    expect(calls[0].url).toBe("https://fal.run/fal-ai/stable-audio");
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Key fal-key",
    });
    expect(calls[0].body).toMatchObject({
      prompt: "ambient synth pulse",
      seconds_total: 6,
      steps: 50,
    });
  });

  it("accepts full media config in the main schema while preserving preserveFilenames", () => {
    const parsed = ElizaSchema.parse({
      media: {
        preserveFilenames: true,
        audio: {
          mode: "own-key",
          defaultKind: "music",
          providers: {
            music: "fal",
            sfx: "elevenlabs",
            tts: "elevenlabs",
          },
          fal: {
            apiKey: "fal-key",
            model: "fal-ai/stable-audio",
            steps: 40,
          },
          elevenlabs: {
            apiKey: "eleven-key",
            voiceId: "voice-1",
            outputFormat: "mp3_44100_128",
          },
        },
      },
    });

    expect(parsed.media?.preserveFilenames).toBe(true);
    expect(parsed.media?.audio?.providers?.music).toBe("fal");
  });

  it("fails tts generation clearly when ElevenLabs has no voiceId", async () => {
    const provider: AudioGenerationProvider = createAudioProvider(
      {
        mode: "own-key",
        providers: { tts: "elevenlabs" },
        elevenlabs: { apiKey: "eleven-key" },
      },
      { cloudMediaDisabled: true },
    );

    const result = await provider.generate({
      prompt: "hello world",
      kind: "tts",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/voiceId/);
  });
});
