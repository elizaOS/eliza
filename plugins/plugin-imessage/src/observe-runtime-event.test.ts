/**
 * Regression tests for observeRuntimeEvent — the shared wrapper that keeps
 * iMessage event emissions (connection, inbound, reaction, system, heartbeat)
 * from producing unhandled rejections when a listener throws or rejects.
 * Extends the pattern established for MESSAGE_SENT emissions (#36784).
 *
 * Two levels:
 *  - Unit: observeRuntimeEvent helper in isolation.
 *  - Call-path: IMessageService.emitAuxiliaryEvent (reaction/system path),
 *    verifying the real emission sites use the wrapper.
 */
import type { EventPayload, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { IMessageService, observeRuntimeEvent } from "./service.js";

function mockRuntime() {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    emitEvent: vi.fn(),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime & {
    emitEvent: ReturnType<typeof vi.fn>;
    reportError: ReturnType<typeof vi.fn>;
  };
}

/** Flush pending microtasks deterministically (no timers). */
async function flushMicrotasks(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("observeRuntimeEvent (unit)", () => {
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
      } as EventPayload),
    ).not.toThrow();

    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "IMessageService.test",
      syncError,
      expect.objectContaining({ event: "TEST_EVENT" }),
    );
  });

  it("reports an asynchronously rejecting listener without an unhandled rejection", async () => {
    const runtime = mockRuntime();
    const asyncError = new Error("async listener boom");
    let rejectEmit!: (err: unknown) => void;
    runtime.emitEvent.mockImplementation(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectEmit = reject;
        }),
    );

    observeRuntimeEvent(runtime, "IMessageService.test", "TEST_EVENT", {
      source: "imessage",
    } as EventPayload);

    // Reject after the .catch(reportFailure) handler is attached, then flush
    // microtasks deterministically. No timers, no global unhandledRejection
    // listener: if the wrapper failed to attach .catch, reportError would not
    // be called and this test fails on the assertion below.
    rejectEmit(asyncError);
    await flushMicrotasks();

    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "IMessageService.test",
      asyncError,
      expect.objectContaining({ event: "TEST_EVENT" }),
    );
  });

  it("is a no-op when runtime is undefined", () => {
    expect(() =>
      observeRuntimeEvent(undefined, "IMessageService.test", "TEST_EVENT", {
        source: "imessage",
      } as EventPayload),
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
      { targetGuid: "guid-123" },
    );

    expect(runtime.reportError).toHaveBeenCalledWith(
      "IMessageService.emitAuxiliaryEvent",
      syncError,
      expect.objectContaining({
        event: "REACTION_RECEIVED",
        targetGuid: "guid-123",
      }),
    );
  });
});

describe("emitAuxiliaryEvent (call-path)", () => {
  function serviceWithRuntime(runtime: IAgentRuntime) {
    const service = new IMessageService(runtime);
    return service as unknown as {
      runtime: IAgentRuntime;
      emitAuxiliaryEvent: (row: unknown) => void;
    };
  }

  function reactionRow() {
    return {
      kind: "reaction",
      reaction: {
        add: true,
        kind: "like",
        targetGuid: "guid-123",
        emoji: "👍",
      },
      handle: "+15551234567",
      chatId: "chat-1",
      service: "iMessage",
      rowId: 42,
      guid: "guid-42",
    };
  }

  it("emits both REACTION_RECEIVED events through the wrapper", () => {
    const runtime = mockRuntime();
    runtime.emitEvent.mockResolvedValue(undefined);
    const internal = serviceWithRuntime(runtime);

    internal.emitAuxiliaryEvent(reactionRow());

    // Plugin-namespaced + core generic event.
    expect(runtime.emitEvent).toHaveBeenCalledTimes(2);
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("reports throwing listeners on the reaction path without propagating", async () => {
    const runtime = mockRuntime();
    const asyncError = new Error("reaction listener boom");
    let rejectEmit!: (err: unknown) => void;
    runtime.emitEvent.mockImplementation(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectEmit = reject;
        }),
    );
    const internal = serviceWithRuntime(runtime);

    expect(() => internal.emitAuxiliaryEvent(reactionRow())).not.toThrow();

    rejectEmit(asyncError);
    await flushMicrotasks();

    // Both emissions go through observeRuntimeEvent.
    expect(runtime.emitEvent).toHaveBeenCalledTimes(2);
    expect(runtime.reportError).toHaveBeenCalledTimes(2);
    expect(runtime.reportError).toHaveBeenNthCalledWith(
      1,
      "IMessageService.emitAuxiliaryEvent",
      asyncError,
      expect.objectContaining({ targetGuid: "guid-123" }),
    );
  });

  it("reports throwing listeners on the system-event path", () => {
    const runtime = mockRuntime();
    const syncError = new Error("system listener boom");
    runtime.emitEvent.mockImplementation(() => {
      throw syncError;
    });
    const internal = serviceWithRuntime(runtime);

    const systemRow = {
      kind: "system",
      handle: "+15551234567",
      chatId: "chat-1",
      rowId: 43,
      guid: "guid-43",
    };

    expect(() => internal.emitAuxiliaryEvent(systemRow)).not.toThrow();

    expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "IMessageService.emitAuxiliaryEvent",
      syncError,
      expect.objectContaining({ rowId: 43 }),
    );
  });
});
