/** Malformed Redis URL userinfo percent-encoding must not throw. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { decodeRedisUrlUserinfo } from "./sandbox-registry.ts";

describe("decodeRedisUrlUserinfo", () => {
  it("keeps the raw text for a lone %", () => {
    expect(() => decodeRedisUrlUserinfo("%")).not.toThrow();
    expect(decodeRedisUrlUserinfo("%")).toBe("%");
  });

  it("keeps the raw text for %ZZ", () => {
    expect(decodeRedisUrlUserinfo("%ZZ")).toBe("%ZZ");
  });

  it("keeps the raw text for truncated UTF-8", () => {
    expect(decodeRedisUrlUserinfo("%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("still decodes a valid %20 userinfo half", () => {
    expect(decodeRedisUrlUserinfo("user%20name")).toBe("user name");
  });
});
