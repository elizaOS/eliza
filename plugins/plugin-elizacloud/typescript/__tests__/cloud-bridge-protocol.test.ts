/**
 * Tests for the JSON-RPC bridge protocol used by CloudBridgeService.
 *
 * Validates message construction, request ID management, and the
 * heartbeat/ack protocol — all without needing a real WebSocket.
 * We test the BridgeMessage type and protocol logic directly.
 */

import { describe, expect, it } from "vitest";
import type { BridgeMessage } from "../types/cloud";

function createRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
): BridgeMessage {
  return { jsonrpc: "2.0", id, method, params };
}

function createResponse(id: number, result: unknown): BridgeMessage {
  return { jsonrpc: "2.0", id, result };
}

function createErrorResponse(
  id: number,
  code: number,
  message: string,
): BridgeMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function createNotification(
  method: string,
  params: Record<string, unknown>,
): BridgeMessage {
  return { jsonrpc: "2.0", method, params };
}

describe("JSON-RPC 2.0 bridge message format", () => {
  it("request has jsonrpc, id, method, and params", () => {
    const msg = createRequest(1, "message.send", { text: "hello" });
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe(1);
    expect(msg.method).toBe("message.send");
    expect(msg.params).toEqual({ text: "hello" });
    expect(msg.result).toBeUndefined();
    expect(msg.error).toBeUndefined();
  });

  it("response has jsonrpc, id, result but no method", () => {
    const msg = createResponse(1, { text: "world" });
    expect(msg.id).toBe(1);
    expect(msg.result).toEqual({ text: "world" });
    expect(msg.method).toBeUndefined();
    expect(msg.error).toBeUndefined();
  });

  it("error response has jsonrpc, id, error but no result", () => {
    const msg = createErrorResponse(1, -32601, "Method not found");
    expect(msg.id).toBe(1);
    expect(msg.error?.code).toBe(-32601);
    expect(msg.error?.message).toBe("Method not found");
    expect(msg.result).toBeUndefined();
  });

  it("notification has no id", () => {
    const msg = createNotification("heartbeat", { timestamp: 12345 });
    expect(msg.id).toBeUndefined();
    expect(msg.method).toBe("heartbeat");
  });

  it("messages roundtrip through JSON serialization", () => {
    const original = createRequest(42, "status.get", { verbose: true });
    const serialized = JSON.stringify(original);
    const parsed = JSON.parse(serialized) as BridgeMessage;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(42);
    expect(parsed.method).toBe("status.get");
    expect(parsed.params).toEqual({ verbose: true });
  });
});

describe("request-response matching logic", () => {
  it("response id matches request id", () => {
    const pending = new Map<number, { resolve: (v: unknown) => void }>();
    let resolved: unknown = null;

    pending.set(7, {
      resolve: (v) => {
        resolved = v;
      },
    });

    // Simulate incoming response
    const msg = createResponse(7, { data: "found" });
    const handler = pending.get(msg.id as number);
    if (handler) {
      handler.resolve(msg.result);
      pending.delete(msg.id as number);
    }

    expect(resolved).toEqual({ data: "found" });
    expect(pending.size).toBe(0);
  });

  it("unmatched response id is ignored", () => {
    const pending = new Map<number, { resolve: (v: unknown) => void }>();
    pending.set(7, { resolve: () => {} });

    const msg = createResponse(999, { data: "orphan" });
    const handler = pending.get(msg.id as number);
    expect(handler).toBeUndefined();
    expect(pending.size).toBe(1); // Still waiting for id=7
  });

  it("error response rejects the pending request", () => {
    const pending = new Map<number, { reject: (e: Error) => void }>();
    let rejected: Error | null = null;

    pending.set(3, {
      reject: (e) => {
        rejected = e;
      },
    });

    const msg = createErrorResponse(3, -32600, "Invalid request");
    const handler = pending.get(msg.id as number);
    if (handler && msg.error) {
      handler.reject(new Error(msg.error.message));
      pending.delete(msg.id as number);
    }

    expect(rejected).not.toBeNull();
    expect(rejected!.message).toBe("Invalid request");
  });
});

describe("heartbeat protocol", () => {
  it("heartbeat is a notification (no id)", () => {
    const hb = createNotification("heartbeat", { timestamp: Date.now() });
    expect(hb.id).toBeUndefined();
    expect(hb.method).toBe("heartbeat");
    expect(typeof hb.params?.timestamp).toBe("number");
  });

  it("heartbeat.ack is recognized as heartbeat response", () => {
    const ack = createNotification("heartbeat.ack", { timestamp: Date.now() });
    expect(ack.method).toBe("heartbeat.ack");
    // Bridge service should update lastHeartbeat when it sees this method
    const isAck = ack.method === "heartbeat.ack";
    expect(isAck).toBe(true);
  });

  it("distinguishes notifications from responses", () => {
    const notification = createNotification("event.new_message", {
      text: "hi",
    });
    const response = createResponse(5, "ok");

    // Notification: has method, no id
    const isNotification =
      notification.method !== undefined && notification.id === undefined;
    expect(isNotification).toBe(true);

    // Response: has id, no method
    const isResponse =
      response.id !== undefined && response.method === undefined;
    expect(isResponse).toBe(true);
  });
});

describe("edge cases", () => {
  it("handles request with zero as id", () => {
    const msg = createRequest(0, "test", {});
    expect(msg.id).toBe(0);
    // id=0 is valid in JSON-RPC 2.0
    const pending = new Map<number, boolean>();
    pending.set(0, true);
    expect(pending.get(msg.id as number)).toBe(true);
  });

  it("handles empty params", () => {
    const msg = createRequest(1, "status.get", {});
    const serialized = JSON.stringify(msg);
    expect(serialized).toContain('"params":{}');
  });

  it("handles string id", () => {
    const msg: BridgeMessage = {
      jsonrpc: "2.0",
      id: "uuid-123",
      method: "test",
      params: {},
    };
    expect(msg.id).toBe("uuid-123");
  });

  it("handles null result", () => {
    const msg: BridgeMessage = { jsonrpc: "2.0", id: 1, result: null };
    expect(msg.result).toBeNull();
    expect(msg.error).toBeUndefined();
  });
});
