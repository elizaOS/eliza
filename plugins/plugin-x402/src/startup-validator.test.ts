/**
 * Unit tests for `validateX402Startup` covering config resolution and
 * rejection cases. Pure in-process assertions against fabricated route
 * objects — no real HTTP dispatch, DB, or network involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateX402Startup } from "./startup-validator.js";

const originalEnv = { ...process.env };

function paidRoute(x402: unknown, overrides: Record<string, unknown> = {}) {
  return {
    path: "/paid",
    type: "GET",
    handler: vi.fn(),
    x402,
    ...overrides,
  } as never;
}

describe("validateX402Startup", () => {
  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: "test" };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("rejects x402 true when character defaults are missing", () => {
    const result = validateX402Startup([paidRoute(true)]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("defaultPriceInCents"),
        expect.stringContaining("defaultPaymentConfigs"),
      ]),
    );
  });

  it("uses character defaults for partial route configuration", () => {
    const result = validateX402Startup([paidRoute({ priceInCents: 25 })], {
      settings: {
        x402: {
          defaultPriceInCents: 10,
          defaultPaymentConfigs: ["base_usdc"],
        },
      },
    } as never);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects unknown payment config names", () => {
    const result = validateX402Startup([
      paidRoute({ priceInCents: 25, paymentConfigs: ["missing_config"] }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("unknown payment config 'missing_config'"),
    ]);
  });

  it("rejects primitive x402 values", () => {
    const result = validateX402Startup([paidRoute("yes")]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("x402 must be true or a configuration object"),
    ]);
  });

  it("rejects protected routes without handlers", () => {
    const result = validateX402Startup([
      paidRoute(
        { priceInCents: 25, paymentConfigs: ["base_usdc"] },
        {
          handler: undefined,
        },
      ),
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("route has x402 protection but no handler"),
    ]);
  });
});
