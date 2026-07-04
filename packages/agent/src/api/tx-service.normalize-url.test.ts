/**
 * Tests for the EVM JSON-RPC URL validator (#8801 / #9943). normalizeJsonRpcUrl
 * gates the endpoint a wallet transaction talks to; it must reject empty,
 * unparseable, and non-http(s) URLs (e.g. ws://, ftp://) — and was untested.
 */
import { describe, expect, it } from "vitest";
import { normalizeJsonRpcUrl } from "./tx-service";

describe("normalizeJsonRpcUrl", () => {
  it("accepts and normalizes an http(s) URL", () => {
    expect(normalizeJsonRpcUrl("https://eth.example.com/rpc")).toBe(
      "https://eth.example.com/rpc",
    );
    expect(normalizeJsonRpcUrl("  http://localhost:8545  ")).toBe(
      "http://localhost:8545/",
    );
  });

  it("throws on an empty / whitespace URL", () => {
    expect(() => normalizeJsonRpcUrl("")).toThrow(/required/);
    expect(() => normalizeJsonRpcUrl("   ")).toThrow(/required/);
  });

  it("throws on an unparseable URL", () => {
    expect(() => normalizeJsonRpcUrl("not a url")).toThrow(
      /expected an http\(s\) URL/,
    );
  });

  it("throws on a non-http(s) scheme", () => {
    expect(() => normalizeJsonRpcUrl("ws://eth.example.com")).toThrow(
      /expected http: or https:/,
    );
    expect(() => normalizeJsonRpcUrl("ftp://x.com/")).toThrow(
      /expected http: or https:/,
    );
  });
});
