/** Exercises the real top-up handler with local settlement and ledger doubles. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { creditsService } from "./credits";
import { referralsService } from "./referrals";
import { createTopupHandler } from "./topup-handler";
import * as walletSignup from "./wallet-signup";
import { x402FacilitatorService } from "./x402-facilitator";

const PAYER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function fixture(transaction = "") {
  spies.push(
    spyOn(walletSignup, "findOrCreateUserByWalletAddress").mockResolvedValue({
      user: { id: "user", organization_id: "org" },
    } as never),
  );
  spies.push(
    spyOn(x402FacilitatorService, "settle").mockImplementation(
      async () =>
        ({
          success: true,
          network: "eip155:8453",
          transaction,
          payer: PAYER,
        }) as never,
    ),
  );
  spies.push(
    spyOn(referralsService, "calculateRevenueSplits").mockResolvedValue({ splits: [] } as never),
  );
  const keys: string[] = [];
  spies.push(
    spyOn(creditsService, "addCredits").mockImplementation(async (input) => {
      keys.push(input.stripePaymentIntentId!);
      return { transaction: { id: "credit" }, newBalance: 10 } as never;
    }),
  );
  const handler = createTopupHandler({ amount: 10, getSourceId: () => "unused" });
  return {
    keys,
    async pay(nonce: string, from = PAYER) {
      const response = await handler(
        new Request("https://cloud.example/api/v1/topup/10", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-PAYMENT": JSON.stringify({
              x402Version: 2,
              accepted: {},
              payload: { signature: "fixture", authorization: { from, nonce } },
            }),
          },
          body: JSON.stringify({ walletAddress: from }),
        }),
        { X402_RECIPIENT_ADDRESS: RECIPIENT, X402_NETWORK: "base" },
      );
      expect(response.status).toBe(200);
    },
  };
}

test("hash-less settlements keep distinct authorizations separate and retries stable", async () => {
  const f = fixture();
  const nonce = "0x" + "01".repeat(32);
  await f.pay(nonce);
  await f.pay("0x" + "02".repeat(32));
  await f.pay(nonce);
  await f.pay(nonce, "0x4444444444444444444444444444444444444444");
  expect(f.keys[0]).not.toBe(f.keys[1]);
  expect(f.keys[0]).toBe(f.keys[2]);
  expect(f.keys[0]).not.toBe(f.keys[3]);
});

test("published settlement hashes retain their existing idempotency key", async () => {
  const f = fixture("0xpublished");
  await f.pay("0x" + "01".repeat(32));
  expect(f.keys).toEqual(["x402:eip155:8453:0xpublished"]);
});

test("a settled payment without a usable fallback identity cannot share an empty credit key", async () => {
  const f = fixture();
  await expect(f.pay("")).rejects.toThrow("no usable payment identity");
  expect(f.keys).toEqual([]);
});
