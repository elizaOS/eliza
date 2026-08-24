/**
 * Unit coverage for SSE stream writer: event formatting, heartbeat scheduling,
 * and graceful close handling. Deterministic — mocked WritableStream and fake
 * timers, real writer logic.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createStreamWriter, SSE_HEADERS } from "./stream-utils";

function mockWriter(overrides: Partial<WritableStreamDefaultWriter<Uint8Array>> = {}) {
  return {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SSE_HEADERS", () => {
  test("has correct SSE content type and cache controls", () => {
    expect(SSE_HEADERS["Content-Type"]).toBe("text/event-stream");
    expect(SSE_HEADERS["Cache-Control"]).toBe("no-cache, no-store, must-revalidate");
    expect(SSE_HEADERS.Connection).toBe("keep-alive");
  });
});

describe("createStreamWriter", () => {
  test("sendEvent writes SSE format and returns true", async () => {
    const writer = mockWriter();
    const stream = createStreamWriter(writer);
    const ok = await stream.sendEvent("message", { hello: "world" });
    expect(ok).toBe(true);
    expect(writer.write).toHaveBeenCalledTimes(1);
    const encoded = (writer.write as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as Uint8Array;
    const text = new TextDecoder().decode(encoded);
    expect(text).toBe('event: message\ndata: {"hello":"world"}\n\n');
    expect(stream.isConnected()).toBe(true);
  });

  test("sendEvent returns false when already disconnected", async () => {
    const writer = mockWriter();
    const stream = createStreamWriter(writer);
    await stream.close();
    expect(stream.isConnected()).toBe(false);
    const ok = await stream.sendEvent("message", { x: 1 });
    expect(ok).toBe(false);
    expect(writer.write).toHaveBeenCalledTimes(0);
  });

  test("sendEvent handles WritableStream closed error and disconnects", async () => {
    const writer = mockWriter({
      write: vi.fn(async () => {
        throw new Error("WritableStream is closed");
      }),
    });
    const stream = createStreamWriter(writer);
    const ok = await stream.sendEvent("test", { a: 1 });
    expect(ok).toBe(false);
    expect(stream.isConnected()).toBe(false);
    const second = await stream.sendEvent("test", { a: 1 });
    expect(second).toBe(false);
  });

  test("sendEvent handles generic error and disconnects", async () => {
    const writer = mockWriter({
      write: vi.fn(async () => {
        throw new Error("network failure");
      }),
    });
    const stream = createStreamWriter(writer);
    const ok = await stream.sendEvent("test", null);
    expect(ok).toBe(false);
    expect(stream.isConnected()).toBe(false);
  });

  test("startHeartbeat and stopHeartbeat manage interval", async () => {
    const writer = mockWriter();
    const stream = createStreamWriter(writer);
    stream.startHeartbeat(2000);
    expect((stream as unknown as { isConnected: () => boolean }).isConnected()).toBe(true);
    stream.stopHeartbeat();
    vi.advanceTimersByTime(5000);
    expect(writer.write).toHaveBeenCalledTimes(0);
  });

  test("heartbeat sends when idle and stops when disconnected", async () => {
    const writer = mockWriter();
    const stream = createStreamWriter(writer);
    await stream.sendEvent("init", { x: 1 });
    vi.clearAllMocks();
    stream.startHeartbeat(2000);
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.write).toHaveBeenCalled();
    stream.stopHeartbeat();
  });

  test("close clears heartbeat and closes writer", async () => {
    const writer = mockWriter();
    const stream = createStreamWriter(writer);
    stream.startHeartbeat(1000);
    await stream.close();
    expect(stream.isConnected()).toBe(false);
    expect(writer.close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(writer.write).toHaveBeenCalledTimes(0);
  });

  test("close handles writer close throwing non-closed error gracefully", async () => {
    const writer = mockWriter({
      close: vi.fn(async () => {
        throw new Error("unexpected close error");
      }),
    });
    const stream = createStreamWriter(writer);
    await expect(stream.close()).resolves.toBeUndefined();
    expect(stream.isConnected()).toBe(false);
  });

  test("close handles already closed writer silently", async () => {
    const writer = mockWriter({
      close: vi.fn(async () => {
        throw new Error("closed");
      }),
    });
    const stream = createStreamWriter(writer);
    await expect(stream.close()).resolves.toBeUndefined();
    expect(stream.isConnected()).toBe(false);
  });
});
