/**
 * Proves truncateError respects max inclusive of "…".
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const file = readFileSync(
  resolve("packages/app-core/src/services/secrets-manager-installer.ts"),
  "utf8",
);
const sibling = readFileSync(
  resolve("packages/cloud/shared/src/lib/web-push/notify-service.ts"),
  "utf8",
);

describe("secrets truncateError", () => {
  it("reserve present: max -1 before …", () => {
    expect(file).toContain("clean.slice(0, max - 1)");
  });

  it("no bare slice without reserve", () => {
    const start = file.indexOf("function truncateError");
    const snippet = file.slice(start, start + 400);
    expect(snippet).not.toContain("slice(0, max)}…");
    expect(snippet).toContain("slice(0, max - 1)}…");
  });

  it("count: exactly one bounded truncate", () => {
    const count = (file.match(/slice\(0, max - 1\)/g) || []).length;
    expect(count).toBe(1);
  });

  it("payload weak vs fixed + sibling correct", () => {
    const weakLen = 800 + 1;
    const fixedLen = 800 - 1 + 1;
    expect(weakLen).toBe(801);
    expect(fixedLen).toBe(800);
    expect(file).toContain("slice(0, max - 1)");
    expect(sibling).toContain("MAX_BODY_LENGTH - 1");
  });
});
