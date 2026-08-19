/**
 * Deterministic lifecycle tests for replacement Cloud bridge sockets and their timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";

vi.mock("@elizaos/core", () => ({
  Service: class {
    protected runtime: unknown;
    constructor(runtime?: unknown) {
      this.runtime = runtime;
    }
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

interface FakeSocketEvent {
  code?: number;
  data?: unknown;
  reason?: string;
}

type Listener = (event: FakeSocketEvent) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  readonly send = vi.fn((_data: string): void => {});

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(type: string, event: FakeSocketEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

vi.mock("undici", () => ({ WebSocket: FakeWebSocket }));

describe("CloudBridgeService stale close race", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ignores a stale close event from a socket replaced by a newer establishConnection()", async () => {
    const { CloudBridgeService } = await import("./cloud-bridge");
    const runtime = {} as IAgentRuntime;
    const service = new CloudBridgeService(runtime);
    Reflect.set(service, "authService", {
      getApiKey: () => undefined,
      getClient: () => ({ buildWsUrl: (path: string) => `ws://test${path}` }),
    });

    await service.connect("container-1");
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.emit("open");
    expect(service.getConnectionState("container-1")).toBe("connected");

    const establishConnection = Reflect.get(service, "establishConnection") as (
      containerId: string,
      attempts: number,
    ) => Promise<void>;
    await establishConnection.call(service, "container-1", 0);
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.emit("open");
    expect(service.getConnectionState("container-1")).toBe("connected");

    firstSocket.emit("close", { code: 1006, reason: "late stale event" });

    expect(service.getConnectionState("container-1")).toBe("connected");
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(30_000);
    expect(secondSocket.send).toHaveBeenCalledTimes(1);
  });

  it("cancels a reconnect timer after a manual connection replaces its socket", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { CloudBridgeService } = await import("./cloud-bridge");
    const service = new CloudBridgeService({} as IAgentRuntime);
    Reflect.set(service, "authService", {
      getApiKey: () => undefined,
      getClient: () => ({ buildWsUrl: (path: string) => `ws://test${path}` }),
    });

    await service.connect("container-1");
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.emit("open");
    firstSocket.emit("close", { code: 1006, reason: "network loss" });
    expect(service.getConnectionState("container-1")).toBe("reconnecting");

    await service.connect("container-1");
    const replacementSocket = FakeWebSocket.instances[1];
    replacementSocket.emit("open");
    vi.advanceTimersByTime(6_000);

    expect(service.getConnectionState("container-1")).toBe("connected");
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
