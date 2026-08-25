import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitModelUsed,
  estimateEmbeddingUsage,
  estimateUsage,
  normalizeTokenUsage,
} from "./modelUsage";

describe("normalizeTokenUsage", () => {
  it("returns undefined for non-object input", () => {
    expect(normalizeTokenUsage(undefined)).toBeUndefined();
    expect(normalizeTokenUsage(null)).toBeUndefined();
    expect(normalizeTokenUsage("tokens")).toBeUndefined();
    expect(normalizeTokenUsage(42)).toBeUndefined();
  });

  it("returns undefined when no usable token fields exist", () => {
    expect(normalizeTokenUsage({})).toBeUndefined();
    expect(normalizeTokenUsage({ promptTokens: "many" })).toBeUndefined();
  });

  it("maps canonical fields", () => {
    expect(
      normalizeTokenUsage({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      })
    ).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("falls back to inputTokens/outputTokens aliases", () => {
    expect(normalizeTokenUsage({ inputTokens: 7, outputTokens: 3 })).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });
  });

  it("derives total from prompt + completion when absent", () => {
    expect(normalizeTokenUsage({ promptTokens: 2, completionTokens: 3 })).toEqual({
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
    });
  });

  it("rejects NaN, Infinity and negative values as absent", () => {
    expect(
      normalizeTokenUsage({
        promptTokens: NaN,
        completionTokens: Infinity,
        totalTokens: -1,
      })
    ).toBeUndefined();
    expect(
      normalizeTokenUsage({
        promptTokens: -5,
        completionTokens: 3,
      })
    ).toEqual({ promptTokens: 0, completionTokens: 3, totalTokens: 3 });
  });

  it("keeps explicit zero totals", () => {
    expect(normalizeTokenUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});

describe("estimateUsage", () => {
  it("estimates from string responses", () => {
    const r = estimateUsage("hello", "world");
    expect(r).toEqual({
      promptTokens: Math.ceil(5 / 4),
      completionTokens: Math.ceil(5 / 4),
      totalTokens: Math.ceil(5 / 4) + Math.ceil(5 / 4),
      estimated: true,
    });
  });

  it("estimates from object responses via JSON serialization", () => {
    const r = estimateUsage("hi", { ok: true });
    expect(r.promptTokens).toBe(Math.ceil(2 / 4));
    expect(r.completionTokens).toBe(Math.ceil(9 / 4));
    expect(r.estimated).toBe(true);
  });

  it("serializes unserializable responses instead of crashing", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => estimateUsage("hi", circular)).not.toThrow();
    const r = estimateUsage("hi", circular);
    expect(r.completionTokens).toBeGreaterThan(0);
  });

  it("handles an undefined response instead of crashing", () => {
    expect(() => estimateUsage("hi", undefined)).not.toThrow();
    const r = estimateUsage("hi", undefined);
    expect(r.promptTokens).toBeGreaterThan(0);
    expect(r.estimated).toBe(true);
    expect(r.totalTokens).toBe(r.promptTokens + r.completionTokens);
  });

  it("handles a null response", () => {
    expect(() => estimateUsage("hi", null)).not.toThrow();
  });

  it("returns zero for empty prompt and empty response", () => {
    expect(estimateUsage("", "")).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: true,
    });
  });
});

describe("estimateEmbeddingUsage", () => {
  it("counts only prompt tokens", () => {
    expect(estimateEmbeddingUsage("abcd")).toEqual({
      promptTokens: 1,
      completionTokens: 0,
      totalTokens: 1,
      estimated: true,
    });
  });
});

describe("emitModelUsed", () => {
  let runtime: { emitEvent: ReturnType<typeof vi.fn>; reportError: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    runtime = {
      emitEvent: vi.fn().mockResolvedValue(undefined),
      reportError: vi.fn(),
    };
  });

  it("throws when the model name is blank after trimming", () => {
    expect(() =>
      emitModelUsed(runtime, "text", "   ", {
        promptTokens: 1,
        completionTokens: 0,
        totalTokens: 1,
      })
    ).toThrow(/MODEL_USED requires the concrete Ollama model name/);
  });

  it("emits the MODEL_USED event with trimmed model and token accounting", () => {
    emitModelUsed(runtime, "text", "  llama3  ", {
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
    });
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      "MODEL_USED",
      expect.objectContaining({
        source: "ollama",
        provider: "ollama",
        model: "llama3",
        tokens: { prompt: 2, completion: 3, total: 5 },
      })
    );
  });

  it("flags estimated usage", () => {
    emitModelUsed(runtime, "text", "llama3", {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      estimated: true,
    });
    const payload = runtime.emitEvent.mock.calls[0][1];
    expect(payload.tokens.estimated).toBe(true);
    expect(payload.usageEstimated).toBe(true);
  });

  it("swallows emission failures and reports them through the runtime diagnostics channel", async () => {
    const failure = new Error("emit boom");
    runtime.emitEvent.mockRejectedValue(failure);
    expect(() =>
      emitModelUsed(runtime, "text", "llama3", {
        promptTokens: 1,
        completionTokens: 0,
        totalTokens: 1,
      })
    ).not.toThrow();
    await vi.waitFor(() => {
      expect(runtime.reportError).toHaveBeenCalledWith(
        "plugin-zerollama.model-usage",
        failure,
        expect.objectContaining({ model: "llama3" })
      );
    });
  });
});
