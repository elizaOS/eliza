/** Surrogate safety for formatPrivateKeyPreview in tx-service.ts. */
import { describe, expect, test } from "vitest";
import { formatPrivateKeyPreview } from "./tx-service.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

describe("tx-service formatPrivateKeyPreview surrogate safety", () => {
  test("emoji at head 6 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const key = `0x1234${fox}7890abcdef1234567890abcdef`;
    const preview = formatPrivateKeyPreview(key);
    expect(isWellFormed(preview)).toBe(true);
    expect(preview.startsWith("0x1234...")).toBe(true);
    expect(() => JSON.stringify({ preview })).not.toThrow();
  });

  test("emoji at tail -4 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const key = `0x1234567890abcdef1234567890abc${fox}`;
    const preview = formatPrivateKeyPreview(key);
    expect(isWellFormed(preview)).toBe(true);
    expect(preview.endsWith(fox)).toBe(true);
    expect(() => JSON.stringify({ preview })).not.toThrow();
  });

  test("standard invalid key preview formatted correctly", () => {
    const key = "0x1234567890abcdef1234567890abcdef";
    const preview = formatPrivateKeyPreview(key);
    expect(preview).toBe("0x1234...cdef");
  });

  test("short key returns placeholder", () => {
    expect(formatPrivateKeyPreview("short")).toBe("(empty or too short)");
  });

  test("sweep offsets for private key previews all stay well-formed", () => {
    const fox = "🦊";
    for (let n = 5; n <= 15; n++) {
      const key = `0x${"a".repeat(n)}${fox}${"b".repeat(n)}`;
      const preview = formatPrivateKeyPreview(key);
      expect(isWellFormed(preview)).toBe(true);
      expect(() => JSON.stringify({ preview })).not.toThrow();
    }
  });
});
