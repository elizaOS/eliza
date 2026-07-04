// Exercises crypto behavior with deterministic cloud-shared lib fixtures.
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import type { OxaPayWebhookPayload } from "./crypto";
import {
  calculateTolerance,
  extractWebhookTimestamp,
  getNetworkConfig,
  getSupportedNetworks,
  validatePaymentAmount,
  validateReceivedAmount,
  validateWebhookTimestamp,
} from "./crypto";

/**
 * OxaPay crypto-payment validation. These gate real money: amounts must stay in
 * [MIN, MAX], underpayment must be rejected (overpayment accepted), and webhook
 * timestamps must be rejected when too old (replay) or implausibly in the future.
 */

const network = getSupportedNetworks()[0];

describe("validatePaymentAmount", () => {
  test("enforces the min/max bounds", () => {
    expect(validatePaymentAmount(new Decimal("0.5")).valid).toBe(false);
    expect(validatePaymentAmount(new Decimal("5000")).valid).toBe(true);
    expect(validatePaymentAmount(new Decimal("20000")).valid).toBe(false);
  });
});

describe("validateReceivedAmount", () => {
  test("accepts exact and overpayment, rejects underpayment", () => {
    const ten = new Decimal("10");
    expect(validateReceivedAmount(new Decimal("10"), ten, network).valid).toBe(true);
    expect(validateReceivedAmount(new Decimal("11"), ten, network).valid).toBe(true);
    expect(validateReceivedAmount(new Decimal("9"), ten, network).valid).toBe(false);
    expect(validateReceivedAmount(ten, ten, network).threshold.equals(ten)).toBe(true);
  });
});

describe("networks", () => {
  test("getSupportedNetworks + getNetworkConfig, throw on unknown", () => {
    expect(getSupportedNetworks().length).toBeGreaterThan(0);
    expect(getNetworkConfig(network)).toBeDefined();
    expect(() => getNetworkConfig("not-a-network" as never)).toThrow(/Unsupported network/);
  });

  test("calculateTolerance never exceeds the amount", () => {
    const amount = new Decimal("100");
    const tol = calculateTolerance(amount, network);
    expect(tol.lessThanOrEqualTo(amount)).toBe(true);
  });
});

describe("webhook timestamps", () => {
  test("extractWebhookTimestamp normalizes seconds to ms, prefers header", () => {
    expect(extractWebhookTimestamp("1700000000", {} as OxaPayWebhookPayload)).toBe(
      1_700_000_000_000,
    );
    expect(extractWebhookTimestamp(null, { date: 1_700_000_000 } as OxaPayWebhookPayload)).toBe(
      1_700_000_000_000,
    );
    expect(extractWebhookTimestamp(null, {} as OxaPayWebhookPayload)).toBeUndefined();
  });

  test("validateWebhookTimestamp rejects stale + future, allows now + undefined", () => {
    const now = Date.now();
    expect(validateWebhookTimestamp(undefined).isValid).toBe(true);
    expect(validateWebhookTimestamp(now).isValid).toBe(true);
    expect(validateWebhookTimestamp(now - 1_000_000_000_000).isValid).toBe(false);
    expect(validateWebhookTimestamp(now + 1_000_000_000_000).isValid).toBe(false);
  });
});
