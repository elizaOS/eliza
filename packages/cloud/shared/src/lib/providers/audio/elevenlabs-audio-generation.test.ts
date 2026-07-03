/**
 * ElevenLabs audio provider — REAL provider code against a local mock
 * upstream (no key, no network): music (/v1/music) and SFX
 * (/v1/sound-generation) byte responses, request-body mapping, upstream
 * failures, and empty-body rejection.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { generateElevenLabsAudio } from "./elevenlabs-audio-generation";

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

interface MockState {
  requests: Array<{ path: string; query: string; body: Record<string, unknown>; apiKey: string }>;
  status: number;
  errorBody: string;
  emptyBody: boolean;
}

const state: MockState = { requests: [], status: 200, errorBody: "", emptyBody: false };

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    state.requests.push({
      path: url.pathname,
      query: url.search,
      body: (await req.json()) as Record<string, unknown>,
      apiKey: req.headers.get("xi-api-key") ?? "",
    });
    if (state.status !== 200) {
      return new Response(state.errorBody, { status: state.status });
    }
    if (state.emptyBody) {
      return new Response(new Uint8Array(), {
        headers: { "content-type": "audio/mpeg" },
      });
    }
    return new Response(MP3_BYTES, { headers: { "content-type": "audio/mpeg" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  state.requests = [];
  state.status = 200;
  state.errorBody = "";
  state.emptyBody = false;
});

const apiKeys = { ELEVENLABS_API_KEY: "xi-test-key", ELEVENLABS_BASE_URL: base };

describe("generateElevenLabsAudio — music", () => {
  test("returns the streamed bytes and maps the request body", async () => {
    const result = await generateElevenLabsAudio({
      kind: "music",
      model: "elevenlabs/music_v1",
      prompt: "lofi beats",
      durationSeconds: 30,
      seed: 11,
      apiKeys,
    });

    expect(result.source).toBe("bytes");
    if (result.source !== "bytes") throw new Error("expected bytes");
    expect(Array.from(result.bytes)).toEqual(Array.from(MP3_BYTES));
    expect(result.contentType).toBe("audio/mpeg");

    const req = state.requests[0];
    expect(req.path).toBe("/v1/music");
    expect(req.query).toContain("output_format=mp3_44100_128");
    expect(req.apiKey).toBe("xi-test-key");
    expect(req.body).toMatchObject({
      prompt: "lofi beats",
      music_length_ms: 30_000,
      model_id: "music_v1",
      seed: 11,
    });
  });

  test("upstream failure surfaces status + body", async () => {
    state.status = 401;
    state.errorBody = '{"detail":"invalid api key"}';

    await expect(
      generateElevenLabsAudio({
        kind: "music",
        model: "elevenlabs/music_v1",
        prompt: "x",
        apiKeys,
      }),
    ).rejects.toThrow(/music generation failed \(401\).*invalid api key/);
  });
});

describe("generateElevenLabsAudio — sfx", () => {
  test("hits /v1/sound-generation with text + duration + prompt influence", async () => {
    const result = await generateElevenLabsAudio({
      kind: "sfx",
      model: "elevenlabs/sound_effects_v1",
      prompt: "glass shattering",
      durationSeconds: 3,
      promptInfluence: 0.7,
      apiKeys,
    });

    expect(result.source).toBe("bytes");
    const req = state.requests[0];
    expect(req.path).toBe("/v1/sound-generation");
    expect(req.body).toMatchObject({
      text: "glass shattering",
      model_id: "eleven_text_to_sound_v2",
      duration_seconds: 3,
      prompt_influence: 0.7,
    });
  });

  test("empty audio body is rejected, not silently stored", async () => {
    state.emptyBody = true;

    await expect(
      generateElevenLabsAudio({
        kind: "sfx",
        model: "elevenlabs/sound_effects_v1",
        prompt: "x",
        apiKeys,
      }),
    ).rejects.toThrow(/empty audio body/);
  });

  test("missing key fails before any network call", async () => {
    await expect(
      generateElevenLabsAudio({
        kind: "sfx",
        model: "elevenlabs/sound_effects_v1",
        prompt: "x",
        apiKeys: { ELEVENLABS_BASE_URL: base },
      }),
    ).rejects.toThrow(/missing ELEVENLABS_API_KEY/);
    expect(state.requests).toHaveLength(0);
  });
});
