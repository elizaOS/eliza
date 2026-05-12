import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { getTtsProviderStatus, resolveTtsConfig } from "./tts-stream-bridge.ts";

function runtimeWithTtsHandler(enabled: boolean) {
  return {
    models: new Map(
      enabled
        ? [
            [
              ModelType.TEXT_TO_SPEECH,
              [{ provider: "eliza-local-inference", handler: vi.fn() }],
            ],
          ]
        : [],
    ),
  };
}

function runtimeWithEdgeTtsOnly() {
  return {
    models: new Map([
      [
        ModelType.TEXT_TO_SPEECH,
        [{ provider: "edge-tts", handler: vi.fn() }],
      ],
    ]),
  };
}

describe("resolveTtsConfig", () => {
  it("resolves explicit local-inference TTS through the runtime model surface", () => {
    const runtime = runtimeWithTtsHandler(true);

    const resolved = resolveTtsConfig(
      { enabled: true, provider: "local-inference" },
      runtime as never,
    );

    expect(resolved?.provider).toBe("local-inference");
    expect(resolved?.runtime).toBe(runtime);
  });

  it("returns no provider for explicit local-inference when the backend is unavailable", () => {
    const resolved = resolveTtsConfig(
      { enabled: true, provider: "local-inference" },
      runtimeWithTtsHandler(false) as never,
    );

    expect(resolved).toBeNull();
  });

  it("does not resolve explicit local-inference to a generic Edge TTS handler", () => {
    const resolved = resolveTtsConfig(
      { enabled: true, provider: "local-inference" },
      runtimeWithEdgeTtsOnly() as never,
    );

    expect(resolved).toBeNull();
  });

  it("does not choose Edge TTS as an implicit non-Eliza fallback", () => {
    const oldElevenLabs = process.env.ELEVENLABS_API_KEY;
    const oldOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(resolveTtsConfig({ enabled: true })).toBeNull();
    } finally {
      if (oldElevenLabs === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = oldElevenLabs;
      if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAi;
    }
  });

  it("still allows Edge TTS when explicitly configured", () => {
    const resolved = resolveTtsConfig({ enabled: true, provider: "edge" });

    expect(resolved).toMatchObject({
      provider: "edge",
      edge: { voice: "en-US-AriaNeural" },
    });
  });

  it("reports local-inference as keyless but resolved when available", () => {
    const status = getTtsProviderStatus(
      { enabled: true, provider: "local-inference" },
      runtimeWithTtsHandler(true) as never,
    );

    expect(status).toEqual({
      configuredProvider: "local-inference",
      hasApiKey: false,
      resolvedProvider: "local-inference",
    });
  });
});
