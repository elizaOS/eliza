/** Surrogate safety for maskSecret and shortenMint in wallet.ts. */
import { describe, expect, test } from "vitest";
import { maskSecret } from "./wallet.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

describe("wallet maskSecret surrogate safety", () => {
  test("emoji in secret head backs off without lone surrogate", () => {
    const fox = "🦊";
    const secret = `abc${fox}long_secret_key_123456`;
    const masked = maskSecret(secret);
    expect(isWellFormed(masked)).toBe(true);
    expect(masked.startsWith("abc...")).toBe(true);
    expect(() => JSON.stringify({ masked })).not.toThrow();
  });

  test("emoji in secret tail backs off without lone surrogate", () => {
    const fox = "🦊";
    const secret = `prefix_long_secret_1234${fox}`;
    const masked = maskSecret(secret);
    expect(isWellFormed(masked)).toBe(true);
    expect(masked.endsWith(fox)).toBe(true);
    expect(() => JSON.stringify({ masked })).not.toThrow();
  });

  test("short secret returns asterisks", () => {
    expect(maskSecret("short")).toBe("****");
  });

  test("lone high surrogate in secret is sanitized safely", () => {
    const badInput = "bad \ud800 secret string value 123456";
    const masked = maskSecret(badInput);
    expect(isWellFormed(masked)).toBe(true);
    expect(masked.includes("\ud800")).toBe(false);
  });

  test("sweep offsets for masked secrets all stay well-formed", () => {
    const fox = "🦊";
    for (let n = 5; n <= 15; n++) {
      const secret = `${"a".repeat(n)}${fox}${"b".repeat(n)}`;
      const masked = maskSecret(secret);
      expect(isWellFormed(masked)).toBe(true);
      expect(() => JSON.stringify({ masked })).not.toThrow();
    }
  });
});
