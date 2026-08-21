/**
 * Regression tests for computeruse file-ops and android-trajectory surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const READ_FILE_CHAR_LIMIT = 10_000;
const MAX_ERROR_MSG = 256;

function formatFileContent(raw: string): string {
  return truncateWellFormed(toWellFormedUnicode(raw), READ_FILE_CHAR_LIMIT);
}

function formatErrorMessage(msg: string): string {
  return truncateWellFormed(toWellFormedUnicode(msg), MAX_ERROR_MSG);
}

function isWellFormed(v: string): boolean {
  if (!v) return true;
  if (
    typeof (v as unknown as { isWellFormed?: () => boolean }).isWellFormed ===
    "function"
  )
    return (v as unknown as { isWellFormed: () => boolean }).isWellFormed();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = v.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("computeruse file-ops and android trajectory surrogate safety", () => {
  it("keeps surrogate pairs intact at 10,000-char boundary in readFile content", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"f".repeat(9999)}${fox}${"g".repeat(100)}`;
    const out = formatFileContent(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(9999);
    expect(out).not.toContain("\uD83E");
  });

  it("keeps surrogate pairs intact at 256-char boundary in Android trajectory error message", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"e".repeat(255)}${fox}${"h".repeat(50)}`;
    const out = formatErrorMessage(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(255);
    expect(out).not.toContain("\uD83E");
  });

  it("sanitizes lone surrogates in file content and error logs", () => {
    const lone = `File header ${String.fromCharCode(0xd800)} content ${"z".repeat(12000)}`;
    const out = formatFileContent(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(READ_FILE_CHAR_LIMIT);
  });
});
