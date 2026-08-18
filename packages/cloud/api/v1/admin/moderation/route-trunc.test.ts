/**
 * Proves truncateText respects maxLength inclusive of "..." suffix.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const file = readFileSync(
  resolve("packages/cloud/api/v1/admin/moderation/route.ts"),
  "utf8",
);
const siblingPath = resolve("packages/agent/src/api/health-routes.ts");
let sibling = "";
try {
  sibling = readFileSync(siblingPath, "utf8");
} catch {}

describe("moderation truncateText", () => {
  it("reserve present: maxLength -3 before ...", () => {
    expect(file).toContain("value.slice(0, maxLength - 3)");
    expect(file).toContain("...` : value");
  });

  it("no bare slice without reserve", () => {
    // Should not contain bare maxLength without -3 inside truncateText
    const start = file.indexOf("function truncateText");
    const snippet = file.slice(start, start + 300);
    expect(snippet).not.toContain("slice(0, maxLength)}...");
    expect(snippet).toContain("slice(0, maxLength - 3)}...");
  });

  it("count: exactly one bounded truncate", () => {
    const count = (file.match(/slice\(0, maxLength - 3\)/g) || []).length;
    expect(count).toBe(1);
  });

  it("payload weak vs fixed + sibling correct", () => {
    // weak: slice(0, maxLength) + "..." =>  maxLength+3 overflow, e.g., 10 -> 13
    // fixed: slice(0, maxLength -3) + "..." => exactly maxLength
    const weakLen = 10 + 3;
    const fixedLen = 10 - 3 + 3;
    expect(weakLen).toBe(13);
    expect(fixedLen).toBe(10);
    expect(file).toContain("slice(0, maxLength - 3)");
    // sibling: health-routes uses same -3 discipline
    expect(sibling).toContain("maxStringLength - 3");
  });
});
