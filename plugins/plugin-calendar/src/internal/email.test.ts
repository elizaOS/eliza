/**
 * Unit tests for `basicEmailValid`, the event-editor attendee check. Confirms
 * it accepts/rejects exactly what the prior `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
 * regex did (equivalence battery), and proves the linear rewrite no longer
 * exhibits that regex's O(n²) backtracking on adversarial input. Pure function.
 */
import { describe, expect, it } from "vitest";
import { basicEmailValid } from "./email.js";

// The regex the rewrite replaces. Run ONLY on safe (short) inputs to prove
// equivalence — never on the pathological string, which would hang it.
const LEGACY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BATTERY = [
  "a@b.co",
  "user.name@sub.domain.com",
  "x@a.b.", // trailing dot in domain — the legacy regex accepts this
  "a@b", // no dot
  "a@.com", // leading dot
  "@b.com", // empty local
  "a@@b.com", // two @
  "a b@c.com", // space in local
  "a@b .com", // space in domain
  "plainaddress", // no @
  "", // empty
  "a@b.c.d.e",
];

describe("basicEmailValid", () => {
  it("matches the legacy regex across the battery", () => {
    for (const value of BATTERY) {
      expect(basicEmailValid(value)).toBe(LEGACY.test(value));
    }
  });

  it("is linear on a dotted-domain + trailing-space input (ReDoS input)", () => {
    const evil = `x@${"a.".repeat(200_000)} `;
    const start = performance.now();
    const result = basicEmailValid(evil);
    const elapsed = performance.now() - start;
    expect(result).toBe(false); // whitespace present
    expect(elapsed).toBeLessThan(1000);
  });

  it("is linear on a dotted-domain + trailing-@ input (ReDoS input)", () => {
    const evil = `x@${"a.".repeat(200_000)}@`;
    const start = performance.now();
    const result = basicEmailValid(evil);
    const elapsed = performance.now() - start;
    expect(result).toBe(false); // two '@'
    expect(elapsed).toBeLessThan(1000);
  });
});
