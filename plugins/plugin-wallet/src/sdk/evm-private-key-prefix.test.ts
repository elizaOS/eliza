/**
 * A private key copied with a 0X prefix is still 32 bytes. `startsWith("0x")`
 * treated that prefix as missing, so the key became `0x0X…` and the wallet
 * refused it.
 */

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";
import { TxService } from "../services/tx-service.js";
import { walletFromEnv } from "./convenience.js";

const BODY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const LOWER = `0x${BODY}`;
const EXPECTED = privateKeyToAccount(LOWER).address;

const ORIGINAL_KEY = process.env.AGENT_PRIVATE_KEY;
const ORIGINAL_ADDRESS = process.env.AGENT_WALLET_ADDRESS;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.AGENT_PRIVATE_KEY;
  else process.env.AGENT_PRIVATE_KEY = ORIGINAL_KEY;
  if (ORIGINAL_ADDRESS === undefined) delete process.env.AGENT_WALLET_ADDRESS;
  else process.env.AGENT_WALLET_ADDRESS = ORIGINAL_ADDRESS;
});

describe("0X EVM private key", () => {
  test("walletFromEnv keeps the same account", () => {
    process.env.AGENT_WALLET_ADDRESS =
      "0x0000000000000000000000000000000000000001";
    process.env.AGENT_PRIVATE_KEY = `0X${BODY}`;
    const wallet = walletFromEnv();
    expect(wallet.walletClient.account?.address).toBe(EXPECTED);
  });

  test("TxService keeps the same account", () => {
    const service = new TxService("http://127.0.0.1:1", `0X${BODY}`);
    expect(service.address).toBe(EXPECTED);
  });

  test("a short key is still rejected", () => {
    expect(() => new TxService("http://127.0.0.1:1", "0Xabc")).toThrow(
      /Invalid EVM_PRIVATE_KEY/,
    );
  });
});
