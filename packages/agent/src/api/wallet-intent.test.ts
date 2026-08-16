/**
 * Unit-tests the wallet chat-intent gate: bare finance verbs without a crypto
 * object are not wallet intent (a todo about swapping a filter must never
 * trigger the wallet-not-executed replacement), while genuine wallet asks
 * still qualify. Pure regex logic, no runtime.
 */
import { describe, expect, test } from "vitest";
import { isWalletActionRequiredIntent } from "./server-helpers.ts";

describe("isWalletActionRequiredIntent", () => {
  test("bare finance verbs in non-wallet chores do not qualify (live todo hijack)", () => {
    for (const text of [
      "add a todo: swap the canon filter, no deadline needed, just a general todo",
      "remind me to transfer the laundry to the dryer",
      "trade you my sandwich for your fries",
    ]) {
      expect(isWalletActionRequiredIntent(text)).toBe(false);
    }
  });

  test("genuine wallet asks still qualify", () => {
    for (const text of [
      "swap 0.1 eth for usdc",
      "whats my wallet balance",
      "transfer 5 sol to my other wallet",
      "send 100 tokens to alice",
    ]) {
      expect(isWalletActionRequiredIntent(text)).toBe(true);
    }
  });
});
