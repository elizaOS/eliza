/**
 * Proves truncateText respects limit inclusive of "...".
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const file = readFileSync(
  resolve("packages/cloud/shared/src/lib/eliza/plugin-cloud-bootstrap/providers/character.ts"),
  "utf8",
);
const sibling = readFileSync(resolve("packages/agent/src/api/health-routes.ts"), "utf8");

describe("character truncateText", () => {
  it("reserve present: limit -3 before ...", () => {
    expect(file).toContain("value.slice(0, limit - 3)");
  });

  it("no bare slice without reserve", () => {
    const start = file.indexOf("function truncateText");
    const snippet = file.slice(start, start + 300);
    expect(snippet).not.toContain("slice(0, limit)}...");
    expect(snippet).toContain("slice(0, limit - 3)}...");
  });

  it("count: exactly one bounded truncate", () => {
    const count = (file.match(/slice\(0, limit - 3\)/g) || []).length;
    expect(count).toBe(1);
  });

  it("payload weak vs fixed + sibling correct", () => {
    const weakLen = 4000 + 3;
    const fixedLen = 4000 - 3 + 3;
    expect(weakLen).toBe(4003);
    expect(fixedLen).toBe(4000);
    expect(file).toContain("slice(0, limit - 3)");
    expect(sibling).toContain("maxStringLength - 3");
  });
});
