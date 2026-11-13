/**
 * A client-address key copied with a 0X prefix is still 32 bytes.
 * `startsWith("0x")` left the X in the body and rejected the key.
 */

import { afterEach, describe, expect, test } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV,
  getOrCreateClientAddressKey,
} from "./cloud-wallet.js";

const BODY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EXPECTED = privateKeyToAccount(`0x${BODY}`).address;

const ORIGINAL_FLAG = process.env.ENABLE_CLOUD_WALLET;
const ORIGINAL_KEY = process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV];

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_CLOUD_WALLET;
  else process.env.ENABLE_CLOUD_WALLET = ORIGINAL_FLAG;
  if (ORIGINAL_KEY === undefined) {
    delete process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV];
  }
  else process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV] = ORIGINAL_KEY;
});

describe("cloud client-address key prefix", () => {
  test("keeps a 0X key as the same account", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV] = `0X${BODY}`;
    const result = await getOrCreateClientAddressKey();
    expect(result.minted).toBe(false);
    expect(result.address).toBe(EXPECTED);
    expect(result.privateKey).toBe(`0x${BODY}`);
  });

  test("still rejects a short key", async () => {
    process.env.ENABLE_CLOUD_WALLET = "1";
    process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV] = "0Xabc";
    await expect(getOrCreateClientAddressKey()).rejects.toThrow(/32-byte hex/);
  });
});
