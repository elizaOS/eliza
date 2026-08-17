import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("logger trunc reserve", () => {
  it("reserve CHAT_PREVIEW_IN_MAX -3 for ... 3 chars", () => {
    const src = fs.readFileSync("packages/logger/src/logger.ts", "utf8");
    expect(src).toContain("slice(0, CHAT_PREVIEW_IN_MAX - 3)}...");
  });
  it("reserve CHAT_PREVIEW_OUT_MAX -3", () => {
    const src = fs.readFileSync("packages/logger/src/logger.ts", "utf8");
    expect(src).toContain("slice(0, CHAT_PREVIEW_OUT_MAX - 3)}...");
  });
  it("no bare slice(0, CHAT_PREVIEW) without reserve", () => {
    const src = fs.readFileSync("packages/logger/src/logger.ts", "utf8");
    expect(src).not.toContain("slice(0, CHAT_PREVIEW_IN_MAX)}...");
    expect(src).not.toContain("slice(0, CHAT_PREVIEW_OUT_MAX)}...");
  });
  it("payload weak 3 over vs fixed capped + sibling correct", () => {
    const MAX=50;
    const weak = ("a".repeat(51).slice(0,MAX)+"...").length;
    const fixed = ("a".repeat(51).slice(0,MAX-3)+"...").length;
    expect(weak).toBe(53);
    expect(fixed).toBe(50);
    const sibling = fs.readFileSync("packages/agent/src/api/health-routes.ts","utf8");
    expect(sibling).toContain("slice(0, options.maxStringLength - 3)}...");
  });
});
