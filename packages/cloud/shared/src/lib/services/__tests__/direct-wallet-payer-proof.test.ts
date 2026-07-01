import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildDirectWalletPayerProofMessage,
  verifyDirectWalletPayerProof,
} from "../direct-wallet-payer-proof";

const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945387dc9e86dae66c3a618469c6e0e8c9ee3a";
const OTHER_KEY = "0x8b3a350cf5c34c9194ca3a9d8b542a7d542a20a6039b332cf98b472c25e11e6b";

describe("direct wallet payer proof", () => {
  test("verifies the EVM payer signature over the canonical payment challenge", async () => {
    const payer = privateKeyToAccount(PAYER_KEY);
    const message = buildDirectWalletPayerProofMessage({
      paymentId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000003",
      network: "base",
      payerAddress: payer.address,
      receiveAddress: "0x000000000000000000000000000000000000ba5e",
      tokenSymbol: "USDC",
      tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      expectedTokenUnits: 10_000_000n,
      expiresAt: "2026-07-01T20:00:00.000Z",
    });

    const signature = await payer.signMessage({ message });

    await expect(
      verifyDirectWalletPayerProof({
        network: "base",
        payerAddress: payer.address,
        message,
        signature,
      }),
    ).resolves.toBe(true);

    expect(message).toContain("Payment ID: 00000000-0000-4000-8000-000000000001");
    expect(message).toContain(`Payer address: ${payer.address.toLowerCase()}`);
    expect(message).toContain("Amount units: 10000000");
  });

  test("rejects a signature from a different wallet or for a different message", async () => {
    const payer = privateKeyToAccount(PAYER_KEY);
    const other = privateKeyToAccount(OTHER_KEY);
    const message = buildDirectWalletPayerProofMessage({
      paymentId: "00000000-0000-4000-8000-000000000011",
      organizationId: "00000000-0000-4000-8000-000000000012",
      userId: "00000000-0000-4000-8000-000000000013",
      network: "bsc",
      payerAddress: payer.address,
      receiveAddress: "0x0000000000000000000000000000000000000b5c",
      tokenSymbol: "USDT",
      tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
      expectedTokenUnits: "25000000000000000000",
      expiresAt: "2026-07-01T20:00:00.000Z",
    });

    const otherSignature = await other.signMessage({ message });
    const payerSignature = await payer.signMessage({ message });

    await expect(
      verifyDirectWalletPayerProof({
        network: "bsc",
        payerAddress: payer.address,
        message,
        signature: otherSignature,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyDirectWalletPayerProof({
        network: "bsc",
        payerAddress: payer.address,
        message: `${message}\nTampered: true`,
        signature: payerSignature,
      }),
    ).resolves.toBe(false);
  });

  test("verifies the Solana payer signature over the canonical payment challenge", async () => {
    const payer = Keypair.fromSeed(new Uint8Array(32).fill(7));
    const message = buildDirectWalletPayerProofMessage({
      paymentId: "00000000-0000-4000-8000-000000000021",
      organizationId: "00000000-0000-4000-8000-000000000022",
      userId: null,
      network: "solana",
      payerAddress: payer.publicKey.toBase58(),
      receiveAddress: "11111111111111111111111111111111",
      tokenSymbol: "USDC",
      tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      expectedTokenUnits: "5000000",
      expiresAt: "2026-07-01T20:00:00.000Z",
    });
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(message), payer.secretKey),
    );

    await expect(
      verifyDirectWalletPayerProof({
        network: "solana",
        payerAddress: payer.publicKey.toBase58(),
        message,
        signature,
      }),
    ).resolves.toBe(true);

    await expect(
      verifyDirectWalletPayerProof({
        network: "solana",
        payerAddress: Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBase58(),
        message,
        signature,
      }),
    ).resolves.toBe(false);
  });
});
