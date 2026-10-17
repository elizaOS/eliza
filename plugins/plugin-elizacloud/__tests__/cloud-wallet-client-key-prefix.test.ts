/**
 * The cloud client-address key is read from `ELIZA_CLOUD_CLIENT_ADDRESS_KEY`
 * (or `config.env`). A key copied with an uppercase `0X` prefix is the same
 * 32-byte key, but the reader only stripped a lowercase `0x`, so the
 * 66-character string failed the 64-hex check and the install reported
 * "Malformed ... expected 32-byte hex" for a valid key. The wallet plugin, the
 * local EOA backend and the vault readers already rewrite that prefix.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV,
  getOrCreateClientAddressKey,
} from "../src/cloud/cloud-wallet";

const BODY = "11".repeat(32);
const LOWERCASE_KEY = `0x${BODY}` as const;
const EXPECTED_ADDRESS = privateKeyToAccount(LOWERCASE_KEY).address;

describe("cloud client-address key prefix", () => {
  let previousFlag: string | undefined;
  let previousKey: string | undefined;

  beforeEach(() => {
    previousFlag = process.env.ENABLE_CLOUD_WALLET;
    previousKey = process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV];
    process.env.ENABLE_CLOUD_WALLET = "1";
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.ENABLE_CLOUD_WALLET;
    else process.env.ENABLE_CLOUD_WALLET = previousFlag;
    if (previousKey === undefined)
      delete process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV];
    else process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV] = previousKey;
  });

  it("reads a 0X-prefixed key as the same account", async () => {
    process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV] = `0X${BODY}`;
    const result = await getOrCreateClientAddressKey();
    expect(result.privateKey).toBe(LOWERCASE_KEY);
    expect(result.address).toBe(EXPECTED_ADDRESS);
    expect(result.minted).toBe(false);
  });

  it("still rejects a key that is not 32 bytes", async () => {
    process.env[ELIZA_CLOUD_CLIENT_ADDRESS_KEY_ENV] = "0Xabc";
    await expect(getOrCreateClientAddressKey()).rejects.toThrow(
      "expected 32-byte hex",
    );
  });
});
