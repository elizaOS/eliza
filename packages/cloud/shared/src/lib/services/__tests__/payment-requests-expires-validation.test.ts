/**
 * Unit test for #20098: validateCreateInput now rejects non-finite expiresInMs
 * (Infinity, NaN) before any repository call.
 */
import { describe, expect, test } from "bun:test";
import type { CreatePaymentRequestInput } from "../payment-requests";
import { validateCreateInput } from "../payment-requests";

const baseInput: CreatePaymentRequestInput = {
  organizationId: "org-1",
  provider: "stripe",
  amountCents: 1000,
  paymentContext: { kind: "open" },
};

describe("validateCreateInput — expiresInMs finite check", () => {
  test("accepts valid positive integer", () => {
    expect(() => validateCreateInput({ ...baseInput, expiresInMs: 30 * 60 * 1000 })).not.toThrow();
  });

  test("accepts undefined (uses default)", () => {
    expect(() => validateCreateInput({ ...baseInput })).not.toThrow();
  });

  test("rejects zero", () => {
    expect(() => validateCreateInput({ ...baseInput, expiresInMs: 0 })).toThrow(
      /expiresInMs must be a finite positive integer/,
    );
  });

  test("rejects negative", () => {
    expect(() => validateCreateInput({ ...baseInput, expiresInMs: -1000 })).toThrow(
      /expiresInMs must be a finite positive integer/,
    );
  });

  test("rejects NaN", () => {
    expect(() => validateCreateInput({ ...baseInput, expiresInMs: Number.NaN })).toThrow(
      /expiresInMs must be a finite positive integer/,
    );
  });

  test("rejects Infinity", () => {
    expect(() => validateCreateInput({ ...baseInput, expiresInMs: Infinity })).toThrow(
      /expiresInMs must be a finite positive integer/,
    );
  });

  test("rejects -Infinity", () => {
    expect(() => validateCreateInput({ ...baseInput, expiresInMs: -Infinity })).toThrow(
      /expiresInMs must be a finite positive integer/,
    );
  });

  test("accepts valid boundary 1ms", () => {
    expect(() => validateCreateInput({ ...baseInput, expiresInMs: 1 })).not.toThrow();
  });
});
