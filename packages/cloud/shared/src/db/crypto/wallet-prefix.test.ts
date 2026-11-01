/**
 * A wallet copied with a 0X prefix is the same EVM account. The lowercase-only
 * check left the mixed-case form in the digest, so the account received a
 * second no-reply email. A base58 key that differs only by case stays distinct.
 */

import { describe, expect, test, vi } from "vitest";

vi.mock("@elizaos/auth/kms", () => ({
  orgKey: () => ({}),
  systemKey: () => ({}),
}));

vi.mock("./kms-client", () => ({
  getKmsClient: () => ({}),
}));

const { normalizeWallet } = await import("./field-crypto");
const { synthesizeOidcWalletEmail } = await import("../../lib/oidc/wallet-email");

const EVM = "fde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const SOLANA = "So11111111111111111111111111111111111111112";

describe("wallet address prefix", () => {
  test("folds a 0X address onto the lowercase account", async () => {
    expect(normalizeWallet(`0X${EVM}`)).toBe(`0x${EVM.toLowerCase()}`);
    expect(normalizeWallet(`0x${EVM}`)).toBe(normalizeWallet(`0X${EVM}`));
    const domain = "users.noreply.example.com";
    const lower = await synthesizeOidcWalletEmail(`0x${EVM}`, domain);
    const upper = await synthesizeOidcWalletEmail(`0X${EVM}`, domain);
    expect(upper).toBe(lower);
  });

  test("does not fold a base58 address", () => {
    expect(normalizeWallet(SOLANA)).toBe(SOLANA);
    expect(normalizeWallet(SOLANA.toLowerCase())).not.toBe(normalizeWallet(SOLANA));
  });
});
