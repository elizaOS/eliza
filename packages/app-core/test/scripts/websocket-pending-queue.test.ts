/** Exercises websocket pending queue behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  clearPendingWebSocketQueue,
  createPendingWebSocketQueueState,
  drainPendingWebSocketQueue,
  enqueuePendingWebSocketMessage,
  websocketSendDataByteLength,
} from "../../scripts/lib/websocket-pending-queue.ts";

describe("websocket pending queue", () => {
  it("measures websocket send payload sizes", () => {
    expect(websocketSendDataByteLength("hello")).toBe(5);
    expect(websocketSendDataByteLength(Buffer.from("hello"))).toBe(5);
    expect(websocketSendDataByteLength(new Uint8Array([1, 2, 3]))).toBe(3);
    expect(
      websocketSendDataByteLength([Buffer.from("hello"), Buffer.from("world")]),
    ).toBe(10);
  });

  it("rejects count overflow without changing the queue", () => {
    const queue = createPendingWebSocketQueueState<Buffer>();
    const limits = { maxMessages: 2, maxMessageBytes: 100, maxBytes: 100 };

    enqueuePendingWebSocketMessage(
      queue,
      { data: Buffer.from("one"), isBinary: true },
      limits,
    );
    enqueuePendingWebSocketMessage(
      queue,
      { data: Buffer.from("two"), isBinary: true },
      limits,
    );
    expect(
      enqueuePendingWebSocketMessage(
        queue,
        { data: Buffer.from("three"), isBinary: true },
        limits,
      ),
    ).toBe(false);

    expect(queue.messages.map((message) => message.data.toString())).toEqual([
      "one",
      "two",
    ]);
  });

  it("rejects byte-budget overflow without changing the queue", () => {
    const queue = createPendingWebSocketQueueState<Buffer>();
    const limits = { maxMessages: 10, maxMessageBytes: 10, maxBytes: 8 };

    enqueuePendingWebSocketMessage(
      queue,
      { data: Buffer.from("aaaa"), isBinary: true },
      limits,
    );
    enqueuePendingWebSocketMessage(
      queue,
      { data: Buffer.from("bbbb"), isBinary: true },
      limits,
    );
    expect(
      enqueuePendingWebSocketMessage(
        queue,
        { data: Buffer.from("cccc"), isBinary: true },
        limits,
      ),
    ).toBe(false);

    expect(queue.bytes).toBe(8);
    expect(queue.messages.map((message) => message.data.toString())).toEqual([
      "aaaa",
      "bbbb",
    ]);
  });

  it("rejects oversized single messages without changing the queue", () => {
    const queue = createPendingWebSocketQueueState<Buffer>();
    const limits = { maxMessages: 10, maxMessageBytes: 4, maxBytes: 20 };

    enqueuePendingWebSocketMessage(
      queue,
      { data: Buffer.from("ok"), isBinary: true },
      limits,
    );
    expect(
      enqueuePendingWebSocketMessage(
        queue,
        { data: Buffer.from("too-large"), isBinary: true },
        limits,
      ),
    ).toBe(false);

    expect(queue.bytes).toBe(2);
    expect(queue.messages.map((message) => message.data.toString())).toEqual([
      "ok",
    ]);
  });

  it("drains and clears byte accounting", () => {
    const queue = createPendingWebSocketQueueState<Buffer>();
    enqueuePendingWebSocketMessage(queue, {
      data: Buffer.from("hello"),
      isBinary: true,
    });

    expect(drainPendingWebSocketQueue(queue)).toHaveLength(1);
    expect(queue.messages).toHaveLength(0);
    expect(queue.bytes).toBe(0);

    enqueuePendingWebSocketMessage(queue, {
      data: Buffer.from("hello"),
      isBinary: true,
    });
    clearPendingWebSocketQueue(queue);
    expect(queue.messages).toHaveLength(0);
    expect(queue.bytes).toBe(0);
  });
});
