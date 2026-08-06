import type { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as settings from "../utils/settings";
import { createProvider, generateRecap, resolveModelRuntime } from "./client";

const mockGenerateText = vi.hoisted(() => vi.fn());

vi.mock("ai", () => {
  return {
    generateText: mockGenerateText,
  };
});

describe("client", () => {
  const mockProvider = createProvider("test-key", "https://api.x.ai/v1", "xai");

  describe("generateRecap", () => {
    beforeEach(() => {
      mockGenerateText.mockReset();
    });

    it("generates a normalized recap with the recap prompt contract", async () => {
      const signal = new AbortController().signal;
      mockGenerateText.mockResolvedValue({
        text: ' "Wrapped up the parser fix. Next step is wiring the new recap banner." ',
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      } as Awaited<ReturnType<typeof generateText>>);

      const result = await generateRecap(mockProvider, "transcript body", signal);

      expect(result).toEqual({
        recap: "Wrapped up the parser fix. Next step is wiring the new recap banner.",
        modelId: "grok-4.20-non-reasoning",
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      });
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          abortSignal: signal,
          maxOutputTokens: 120,
          prompt: "transcript body",
          system: expect.stringContaining("Maximum 3 sentences total"),
        }),
      );
    });

    it("returns an empty recap when generation fails", async () => {
      mockGenerateText.mockRejectedValue(new Error("boom"));

      const result = await generateRecap(mockProvider, "transcript body");

      expect(result).toEqual({
        recap: "",
        modelId: "grok-4.20-non-reasoning",
      });
    });
  });

  describe("resolveModelRuntime", () => {
    describe("without configured reasoning effort", () => {
      it("does not include providerOptions for grok-3-mini when no effort configured", () => {
        const runtime = resolveModelRuntime(mockProvider, "grok-3-mini");
        expect(runtime.modelId).toBe("grok-3-mini");
        expect(runtime.providerOptions).toBeUndefined();
      });

      it("normalizes retired flagship reasoning models to grok-4.3", () => {
        const runtime = resolveModelRuntime(mockProvider, "grok-4-0709");
        expect(runtime.modelId).toBe("grok-4.3");
        expect(runtime.providerOptions).toBeUndefined();
      });

      it("normalizes retired code models to grok-4.3", () => {
        const runtime = resolveModelRuntime(mockProvider, "grok-code-fast-1");
        expect(runtime.modelId).toBe("grok-4.3");
        expect(runtime.providerOptions).toBeUndefined();
      });

      it("normalizes retired fast reasoning models to grok-4.3", () => {
        const runtime = resolveModelRuntime(mockProvider, "grok-4-1-fast-reasoning");
        expect(runtime.modelId).toBe("grok-4.3");
        expect(runtime.providerOptions).toBeUndefined();
      });

      it("does not include providerOptions for grok-4.20-multi-agent", () => {
        const runtime = resolveModelRuntime(mockProvider, "grok-4.20-multi-agent");
        expect(runtime.modelId).toBe("grok-4.20-multi-agent-0309");
        expect(runtime.providerOptions).toBeUndefined();
      });

      it("normalizes retired non-reasoning models to grok-4.20-non-reasoning", () => {
        const runtime = resolveModelRuntime(mockProvider, "grok-3");
        expect(runtime.modelId).toBe("grok-4.20-non-reasoning");
        expect(runtime.providerOptions).toBeUndefined();
      });
    });

    describe("with configured reasoning effort", () => {
      beforeEach(() => {
        vi.spyOn(settings, "getReasoningEffortForModel");
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("includes providerOptions with reasoningEffort for grok-3-mini when effort is configured", () => {
        vi.spyOn(settings, "getReasoningEffortForModel").mockReturnValue("high");
        const runtime = resolveModelRuntime(mockProvider, "grok-3-mini");
        expect(runtime.modelId).toBe("grok-3-mini");
        expect(runtime.providerOptions).toEqual({
          xai: {
            reasoningEffort: "high",
          },
        });
      });

      it("includes providerOptions with low effort for grok-3-mini when configured", () => {
        vi.spyOn(settings, "getReasoningEffortForModel").mockReturnValue("low");
        const runtime = resolveModelRuntime(mockProvider, "grok-3-mini");
        expect(runtime.modelId).toBe("grok-3-mini");
        expect(runtime.providerOptions).toEqual({
          xai: {
            reasoningEffort: "low",
          },
        });
      });

      it("does not include providerOptions for retired reasoning aliases even when effort is configured", () => {
        vi.spyOn(settings, "getReasoningEffortForModel").mockReturnValue("high");
        const runtime = resolveModelRuntime(mockProvider, "grok-4-0709");
        expect(runtime.modelId).toBe("grok-4.3");
        expect(runtime.providerOptions).toBeUndefined();
      });

      it("does not include providerOptions for retired code aliases even when effort is configured", () => {
        vi.spyOn(settings, "getReasoningEffortForModel").mockReturnValue("high");
        const runtime = resolveModelRuntime(mockProvider, "grok-code-fast-1");
        expect(runtime.modelId).toBe("grok-4.3");
        expect(runtime.providerOptions).toBeUndefined();
      });

      it("does not include providerOptions for grok-4.3 even when effort is configured", () => {
        vi.spyOn(settings, "getReasoningEffortForModel").mockReturnValue("high");
        const runtime = resolveModelRuntime(mockProvider, "grok-4.3");
        expect(runtime.modelId).toBe("grok-4.3");
        expect(runtime.providerOptions).toBeUndefined();
      });
    });
  });
});
