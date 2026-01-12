import { describe, expect, it } from "vitest";
import {
  calculateSHA256,
  getTeeEndpoint,
  hexToUint8Array,
  sha256Bytes,
  uint8ArrayToHex,
} from "../utils";

describe("hexToUint8Array", () => {
  it("should convert valid hex string to Uint8Array", () => {
    const result = hexToUint8Array("0102030405");
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("should handle hex string with 0x prefix", () => {
    const result = hexToUint8Array("0x0102030405");
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("should throw error for empty hex string", () => {
    expect(() => hexToUint8Array("")).toThrow("Invalid hex string");
  });

  it("should throw error for hex string with 0x only", () => {
    expect(() => hexToUint8Array("0x")).toThrow("Invalid hex string");
  });

  it("should throw error for odd-length hex string", () => {
    expect(() => hexToUint8Array("0x123")).toThrow("Invalid hex string");
  });

  it("should throw error for invalid hex characters", () => {
    expect(() => hexToUint8Array("0xGG")).toThrow("Invalid hex string");
  });
});

describe("uint8ArrayToHex", () => {
  it("should convert Uint8Array to hex string", () => {
    const result = uint8ArrayToHex(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result).toBe("0102030405");
  });

  it("should handle empty array", () => {
    const result = uint8ArrayToHex(new Uint8Array([]));
    expect(result).toBe("");
  });

  it("should pad single digit bytes", () => {
    const result = uint8ArrayToHex(new Uint8Array([0, 1, 15, 16]));
    expect(result).toBe("00010f10");
  });
});

describe("calculateSHA256", () => {
  it("should calculate SHA256 hash of string", () => {
    const result = calculateSHA256("hello");
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(32);
  });

  it("should produce consistent results", () => {
    const result1 = calculateSHA256("test");
    const result2 = calculateSHA256("test");
    expect(result1.equals(result2)).toBe(true);
  });

  it("should produce different results for different inputs", () => {
    const result1 = calculateSHA256("hello");
    const result2 = calculateSHA256("world");
    expect(result1.equals(result2)).toBe(false);
  });
});

describe("sha256Bytes", () => {
  it("should calculate SHA256 hash of Uint8Array", () => {
    const result = sha256Bytes(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });
});

describe("getTeeEndpoint", () => {
  it("should return localhost for LOCAL mode", () => {
    expect(getTeeEndpoint("LOCAL")).toBe("http://localhost:8090");
  });

  it("should return docker internal for DOCKER mode", () => {
    expect(getTeeEndpoint("DOCKER")).toBe("http://host.docker.internal:8090");
  });

  it("should return undefined for PRODUCTION mode", () => {
    expect(getTeeEndpoint("PRODUCTION")).toBeUndefined();
  });

  it("should handle case insensitivity", () => {
    expect(getTeeEndpoint("local")).toBe("http://localhost:8090");
    expect(getTeeEndpoint("docker")).toBe("http://host.docker.internal:8090");
    expect(getTeeEndpoint("production")).toBeUndefined();
  });

  it("should throw error for invalid mode", () => {
    expect(() => getTeeEndpoint("INVALID")).toThrow("Invalid TEE_MODE");
  });
});
