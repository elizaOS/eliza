/**
 * Regression tests for the McpService stdio reconnect ladder when the failure is
 * at *transport construction* time (buildStdioClientTransport throws) rather than
 * at the MCP handshake.
 *
 * This is the path service-reconnect-ladder.test.ts does not exercise. There the
 * stubbed builder always succeeds and the client's connect() throws, so the
 * McpConnection is already stored in the map when the failure lands. When the
 * builder itself throws — a persistently-down stdio server whose child process
 * never spawns (slow restart, transient crash, bad PATH) — initializeConnection's
 * leading deleteConnection has already wiped the map entry and the throw skips the
 * re-add. Before the fix the reconnect timer read the config back off that (now
 * missing) McpConnection, found undefined, and abandoned the server after a single
 * retry, defeating MAX_RECONNECT_ATTEMPTS and the exponential backoff entirely.
 *
 * Deterministic unit harness on fake timers: the real private methods
 * (initializeConnection, deleteConnection, setupTransportHandlers,
 * handleDisconnection) run unmodified; only the MCP SDK client and the stdio
 * transport builder are replaced so nothing spawns a child process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class LocalClient {
    async connect(): Promise<void> {}
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
  type ConnectionState,
  DEFAULT_PING_CONFIG,
  INITIAL_RETRY_DELAY,
  MAX_RECONNECT_ATTEMPTS,
  type McpConnection,
  type McpServerConfig,
  type PingConfig,
} from "../src/types";

const STDIO: McpServerConfig = { type: "stdio", command: "bun", args: ["server.mjs"] };

type BuildLadderInternals = {
  runtime: { reportError: ReturnType<typeof vi.fn> };
  connections: Map<string, McpConnection>;
  connectionStates: Map<string, ConnectionState>;
  pingConfig: PingConfig;
  initializeConnection: (name: string, config: McpServerConfig) => Promise<void>;
  buildStdioClientTransport: (name: string, config: McpServerConfig) => Promise<unknown>;
  handleDisconnection: (name: string, error: unknown) => void;
};

/** Toggles whether the stubbed transport builder throws (server "down"). */
const builder = { fails: false, calls: 0 };

/** Every delay handed to setTimeout while the fake clock is installed. */
let scheduledDelays: number[] = [];
let restoreSetTimeout: () => void = () => {};

function armedReconnectDelay(): number | undefined {
  const ladderDelays = scheduledDelays.filter((ms) => ms >= INITIAL_RETRY_DELAY);
  return ladderDelays.at(-1);
}

function makeService(): BuildLadderInternals {
  const service = new McpService() as unknown as BuildLadderInternals;
  service.runtime = { reportError: vi.fn() };
  service.pingConfig = { ...DEFAULT_PING_CONFIG, enabled: false };
  service.buildStdioClientTransport = vi.fn(async () => {
    builder.calls++;
    if (builder.fails) {
      throw new Error("spawn server.mjs ENOENT: stdio child process is down");
    }
    return { close: vi.fn(async () => {}) };
  });
  return service;
}

/** Fires the real onclose handler installed by setupTransportHandlers. */
async function crashChildProcess(service: BuildLadderInternals): Promise<void> {
  const transport = service.connections.get("srv")?.transport as
    | { onclose?: () => Promise<void> }
    | undefined;
  if (!transport?.onclose) throw new Error("onclose handler was not installed");
  scheduledDelays = [];
  await transport.onclose();
}

/**
 * Runs the armed reconnect timer, letting the real timer callback, the real
 * initializeConnection, and the real handleDisconnection run. Returns the delay
 * that was waited out, or undefined once the service has stopped retrying.
 */
async function runNextReconnect(): Promise<number | undefined> {
  const delayMs = armedReconnectDelay();
  if (delayMs === undefined) return undefined;
  scheduledDelays = [];
  await vi.advanceTimersByTimeAsync(delayMs);
  return delayMs;
}

beforeEach(() => {
  builder.fails = false;
  builder.calls = 0;
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

describe("stdio reconnect ladder — transport-build failure", () => {
  it("retries MAX_RECONNECT_ATTEMPTS times with exponential backoff when the transport build keeps throwing", async () => {
    const service = makeService();
    await service.initializeConnection("srv", STDIO);
    expect(service.connections.get("srv")?.server.status).toBe("connected");

    // Every later child-process spawn fails: the builder throws before any
    // McpConnection is stored, so the map entry stays gone for the whole ladder.
    builder.fails = true;
    const buildsBeforeLadder = builder.calls;
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

    // Each ladder step invoked the (throwing) builder exactly once, five times.
    expect(builder.calls - buildsBeforeLadder).toBe(MAX_RECONNECT_ATTEMPTS);
    expect(observed.map((entry) => entry.attempt)).toEqual([1, 2, 3, 4, 5]);
    // Backoff grows 2s -> 4s -> 8s -> 16s -> 32s (INITIAL * 2^n).
    expect(observed.map((entry) => entry.delayMs)).toEqual([
      INITIAL_RETRY_DELAY,
      INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER,
      INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** 2,
      INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** 3,
      INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** 4,
    ]);
    // The give-up branch is reached and is observable, not silent, even though
    // no McpConnection survives for getServers to report.
    expect(armedReconnectDelay()).toBeUndefined();
    expect(service.connections.has("srv")).toBe(false);
    expect(service.connectionStates.get("srv")?.status).toBe("disconnected");
    expect(service.runtime.reportError).toHaveBeenCalledWith(
      "mcp.reconnect",
      expect.any(Error),
      expect.objectContaining({ serverName: "srv", attempts: MAX_RECONNECT_ATTEMPTS })
    );
  });

  it("does not loop or throw when the reconnect fires after the connection map entry was removed", async () => {
    const service = makeService();
    await service.initializeConnection("srv", STDIO);

    builder.fails = true;
    await crashChildProcess(service);

    // First retry deletes the McpConnection and the build throws, so the map
    // entry is gone. The second retry must still fire off the persisted config,
    // not skip because connections.get('srv') is undefined.
    expect(await runNextReconnect()).toBe(INITIAL_RETRY_DELAY);
    expect(service.connections.has("srv")).toBe(false);
    expect(service.connectionStates.get("srv")?.reconnectAttempts).toBe(1);

    expect(await runNextReconnect()).toBe(INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER);
    expect(service.connectionStates.get("srv")?.reconnectAttempts).toBe(2);
    expect(armedReconnectDelay()).toBe(INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** 2);
  });

  it("reconnects and resets the ladder when the child process comes back mid-ladder", async () => {
    const service = makeService();
    await service.initializeConnection("srv", STDIO);

    builder.fails = true;
    await crashChildProcess(service);
    expect(await runNextReconnect()).toBe(INITIAL_RETRY_DELAY);
    expect(await runNextReconnect()).toBe(INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER);
    expect(service.connectionStates.get("srv")?.reconnectAttempts).toBe(2);

    // The child process comes back on the third attempt.
    builder.fails = false;
    expect(await runNextReconnect()).toBe(INITIAL_RETRY_DELAY * BACKOFF_MULTIPLIER ** 2);
    expect(service.connections.get("srv")?.server.status).toBe("connected");
    expect(service.connectionStates.get("srv")?.reconnectAttempts).toBe(0);
    expect(service.runtime.reportError).not.toHaveBeenCalled();

    // A later outage gets a full fresh ladder, not an immediate give-up.
    builder.fails = true;
    await crashChildProcess(service);
    expect(armedReconnectDelay()).toBe(INITIAL_RETRY_DELAY);
  });
});
