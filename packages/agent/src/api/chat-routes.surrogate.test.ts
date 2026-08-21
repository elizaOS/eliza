/**
 * Regression for chat-routes surrogate-safe truncation (700 + 997).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const CHAT_LIMIT = 700;
const VALUE_LIMIT = 1000;
const VALUE_TRUNCATE = 997;

function clampChat(text: string): string {
  const wellFormed = toWellFormedUnicode(text ?? "");
  if (wellFormed.length <= CHAT_LIMIT) return wellFormed;
  return truncateWellFormed(wellFormed, CHAT_LIMIT);
}

function clampActionValue(value: string): string {
  const wellFormed = toWellFormedUnicode(value ?? "");
  return wellFormed.length > VALUE_LIMIT
    ? `${truncateWellFormed(wellFormed, VALUE_TRUNCATE)}...`
    : wellFormed;
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("chat-routes well-formed", () => {
  it("backs off astral at 700 boundary (699+fox->699)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(699)}${fox}${"b".repeat(20)}`;
    const out = clampChat(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(699);
    expect(out).toBe("a".repeat(699));
  });

  it("preserves fitting astral at 700 (698+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(698)}${fox}`;
    const out = clampChat(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(700);
  });

  it("backs off astral at 997 boundary (996+fox->996)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(996)}${fox}${"b".repeat(50)}`;
    const out = clampActionValue(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(999);
    expect(out.endsWith("...")).toBe(true);
    expect(out.slice(0, 996)).toBe("a".repeat(996));
  });

  it("preserves fitting astral at 997 (995+fox intact before suffix)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(995)}${fox}${"b".repeat(10)}`;
    const out = clampActionValue(input);
    // input length = 995+2+10=1007 >1000, so truncates to 997+"..." =1000, must be well-formed
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(1000);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `chat ${String.fromCharCode(0xd800)} text`;
    const outChat = clampChat(`${lone}${"x".repeat(800)}`);
    const outVal = clampActionValue(`${lone}${"x".repeat(1200)}`);
    expect(isWellFormed(outChat)).toBe(true);
    expect(isWellFormed(outVal)).toBe(true);
    expect(outChat.includes("�")).toBe(true);
    expect(outVal.includes("�")).toBe(true);
  });

  it("short passthrough well-formed", () => {
    expect(clampChat("short chat")).toBe("short chat");
    expect(clampActionValue("short value")).toBe("short value");
  });

  it("sweep around 700 and 997 well-formed", () => {
    const fox = "🦊";
    for (let n = 695; n <= 705; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampChat(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(700);
    }
    for (let n = 992; n <= 1002; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampActionValue(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(1000);
    }
  });
});
