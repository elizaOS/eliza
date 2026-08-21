/** Surrogate safety for formatAddressShort in agent-status-routes. */
import { describe, expect, test } from "vitest";
import { formatAddressShort } from "./agent-status-routes.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

describe("agent-status formatAddressShort surrogate safety", () => {
  test("emoji at head 6 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const address = `0x1234${fox}7890abcdef1234567890abcdef`;
    const formatted = formatAddressShort(address, 6, 4);
    expect(formatted).not.toBeNull();
    if (formatted) {
      expect(isWellFormed(formatted)).toBe(true);
      expect(formatted.startsWith("0x1234...")).toBe(true);
      expect(() => JSON.stringify({ formatted })).not.toThrow();
    }
  });

  test("emoji at tail -4 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const address = `0x1234567890abcdef1234567890abc${fox}`;
    const formatted = formatAddressShort(address, 6, 4);
    expect(formatted).not.toBeNull();
    if (formatted) {
      expect(isWellFormed(formatted)).toBe(true);
      expect(formatted.endsWith(fox)).toBe(true);
      expect(() => JSON.stringify({ formatted })).not.toThrow();
    }
  });

  test("standard EVM address formats correctly", () => {
    const address = "0x1234567890abcdef1234567890abcdef12345678";
    const formatted = formatAddressShort(address, 6, 4);
    expect(formatted).toBe("0x1234...5678");
  });

  test("short address returned verbatim", () => {
    const address = "0x1234";
    expect(formatAddressShort(address, 6, 4)).toBe("0x1234");
  });

  test("sweep offsets for address formatting all stay well-formed", () => {
    const fox = "🦊";
    for (let n = 5; n <= 15; n++) {
      const addr = `0x${"a".repeat(n)}${fox}${"b".repeat(n)}`;
      const formatted = formatAddressShort(addr, 6, 4);
      expect(formatted).not.toBeNull();
      if (formatted) {
        expect(isWellFormed(formatted)).toBe(true);
        expect(() => JSON.stringify({ formatted })).not.toThrow();
      }
    }
  });
});
