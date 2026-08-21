/**
 * Tests the McpService stdio reconnect ladder.
 *
 * A stdio server that never comes back must climb the exponential backoff and
 * stop after MAX_RECONNECT_ATTEMPTS; a server that does come back must
 * reconnect and get its ladder reset, so a transient outage is never punished.
 *
 * Deterministic unit harness on fake timers. The real private methods
 * (initializeConnection, deleteConnection, setupTransportHandlers,
 * handleDisconnection) run unmodified — only the MCP SDK client and the stdio
 * transport builder are replaced by local re-implementations, because those are
 * the two places that would otherwise spawn a child process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handshake = vi.hoisted(() => ({ fails: false }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class LocalClient {
    async connect(): Promise<void> {
      if (handshake.fails) {
        throw new Error("MCP handshake failed");
      }
    }
    getServerCapabilities(): Record<string, never> {
      return {};
    }
    async listTools(): Promise<{ tools: [] }> {
      return { tools: [] };
    }
    async listResources(): Promise<{ resources: [] }> {
      return { resources: [] };
    }
    async listResourceTemplates(): Promise<{ resourceTemplates: [] }> {
      return { resourceTemplates: [] };
    }
    async close(): Promise<void> {}
  }
  return { Client: LocalClient };
});

import { McpService } from "../src/service";
import {
  BACKOFF_MULTIPLIER,
  DEFAULT_PING_CONFIG,
  INITIAL_RETRY_DELAY,
  MAX_RECONNECT_ATTEMPTS,
  type McpConnection,
  type McpServerConfig,
  type PingConfig,
} from "../src/types";

const STDIO: McpServerConfig = { type: "stdio", command: "bun", args: ["server.mjs"] };

type LadderInternals = {
  runtime: { reportError: ReturnType<typeof vi.fn> };
  connections: Map<string, McpConnection>;
  connectionStates: Map<string, { status: string; reconnectAttempts: number }>;
  pingConfig: PingConfig;
  initializeConnection: (name: string, config: McpServerConfig) => Promise<void>;
  buildStdioClientTransport: (name: string, config: McpServerConfig) => Promise<unknown>;
};

/** Every delay handed to setTimeout while the fake clock is installed. */
let scheduledDelays: number[] = [];
let restoreSetTimeout: () => void = () => {};

function armedReconnectDelay(): number | undefined {
  const ladderDelays = scheduledDelays.filter((ms) => ms >= INITIAL_RETRY_DELAY);
  return ladderDelays.at(-1);
}

function makeService(): LadderInternals {
  const service = new McpService() as unknown as LadderInternals;
  service.runtime = { reportError: vi.fn() };
  // The ladder is transport-driven; the periodic ping only feeds the same
  // handleDisconnection entry point, so it is off here to keep the fake clock
  // showing nothing but reconnect delays.
  service.pingConfig = { ...DEFAULT_PING_CONFIG, enabled: false };
  service.buildStdioClientTransport = vi.fn(async () => ({
    close: vi.fn(async () => {}),
  }));
  return service;
}

/** Fires the real transport onclose handler installed by setupTransportHandlers. */
async function crashChildProcess(service: LadderInternals): Promise<void> {
  const transport = service.connections.get("srv")?.transport as
    | { onclose?: () => Promise<void> }
    | undefined;
  if (!transport?.onclose) throw new Error("onclose handler was not installed");
  scheduledDelays = [];
  await transport.onclose();
}

/**
 * Runs the armed reconnect timer, letting the real timer callback and the real
 * initializeConnection / handleDisconnection run. Returns the delay that was
 * waited out, or undefined when the service has stopped retrying.
 */
async function runNextReconnect(): Promise<number | undefined> {
  const delayMs = armedReconnectDelay();
  if (delayMs === undefined) return undefined;
  scheduledDelays = [];
  await vi.advanceTimersByTimeAsync(delayMs);
  return delayMs;
}

beforeEach(() => {
  handshake.fails = false;
  vi.useFakeTimers();
  scheduledDelays = [];
  const clockSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    scheduledDelays.push(ms ?? 0);
    return (clockSetTimeout as (...a: unknown[]) => unknown)(handler, ms, ...args);
  }) as typeof globalThis.setTimeout;
  restoreSetTimeout = () => {
    globalThis.setTimeout = clockSetTimeout;
  };
});

afterEach(() => {
  restoreSetTimeout();
  vi.useRealTimers();
});

describe("stdio reconnect ladder", () => {
  it("backs off exponentially and stops after MAX_RECONNECT_ATTEMPTS on a server that never returns", async () => {
    const service = makeService();
    await service.initializeConnection("srv", STDIO);
    expect(service.connections.get("srv")?.server.status).toBe("connected");

    // The child process dies and every later handshake fails.
    handshake.fails = true;
    await crashChildProcess(service);

    const observed: Array<{ attempt: number; delayMs: number }> = [];
    for (let round = 0; round < MAX_RECONNECT_ATTEMPTS * 3; round++) {
      const delayMs = await runNextReconnect();
      if (delayMs === undefined) break;
      observed.push({
        attempt: service.connectionStates.get("srv")?.reconnectAttempts ?? -1,
        delayMs,
      });
    }

    expect(observed.map((entry) => entry.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(observed.map((entry) => entry.delayMs)).toEqual([
      INITIAL_RETRY_DELAY,
      INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER,
      INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** 2,
      INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** 3,
      INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** 4,
    ]);
    // The give-up branch is reached, and it is observable rather than silent.
    expect(armedReconnectDelay()).toBeUndefined();
    expect(service.runtime.reportError).toHaveBeenCalledWith(
      "mcp.reconnect",
      expect.any(Error),
      expect.objectContaining({ serverName: "srv", attempts: MAX_RECONNECT_ATTEMPTS })
    );
  });

  it("reconnects a server that recovers mid-ladder and rearms the full ladder afterwards", async () => {
    const service = makeService();
    await service.initializeConnection("srv", STDIO);

    handshake.fails = true;
    await crashChildProcess(service);
    expect(await runNextReconnect()).toBe(INITIAL_RETRY_DELAY);
    expect(await runNextReconnect()).toBe(INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER);

    // The server comes back before the ladder runs out.
    handshake.fails = false;
    expect(await runNextReconnect()).toBe(INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** 2);
    expect(service.connections.get("srv")?.server.status).toBe("connected");
    expect(service.connectionStates.get("srv")?.reconnectAttempts).toBe(0);
    expect(service.runtime.reportError).not.toHaveBeenCalled();

    // A later outage gets a full fresh ladder, not an immediate give-up.
    handshake.fails = true;
    await crashChildProcess(service);
    expect(armedReconnectDelay()).toBe(INITIAL_RETRY_DELAY);
    expect(await runNextReconnect()).toBe(INITIAL_RETRY_DELAY);
    expect(armedReconnectDelay()).toBe(INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER);
  });

  it("keeps reconnecting a flapping server whose every reconnect succeeds", async () => {
    const service = makeService();
    await service.initializeConnection("srv", STDIO);

    const delays: number[] = [];
    for (let cycle = 0; cycle < MAX_RECONNECT_ATTEMPTS * 2 + 2; cycle++) {
      await crashChildProcess(service);
      const delayMs = await runNextReconnect();
      expect(delayMs).toBe(INITIAL_RETRY_DELAY);
      delays.push(delayMs as number);
      expect(service.connections.get("srv")?.server.status).toBe("connected");
    }

    expect(delays).toHaveLength(MAX_RECONNECT_ATTEMPTS * 2 + 2);
    expect(service.runtime.reportError).not.toHaveBeenCalled();
  });
});
