/**
 * Deterministic coverage for the cloud-shared structural email validator.
 * Auto-provisioning wants the same practical shape as the previous simple
 * regex, with adversarial dotted domains handled by scans instead of regex
 * backtracking.
 */
import { describe, expect, test } from "vitest";
import { basicEmailValid, isValidEmail } from "./email-validation";

const LEGACY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BATTERY = [
  "a@b.co",
  "user.name@sub.domain.com",
  "x@a.b.",
  "a@b",
  "a@.com",
  "@b.com",
  "a@@b.com",
  "a b@c.com",
  "a@b .com",
  "plainaddress",
  "",
  "a@b.c.d.e",
];

describe("basicEmailValid", () => {
  test("matches the previous simple regex across safe cases", () => {
    for (const value of BATTERY) {
      expect(basicEmailValid(value)).toBe(LEGACY.test(value));
    }
  });

  test("is linear on dotted-domain ReDoS input", () => {
    const evil = `x@${"a.".repeat(200_000)} `;
    const start = performance.now();
    const result = basicEmailValid(evil);
    const elapsed = performance.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("isValidEmail", () => {
  test("preserves trimming and length bounds", () => {
    expect(isValidEmail("  a@b.co  ")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail(`${"a".repeat(250)}@b.co`)).toBe(false);
  });
});
