/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves voice-profile first-run and profile hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  VOICE_PROFILES_APPEND_FETCH_TIMEOUT_MS,
  VOICE_PROFILES_FINALIZE_FETCH_TIMEOUT_MS,
  VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS,
  VoiceProfilesClient,
  VoiceProfilesUnavailableError,
} from "./client-voice-profiles";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeVoices(request: AgentRequestTransport["request"]) {
  const api = new ElizaClient("http://agent.example:2138", "token");
  api.setRequestTransport({ request });
  return new VoiceProfilesClient(api);
}

describe("VoiceProfilesClient ElizaClient native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the append deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({}),
    );
    const voices = makeVoices(request);
    await voices.appendOwnerCapture("s1", {
      promptId: "p1",
      audioBase64: "YQ==",
      durationMs: 1,
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/voice/first-run/profile/append?id=s1",
      expect.any(Object),
      { timeoutMs: VOICE_PROFILES_APPEND_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the finalize deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({
        profileId: "p1",
        entityId: "e1",
        isOwner: true,
      }),
    );
    const voices = makeVoices(request);
    await voices.finalizeOwnerCapture("s1", { displayName: "Shaw" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/voice/first-run/profile/finalize?id=s1",
      expect.any(Object),
      { timeoutMs: VOICE_PROFILES_FINALIZE_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the profile patch deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({}),
    );
    const voices = makeVoices(request);
    await voices.patch("p1", { displayName: "Shaw" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/voice/profiles/p1",
      expect.any(Object),
      { timeoutMs: VOICE_PROFILES_MUTATION_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled finalize hop through ElizaClient", async () => {
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
    const voices = makeVoices(request);
    await expect(
      voices.finalizeOwnerCapture("s1", { displayName: "Shaw" }, 10),
    ).rejects.toBeInstanceOf(VoiceProfilesUnavailableError);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/voice/first-run/profile/finalize?id=s1",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
