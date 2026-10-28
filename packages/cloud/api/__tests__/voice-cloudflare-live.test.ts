/** Authenticated application-route qualification for the Workers AI cutover. */
import { describe, expect, test } from "bun:test";

const live = process.env.ELIZA_VOICE_LIVE_CLOUDFLARE === "1";
const maybe = live ? test : test.skip;

function configuration() {
  const base = process.env.ELIZA_VOICE_CLOUD_API_URL;
  const key = process.env.ELIZAOS_CLOUD_API_KEY;
  if (!base || !key)
    throw new Error(
      "Live voice requires ELIZA_VOICE_CLOUD_API_URL and ELIZAOS_CLOUD_API_KEY",
    );
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(
      "Live voice requires an HTTPS API URL without embedded credentials",
    );
  return {
    base: base.replace(/\/+$/, ""),
    headers: { Authorization: `Bearer ${key}` },
  };
}

async function verifyDeployedRelease(base: string): Promise<void> {
  const commit = process.env.ELIZA_VOICE_CLOUD_COMMIT;
  const environment = process.env.ELIZA_VOICE_CLOUD_ENVIRONMENT;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Live voice requires an exact ELIZA_VOICE_CLOUD_COMMIT");
  }
  if (environment !== "staging" && environment !== "production") {
    throw new Error("Live voice requires staging or production environment");
  }
  const canonicalOrigin =
    environment === "production"
      ? "https://api.eliza.app"
      : "https://api-staging.eliza.app";
  if (base !== canonicalOrigin) {
    throw new Error("Live voice URL does not match its protected environment");
  }
  const response = await fetch(`${base}/api/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ commit, environment });
}

describe("Workers AI through authenticated Cloud voice routes", () => {
  maybe(
    "TTS and STT both report Cloudflare and recover the spoken phrase",
    async () => {
      const { base, headers } = configuration();
      await verifyDeployedRelease(base);
      const tts = await fetch(`${base}/api/v1/voice/tts`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Hello from Eliza, this is the cloud voice integration test.",
          voiceId: "af_heart",
          format: "wav",
        }),
        signal: AbortSignal.timeout(90_000),
      });
      expect(tts.status).toBe(200);
      expect(tts.headers.get("X-Eliza-TTS-Provider")).toBe("cloudflare");
      expect(tts.headers.get("X-Eliza-TTS-Voice")).toBe("luna");
      const wav = await tts.arrayBuffer();
      expect(wav.byteLength).toBeGreaterThan(1000);
      expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
      expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
      const form = new FormData();
      form.append(
        "audio",
        new File([wav], "voice-contract.wav", { type: "audio/wav" }),
      );
      // Do not force a request-level provider: prove the deployed default moved.
      const stt = await fetch(`${base}/api/v1/voice/stt`, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(90_000),
      });
      expect(stt.status).toBe(200);
      expect(stt.headers.get("X-Eliza-STT-Provider")).toBe("cloudflare");
      expect(stt.headers.get("X-Eliza-STT-Model")).toBe("@cf/deepgram/nova-3");
      const payload = (await stt.json()) as { transcript?: unknown };
      expect(typeof payload.transcript).toBe("string");
      if (typeof payload.transcript !== "string")
        throw new Error("Missing transcript");
      const transcript = payload.transcript.toLowerCase();
      expect(transcript).toContain("hello");
      expect(transcript).toContain("eliza");
      expect(transcript).toContain("cloud");
      await verifyDeployedRelease(base);
    },
    260_000,
  );

  maybe(
    "oversized text receives an explicit client error",
    async () => {
      const { base, headers } = configuration();
      await verifyDeployedRelease(base);
      const response = await fetch(`${base}/api/v1/voice/tts`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "x".repeat(2001),
          voiceId: "af_heart",
          format: "wav",
        }),
        signal: AbortSignal.timeout(30_000),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "Text too long. Maximum length is 2000 characters",
      });
    },
    75_000,
  );
});
