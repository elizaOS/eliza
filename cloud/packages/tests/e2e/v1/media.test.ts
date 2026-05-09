import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type EmbeddingsResponse = {
  data?: unknown;
  embeddings?: unknown;
};

/**
 * Media Generation API E2E Tests
 */

describe("Video Generation API", () => {
  test("POST /api/v1/generate-video requires auth", async () => {
    const response = await api.post("/api/v1/generate-video", {
      prompt: "A test video",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/v1/generate-video validates input", async () => {
    const response = await api.post("/api/v1/generate-video", {}, { authenticated: true });
    expect([400, 402, 503]).toContain(response.status);
  });
});

describe("Voice API", () => {
  test("GET /api/v1/voice/list requires auth", async () => {
    const response = await api.get("/api/v1/voice/list");
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/v1/voice/tts requires auth", async () => {
    const response = await api.post("/api/v1/voice/tts", {
      text: "Hello",
      voiceId: "test",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/v1/voice/stt requires auth", async () => {
    const response = await api.post("/api/v1/voice/stt");
    expect([401, 403, 400]).toContain(response.status);
  });

  test("POST /api/v1/voice/clone requires auth", async () => {
    const response = await api.post("/api/v1/voice/clone");
    expect([401, 403, 400]).toContain(response.status);
  });

  test("GET /api/v1/voice/jobs requires auth", async () => {
    const response = await api.get("/api/v1/voice/jobs");
    expect([401, 403]).toContain(response.status);
  });
});

describe("ElevenLabs Voices API", () => {
  test("GET /api/elevenlabs/voices requires auth", async () => {
    const response = await api.get("/api/elevenlabs/voices");
    expect([401, 403]).toContain(response.status);
  });
});

describe("Embeddings API", () => {
  test("POST /api/v1/embeddings requires auth", async () => {
    const response = await api.post("/api/v1/embeddings", {
      input: "Test text",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/v1/embeddings returns embedding vector", async () => {
    const response = await api.post(
      "/api/v1/embeddings",
      {
        input: "Test embedding text",
        model: "text-embedding-3-small",
      },
      { authenticated: true },
    );
    expect([200, 402, 429, 503]).toContain(response.status);

    if (response.status === 200) {
      const body = await readJson<EmbeddingsResponse>(response);
      expect(body.data || body.embeddings).toBeTruthy();
    }
  });
});
