import { afterEach, expect, it, vi } from "vitest";
import { importWallet, validatePrivateKey } from "../src/api/wallet.ts";
import { deriveEvmAddress } from "../src/api/wallet-keygen.ts";

const BODY = "11".repeat(32);
const LOWER = `0x${BODY}`;
const UPPER = `0X${BODY}`;

afterEach(() => vi.unstubAllEnvs());

it("accepts an uppercase 0X EVM private key as the same key as 0x", () => {
  const address = deriveEvmAddress(LOWER);
  expect(deriveEvmAddress(UPPER)).toBe(address);
  const validated = validatePrivateKey(UPPER);
  expect(validated).toMatchObject({
    valid: true,
    chain: "evm",
    address,
  });
  vi.stubEnv("EVM_PRIVATE_KEY", "");
  const imported = importWallet("evm", UPPER);
  expect(imported.success).toBe(true);
  expect(imported.address).toBe(address);
  expect(process.env.EVM_PRIVATE_KEY).toBe(LOWER);
});
