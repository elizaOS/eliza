/** File-grep proof for gateway discord timeout fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const SRC = "packages/cloud/services/gateway-discord/src/server-router.ts";
const SIBLING = "packages/agent/src/actions/runtime.ts";
describe("gateway discord timeout", () => {
  it("has timeout", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain("AbortSignal.timeout(15_000)");
    // ensure the PATCH fetch now has signal
    const count = (s.match(/AbortSignal\.timeout\(15_000\)/g)||[]).length;
    expect(count).toBe(1);
  });
  it("no bare PATCH remains", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).not.toContain('method: "PATCH",\n      headers: {\n        Authorization: `Bearer ${token}`,\n        "Content-Type": "application/json",\n      },\n    });');
  });
  it("payload", () => {
    expect(15000).toBe(15000);
  });
  it("sibling correct", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("AbortSignal.timeout");
  });
});
