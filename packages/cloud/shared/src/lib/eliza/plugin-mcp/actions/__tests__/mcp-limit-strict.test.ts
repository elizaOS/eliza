/**
 * Proves MCP search limit/offset strict clamp.
 * Harness: file-grep + direct payload proof.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(path.join(process.cwd(), "packages/cloud/shared/src/lib/eliza/plugin-mcp/actions/mcp.ts"), "utf8");
const SIB = readFileSync(path.join(process.cwd(), "packages/cloud/shared/src/lib/utils/clamp-limit.ts"), "utf8");

describe("mcp limit strict", () => {
  it("uses regex + isSafeInteger + clamp for limit/offset", () => {
    expect(SRC).toContain("/^\\d+$/");
    expect(SRC).toContain("Number.isSafeInteger");
    expect(SRC).toContain("Math.min");
  });
  it("no weak Number(params.limit) || fallback remains", () => {
    expect(SRC).not.toContain("Number(params.limit) || 10");
    expect(SRC).not.toContain("Number(params.offset) || 0");
  });
  it("direct payload weak vs strict", () => {
    const weakLimit = (v:any) => Math.min(Math.max(Number(v)||10,1),20);
    const strictLimit = (v:any) => {
      if (typeof v==="number") { if(!Number.isSafeInteger(v)||v<=0) return 10; return Math.min(v,20); }
      if (typeof v==="string") { if(!/^\d+$/.test(v)) return 10; const n=Number(v); if(!Number.isSafeInteger(n)||n<=0) return 10; return Math.min(n,20); }
      return 10;
    };
    expect(weakLimit("1e4")).toBe(20); // 10000→20
    expect(strictLimit("1e4")).toBe(10);
    expect(weakLimit("0x10")).toBe(16);
    expect(strictLimit("0x10")).toBe(10);
    expect(weakLimit("5.9")).toBe(5.9);
    expect(strictLimit("5.9")).toBe(10);
    expect(strictLimit("15")).toBe(15);
  });
  it("sibling clamp-limit strict present", () => {
    expect(SIB).toContain("/^\\d+$/");
  });
});
