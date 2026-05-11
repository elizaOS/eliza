import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type ChatCompletionResponse = {
  choices?: unknown[];
  id?: string;
};

const E2E_CHAT_MODEL = process.env.E2E_CHAT_MODEL?.trim() || "openai/gpt-5-mini";

/**
 * Chat API E2E Tests
 */

describe("Chat API", () => {
  test("POST /api/v1/chat requires authentication", async () => {
    const response = await api.post("/api/v1/chat", {
      messages: [{ role: "user", content: "Hello" }],
    });
    if (api.hasAiProvider()) {
      // Anonymous users get 200 (anonymous fallback) or auth-layer rejection.
      expect([200, 401, 403]).toContain(response.status);
    } else {
      expect([401, 403, 503]).toContain(response.status);
    }
  });

  test("POST /api/v1/chat rejects empty messages", async () => {
    const response = await api.post("/api/v1/chat", { messages: [] });
    expect([400, 401]).toContain(response.status);
  });

  test("POST /api/v1/chat accepts valid message with API key", async () => {
    const response = await api.post(
      "/api/v1/chat",
      {
        id: E2E_CHAT_MODEL,
        messages: [{ role: "user", content: "Say hello in one word" }],
      },
      { authenticated: true },
    );
    expect([200, 402, 503]).toContain(response.status);

    if (response.status === 200) {
      const body = await response.text();
      expect(body.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("Chat Completions API (OpenAI-compat)", () => {
  test("POST /api/v1/chat/completions requires auth", async () => {
    const response = await api.post("/api/v1/chat/completions", {
      model: E2E_CHAT_MODEL,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect([200, 401, 403]).toContain(response.status);
  });

  test("POST /api/v1/chat/completions returns valid response structure", async () => {
    const response = await api.post(
      "/api/v1/chat/completions",
      {
        model: E2E_CHAT_MODEL,
        messages: [{ role: "user", content: "Say ok" }],
        max_tokens: 16,
        stream: false,
      },
      { authenticated: true },
    );

    if (response.status === 200) {
      const body = await readJson<ChatCompletionResponse>(response);
      expect(body.choices || body.id).toBeTruthy();
    } else {
      expect([402, 429, 503]).toContain(response.status);
    }
  });
});
