/**
 * Isolated overflow tests for the SandboxRegistry TCP byte budget.
 * Deterministic — no Redis, socket, or Upstash fetch.
 */
import { describe, expect, it } from "vitest";
import {
  appendRegistryTcpBytes,
  isRegistryTcpBulkLengthAllowed,
  MAX_REGISTRY_TCP_BYTES,
} from "./sandbox-registry-tcp-budget.ts";

describe("appendRegistryTcpBytes", () => {
  it("accepts a last-fit honest chunk", () => {
    const first = appendRegistryTcpBytes(Buffer.alloc(0), Buffer.from("OK\r\n"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.buffer.toString()).toBe("OK\r\n");
  });

  it("rejects a write that would exceed the budget without retaining it", () => {
    const held = Buffer.alloc(MAX_REGISTRY_TCP_BYTES - 4, 0x2b);
    const result = appendRegistryTcpBytes(held, Buffer.alloc(8, 0x78));
    expect(result).toEqual({ ok: false });
  });
});

describe("isRegistryTcpBulkLengthAllowed", () => {
  it("allows Redis null bulk and honest GET payloads", () => {
    expect(isRegistryTcpBulkLengthAllowed(-1)).toBe(true);
    expect(isRegistryTcpBulkLengthAllowed(0)).toBe(true);
    expect(isRegistryTcpBulkLengthAllowed(64)).toBe(true);
    expect(isRegistryTcpBulkLengthAllowed(MAX_REGISTRY_TCP_BYTES)).toBe(true);
  });

  it("rejects a declared bulk length that would overflow the TCP budget", () => {
    expect(isRegistryTcpBulkLengthAllowed(MAX_REGISTRY_TCP_BYTES + 1)).toBe(
      false,
    );
    expect(isRegistryTcpBulkLengthAllowed(Number.POSITIVE_INFINITY)).toBe(
      false,
    );
    expect(isRegistryTcpBulkLengthAllowed(Number.NaN)).toBe(false);
    expect(isRegistryTcpBulkLengthAllowed(-2)).toBe(false);
  });
});
