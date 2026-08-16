// Deterministic unit coverage for deadline-to-provider checkout lifetime
// clamping (Stripe expires_at seconds, OxaPay whole-minute lifetime).
import { describe, expect, test } from "bun:test";
import {
  clampCheckoutLifetimeMs,
  OXAPAY_INVOICE_MAX_LIFETIME_MS,
  OXAPAY_INVOICE_MIN_LIFETIME_MS,
  oxapayInvoiceLifetimeSeconds,
  STRIPE_CHECKOUT_MAX_LIFETIME_MS,
  STRIPE_CHECKOUT_MIN_LIFETIME_MS,
  stripeCheckoutExpiresAtSeconds,
} from "./checkout-lifetime";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const HOUR_MS = 3_600_000;

function deadlineIn(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

describe("clampCheckoutLifetimeMs", () => {
  const bounds = { minMs: 10_000, maxMs: 100_000 };

  test("passes through an in-window deadline", () => {
    expect(clampCheckoutLifetimeMs(deadlineIn(50_000), NOW, bounds)).toBe(50_000);
  });

  test("clamps a too-near deadline up to the provider floor", () => {
    expect(clampCheckoutLifetimeMs(deadlineIn(1_000), NOW, bounds)).toBe(10_000);
  });

  test("clamps an already-passed deadline up to the provider floor", () => {
    expect(clampCheckoutLifetimeMs(deadlineIn(-5_000), NOW, bounds)).toBe(10_000);
  });

  test("clamps a far deadline down to the provider ceiling", () => {
    expect(clampCheckoutLifetimeMs(deadlineIn(1_000_000), NOW, bounds)).toBe(100_000);
  });

  test("throws on an invalid deadline instead of minting an unbounded session", () => {
    expect(() => clampCheckoutLifetimeMs(new Date(Number.NaN), NOW, bounds)).toThrow(
      /not a valid date/,
    );
  });
});

describe("stripeCheckoutExpiresAtSeconds", () => {
  test("binds an in-window deadline exactly", () => {
    const deadline = deadlineIn(2 * HOUR_MS);
    expect(stripeCheckoutExpiresAtSeconds(deadline, NOW)).toBe(
      Math.floor(deadline.getTime() / 1000),
    );
  });

  test("clamps a 5-minute deadline up to Stripe's 30-minute floor", () => {
    expect(stripeCheckoutExpiresAtSeconds(deadlineIn(5 * 60_000), NOW)).toBe(
      Math.floor((NOW.getTime() + STRIPE_CHECKOUT_MIN_LIFETIME_MS) / 1000),
    );
  });

  test("clamps a 7-day deadline down to Stripe's 24-hour ceiling", () => {
    expect(stripeCheckoutExpiresAtSeconds(deadlineIn(7 * 24 * HOUR_MS), NOW)).toBe(
      Math.floor((NOW.getTime() + STRIPE_CHECKOUT_MAX_LIFETIME_MS) / 1000),
    );
  });
});

describe("oxapayInvoiceLifetimeSeconds", () => {
  test("binds an in-window deadline, rounded up to a whole minute", () => {
    expect(oxapayInvoiceLifetimeSeconds(deadlineIn(HOUR_MS + 30_000), NOW)).toBe(61 * 60);
  });

  test("clamps a 2-minute deadline up to OxaPay's 15-minute floor", () => {
    expect(oxapayInvoiceLifetimeSeconds(deadlineIn(2 * 60_000), NOW)).toBe(
      OXAPAY_INVOICE_MIN_LIFETIME_MS / 1000,
    );
  });

  test("clamps a 7-day deadline down to OxaPay's 2-day ceiling", () => {
    expect(oxapayInvoiceLifetimeSeconds(deadlineIn(7 * 24 * HOUR_MS), NOW)).toBe(
      OXAPAY_INVOICE_MAX_LIFETIME_MS / 1000,
    );
  });

  test("ceiling boundary is not pushed past the maximum by minute rounding", () => {
    expect(oxapayInvoiceLifetimeSeconds(deadlineIn(OXAPAY_INVOICE_MAX_LIFETIME_MS - 1), NOW)).toBe(
      OXAPAY_INVOICE_MAX_LIFETIME_MS / 1000,
    );
  });
});
