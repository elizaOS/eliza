import { describe, expect, it } from "vitest";
import { extendedHash, simpleHash } from "./crypto-utils.ts";

describe("simpleHash", () => {
  it("is deterministic", () => {
    expect(simpleHash("hello")).toBe(simpleHash("hello"));
  });

  it("produces 8-char hex", () => {
    expect(simpleHash("anything")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("differs for different inputs", () => {
    expect(simpleHash("a")).not.toBe(simpleHash("b"));
  });
});

describe("extendedHash", () => {
  it("is deterministic and longer", () => {
    expect(extendedHash("snapshot")).toBe(extendedHash("snapshot"));
    expect(extendedHash("snapshot")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs for different inputs", () => {
    expect(extendedHash("v1")).not.toBe(extendedHash("v2"));
  });

  it("handles empty input", () => {
    expect(extendedHash("")).toMatch(/^[0-9a-f]{32}$/);
  });
});
