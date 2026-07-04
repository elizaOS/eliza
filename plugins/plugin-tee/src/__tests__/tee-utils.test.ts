/**
 * Real smoke test for the TEE plugin's pure utilities (issue #9943: the plugin
 * shipped with zero tests). The plugin's index eagerly loads the Phala dstack
 * SDK at module-eval, so this targets the dependency-free utils sub-module —
 * the hex/SHA-256/endpoint helpers that every attestation path relies on — with
 * real assertions (known vectors, round-trips, and the documented error cases).
 */
import { describe, expect, it } from "vitest";
import {
  calculateSHA256,
  getTeeEndpoint,
  hexToUint8Array,
  sha256Bytes,
  uint8ArrayToHex,
} from "../utils";

describe("plugin-tee utils", () => {
  it("round-trips bytes through hex", () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xa0, 0xff, 0x42]);
    const hex = uint8ArrayToHex(bytes);
    expect(hex).toBe("000fa0ff42");
    expect(Array.from(hexToUint8Array(hex))).toEqual(Array.from(bytes));
  });

  it("hexToUint8Array strips an optional 0x prefix", () => {
    expect(Array.from(hexToUint8Array("0xdeadbeef"))).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
  });

  it("hexToUint8Array rejects malformed input", () => {
    expect(() => hexToUint8Array("")).toThrow(/empty/);
    expect(() => hexToUint8Array("abc")).toThrow(/odd number/);
    expect(() => hexToUint8Array("zz")).toThrow(/invalid byte/);
  });

  it("calculateSHA256 matches the known empty-string digest", () => {
    expect(calculateSHA256("").toString("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("sha256Bytes returns a 32-byte digest matching calculateSHA256", () => {
    const text = "elizaos-tee";
    const digest = sha256Bytes(new TextEncoder().encode(text));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);
    expect(uint8ArrayToHex(digest)).toBe(calculateSHA256(text).toString("hex"));
  });

  it("getTeeEndpoint maps modes and rejects unknown ones", () => {
    expect(getTeeEndpoint("LOCAL")).toBe("http://localhost:8090");
    expect(getTeeEndpoint("docker")).toBe("http://host.docker.internal:8090");
    expect(getTeeEndpoint("PRODUCTION")).toBeUndefined();
    expect(() => getTeeEndpoint("NONSENSE")).toThrow(/Invalid TEE_MODE/);
  });
});
