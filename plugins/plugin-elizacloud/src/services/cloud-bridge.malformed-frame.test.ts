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
 * without disrupting an in-flight JSON-RPC request on the same connection. It
 * also pins the redaction guarantee: the warn arms log a shape/error name plus
 * a byte count, never the peer-controlled bytes that may carry the `?token=`
 * API key, and the dropped-shape label stays precise for `null`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { type IAgentRuntime, logger } from "@elizaos/core";
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

  it("drops a valid-JSON but non-object frame without dispatching it to handlers", async () => {
    await connect("container-2");

    // A registered handler must never see a non-object frame. Pre-fix, `42`
    // and the array fell through to this dispatch typed as BridgeMessage; the
    // guard's `typeof !== "object" || null || Array.isArray` branch is what
    // this assertion locks (the valid response below resolves the pending
    // request and returns before handler dispatch, so it is never delivered).
    const received: unknown[] = [];
    service.onMessage("container-2", (message) => {
      received.push(message);
    });

    const pending = service.sendRequest("container-2", "status.get", {});
    // `42` and `[...]` are valid JSON but not JSON-RPC objects.
    serverSocket?.send("42");
    serverSocket?.send(JSON.stringify(["not", "an", "object"]));
    serverSocket?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { survived: true } }));

    await expect(pending).resolves.toEqual({ survived: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaughtErrors).toEqual([]);
    expect(received).toEqual([]);
    expect(service.getConnectionState("container-2")).toBe("connected");
  });

  it("never logs peer frame bytes and labels the dropped JSON shape precisely", async () => {
    await connect("container-3");

    // Capture the warn arm. The connect URL carries `?token=<apiKey>`, so a
    // proxy-injected error page echoing that URL is the frame most likely to be
    // malformed and to contain the key; the guard must log a shape/name plus a
    // byte count and never the raw bytes. Without this assertion, restoring the
    // raw frame into either warn string leaves the suite green (see #30159).
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
      return logger;
    });

    const marker = "LEAKMARK-a1b2c3-secret-token";
    const pending = service.sendRequest("container-3", "status.get", {});
    // Malformed frame carrying the marker (mirrors a proxy error page whose body
    // echoes the requested `?token=` URL).
    serverSocket?.send(`not json ${marker} {`);
    // Valid JSON that is not a JSON-RPC object: a string carrying the marker, a
    // literal `null` (the `typeof null === "object"` trap), and an array.
    serverSocket?.send(JSON.stringify(marker));
    serverSocket?.send("null");
    serverSocket?.send(JSON.stringify([marker]));
    serverSocket?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));

    await expect(pending).resolves.toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    warnSpy.mockRestore();

    const combined = warnings.join("\n");
    // Security guarantee: no peer-controlled bytes reach the log, from either arm.
    expect(combined).not.toContain(marker);
    // Shape-only labels stay precise, including the `null` special-case.
    expect(warnings).toContainEqual(expect.stringContaining("JSON string"));
    expect(warnings).toContainEqual(expect.stringContaining("JSON null"));
    expect(warnings).toContainEqual(expect.stringContaining("JSON array"));
    expect(warnings).not.toContainEqual(expect.stringContaining("JSON object"));
    expect(uncaughtErrors).toEqual([]);
    expect(service.getConnectionState("container-3")).toBe("connected");
  });
});
