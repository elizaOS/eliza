/**
 * Regression tests for observeRuntimeEvent — the shared wrapper that keeps
 * iMessage event emissions (connection, inbound, reaction, system, heartbeat)
 * from producing unhandled rejections when a listener throws or rejects.
 * Extends the pattern established for MESSAGE_SENT emissions (#36784).
 */
import type { EventPayload, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { observeRuntimeEvent } from "../src/service.js";

function mockRuntime() {
  return {
    emitEvent: vi.fn(),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime & {
    emitEvent: ReturnType<typeof vi.fn>;
    reportError: ReturnType<typeof vi.fn>;
  };
}

describe("observeRuntimeEvent", () => {
  it("delivers the event when listeners succeed", () => {
    const runtime = mockRuntime();
    runtime.emitEvent.mockResolvedValue(undefined);

    observeRuntimeEvent(runtime, "IMessageService.test", "TEST_EVENT", {
      source: "imessage",
    } as EventPayload);

    expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
    expect(runtime.emitEvent).toHaveBeenCalledWith("TEST_EVENT", {
      source: "imessage",
    });
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("reports a synchronously throwing emitEvent instead of propagating", () => {
    const runtime = mockRuntime();
    const syncError = new Error("sync listener boom");
    runtime.emitEvent.mockImplementation(() => {
      throw syncError;
    });

    expect(() =>
      observeRuntimeEvent(runtime, "IMessageService.test", "TEST_EVENT", {
        source: "imessage",
      } as EventPayload)
    ).not.toThrow();

    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "IMessageService.test",
      syncError,
      expect.objectContaining({ event: "TEST_EVENT" })
    );
  });

  it("reports an asynchronously rejecting listener without an unhandled rejection", async () => {
    const runtime = mockRuntime();
    const asyncError = new Error("async listener boom");
    runtime.emitEvent.mockRejectedValue(asyncError);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      observeRuntimeEvent(runtime, "IMessageService.test", "TEST_EVENT", {
        source: "imessage",
      } as EventPayload);

      // Let the .catch(reportFailure) microtask run.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "IMessageService.test",
      asyncError,
      expect.objectContaining({ event: "TEST_EVENT" })
    );
  });

  it("is a no-op when runtime is undefined", () => {
    expect(() =>
      observeRuntimeEvent(undefined, "IMessageService.test", "TEST_EVENT", {
        source: "imessage",
      } as EventPayload)
    ).not.toThrow();
  });

  it("includes caller context in the report", () => {
    const runtime = mockRuntime();
    const syncError = new Error("boom");
    runtime.emitEvent.mockImplementation(() => {
      throw syncError;
    });

    observeRuntimeEvent(
      runtime,
      "IMessageService.emitAuxiliaryEvent",
      "REACTION_RECEIVED",
      { source: "imessage" } as EventPayload,
      { targetGuid: "guid-123" }
    );

    expect(runtime.reportError).toHaveBeenCalledWith(
      "IMessageService.emitAuxiliaryEvent",
      syncError,
      expect.objectContaining({
        event: "REACTION_RECEIVED",
        targetGuid: "guid-123",
      })
    );
  });
});
