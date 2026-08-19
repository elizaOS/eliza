/**
 * Regression coverage for a stale-close race in CloudBridgeService: a socket
 * replaced by a newer establishConnection() call can still deliver its
 * "close" event after the replacement is already connected. Without a
 * same-instance guard, that late close mutates the CURRENT connection entry
 * (looked up fresh by containerId in scheduleReconnect()), moving an active
 * replacement out of "connected" and scheduling an unwanted reconnect on top
 * of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";

// The real @elizaos/core pulls in a generated-codegen dependency
// (i18n/validation-keywords.ts -> ./generated/validation-keyword-data.ts)
// that isn't present in a plain checkout and is unrelated to this race --
// stub the two exports cloud-bridge.ts actually uses.
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

type Listener = (event: any) => void;

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

  send(_data: string): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

vi.mock("undici", () => ({ WebSocket: FakeWebSocket }));

describe("CloudBridgeService stale close race", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });

  it("ignores a stale close event from a socket replaced by a newer establishConnection()", async () => {
    const { CloudBridgeService } = await import("./cloud-bridge");
    const runtime = {} as IAgentRuntime;
    const service = new CloudBridgeService(runtime);
    // Bypass initialize()'s CLOUD_AUTH dependency -- not relevant to the
    // connection-replacement race under test.
    (service as any).authService = {
      getApiKey: () => undefined,
      getClient: () => ({ buildWsUrl: (path: string) => `ws://test${path}` }),
    };

    await service.connect("container-1");
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.emit("open");
    expect(service.getConnectionState("container-1")).toBe("connected");

    // Simulate the first socket disconnecting uncleanly and a replacement
    // being established, but the first socket's own "close" event is
    // delivered late -- after the replacement has already opened.
    const disconnect = (service as any).establishConnection(
      "container-1",
      0,
    ) as Promise<void>;
    await disconnect;
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.emit("open");
    expect(service.getConnectionState("container-1")).toBe("connected");

    firstSocket.emit("close", { code: 1006, reason: "late stale event" });

    expect(service.getConnectionState("container-1")).toBe("connected");
    // No spurious third connection attempt scheduled off the stale close.
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
