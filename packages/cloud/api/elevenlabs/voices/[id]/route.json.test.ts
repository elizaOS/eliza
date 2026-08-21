/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const VOICE_ID = "00000000-0000-4000-8000-0000000000aa";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const updateVoice = mock(async () => ({
  id: VOICE_ID,
  name: "demo",
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));
mock.module("@/lib/services/voice-cloning", () => ({
  voiceCloningService: {
    updateVoice,
    getVoiceById: async () => ({ id: VOICE_ID }),
    deleteVoice: async () => undefined,
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("PATCH /api/elevenlabs/voices/:id malformed JSON", () => {
  test("returns 400 instead of 500 and never updates the voice", async () => {
    const response = await app.request(`/${VOICE_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(updateVoice).not.toHaveBeenCalled();
  });

  test("canonical JSON still updates the voice", async () => {
    const response = await app.request(`/${VOICE_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(response.status).toBe(200);
    expect(updateVoice).toHaveBeenCalled();
  });
});
