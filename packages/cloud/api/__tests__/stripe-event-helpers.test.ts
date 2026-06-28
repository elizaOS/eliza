/**
 * Unit tests for pure helpers in `src/queue/stripe-event.ts`.
 *
 * The full event handlers require a live Postgres + Stripe + Redis stack;
 * these helpers gate every downstream write, so a regression here would
 * corrupt billing data. Verifying them in isolation is high-value.
 */

import { describe, expect, test } from "bun:test";

import {
  isInvoiceExpanded,
  parseAndValidateCredits,
  STRIPE_MAX_CREDITS,
} from "../src/queue/stripe-event";

describe("parseAndValidateCredits", () => {
  test("parses and rounds to two decimals", () => {
    expect(parseAndValidateCredits("10")).toBe(10);
    expect(parseAndValidateCredits("10.005")).toBe(10.01);
    expect(parseAndValidateCredits("0.336")).toBe(0.34);
  });

  test("rejects non-positive values", () => {
    expect(parseAndValidateCredits("0")).toBeNull();
    expect(parseAndValidateCredits("-5")).toBeNull();
    expect(parseAndValidateCredits("-0.01")).toBeNull();
  });

  test("rejects non-numeric strings", () => {
    expect(parseAndValidateCredits("")).toBeNull();
    expect(parseAndValidateCredits("abc")).toBeNull();
    expect(parseAndValidateCredits("NaN")).toBeNull();
    expect(parseAndValidateCredits("Infinity")).toBeNull();
  });

  test("rejects values above the cap", () => {
    expect(parseAndValidateCredits(String(STRIPE_MAX_CREDITS + 1))).toBeNull();
    expect(parseAndValidateCredits("1000000")).toBeNull();
  });

  test("accepts values at the cap", () => {
    expect(parseAndValidateCredits(String(STRIPE_MAX_CREDITS))).toBe(
      STRIPE_MAX_CREDITS,
    );
  });
});

describe("isInvoiceExpanded", () => {
  test("recognises an expanded invoice object with id", () => {
    expect(isInvoiceExpanded({ id: "in_123" })).toBe(true);
  });

  test("returns false for a string id", () => {
    expect(isInvoiceExpanded("in_123")).toBe(false);
  });

  test("returns false for null / undefined", () => {
    expect(isInvoiceExpanded(null)).toBe(false);
    expect(isInvoiceExpanded(undefined)).toBe(false);
  });

  test("returns false for an object without id", () => {
    expect(isInvoiceExpanded({ amount_due: 100 })).toBe(false);
  });
});
