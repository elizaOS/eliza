/**
 * Regression tests for surrogate-safe truncation in shell components.
 *
 * Exercises formatSharePreview and buildStartupBugReportDraft to guarantee that
 * truncation boundaries back off safely when landing on a UTF-16 surrogate pair
 * (such as an emoji or astral-plane character), preventing lone surrogates and
 * replacement glyphs from appearing in toast notices and bug report descriptions.
 */

import { describe, expect, it } from "vitest";
import { formatSharePreview } from "./ShellOverlays";
import { buildStartupBugReportDraft } from "./StartupFailureView";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("ShellOverlays formatSharePreview — surrogate safety", () => {
  it("keeps strings shorter than or equal to 80 chars intact without truncation", () => {
    const shortText = "Shared text from mobile";
    expect(formatSharePreview(shortText)).toBe(shortText);

    const exact80 = "a".repeat(80);
    expect(formatSharePreview(exact80)).toBe(exact80);
  });

  it("truncates standard ASCII strings longer than 80 chars at 77 with ellipsis", () => {
    const text = "a".repeat(100);
    const preview = formatSharePreview(text);
    expect(preview).toBe(`${"a".repeat(77)}...`);
    expect(preview.length).toBe(80);
    expect(isWellFormed(preview)).toBe(true);
  });

  it("backs off surrogate pair that straddles the 77-char truncation boundary", () => {
    const rocket = String.fromCharCode(0xd83d, 0xde80); // 🚀 = \uD83D\uDE80
    const text = `${"x".repeat(76)}${rocket}${"y".repeat(20)}`;
    const preview = formatSharePreview(text);

    expect(isWellFormed(preview)).toBe(true);
    expect(() => JSON.stringify(preview)).not.toThrow();
    expect(preview.endsWith("...")).toBe(true);
    // Backs off the split surrogate: 76 chars + 3 dots = 79 chars, instead of 77 (high only) + 3 = 80 with dangling surrogate
    expect(preview.length).toBe(76 + 3);
    expect(preview).toBe(`${"x".repeat(76)}...`);
    expect(preview).not.toContain("\uD83D");
  });

  it("preserves complete surrogate pair when it fits wholly inside the 77-char budget", () => {
    const rocket = String.fromCharCode(0xd83d, 0xde80); // 🚀
    const text = `${"x".repeat(75)}${rocket}${"y".repeat(20)}`;
    const preview = formatSharePreview(text);

    expect(isWellFormed(preview)).toBe(true);
    expect(preview.length).toBe(75 + 2 + 3); // 80 chars
    expect(preview).toBe(`${"x".repeat(75)}${rocket}...`);
  });

  it("handles repeated emoji sequences without emitting lone surrogates", () => {
    const rocket = String.fromCharCode(0xd83d, 0xde80); // 🚀
    const text = rocket.repeat(50); // 100 code units
    const preview = formatSharePreview(text);

    expect(isWellFormed(preview)).toBe(true);
    expect(preview.endsWith("...")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview).toBe(`${rocket.repeat(38)}...`);
  });
});

describe("StartupFailureView buildStartupBugReportDraft — surrogate safety", () => {
  it("keeps short error messages without truncation", () => {
    const draft = buildStartupBugReportDraft("Can't connect", {
      reason: "backend-unreachable",
      phase: "starting-backend",
      message: "Connection refused",
    });
    expect(draft.description).toBe("Can't connect: Connection refused");
    expect(isWellFormed(draft.description ?? "")).toBe(true);
  });

  it("backs off surrogate pair straddling the 80-char description boundary", () => {
    const explosion = String.fromCharCode(0xd83d, 0xdca5); // 💥 = \uD83D\uDCA5
    // label "Error" (5) + ": " (2) = 7 chars. We need 72 chars of prefix before explosion straddles 79..80
    const prefix = "e".repeat(72);
    const message = `${prefix}${explosion}${"tail".repeat(10)}`;

    const draft = buildStartupBugReportDraft("Error", {
      reason: "unknown",
      phase: "starting-backend",
      message,
    });

    const desc = draft.description ?? "";
    expect(isWellFormed(desc)).toBe(true);
    expect(() => JSON.stringify(desc)).not.toThrow();
    expect(desc.length).toBeLessThanOrEqual(80);
    // Backs off the high surrogate: 7 + 72 = 79 chars
    expect(desc.length).toBe(79);
    expect(desc).toBe(`Error: ${prefix}`);
    expect(desc).not.toContain("\uD83D");
  });

  it("preserves complete surrogate pair when fitting within 80 chars", () => {
    const explosion = String.fromCharCode(0xd83d, 0xdca5); // 💥
    const prefix = "e".repeat(71);
    const message = `${prefix}${explosion}${"tail".repeat(10)}`;

    const draft = buildStartupBugReportDraft("Error", {
      reason: "unknown",
      phase: "starting-backend",
      message,
    });

    const desc = draft.description ?? "";
    expect(isWellFormed(desc)).toBe(true);
    expect(desc.length).toBe(7 + 71 + 2); // 80 chars
    expect(desc).toBe(`Error: ${prefix}${explosion}`);
  });
});
