import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("trajectory trunc",()=>{
  it("reserve max-1 for c.dim …",()=>{
    const src=fs.readFileSync("packages/scripts/trajectory.ts","utf8");
    expect(src).toContain("slice(0, max - 1)}${c.dim");
  });
  it("no bare slice(0, max) with c.dim",()=>{
    const src=fs.readFileSync("packages/scripts/trajectory.ts","utf8");
    expect(src).not.toContain("slice(0, max)}${c.dim");
  });
  it("count 1",()=>{
    const src=fs.readFileSync("packages/scripts/trajectory.ts","utf8");
    expect((src.match(/max - 1/g)||[]).length).toBeGreaterThanOrEqual(1);
  });
  it("payload weak vs fixed sibling correct",()=>{
    const MAX=100;
    // mock c.dim as wrapping with 1 char visible but string length 1+ansi; we test visible overflow 1
    const weakVisible=("a".repeat(101).slice(0,MAX)+"…").length;
    const fixedVisible=("a".repeat(101).slice(0,MAX-1)+"…").length;
    expect(weakVisible).toBe(101);
    expect(fixedVisible).toBe(100);
    const sib=fs.readFileSync("packages/cloud/shared/src/lib/web-push/notify-service.ts","utf8");
    expect(sib).toContain("slice(0, MAX_BODY_LENGTH - 1)");
  });
});
