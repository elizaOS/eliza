/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves voice-model list/check/pin/preferences hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  VOICE_MODELS_CHECK_FETCH_TIMEOUT_MS,
  VOICE_MODELS_LIST_FETCH_TIMEOUT_MS,
  VOICE_MODELS_PIN_FETCH_TIMEOUT_MS,
} from "./client-voice-models";
import "./client-voice-models";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient voice-model native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the list deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ installations: [] }),
    );
    await makeClient(request).listVoiceModels();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models",
      expect.any(Object),
      { timeoutMs: VOICE_MODELS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the check deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ lastCheckedAt: "now", statuses: [] }),
    );
    await makeClient(request).checkVoiceModelUpdates();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models/check",
      expect.any(Object),
      { timeoutMs: VOICE_MODELS_CHECK_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the pin deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true, id: "kokoro", pinned: false }),
    );
    await makeClient(request).pinVoiceModel("kokoro", false);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models/kokoro/pin",
      expect.any(Object),
      { timeoutMs: VOICE_MODELS_PIN_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled check hop through ElizaClient", async () => {
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
    await expect(
      makeClient(request).checkVoiceModelUpdates(undefined, 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/voice-models/check",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
