/**
 * Structural email validator coverage for form control types. Built-in controls
 * retain their historical practical shape, while the field validator keeps its
 * stricter non-empty domain-label contract without regex backtracking.
 */
import { describe, expect, it } from "vitest";
import { basicEmailValid, strictEmailValid } from "./email";

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
  it("matches the previous simple regex across safe cases", () => {
    for (const value of BATTERY) {
      expect(basicEmailValid(value)).toBe(LEGACY.test(value));
    }
  });

  it("is linear on dotted-domain ReDoS input", () => {
    const evil = `x@${"a.".repeat(200_000)} `;
    const start = performance.now();
    const result = basicEmailValid(evil);
    const elapsed = performance.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("strictEmailValid", () => {
  it("preserves the previous field-validator domain label behavior", () => {
    expect(strictEmailValid("a@b.co")).toBe(true);
    expect(strictEmailValid("user.name@sub.domain.com")).toBe(true);
    expect(strictEmailValid("x@a.b.")).toBe(false);
    expect(strictEmailValid("a@.com")).toBe(false);
    expect(strictEmailValid("a@b")).toBe(false);
  });

  it("is linear on dotted-domain ReDoS input", () => {
    const evil = `x@${"a.".repeat(200_000)} `;
    const start = performance.now();
    const result = strictEmailValid(evil);
    const elapsed = performance.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });
});
