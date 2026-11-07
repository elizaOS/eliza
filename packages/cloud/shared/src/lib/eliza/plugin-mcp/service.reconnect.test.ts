import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import type { ConnectionState, McpServerConfig } from "./types";

let failConnect = true;
let connectCalls = 0;
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {
      connectCalls++;
      if (failConnect) throw new Error("server unavailable");
    }
    async close() {}
    getServerCapabilities() {
      return {};
    }
    async listTools() {
      return { tools: [] };
    }
  },
}));
const { McpService } = await import("./service");

type Internals = {
  connect(name: string, config: McpServerConfig): Promise<void>;
  connectionStates: Map<string, ConnectionState>;
  handleDisconnect(name: string, error: Error): void;
};
const timers = new Map<number, { callback: () => Promise<void>; delay: number }>();
let nextTimer = 1;
let service: InstanceType<typeof McpService>;
let internal: Internals;
const validConfig: McpServerConfig = { type: "streamable-http", url: "https://mcp.example.test" };
beforeEach(async () => {
  connectCalls = 0;
  failConnect = true;
  timers.clear();
  service = await McpService.start({
    getSetting: () => null,
    actions: [],
  } as unknown as IAgentRuntime);
  internal = service as unknown as Internals;
  spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => Promise<void>,
    delay: number,
  ) => {
    const id = nextTimer++;
    timers.set(id, { callback, delay });
    return id;
  }) as typeof setTimeout);
  spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
    timers.delete(id);
  }) as typeof clearTimeout);
});
afterEach(async () => {
  for (const name of internal.connectionStates.keys()) await service.disconnect(name);
  mock.restore();
});
async function retry() {
  const entry = [...timers.entries()].find(([, timer]) => timer.delay < 60000);
  if (!entry) throw new Error("No pending retry");
  timers.delete(entry[0]);
  await entry[1].callback();
  return entry[1].delay;
}
function retryTimers() {
  return [...timers.values()].filter((timer) => timer.delay < 60000);
}
/** Starts a retry timer's callback without awaiting it, so the test controls the interleaving. */
function fireRetry(): Promise<void> {
  const entry = [...timers.entries()].find(([, timer]) => timer.delay < 60000);
  if (!entry) throw new Error("No pending retry");
  timers.delete(entry[0]);
  return entry[1].callback();
}

test("failed connection retries back off and stop at the cap", async () => {
  await expect(internal.connect("server", validConfig)).rejects.toThrow("server unavailable");
  const delays = [];
  for (let i = 0; i < 5; i++) delays.push(await retry());
  expect(delays).toEqual([2000, 4000, 8000, 16000, 32000]);
  expect(connectCalls).toBe(6);
  expect(retryTimers()).toHaveLength(0);
  expect(internal.connectionStates.get("server")?.reconnectAttempts).toBe(5);
});

test("transport construction failures also reach the cap", async () => {
  await expect(internal.connect("server", { type: "stdio", command: "" })).rejects.toThrow(
    "Missing command",
  );
  for (let i = 0; i < 5; i++) await retry();
  expect(internal.connectionStates.get("server")?.reconnectAttempts).toBe(5);
  expect(retryTimers()).toHaveLength(0);
});

test("success resets the retry ladder", async () => {
  await expect(internal.connect("server", validConfig)).rejects.toThrow();
  await retry();
  failConnect = false;
  await retry();
  expect(internal.connectionStates.get("server")?.reconnectAttempts).toBe(0);
  internal.handleDisconnect("server", new Error("later outage"));
  expect(retryTimers().map((timer) => timer.delay)).toEqual([2000]);
});

test("stop cancels retries even when no transport could be constructed", async () => {
  await expect(internal.connect("server", { type: "stdio", command: "" })).rejects.toThrow();
  expect(retryTimers()).toHaveLength(1);
  await service.stop();
  expect(retryTimers()).toHaveLength(0);
  expect(internal.connectionStates.size).toBe(0);
});

test("stop during an in-flight retry leaves no state or timers", async () => {
  await expect(internal.connect("server", { type: "stdio", command: "" })).rejects.toThrow();
  expect(retryTimers()).toHaveLength(1);
  // Fire the retry callback without awaiting it: it runs synchronously through
  // connect()'s leading disconnect() (deleting the old state) and then pauses.
  const inFlight = fireRetry();
  expect(internal.connectionStates.size).toBe(0);
  // stop() establishes shutdown before scanning the maps, so the paused
  // callback must not resurrect state or schedule another timer when it resumes.
  await service.stop();
  await inFlight;
  expect(internal.connectionStates.size).toBe(0);
  expect(retryTimers()).toHaveLength(0);
});

test("an explicit reconnect starts a fresh retry ladder", async () => {
  await expect(internal.connect("server", validConfig)).rejects.toThrow();
  await retry();
  await retry();
  expect(internal.connectionStates.get("server")?.reconnectAttempts).toBe(2);
  await expect(internal.connect("server", validConfig)).rejects.toThrow();
  expect(internal.connectionStates.get("server")?.reconnectAttempts).toBe(0);
  expect(retryTimers().map((timer) => timer.delay)).toEqual([2000]);
});
