/**
 * Regression guard for the x402 top-up idempotency key: a settlement whose
 * `transaction` is empty must not collapse every payment on that network into
 * one key, because `creditsService.addCredits` dedupes on it and the payer
 * would be charged without receiving credits (#31960 family).
 */
import { describe, expect, it } from "vitest";
import { x402TopupIdempotencyKey, x402TopupPaymentId } from "./x402-topup-identity.ts";

describe("x402TopupPaymentId", () => {
  it("prefers the settlement transaction hash when the facilitator published one", () => {
    expect(
      x402TopupPaymentId(
        { transaction: "0xabc123" },
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      ),
    ).toBe("0xabc123");
  });

  it("falls back to the authorization nonce when the hash is empty", () => {
    expect(
      x402TopupPaymentId(
        { transaction: "" },
        "0x0000000000000000000000000000000000000000000000000000000000000002",
      ),
    ).toBe("0x0000000000000000000000000000000000000000000000000000000000000002");
  });

  it("keeps two hash-less payments on one network distinct", () => {
    const first = x402TopupPaymentId(
      { transaction: "" },
      "0x0000000000000000000000000000000000000000000000000000000000000003",
    );
    const second = x402TopupPaymentId(
      { transaction: "" },
      "0x0000000000000000000000000000000000000000000000000000000000000004",
    );
    expect(first).not.toBe(second);
    // The previous inline key (`x402:${network}:${settlement.transaction}`)
    // collapsed both of these onto the same empty-hash key.
    expect(`x402:base:${first}`).not.toBe(`x402:base:${second}`);
  });

  it("treats a missing transaction like an empty one", () => {
    expect(
      x402TopupPaymentId({}, "0x0000000000000000000000000000000000000000000000000000000000000005"),
    ).toBe("0x0000000000000000000000000000000000000000000000000000000000000005");
  });
});

describe("x402TopupIdempotencyKey", () => {
  it("is the key the handler passes to addCredits", () => {
    // createTopupHandler passes exactly this string as stripePaymentIntentId.
    expect(x402TopupIdempotencyKey("base", "0xabc123")).toBe("x402:base:0xabc123");
    expect(
      x402TopupIdempotencyKey(
        "base",
        x402TopupPaymentId(
          { transaction: "" },
          "0x0000000000000000000000000000000000000000000000000000000000000006",
        ),
      ),
    ).toBe("x402:base:0x0000000000000000000000000000000000000000000000000000000000000006");
  });

  it("keeps two hash-less payments on one network distinct at the key level", () => {
    const keyFor = (nonce: string) =>
      x402TopupIdempotencyKey("base", x402TopupPaymentId({ transaction: "" }, nonce));
    expect(keyFor("0x01")).not.toBe(keyFor("0x02"));
    // The previous key was `x402:${network}:${settlement.transaction}`, which
    // collapsed both of these onto "x402:base:".
    expect(keyFor("0x01")).not.toBe("x402:base:");
  });
});
