/**
 * Verifies device-side generation ownership and cancellation at the WebSocket
 * protocol boundary while the native adapter is held in a controllable decode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceBridgeClient } from "./device-bridge-client";
import { loadCapacitorLlama } from "./load-capacitor-llama";

vi.mock("./load-capacitor-llama", () => ({
  loadCapacitorLlama: vi.fn(),
}));

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readyState = TestWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("DeviceBridgeClient generation ownership", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    TestWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: TestWebSocket,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  it("cancels the owning native decode and emits no stale result", async () => {
    const generation = deferred<{
      text: string;
      promptTokens: number;
      outputTokens: number;
      durationMs: number;
    }>();
    const cancelGenerate = vi.fn(async () => {});
    vi.mocked(loadCapacitorLlama).mockReturnValue({
      getHardwareInfo: async () => ({
        source: "native",
        platform: "android",
        deviceModel: "test",
        totalRamGb: 8,
        cpuCores: 8,
        gpu: { backend: "vulkan", available: true },
      }),
      isLoaded: async () => ({ loaded: true, modelPath: "/model.gguf" }),
      generate: () => generation.promise,
      cancelGenerate,
    } as never);
    const client = new DeviceBridgeClient({
      agentUrl: "ws://agent/device-bridge",
      deviceId: "android-test",
    });
    client.start();
    const socket = TestWebSocket.instances[0];
    socket.open();
    await flush();

    socket.receive({
      type: "generate",
      correlationId: "generation-a",
      prompt: "continue",
    });
    socket.receive({ type: "cancel", correlationId: "generation-a" });
    await flush();
    expect(cancelGenerate).toHaveBeenCalledTimes(1);

    generation.resolve({
      text: "stale",
      promptTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    });
    await flush();
    expect(
      socket.sent.find(
        (message) =>
          message.type === "generateResult" &&
          message.correlationId === "generation-a",
      ),
    ).toBeUndefined();
    client.stop();
  });

  it("fails a concurrent generation instead of corrupting native ownership", async () => {
    const generation = deferred<{
      text: string;
      promptTokens: number;
      outputTokens: number;
      durationMs: number;
    }>();
    vi.mocked(loadCapacitorLlama).mockReturnValue({
      getHardwareInfo: async () => ({
        source: "native",
        platform: "android",
        deviceModel: "test",
        totalRamGb: 8,
        cpuCores: 8,
        gpu: { backend: "vulkan", available: true },
      }),
      isLoaded: async () => ({ loaded: true, modelPath: "/model.gguf" }),
      generate: () => generation.promise,
      cancelGenerate: async () => {},
    } as never);
    const client = new DeviceBridgeClient({
      agentUrl: "ws://agent/device-bridge",
      deviceId: "android-test",
    });
    client.start();
    const socket = TestWebSocket.instances[0];
    socket.open();
    await flush();

    socket.receive({
      type: "generate",
      correlationId: "generation-a",
      prompt: "first",
    });
    socket.receive({
      type: "generate",
      correlationId: "generation-b",
      prompt: "second",
    });
    await flush();

    expect(socket.sent).toContainEqual({
      type: "generateResult",
      correlationId: "generation-b",
      ok: false,
      error:
        "DEVICE_BUSY: generation generation-a already owns the native context",
    });
    generation.resolve({
      text: "first",
      promptTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    });
    await flush();
    client.stop();
  });
});
