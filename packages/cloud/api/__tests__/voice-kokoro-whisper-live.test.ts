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

const LIVE = process.env.ELIZA_VOICE_LIVE_RAILWAY === "1";
const KOKORO_TTS_URL =
  process.env.KOKORO_TTS_URL ??
  "https://kokoro-tts-production-aa4b.up.railway.app";
const WHISPER_STT_URL =
  process.env.WHISPER_STT_URL ??
  "https://whisper-stt-production-6fc7.up.railway.app";

const maybe = LIVE ? test : test.skip;

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
      const form = new FormData();
      form.append("file", new File([wav], "tts.wav", { type: "audio/wav" }));
      form.append("model", "Systran/faster-whisper-tiny.en");
      const sttRes = await fetch(
        `${WHISPER_STT_URL.replace(/\/+$/, "")}/v1/audio/transcriptions`,
        { method: "POST", body: form },
      );
      expect(sttRes.status).toBe(200);
      const sttJson = (await sttRes.json()) as { text?: string };
      const transcript = (sttJson.text ?? "").toLowerCase();
      // The round-trip should recover the salient words.
      expect(transcript).toContain("hello");
      expect(transcript).toContain("eliza");
      expect(transcript).toContain("cloud");
    },
    60_000,
  );
});
