import { describe, expect, test } from "bun:test";
import {
  type CloudflareSpeechBinding,
  synthesizeCloudflareAudio,
  transcribeCloudflareAudio,
} from "../../shared/src/lib/providers/cloudflare-speech";
import {
  KOKORO_CLOUDFLARE_VOICES,
  KOKORO_VOICE_IDS,
  LEGACY_DEFAULT_ELEVENLABS_VOICE_ID,
  selectTtsProvider,
} from "../v1/voice/tts/provider-selection";

describe("Workers AI speech migration", () => {
  test("Nova preserves audio bytes and word timings, and rejects malformed provider timings", async () => {
    const audio = new Uint8Array([1, 2, 3]);
    let end = 0.4;
    const binding = {
      async run(
        model: unknown,
        input: {
          audio: { body: ReadableStream<Uint8Array>; contentType: string };
        },
      ) {
        expect(model).toBe("@cf/deepgram/nova-3");
        expect(input.audio.contentType).toBe("audio/ogg");
        expect(
          new Uint8Array(await new Response(input.audio.body).arrayBuffer()),
        ).toEqual(audio);
        return {
          results: {
            channels: [
              {
                alternatives: [
                  {
                    transcript: "Hello",
                    words: [{ word: "hello", start: 0.1, end }],
                  },
                ],
              },
            ],
          },
        };
      },
    } as CloudflareSpeechBinding;
    expect(
      await transcribeCloudflareAudio(
        binding,
        audio,
        undefined,
        undefined,
        "audio/ogg",
      ),
    ).toEqual({
      text: "Hello",
      words: [{ word: "hello", start: 0.1, end: 0.4 }],
    });
    end = -1;
    await expect(
      transcribeCloudflareAudio(
        binding,
        audio,
        undefined,
        undefined,
        "audio/ogg",
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "SPEECH_PROVIDER_RESPONSE_INVALID",
    });
  });
  test("oversized speech is rejected before any provider call and boundary text is preserved", async () => {
    const inputs: string[] = [];
    const binding = {
      run: async (_model: unknown, input: unknown) => {
        if (
          !input ||
          typeof input !== "object" ||
          !("text" in input) ||
          typeof input.text !== "string"
        )
          throw new Error("Expected TTS input");
        inputs.push(input.text);
        return new ReadableStream();
      },
    } as CloudflareSpeechBinding;
    await expect(
      synthesizeCloudflareAudio(binding, "x".repeat(2001), true),
    ).rejects.toMatchObject({ status: 400, code: "SPEECH_TEXT_TOO_LONG" });
    expect(inputs).toEqual([]);
    const text = "x".repeat(2000);
    await synthesizeCloudflareAudio(binding, text, true);
    expect(inputs).toEqual([text]);
  });
  test("every supported legacy Kokoro voice selects its replacement even with paid defaults configured", async () => {
    expect(Object.keys(KOKORO_CLOUDFLARE_VOICES).sort()).toEqual(
      [...KOKORO_VOICE_IDS].sort(),
    );
    for (const voiceId of KOKORO_VOICE_IDS) {
      const choice = selectTtsProvider({
        voiceId,
        cloudflareConfigured: true,
        cartesiaConfigured: true,
        kokoroConfigured: true,
      });
      expect(choice.ok).toBe(true);
      if (!choice.ok || choice.provider !== "cloudflare")
        throw new Error("Legacy voice still requires Kokoro");
      expect(choice.speaker).toBe(KOKORO_CLOUDFLARE_VOICES[voiceId]);
      let observed: unknown;
      const binding = {
        run: async (_model: unknown, input: unknown) => {
          observed = input;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          });
        },
      } as CloudflareSpeechBinding;
      await synthesizeCloudflareAudio(
        binding,
        "Migration test",
        true,
        undefined,
        choice.speaker,
      );
      expect(observed).toMatchObject({
        text: "Migration test",
        speaker: choice.speaker,
        encoding: "linear16",
        container: "wav",
      });
    }
  });
  test("free defaults use Workers AI and configured paid defaults retain their provider", () => {
    for (const voiceId of [undefined, LEGACY_DEFAULT_ELEVENLABS_VOICE_ID]) {
      expect(
        selectTtsProvider({
          voiceId,
          cloudflareConfigured: true,
          kokoroConfigured: false,
        }),
      ).toMatchObject({ ok: true, provider: "cloudflare", speaker: "luna" });
      expect(
        selectTtsProvider({
          voiceId,
          cloudflareConfigured: true,
          cartesiaConfigured: true,
          kokoroConfigured: false,
        }),
      ).toMatchObject({ ok: true, provider: "cartesia" });
    }
    expect(
      selectTtsProvider({
        voiceId: "custom-elevenlabs",
        cloudflareConfigured: true,
        kokoroConfigured: false,
      }),
    ).toMatchObject({ ok: true, provider: "elevenlabs" });
  });
  test("unknown Kokoro IDs fail without calling a paid provider", () => {
    expect(
      selectTtsProvider({
        voiceId: "af_unknown",
        cloudflareConfigured: true,
        kokoroConfigured: false,
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });
  test("an environment without Workers AI retains its existing backend until cutover", () => {
    expect(
      selectTtsProvider({
        voiceId: "af_heart",
        cloudflareConfigured: false,
        kokoroConfigured: true,
      }),
    ).toMatchObject({ ok: true, provider: "kokoro" });
    expect(
      selectTtsProvider({
        voiceId: "af_heart",
        cloudflareConfigured: false,
        kokoroConfigured: false,
      }),
    ).toMatchObject({ ok: false, status: 503 });
  });
});
