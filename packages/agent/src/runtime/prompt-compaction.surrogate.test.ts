/**
 * Regression for prompt-compaction surrogate-safe truncation (2000 + 500).
 */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const TASK_LIMIT = 2000;
const USER_MSG_LIMIT = 500;
function clampTask(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text ?? ""), TASK_LIMIT);
}
function clampUserMsg(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text ?? ""), USER_MSG_LIMIT);
}
function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}
describe("prompt-compaction well-formed", () => {
  it("backs off astral at 2000 boundary (1999+fox->1999)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(1999)}${fox}${"b".repeat(20)}`;
    const out = clampTask(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(1999);
    expect(out).toBe("a".repeat(1999));
  });
  it("preserves fitting astral at 2000 (1998+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(1998)}${fox}`;
    const out = clampTask(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(2000);
  });
  it("backs off astral at 500 boundary (499+fox->499)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(499)}${fox}${"b".repeat(20)}`;
    const out = clampUserMsg(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(499);
    expect(out).toBe("a".repeat(499));
  });
  it("preserves fitting astral at 500 (498+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(498)}${fox}`;
    const out = clampUserMsg(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(500);
  });
  it("sanitizes lone high surrogate", () => {
    const lone = `prompt ${String.fromCharCode(0xd800)} text`;
    const outTask = clampTask(`${lone}${"x".repeat(2500)}`);
    const outUser = clampUserMsg(`${lone}${"x".repeat(600)}`);
    expect(isWellFormed(outTask)).toBe(true);
    expect(isWellFormed(outUser)).toBe(true);
    expect(outTask.includes("�")).toBe(true);
    expect(outUser.includes("�")).toBe(true);
  });
  it("sanitizes lone low surrogate", () => {
    const lone = `prompt ${String.fromCharCode(0xdc00)} text`;
    const outTask = clampTask(`${lone}${"x".repeat(2500)}`);
    const outUser = clampUserMsg(`${lone}${"x".repeat(600)}`);
    expect(isWellFormed(outTask)).toBe(true);
    expect(isWellFormed(outUser)).toBe(true);
    expect(outTask.includes("�")).toBe(true);
    expect(outUser.includes("�")).toBe(true);
  });
  it("sweep around 2000 and 500 well-formed", () => {
    const fox = "🦊";
    for (let n = 1995; n <= 2005; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampTask(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(2000);
    }
    for (let n = 495; n <= 505; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampUserMsg(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(500);
    }
  });
  it("JSON.stringify does not throw on truncated output", () => {
    const fox = "🦊";
    const lone = String.fromCharCode(0xd800);
    for (const input of [
      `${"a".repeat(1999)}${fox}`,
      `${lone}${"x".repeat(10)}`,
      `${fox.repeat(300)}`,
    ]) {
      const outTask = clampTask(input);
      const outUser = clampUserMsg(input);
      expect(() => JSON.stringify(outTask)).not.toThrow();
      expect(() => JSON.stringify(outUser)).not.toThrow();
      expect(isWellFormed(outTask)).toBe(true);
      expect(isWellFormed(outUser)).toBe(true);
    }
  });
});
