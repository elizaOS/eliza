import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitModelUsageEvent } from "./events";

describe("emitModelUsageEvent", () => {
  const runtime = {
    emitEvent: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    runtime.emitEvent.mockClear();
  });

  it("emits the MODEL_USED event with the plugin as source", async () => {
    await emitModelUsageEvent(
      runtime as never,
      "TEXT_EMBEDDING" as never,
      "prompt text",
      { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    );
    expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
    const [eventName, payload] = runtime.emitEvent.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(eventName).toBe("MODEL_USED");
    expect(payload.source).toBe("plugin-google-genai");
  });

  it("carries the model type through to the payload", async () => {
    await emitModelUsageEvent(
      runtime as never,
      "TEXT_GENERATION" as never,
      "prompt",
      { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    );
    const payload = runtime.emitEvent.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(payload.type).toBe("TEXT_GENERATION");
  });

  it("maps prompt/completion/total token counts into the tokens object", async () => {
    await emitModelUsageEvent(
      runtime as never,
      "TEXT_GENERATION" as never,
      "prompt",
      { promptTokens: 123, completionTokens: 456, totalTokens: 579 },
    );
    const payload = runtime.emitEvent.mock.calls[0][1] as {
      tokens: { prompt: number; completion: number; total: number };
    };
    expect(payload.tokens.prompt).toBe(123);
    expect(payload.tokens.completion).toBe(456);
    expect(payload.tokens.total).toBe(579);
  });

  it("preserves zero and large token counts exactly", async () => {
    await emitModelUsageEvent(
      runtime as never,
      "TEXT_GENERATION" as never,
      "prompt",
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );
    const payload = runtime.emitEvent.mock.calls[0][1] as {
      tokens: { prompt: number; completion: number; total: number };
    };
    expect(payload.tokens).toEqual({ prompt: 0, completion: 0, total: 0 });

    await emitModelUsageEvent(
      runtime as never,
      "TEXT_GENERATION" as never,
      "prompt",
      { promptTokens: 999999999, completionTokens: 1, totalTokens: 1000000000 },
    );
    const payload2 = runtime.emitEvent.mock.calls[1][1] as {
      tokens: { prompt: number; completion: number; total: number };
    };
    expect(payload2.tokens.total).toBe(1000000000);
  });

  it("does not leak the raw prompt into the event payload", async () => {
    await emitModelUsageEvent(
      runtime as never,
      "TEXT_GENERATION" as never,
      "sensitive prompt text",
      { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    );
    const payload = runtime.emitEvent.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(payload.prompt).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("sensitive prompt text");
  });

  it("resolves when emitEvent resolves", async () => {
    await expect(
      emitModelUsageEvent(runtime as never, "TEXT_GENERATION" as never, "p", {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      }),
    ).resolves.toBeUndefined();
  });
});
