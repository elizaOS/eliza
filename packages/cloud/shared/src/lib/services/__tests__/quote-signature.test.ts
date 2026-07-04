// Exercises quote signature behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Bindings } from "../../../types/cloud-worker-env";
import {
  type QuoteSignatureInput,
  signQuote,
  verifyQuoteSignature,
} from "../direct-wallet-payments";

const ENV_KEYS = ["CRYPTO_DIRECT_QUOTE_SIGNING_KEY", "NODE_ENV"];
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function envWith(overrides: Record<string, string>): Bindings {
  return overrides as unknown as Bindings;
}

const validInput: QuoteSignatureInput = {
  paymentId: "00000000-0000-0000-0000-000000000001",
  expectedTokenUnits: 1_000_000_000_000_000_000n,
  receiveAddress: "0x93cacDACDf6791be31EA44742CA94db238C887EB",
  chainId: 56,
  tokenAddress: null,
  tokenMint: null,
  expiresAt: new Date("2026-05-21T07:30:00Z"),
};

describe("quote signing", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  test("signs and verifies a valid quote", async () => {
    const env = envWith({ CRYPTO_DIRECT_QUOTE_SIGNING_KEY: "test-key" });
    const { signature } = await signQuote(env, validInput);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signature.length).toBeGreaterThan(20);
    const ok = await verifyQuoteSignature(env, validInput, signature);
    expect(ok).toBe(true);
  });

  test("rejects a quote with tampered expectedTokenUnits", async () => {
    const env = envWith({ CRYPTO_DIRECT_QUOTE_SIGNING_KEY: "test-key" });
    const { signature } = await signQuote(env, validInput);
    const tampered: QuoteSignatureInput = {
      ...validInput,
      expectedTokenUnits: 1n, // attacker swaps 1 BNB → 1 wei
    };
    const ok = await verifyQuoteSignature(env, tampered, signature);
    expect(ok).toBe(false);
  });

  test("rejects a quote with tampered receiveAddress", async () => {
    const env = envWith({ CRYPTO_DIRECT_QUOTE_SIGNING_KEY: "test-key" });
    const { signature } = await signQuote(env, validInput);
    const tampered: QuoteSignatureInput = {
      ...validInput,
      receiveAddress: "0x0000000000000000000000000000000000000bad",
    };
    const ok = await verifyQuoteSignature(env, tampered, signature);
    expect(ok).toBe(false);
  });

  test("rejects a signature produced with a different key", async () => {
    const envA = envWith({ CRYPTO_DIRECT_QUOTE_SIGNING_KEY: "key-A" });
    const envB = envWith({ CRYPTO_DIRECT_QUOTE_SIGNING_KEY: "key-B" });
    const { signature } = await signQuote(envA, validInput);
    const ok = await verifyQuoteSignature(envB, validInput, signature);
    expect(ok).toBe(false);
  });

  test("identical inputs yield deterministic signatures", async () => {
    const env = envWith({ CRYPTO_DIRECT_QUOTE_SIGNING_KEY: "test-key" });
    const a = await signQuote(env, validInput);
    const b = await signQuote(env, validInput);
    expect(a.signature).toBe(b.signature);
    expect(a.canonicalInput).toBe(b.canonicalInput);
  });

  test("canonical input format encodes all critical fields", async () => {
    const env = envWith({ CRYPTO_DIRECT_QUOTE_SIGNING_KEY: "test-key" });
    const { canonicalInput } = await signQuote(env, validInput);
    expect(canonicalInput).toContain(validInput.paymentId);
    expect(canonicalInput).toContain("1000000000000000000");
    expect(canonicalInput).toContain(validInput.receiveAddress);
    expect(canonicalInput).toContain("|56|");
    expect(canonicalInput).toContain("|native|");
    expect(canonicalInput).toContain("2026-05-21T07:30:00.000Z");
  });

  test("refuses to sign in production without env key", async () => {
    const env = envWith({ NODE_ENV: "production" });
    await expect(signQuote(env, validInput)).rejects.toThrow(
      /CRYPTO_DIRECT_QUOTE_SIGNING_KEY is not configured/,
    );
  });

  test("dev environment without key uses the dev fallback (warning logged)", async () => {
    const env = envWith({ NODE_ENV: "development" });
    const { signature } = await signQuote(env, validInput);
    expect(signature.length).toBeGreaterThan(20);
  });

  test("token address vs token mint vs native are distinguished in the canonical string", async () => {
    const env = envWith({ CRYPTO_DIRECT_QUOTE_SIGNING_KEY: "test-key" });
    const erc20: QuoteSignatureInput = {
      ...validInput,
      tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    };
    const spl: QuoteSignatureInput = {
      ...validInput,
      tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const native = validInput;

    const sigErc20 = (await signQuote(env, erc20)).signature;
    const sigSpl = (await signQuote(env, spl)).signature;
    const sigNative = (await signQuote(env, native)).signature;

    expect(sigErc20).not.toBe(sigSpl);
    expect(sigSpl).not.toBe(sigNative);
    expect(sigErc20).not.toBe(sigNative);
  });
});
