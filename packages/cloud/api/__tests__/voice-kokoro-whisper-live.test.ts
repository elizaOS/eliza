/**
 * Live integration contract test for the free cloud voice path (Kokoro TTS +
 * self-hosted Whisper STT). It exercises the EXACT request shapes the cloud-api
 * voice routes use:
 *   - TTS route → `POST ${KOKORO_TTS_URL}/api/tts` { text, voice, speed } → WAV
 *   - STT route → `POST ${WHISPER_STT_URL}/v1/audio/transcriptions` (multipart)
 *
 * Gated: only runs when ELIZA_VOICE_LIVE_RAILWAY=1 (it hits the deployed Railway
 * services). Defaults point at the provisioned deploy; override via env. This is
 * the on-machine end-to-end validation of the web/cloud voice integration that
 * does not require a Cloudflare Worker deploy.
 */
import { describe, expect, test } from "bun:test";
import { resolveWhisperSttModel } from "../v1/voice/stt/whisper-model";

const LIVE = process.env.ELIZA_VOICE_LIVE_RAILWAY === "1";
const LIVE_SPANISH =
  LIVE && Boolean(process.env.ELIZA_VOICE_LIVE_SPANISH_AUDIO_URL);
// `||`, not `??`: the CI workflow maps these from repo *variables*, and GitHub
// injects an unset variable as the empty string — which must still fall back
// to the provisioned Railway instances instead of fetch()ing an empty base.
const KOKORO_TTS_URL =
  process.env.KOKORO_TTS_URL ||
  "https://kokoro-tts-production-aa4b.up.railway.app";
const WHISPER_STT_URL =
  process.env.WHISPER_STT_URL ||
  "https://whisper-stt-production-6fc7.up.railway.app";
const WHISPER_MODEL = resolveWhisperSttModel(process.env.WHISPER_STT_MODEL);

const maybe = LIVE ? test : test.skip;
const maybeSpanish = LIVE_SPANISH ? test : test.skip;

async function transcribeAudio(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  language?: string,
) {
  const audioBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(audioBytes).set(bytes);
  const form = new FormData();
  form.append("file", new File([audioBytes], filename, { type: mimeType }));
  form.append("model", WHISPER_MODEL);
  if (language) form.append("language", language);
  const sttRes = await fetch(
    `${WHISPER_STT_URL.replace(/\/+$/, "")}/v1/audio/transcriptions`,
    { method: "POST", body: form },
  );
  expect(sttRes.status).toBe(200);
  const sttJson = (await sttRes.json()) as { text?: string };
  return (sttJson.text ?? "").toLowerCase();
}

describe("free cloud voice — live Railway contract (Kokoro TTS + Whisper STT)", () => {
  maybe(
    "TTS→STT round-trip: Kokoro synthesizes WAV, Whisper transcribes it back",
    async () => {
      const phrase =
        "Hello from Eliza, this is the cloud voice integration test.";

      // 1) TTS — the exact request the cloud-api /v1/voice/tts Kokoro branch makes.
      const ttsRes = await fetch(
        `${KOKORO_TTS_URL.replace(/\/+$/, "")}/api/tts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: phrase, voice: "af_heart", speed: 1 }),
        },
      );
      expect(ttsRes.status).toBe(200);
      expect(ttsRes.headers.get("content-type") ?? "").toContain("audio");
      const wav = new Uint8Array(await ttsRes.arrayBuffer());
      expect(wav.byteLength).toBeGreaterThan(1000);
      // RIFF/WAVE header.
      expect(String.fromCharCode(wav[0], wav[1], wav[2], wav[3])).toBe("RIFF");
      expect(String.fromCharCode(wav[8], wav[9], wav[10], wav[11])).toBe(
        "WAVE",
      );

      // 2) STT — the exact request the cloud-api /v1/voice/stt Whisper branch makes.
      const transcript = await transcribeAudio(wav, "tts.wav", "audio/wav");
      // The round-trip should recover the salient words.
      expect(transcript).toContain("hello");
      expect(transcript).toContain("eliza");
      expect(transcript).toContain("cloud");
    },
    60_000,
  );

  maybeSpanish(
    "Whisper transcribes a non-English clip when a multilingual model is configured",
    async () => {
      const url = process.env.ELIZA_VOICE_LIVE_SPANISH_AUDIO_URL;
      if (!url)
        throw new Error("ELIZA_VOICE_LIVE_SPANISH_AUDIO_URL is required");
      const expected = (
        process.env.ELIZA_VOICE_LIVE_SPANISH_EXPECT ?? "recordatorio"
      ).toLowerCase();
      const clip = await fetch(url);
      expect(clip.status).toBe(200);
      const bytes = new Uint8Array(await clip.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(1000);
      const transcript = await transcribeAudio(
        bytes,
        "spanish.wav",
        clip.headers.get("content-type") ?? "audio/wav",
        "es",
      );
      expect(transcript).toContain(expected);
    },
    60_000,
  );
});
