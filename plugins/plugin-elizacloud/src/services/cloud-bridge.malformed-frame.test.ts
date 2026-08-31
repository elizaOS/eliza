/**
 * End-to-end regression test for CloudBridgeService's inbound-frame handling.
 *
 * Harness is integration-backed: a real `ws` WebSocketServer plus the real
 * undici `WebSocket` client the service actually constructs (no fake socket,
 * no mocked `@elizaos/core`). undici's `WebSocket` is an `EventTarget`
 * subclass, so a throw inside the `"message"` listener is re-raised via
 * `process.nextTick` and surfaces as an `uncaughtException`; the agent host
 * translates that into `process.exit(1)`. This proves that a single malformed
 * or non-object frame is dropped without emitting `uncaughtException` and
 * without disrupting an in-flight JSON-RPC request on the same connection.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { IAgentRuntime } from "@elizaos/core";
import { CloudBridgeService } from "./cloud-bridge";

describe("CloudBridgeService malformed-frame resilience (real undici WebSocket)", () => {
  let wss: WebSocketServer;
  let port: number;
  let service: CloudBridgeService;
  let serverSocket: import("ws").WebSocket | null;
  const uncaughtErrors: unknown[] = [];
  let priorUncaughtListeners: NodeJS.UncaughtExceptionListener[] = [];
  const onUncaught = (error: unknown): void => {
    uncaughtErrors.push(error);
  };

  beforeEach(async () => {
    uncaughtErrors.length = 0;
    serverSocket = null;
    // Take over uncaughtException so a pre-fix re-thrown parse error is
    // recorded here instead of terminating the vitest worker, then restore
    // the harness's own listeners afterward.
    priorUncaughtListeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", onUncaught);

    await new Promise<void>((resolve) => {
      wss = new WebSocketServer({ port: 0 }, () => {
        port = (wss.address() as { port: number }).port;
        resolve();
      });
    });
    wss.on("connection", (sock) => {
      serverSocket = sock;
    });

    service = new CloudBridgeService({} as IAgentRuntime);
    Reflect.set(service, "authService", {
      getApiKey: () => undefined,
      getClient: () => ({
        buildWsUrl: (path: string) => `ws://127.0.0.1:${port}${path}`,
      }),
    });
  });

  afterEach(async () => {
    process.off("uncaughtException", onUncaught);
    for (const listener of priorUncaughtListeners) process.on("uncaughtException", listener);
    await service.stop().catch(() => {});
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  async function connect(containerId: string): Promise<void> {
    await service.connect(containerId);
    // Wait until the real undici client reports connected.
    for (let i = 0; i < 200 && service.getConnectionState(containerId) !== "connected"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(service.getConnectionState(containerId)).toBe("connected");
    for (let i = 0; i < 200 && !serverSocket; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(serverSocket).not.toBeNull();
  }

  it("drops a malformed text frame without crashing and still resolves a pending request", async () => {
    await connect("container-1");

    const pending = service.sendRequest("container-1", "status.get", {});
    // Server replies with one malformed frame, then the real JSON-RPC response.
    serverSocket?.send("not json {");
    serverSocket?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));

    await expect(pending).resolves.toEqual({ ok: true });
    // Give any re-thrown parse error a nextTick/microtask window to surface.
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaughtErrors).toEqual([]);
    expect(service.getConnectionState("container-1")).toBe("connected");
  });

  it("drops a valid-JSON but non-object frame without dereferencing method/id", async () => {
    await connect("container-2");

    const pending = service.sendRequest("container-2", "status.get", {});
    // `42` and `[...]` are valid JSON but not JSON-RPC objects.
    serverSocket?.send("42");
    serverSocket?.send(JSON.stringify(["not", "an", "object"]));
    serverSocket?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { survived: true } }));

    await expect(pending).resolves.toEqual({ survived: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaughtErrors).toEqual([]);
    expect(service.getConnectionState("container-2")).toBe("connected");
  });
});
