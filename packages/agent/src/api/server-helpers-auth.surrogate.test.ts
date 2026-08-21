/** Surrogate safety for formatTokenFingerprint in server-helpers-auth. */
import { describe, expect, test } from "vitest";
import { formatTokenFingerprint } from "./server-helpers-auth.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

describe("server-helpers-auth formatTokenFingerprint surrogate safety", () => {
  test("emoji in head 4 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const token = `abc${fox}random_secret_token_1234567890`;
    const fingerprint = formatTokenFingerprint(token);
    expect(isWellFormed(fingerprint)).toBe(true);
    expect(fingerprint.startsWith("abc...")).toBe(true);
    expect(() => JSON.stringify({ fingerprint })).not.toThrow();
  });

  test("emoji in tail -4 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const token = `prefix_long_random_token_1234${fox}`;
    const fingerprint = formatTokenFingerprint(token);
    expect(isWellFormed(fingerprint)).toBe(true);
    expect(fingerprint.endsWith(fox)).toBe(true);
    expect(() => JSON.stringify({ fingerprint })).not.toThrow();
  });

  test("standard hex token formats correctly", () => {
    const token =
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const fingerprint = formatTokenFingerprint(token);
    expect(fingerprint).toBe("abcd...6789");
  });

  test("short token returns asterisks safely", () => {
    expect(formatTokenFingerprint("secret")).toBe("****");
  });

  test("sweep offsets for token fingerprints all stay well-formed", () => {
    const fox = "🦊";
    for (let n = 5; n <= 15; n++) {
      const tok = `${"a".repeat(n)}${fox}${"b".repeat(n)}`;
      const fingerprint = formatTokenFingerprint(tok);
      expect(isWellFormed(fingerprint)).toBe(true);
      expect(() => JSON.stringify({ fingerprint })).not.toThrow();
    }
  });
});
