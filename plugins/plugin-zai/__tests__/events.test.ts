import { EventType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { emitModelUsageEvent } from "../utils/events";

describe("z.ai usage events", () => {
  it("emits normalized token usage from prompt/completion fields", () => {
    const runtime = {
      emitEvent: vi.fn(),
    };

    emitModelUsageEvent(runtime as never, "TEXT_SMALL", {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 20,
    });

    expect(runtime.emitEvent).toHaveBeenCalledWith(EventType.MODEL_USED, {
      runtime,
      source: "zai",
      type: "TEXT_SMALL",
      tokens: {
        prompt: 11,
        completion: 7,
        total: 20,
      },
    });
  });

  it("falls back to input/output fields and derives total tokens", () => {
    const runtime = {
      emitEvent: vi.fn(),
    };

    emitModelUsageEvent(runtime as never, "TEXT_LARGE", {
      inputTokens: 5,
      outputTokens: 8,
    });

    expect(runtime.emitEvent).toHaveBeenCalledWith(EventType.MODEL_USED, {
      runtime,
      source: "zai",
      type: "TEXT_LARGE",
      tokens: {
        prompt: 5,
        completion: 8,
        total: 13,
      },
    });
  });
});
