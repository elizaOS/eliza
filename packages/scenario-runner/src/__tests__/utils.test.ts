import { describe, expect, it } from "vitest";
import { isLoopbackUrl, toRecord } from "./utils.ts";

describe("toRecord", () => {
  it("narrows plain objects", () => {
    expect(toRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("returns null for non-objects", () => {
    expect(toRecord(null)).toBeNull();
    expect(toRecord([])).toBeNull();
    expect(toRecord("x")).toBeNull();
  });
});

describe("isLoopbackUrl", () => {
  it("detects loopback hosts", () => {
    expect(isLoopbackUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8080/x")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:80")).toBe(true);
  });

  it("rejects remote hosts, malformed urls, and empty", () => {
    expect(isLoopbackUrl("https://example.com")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});
