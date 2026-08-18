/** Verifies voice-model list/check/pin/preferences hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  VOICE_MODELS_CHECK_FETCH_TIMEOUT_MS,
  VOICE_MODELS_GET_PREFERENCES_FETCH_TIMEOUT_MS,
  VOICE_MODELS_LIST_FETCH_TIMEOUT_MS,
  VOICE_MODELS_PIN_FETCH_TIMEOUT_MS,
  VOICE_MODELS_SET_PREFERENCES_FETCH_TIMEOUT_MS,
} from "./client-voice-models";
import "./client-voice-models";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClientWithTransport(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient voice-model native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(VOICE_MODELS_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(VOICE_MODELS_CHECK_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(VOICE_MODELS_PIN_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(VOICE_MODELS_GET_PREFERENCES_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(VOICE_MODELS_SET_PREFERENCES_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes list timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ installations: [] }),
    );
    const client = makeClientWithTransport(request);
    await client.listVoiceModels();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models",
      expect.any(Object),
      { timeoutMs: VOICE_MODELS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("passes check timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ lastCheckedAt: "now", statuses: [] }),
    );
    const client = makeClientWithTransport(request);
    await client.checkVoiceModelUpdates();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models/check",
      expect.any(Object),
      { timeoutMs: VOICE_MODELS_CHECK_FETCH_TIMEOUT_MS },
    );
  });

  it("passes force-check timeoutMs on its own hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ lastCheckedAt: "now", statuses: [] }),
    );
    const client = makeClientWithTransport(request);
    await client.checkVoiceModelUpdates({ force: true });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models/check?force=1",
      expect.any(Object),
      { timeoutMs: VOICE_MODELS_CHECK_FETCH_TIMEOUT_MS },
    );
  });

  it("passes pin timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true, id: "kokoro", pinned: true }),
    );
    const client = makeClientWithTransport(request);
    await client.pinVoiceModel("kokoro", true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models/kokoro/pin",
      expect.any(Object),
      { timeoutMs: VOICE_MODELS_PIN_FETCH_TIMEOUT_MS },
    );
  });

  it("passes preferences GET timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({
        preferences: {
          autoUpdateOnWifi: true,
          autoUpdateOnCellular: false,
          autoUpdateOnMetered: false,
          quietHours: [],
        },
      }),
    );
    const client = makeClientWithTransport(request);
    await client.getVoiceModelPreferences();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models/preferences",
      expect.any(Object),
      { timeoutMs: VOICE_MODELS_GET_PREFERENCES_FETCH_TIMEOUT_MS },
    );
  });

  it("passes preferences POST timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({
        ok: true,
        preferences: {
          autoUpdateOnWifi: false,
          autoUpdateOnCellular: false,
          autoUpdateOnMetered: false,
          quietHours: [],
        },
      }),
    );
    const client = makeClientWithTransport(request);
    await client.setVoiceModelPreferences({ autoUpdateOnWifi: false });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models/preferences",
      expect.any(Object),
      { timeoutMs: VOICE_MODELS_SET_PREFERENCES_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled pin hop as TimeoutError", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        await new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              Object.assign(new Error(`Request timed out after ${ms}ms`), {
                name: "TimeoutError",
              }),
            );
          }, ms);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      },
    );
    const client = makeClientWithTransport(request);
    await expect(client.pinVoiceModel("kokoro", true, 10)).rejects.toMatchObject(
      { name: "ApiError", kind: "timeout" },
    );
  });

  it("surfaces a provider error from a completed list GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = makeClientWithTransport(request);
    await expect(client.listVoiceModels()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
