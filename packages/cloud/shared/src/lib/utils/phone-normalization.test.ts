// Exercises phone normalization behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  isValidE164,
  isValidEmail,
  normalizePhoneNumber,
  normalizeToE164,
} from "./phone-normalization";

/**
 * Phone/email normalization feeds identity matching (iMessage, SMS). E.164 is
 * the canonical phone key; emails normalize to lowercase. A drift here splits
 * one contact across two identities or accepts a malformed key.
 */

describe("isValidE164 / isValidEmail", () => {
  test("E.164 requires a leading + and digits, no separators", () => {
    expect(isValidE164("+14155550123")).toBe(true);
    expect(isValidE164("14155550123")).toBe(false); // missing +
    expect(isValidE164("+1 415 555 0123")).toBe(false); // spaces
    expect(isValidE164("+0123")).toBe(false); // leading zero after +
  });

  test("email check accepts addr@host.tld, rejects malformed", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("no-at-sign")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });

  test("email check is linear on dotted-domain ReDoS input", () => {
    const evil = `x@${"a.".repeat(200_000)}@`;
    const start = performance.now();
    const result = isValidEmail(evil);
    const elapsed = performance.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("normalizeToE164", () => {
  test("passes through valid +E.164 and infers +1 for NANP digits", () => {
    expect(normalizeToE164("+1 (415) 555-0123")).toBe("+14155550123");
    expect(normalizeToE164("415-555-0123")).toBe("+14155550123"); // 10-digit → +1
    expect(normalizeToE164("1-415-555-0123")).toBe("+14155550123"); // 11-digit → +
    expect(normalizeToE164("12345")).toBeNull(); // not resolvable
  });
});

describe("normalizePhoneNumber", () => {
  test("emails normalize to lowercase, phones to E.164", () => {
    expect(normalizePhoneNumber("  User@Example.COM ")).toBe("user@example.com");
    expect(normalizePhoneNumber("+1 415 555 0123")).toBe("+14155550123");
  });
});
