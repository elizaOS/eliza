/**
 * Regression tests for MessageProcessor.emitMessageSent listener isolation.
 *
 * MESSAGE_SENT listeners (trajectory loggers, analytics) are observers. A
 * throwing or rejecting listener must not turn an already-persisted reply
 * into a delivery failure: the delivery paths await emitMessageSent before
 * invoking the reply callback, so a propagated listener error used to skip
 * delivery entirely. Failures are reported via runtime.reportError instead.
 */
import { EventType, type IAgentRuntime, type Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageProcessor, type MessageProcessorHost } from "./processor.js";

function processor() {
  // emitMessageSent does not touch the host; an empty stub is enough.
  return new MessageProcessor({} as MessageProcessorHost);
}

function mockRuntime() {
  return {
    emitEvent: vi.fn(),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime & {
    emitEvent: ReturnType<typeof vi.fn>;
    reportError: ReturnType<typeof vi.fn>;
  };
}

const message = {
  id: "message-1",
  entityId: "entity-1",
  agentId: "agent-1",
  roomId: "room-1",
  content: { text: "hello" },
} as Memory;

describe("MessageProcessor.emitMessageSent", () => {
  it("delivers the event when listeners succeed", async () => {
    const runtime = mockRuntime();
    runtime.emitEvent.mockResolvedValue(undefined);

    await expect(
      processor().emitMessageSent(runtime, message, "test"),
    ).resolves.toBeUndefined();

    expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
    expect(runtime.emitEvent).toHaveBeenCalledWith(EventType.MESSAGE_SENT, {
      runtime,
      message,
      source: "test",
      trajectoryTerminalOwner: "run",
    });
    expect(runtime.reportError).not.toHaveBeenCalled();
  });

  it("reports an asynchronously rejecting listener instead of propagating", async () => {
    const runtime = mockRuntime();
    const asyncError = new Error("analytics listener boom");
    runtime.emitEvent.mockRejectedValue(asyncError);

    await expect(
      processor().emitMessageSent(runtime, message, "test"),
    ).resolves.toBeUndefined();

    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "MessageProcessor.emitMessageSent",
      asyncError,
      expect.objectContaining({
        event: EventType.MESSAGE_SENT,
        messageId: "message-1",
      }),
    );
  });

  it("reports a synchronously throwing listener instead of propagating", async () => {
    const runtime = mockRuntime();
    const syncError = new Error("sync listener boom");
    runtime.emitEvent.mockImplementation(() => {
      throw syncError;
    });

    await expect(
      processor().emitMessageSent(runtime, message, "test"),
    ).resolves.toBeUndefined();

    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "MessageProcessor.emitMessageSent",
      syncError,
      expect.objectContaining({ event: EventType.MESSAGE_SENT }),
    );
  });
});
