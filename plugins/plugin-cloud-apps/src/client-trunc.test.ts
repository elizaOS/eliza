import { describe, it, expect } from "vitest";
import fs from "node:fs";

describe("cloud-apps trunc reserve", () => {
  it("reserve is 119 for 120 cap with … 1 char", () => {
    const src = fs.readFileSync("plugins/plugin-cloud-apps/src/client.ts", "utf8");
    expect(src).toContain("slice(0, 119)}…");
    expect(src).not.toContain("slice(0, 120)}…");
  });
  it("no bare slice(0,120) remains", () => {
    const src = fs.readFileSync("plugins/plugin-cloud-apps/src/client.ts", "utf8");
    expect(src).not.toContain("slice(0, 120)}…");
  });
  it("count is 1 reserved slice", () => {
    const src = fs.readFileSync("plugins/plugin-cloud-apps/src/client.ts", "utf8");
    const matches = src.match(/slice\(0, 119\)\}…/g) || [];
    expect(matches.length).toBe(1);
  });
  it("payload weak 121 vs fixed 120 sibling correct", () => {
    const weak = ("a".repeat(121).slice(0,120)+"…").length;
    const fixed = ("a".repeat(121).slice(0,119)+"…").length;
    expect(weak).toBe(121);
    expect(fixed).toBe(120);
    const sibling = fs.readFileSync("packages/cloud/shared/src/lib/web-push/notify-service.ts", "utf8");
    expect(sibling).toContain("slice(0, MAX_BODY_LENGTH - 1)");
    const sibling2 = fs.readFileSync("packages/agent/src/api/health-routes.ts", "utf8");
    expect(sibling2).toContain("slice(0, options.maxStringLength - 3)}...");
  });
});
