import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleTtsRoutes, type TtsRouteContext } from "./tts-routes.ts";

function riffWav(): Uint8Array {
  const bytes = new Uint8Array(44);
  bytes.set(Buffer.from("RIFF"), 0);
  bytes.set(Buffer.from("WAVE"), 8);
  bytes.set(Buffer.from("data"), 36);
  return bytes;
}

function makeRes() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    body: Buffer.alloc(0),
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    end(body?: Buffer) {
      if (body) this.body = body;
    },
  };
}

function makeContext(
  overrides: Partial<TtsRouteContext> = {},
): TtsRouteContext {
  return {
    req: {} as never,
    res: makeRes() as never,
    method: "POST",
    pathname: "/api/tts/local-inference",
    state: { config: {} },
    json: vi.fn(),
    error: vi.fn((res, message, status = 500) => {
      (res as ReturnType<typeof makeRes>).status = status;
      (res as ReturnType<typeof makeRes>).body = Buffer.from(message);
    }),
    readJsonBody: vi.fn(async () => ({ text: "[singing] hello" })),
    isRedactedSecretValue: vi.fn(() => false),
    fetchWithTimeoutGuard: vi.fn() as never,
    streamResponseBodyWithByteLimit: vi.fn() as never,
    responseContentLength: vi.fn(() => null),
    isAbortError: vi.fn(() => false),
    ELEVENLABS_FETCH_TIMEOUT_MS: 1000,
    ELEVENLABS_AUDIO_MAX_BYTES: 1024,
    ...overrides,
  };
}

describe("handleTtsRoutes local-inference", () => {
  it("routes through a local provider and preserves OmniVoice tags", async () => {
    const useModel = vi.fn(async (_modelType, params, provider) => {
      expect(_modelType).toBe(ModelType.TEXT_TO_SPEECH);
      expect(provider).toBe("eliza-local-inference");
      expect(params).toEqual({ text: "[singing] hello" });
      return riffWav();
    });
    const ctx = makeContext({
      state: { config: {}, runtime: { useModel } as never },
    });

    await expect(handleTtsRoutes(ctx)).resolves.toBe(true);

    const res = ctx.res as unknown as ReturnType<typeof makeRes>;
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("audio/wav");
    expect(res.body.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("forwards local voice, model, speed, sample rate, and format hints", async () => {
    const useModel = vi.fn(async (_modelType, params, provider) => {
      expect(_modelType).toBe(ModelType.TEXT_TO_SPEECH);
      expect(provider).toBe("eliza-local-inference");
      expect(params).toEqual({
        text: "hello",
        voice: "af_bella",
        modelId: "kokoro-q4",
        speed: 1.1,
        sampleRate: 24000,
        format: "wav",
      });
      return riffWav();
    });
    const ctx = makeContext({
      state: { config: {}, runtime: { useModel } as never },
      readJsonBody: vi.fn(async () => ({
        text: "hello",
        voice: "ignored",
        voiceId: "af_bella",
        modelId: "kokoro-q4",
        speed: 1.1,
        sampleRate: 24000,
        format: "wav",
      })),
    });

    await expect(handleTtsRoutes(ctx)).resolves.toBe(true);

    const res = ctx.res as unknown as ReturnType<typeof makeRes>;
    expect(res.status).toBe(200);
  });

  it("forwards model hint to the provider", async () => {
    const useModel = vi.fn(async (_modelType, params, _provider) => {
      expect(params).toMatchObject({
        text: "hi",
        model: "kokoro-onnx",
      });
      return riffWav();
    });
    const ctx = makeContext({
      state: { config: {}, runtime: { useModel } as never },
      readJsonBody: vi.fn(async () => ({
        text: "hi",
        model: "kokoro-onnx",
      })),
    });

    await expect(handleTtsRoutes(ctx)).resolves.toBe(true);

    const res = ctx.res as unknown as ReturnType<typeof makeRes>;
    expect(res.status).toBe(200);
  });

  it("rejects unknown format values", async () => {
    const useModel = vi.fn(async (_modelType, params, _provider) => {
      expect(params).not.toHaveProperty("format");
      return riffWav();
    });
    const ctx = makeContext({
      state: { config: {}, runtime: { useModel } as never },
      readJsonBody: vi.fn(async () => ({
        text: "hi",
        format: "exe",
      })),
    });

    await expect(handleTtsRoutes(ctx)).resolves.toBe(true);
    expect(useModel).toHaveBeenCalled();
  });

  it("fails closed when no local provider is registered", async () => {
    const useModel = vi.fn(async () => {
      throw new Error("No handler found for delegate type: TEXT_TO_SPEECH");
    });
    const ctx = makeContext({
      state: { config: {}, runtime: { useModel } as never },
    });

    await expect(handleTtsRoutes(ctx)).resolves.toBe(true);

    const res = ctx.res as unknown as ReturnType<typeof makeRes>;
    expect(res.status).toBe(502);
    expect(res.body.toString()).toContain("TEXT_TO_SPEECH");
  });
});
