/**
 * Unit tests for `emitModelUsageEvent`: token normalization asserted against a
 * mocked `runtime.emitEvent`, plus a real-runtime regression that a rejecting
 * MODEL_USED handler is captured (error-policy J7) and never leaks an unhandled
 * rejection after a successful model call. The rejecting `emitEvent` is a plain
 * function returning `Promise.reject(...)`, not a vitest mock — vitest mocks
 * internally attach a `.catch` to their result promise and would mask the leak.
 */
import { EventType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitModelUsageEvent } from "../utils/events";

const flushMacrotask = () => new Promise((resolve) => setTimeout(resolve, 50));

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

  describe("when a MODEL_USED handler rejects", () => {
    let unhandled: unknown[];
    let onUnhandled: (reason: unknown) => void;

    beforeEach(() => {
      unhandled = [];
      onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
    });

    afterEach(() => {
      process.off("unhandledRejection", onUnhandled);
    });

    it("captures the emission rejection and reports it without leaking (J7)", async () => {
      const boom = new Error("metering handler boom");
      const reportError = vi.fn();
      // A plain rejecting function models AgentRuntime.emitEvent faithfully:
      // it does `await Promise.all(handlers.map(...))`, so a throwing MODEL_USED
      // handler surfaces as a rejected promise from emitEvent itself.
      const runtime = {
        emitEvent: () => Promise.reject(boom),
        reportError,
      };

      expect(() =>
        emitModelUsageEvent(runtime as never, "TEXT_SMALL", {
          promptTokens: 3,
          completionTokens: 4,
          totalTokens: 7,
        })
      ).not.toThrow();

      // Control: an unguarded rejection in this same test must be collected,
      // proving the unhandledRejection listener is live.
      const control = new Error("control unguarded rejection");
      Promise.reject(control);

      await flushMacrotask();

      // (a) the guarded emission did NOT leak an unhandled rejection.
      expect(unhandled).not.toContain(boom);
      // The live control WAS collected.
      expect(unhandled).toContain(control);
      // (b) the failure was routed to runtime diagnostics.
      expect(reportError).toHaveBeenCalledWith(
        "plugin-zai.model-usage",
        boom,
        expect.objectContaining({ type: "TEXT_SMALL" })
      );
    });
  });
});
