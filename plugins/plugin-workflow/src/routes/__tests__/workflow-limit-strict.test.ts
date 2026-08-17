/**
 * Proves workflow helpers/actions strict clamp (reject 1e4/hex/float).
 * Harness: file-grep + direct payload arithmetic.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const HELP = readFileSync(path.join(process.cwd(), "plugins/plugin-workflow/src/routes/_helpers.ts"), "utf8");
const ACT = readFileSync(path.join(process.cwd(), "plugins/plugin-workflow/src/actions/workflow.ts"), "utf8");
const SMITH = readFileSync(path.join(process.cwd(), "plugins/plugin-workflow/src/services/smithers-runtime.ts"), "utf8");

describe("workflow helpers strict", () => {
  it("validateLimit uses /^\\d+$/ + isSafeInteger + clamp", () => {
    expect(HELP).toContain("validateLimit");
    expect(HELP).toContain("/^\\d+$/");
    expect(HELP).toContain("Number.isSafeInteger");
    expect(HELP).toContain("Math.min");
  });
  it("no weak Number(limitParam) + isFinite path remains", () => {
    // helper should not contain `Number(limitParam)` with isFinite fallback
    expect(HELP).not.toContain("Number(limitParam)");
    expect(HELP).not.toContain("Number.isFinite(limit)");
  });
  it("direct payload — weak vs strict validateLimit", () => {
    const weak = (v: unknown, d=20, m=100) => {
      const n = Number(v as any);
      if (!Number.isFinite(n) || n <=0) return d;
      return Math.min(n,m);
    };
    const strict = (v: unknown, d=20, m=100) => {
      if (typeof v === "number") {
        if (!Number.isSafeInteger(v) || v<=0) return d;
        return Math.min(v,m);
      }
      if (typeof v === "string") {
        if (!/^\d+$/.test(v)) return d;
        const n= Number(v);
        if (!Number.isSafeInteger(n) || n<=0) return d;
        return Math.min(n,m);
      }
      return d;
    };
    expect(weak("1e4")).toBe(100); // Math.min(10000,100)
    expect(strict("1e4")).toBe(20);
    expect(weak("0x10")).toBe(16);
    expect(strict("0x10")).toBe(20);
    expect(weak("5.9")).toBe(5.9);
    expect(strict("5.9")).toBe(20);
    expect(weak("5junk")).toBe(20); // NaN fallback masks
    expect(strict("5junk")).toBe(20);
    expect(strict("007")).toBe(7); // allowed via /^\d+$/
    expect(strict(50)).toBe(50);
    expect(weak(50)).toBe(50);
  });
});

describe("workflow action number() strict", () => {
  it("uses regex + isSafeInteger", () => {
    expect(ACT).toContain("function number");
    expect(ACT).toContain("/^\\d+$/");
    expect(ACT).toContain("Number.isSafeInteger");
  });
  it("no weak Number(value) + isFinite", () => {
    expect(ACT).not.toContain("Number.isFinite(parsed)");
  });
  it("direct payload action limit", () => {
    const weak = (v: unknown, fb=20) => {
      const p = typeof v==="number"? v : Number(v as any);
      return Number.isFinite(p) ? p : fb;
    };
    const strict = (v: unknown, fb=20) => {
      if (typeof v==="number") return Number.isSafeInteger(v) && v>0 ? v : fb;
      if (typeof v==="string") { if(!/^\d+$/.test(v)) return fb; const n=Number(v); return Number.isSafeInteger(n)&&n>0? n:fb;}
      return fb;
    };
    // then caller does Math.min(50, Math.max(1, number(...)))
    const weakLimit = (v: unknown)=> Math.min(50, Math.max(1, weak(v,20)));
    const strictLimit = (v: unknown)=> Math.min(50, Math.max(1, strict(v,20)));
    expect(weakLimit("1e4")).toBe(50); // 10000→50
    expect(strictLimit("1e4")).toBe(20); // fallback→20
    expect(weakLimit("0x10")).toBe(16);
    expect(strictLimit("0x10")).toBe(20);
    expect(weakLimit("5.9")).toBe(5.9);
    expect(strictLimit("5.9")).toBe(20);
    expect(strictLimit("30")).toBe(30);
    expect(strictLimit(30)).toBe(30);
  });
});

describe("sibling correct smithers-runtime", () => {
  it("has strict regex", () => {
    expect(SMITH).toContain("/^[1-9]\\d*$/");
    expect(SMITH).toContain("Number.isSafeInteger");
  });
});
