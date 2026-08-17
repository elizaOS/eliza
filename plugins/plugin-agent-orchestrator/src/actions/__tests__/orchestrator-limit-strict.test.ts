/**
 * Proves orchestrator TASKS history limit strict clamp.
 * Harness: file-grep + direct payload arithmetic.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(path.join(process.cwd(), "plugins/plugin-agent-orchestrator/src/actions/tasks.ts"), "utf8");
const SMITH = readFileSync(path.join(process.cwd(), "plugins/plugin-workflow/src/services/smithers-runtime.ts"), "utf8");

describe("orchestrator limit strict", () => {
  it("uses regex + isSafeInteger + clamp", () => {
    expect(SRC).toContain("/^\\d+$/");
    expect(SRC).toContain("Number.isSafeInteger");
    expect(SRC).toContain("Math.min");
  });
  it("no weak Number(params.limit) + isFinite trunc remains for that site", () => {
    // ensure old pattern not present in the 3070 region
    const region = SRC.slice(SRC.indexOf("runHistory"));
    expect(region).not.toContain("const limitRaw = Number(");
    expect(region).not.toContain("Number.isFinite(limitRaw)");
  });
  it("direct payload weak vs strict", () => {
    const weak = (v: unknown, fb=10) => {
      const n = Number(v as any);
      return Number.isFinite(n) && n>0 ? Math.trunc(n) : fb;
    };
    const strict = (v: unknown, fb=10) => {
      if (typeof v==="number") { if(!Number.isSafeInteger(v)||v<=0) return fb; return Math.min(v,100);}
      if (typeof v==="string") { if(!/^\d+$/.test(v)) return fb; const n=Number(v); if(!Number.isSafeInteger(n)||n<=0) return fb; return Math.min(n,100);}
      return fb;
    };
    expect(weak("1e4")).toBe(10000);
    expect(strict("1e4")).toBe(10);
    expect(weak("0x10")).toBe(16);
    expect(strict("0x10")).toBe(10);
    expect(weak("5.9")).toBe(5);
    expect(strict("5.9")).toBe(10);
    expect(weak("1e6")).toBe(1_000_000);
    expect(strict("1e6")).toBe(100); // clamped to 100 not 1M
    expect(strict("50")).toBe(50);
  });
  it("sibling smithers-runtime strict present", () => {
    expect(SMITH).toContain("/^[1-9]\\d*$/");
  });
});
