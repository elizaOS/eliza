/**
 * A payout key copied with a 0X prefix is still 32 bytes. `startsWith("0x")`
 * doubled it to `0x0X…`, and the admin hot-wallet lookup threw.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

mock.module("./eliza-token-price", () => ({
  ELIZA_TOKEN_ADDRESSES: {},
}));
mock.module("../utils/logger", () => ({
  logger: { warn() {}, info() {}, error() {}, debug() {} },
}));

const BODY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EXPECTED = privateKeyToAccount(`0x${BODY}`).address;

const ORIGINAL_PAYOUT = process.env.EVM_PAYOUT_PRIVATE_KEY;
const ORIGINAL_EVM = process.env.EVM_PRIVATE_KEY;

let getHotWalletAddresses: () => { evm: string | null; solana: string | null };

beforeAll(async () => {
  ({ getHotWalletAddresses } = await import("./payout-status"));
});

afterEach(() => {
  if (ORIGINAL_PAYOUT === undefined) delete process.env.EVM_PAYOUT_PRIVATE_KEY;
  else process.env.EVM_PAYOUT_PRIVATE_KEY = ORIGINAL_PAYOUT;
  if (ORIGINAL_EVM === undefined) delete process.env.EVM_PRIVATE_KEY;
  else process.env.EVM_PRIVATE_KEY = ORIGINAL_EVM;
});

describe("getHotWalletAddresses 0X prefix", () => {
  test("derives the same address from a 0X payout key", () => {
    delete process.env.EVM_PRIVATE_KEY;
    process.env.EVM_PAYOUT_PRIVATE_KEY = `0X${BODY}`;
    expect(getHotWalletAddresses().evm).toBe(EXPECTED);
  });
});
