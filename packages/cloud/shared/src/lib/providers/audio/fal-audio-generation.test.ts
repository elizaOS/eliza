/**
 * fal audio provider — REAL queue pipeline against a local mock upstream:
 * music input mapping (lyrics optimizer defaulting, duration fan-out), SFX
 * input mapping (seconds_total), hosted-URL normalization across response
 * shapes, and no-audio rejection.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { generateFalAudio } from "./fal-audio-generation";

interface MockState {
  submitBodies: Array<Record<string, unknown>>;
  responseBody: Record<string, unknown>;
}

const state: MockState = { submitBodies: [], responseBody: {} };

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST") {
      state.submitBodies.push((await req.json()) as Record<string, unknown>);
      return Response.json({
        request_id: "req-7",
        status_url: `${base}/requests/req-7/status`,
        response_url: `${base}/requests/req-7/response`,
      });
    }
    if (url.pathname.endsWith("/status")) {
      return Response.json({ status: "COMPLETED" });
    }
    return Response.json(state.responseBody);
  },
});
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  state.submitBodies = [];
  state.responseBody = {
    audio: {
      url: `${base}/media/out.mp3`,
      file_size: 2048,
      content_type: "audio/mpeg",
    },
  };
});

const apiKeys = {
  FAL_KEY: "test-fal-key",
  FAL_QUEUE_BASE_URL: base,
  FAL_QUEUE_POLL_INTERVAL_MS: "5",
  FAL_QUEUE_TIMEOUT_MS: "2000",
};

describe("generateFalAudio — music", () => {
  test("maps music input and returns the hosted audio", async () => {
    const result = await generateFalAudio({
      kind: "music",
      model: "fal-ai/minimax-music/v2.6",
      prompt: "upbeat synthwave",
      durationSeconds: 60,
      apiKeys,
    });

    expect(result.source).toBe("hosted");
    if (result.source !== "hosted") throw new Error("expected hosted");
    expect(result.url).toBe(`${base}/media/out.mp3`);
    expect(result.fileSize).toBe(2048);
    expect(result.requestId).toBe("req-7");

    // No lyrics + not explicitly instrumental → optimizer defaults on;
    // duration fans out to every alias fal models accept.
    expect(state.submitBodies[0]).toMatchObject({
      prompt: "upbeat synthwave",
      lyrics_optimizer: true,
      duration: 60,
      duration_seconds: 60,
      seconds_total: 60,
    });
  });

  test("instrumental music does not force the lyrics optimizer", async () => {
    await generateFalAudio({
      kind: "music",
      model: "fal-ai/minimax-music/v2.6",
      prompt: "x",
      instrumental: true,
      apiKeys,
    });

    expect(state.submitBodies[0]).toMatchObject({ is_instrumental: true });
    expect(state.submitBodies[0]).not.toHaveProperty("lyrics_optimizer");
  });
});

describe("generateFalAudio — sfx", () => {
  test("stable-audio style input: prompt + seconds_total + seed only", async () => {
    await generateFalAudio({
      kind: "sfx",
      model: "fal-ai/stable-audio-25/text-to-audio",
      prompt: "rain on a tin roof",
      durationSeconds: 12,
      seed: 3,
      apiKeys,
    });

    expect(state.submitBodies[0]).toEqual({
      prompt: "rain on a tin roof",
      seconds_total: 12,
      seed: 3,
    });
  });

  test("normalizes alternate response shapes (audio_file)", async () => {
    state.responseBody = {
      audio_file: { url: `${base}/media/alt.wav`, content_type: "audio/wav" },
    };

    const result = await generateFalAudio({
      kind: "sfx",
      model: "fal-ai/stable-audio-25/text-to-audio",
      prompt: "x",
      apiKeys,
    });
    if (result.source !== "hosted") throw new Error("expected hosted");
    expect(result.url).toBe(`${base}/media/alt.wav`);
    expect(result.contentType).toBe("audio/wav");
  });

  test("normalizes Stable Audio direct string audio URL output", async () => {
    state.responseBody = {
      audio: `${base}/media/stable-audio.wav`,
      seed: 123,
    };

    const result = await generateFalAudio({
      kind: "sfx",
      model: "fal-ai/stable-audio-25/text-to-audio",
      prompt: "x",
      apiKeys,
    });
    if (result.source !== "hosted") throw new Error("expected hosted");
    expect(result.url).toBe(`${base}/media/stable-audio.wav`);
  });

  test("completed job without audio throws", async () => {
    state.responseBody = { detail: "nothing here" };

    await expect(
      generateFalAudio({
        kind: "sfx",
        model: "fal-ai/stable-audio-25/text-to-audio",
        prompt: "x",
        apiKeys,
      }),
    ).rejects.toThrow(/returned no audio URL/);
  });
});
