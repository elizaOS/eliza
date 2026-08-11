/**
 * Regression coverage for the STT/TTS handlers' transient cold-cache warming
 * handling — the raw-Response companion to the throw-shaped retries already
 * covering image/video/music (#18323/#18325/#18333). On a box whose text
 * brain runs elsewhere, the cloud's per-model admission cache goes cold
 * between rare voice calls and the first one 503s with a machine-readable
 * warming body that clears within ~1s on retry.
 *   - warmingRetryWaitSeconds: the pure Response-shape detector.
 *   - handleTranscription: retries the warming 503 in place (mocked fetch,
 *     real client — matching cloud-transcription-contract.test.ts).
 *   - handleTextToSpeech: retries via the injected client factory.
 * No network.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTextToSpeech, setCloudTtsClientFactoryForTesting } from "../src/models/speech";
import { handleTranscription } from "../src/models/transcription";
import { warmingRetryWaitSeconds } from "../src/utils/warming";

function makeRuntime(): IAgentRuntime {
  const settings: Record<string, string> = {
    ELIZAOS_CLOUD_API_KEY: "test-key",
    ELIZAOS_CLOUD_BASE_URL: "https://cloud.test.local/api/v1",
    ELIZAOS_CLOUD_ENABLED: "true",
  };
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

function warming503(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Billing authorization is warming. Retry shortly.",
        type: "service_unavailable",
        code: "billing_cache_warming",
        retryAfter: 1,
      },
    }),
    { status: 503, headers: { "content-type": "application/json" } }
  );
}

const ISOLATED_ENV_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_USE_STT",
  "ELIZAOS_CLOUD_USE_TTS",
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setCloudTtsClientFactoryForTesting(null);
  vi.restoreAllMocks();
});

describe("warmingRetryWaitSeconds", () => {
  it("detects the warming 503 shape and honours a capped retryAfter", async () => {
    expect(await warmingRetryWaitSeconds(warming503())).toBe(1);
    const longWait = new Response(
      JSON.stringify({ error: { code: "auth_cache_warming", retryAfter: 30 } }),
      { status: 503 }
    );
    expect(await warmingRetryWaitSeconds(longWait)).toBe(3);
  });

  it("defaults the wait when the body has no retryAfter", async () => {
    const bare = new Response(JSON.stringify({ code: "service_unavailable" }), { status: 503 });
    expect(await warmingRetryWaitSeconds(bare)).toBe(1.5);
  });

  it("returns null for non-503s, non-warming 503s, and non-JSON bodies", async () => {
    expect(await warmingRetryWaitSeconds(new Response("{}", { status: 500 }))).toBeNull();
    expect(
      await warmingRetryWaitSeconds(
        new Response(JSON.stringify({ error: { code: "api_error" } }), { status: 503 })
      )
    ).toBeNull();
    expect(
      await warmingRetryWaitSeconds(new Response("upstream boom", { status: 503 }))
    ).toBeNull();
  });

  it("leaves the caller's body consumable (reads a clone)", async () => {
    const response = warming503();
    await warmingRetryWaitSeconds(response);
    expect((await response.json()).error.code).toBe("billing_cache_warming");
  });
});

describe("handleTranscription warming-503 retry", () => {
  it("rides through a cold-cache warming 503 and returns the transcript", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(warming503())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "hello from the video" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    const transcript = await handleTranscription(makeRuntime(), Buffer.from("fake-audio-bytes"));
    expect(transcript).toBe("hello from the video");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fails fast on a non-warming 503", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "api_error" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(
      handleTranscription(makeRuntime(), Buffer.from("fake-audio-bytes"))
    ).rejects.toThrow("Failed to transcribe audio: 503");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("handleTextToSpeech warming-503 retry", () => {
  it("rides through a cold-cache warming 503 and returns audio", async () => {
    const postApiV1VoiceTts = vi
      .fn()
      .mockResolvedValueOnce(warming503())
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        })
      );
    setCloudTtsClientFactoryForTesting(() => ({
      routes: { postApiV1VoiceTts },
    }));
    const audio = await handleTextToSpeech(makeRuntime(), "say hi");
    expect(audio).toBeDefined();
    expect(postApiV1VoiceTts).toHaveBeenCalledTimes(2);
  });

  it("fails fast on a non-warming TTS error", async () => {
    const postApiV1VoiceTts = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    setCloudTtsClientFactoryForTesting(() => ({
      routes: { postApiV1VoiceTts },
    }));
    await expect(handleTextToSpeech(makeRuntime(), "say hi")).rejects.toThrow(/500/);
    expect(postApiV1VoiceTts).toHaveBeenCalledTimes(1);
  });
});
