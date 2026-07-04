// Exercises direct wallet payer proof behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildDirectWalletPayerProofMessage,
  buildDirectWalletPayerProofTypedData,
  toDirectWalletPayerProofSigningTypedData,
  verifyDirectWalletPayerProof,
} from "../direct-wallet-payer-proof";

const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945387dc9e86dae66c3a618469c6e0e8c9ee3a";
const OTHER_KEY = "0x8b3a350cf5c34c9194ca3a9d8b542a7d542a20a6039b332cf98b472c25e11e6b";

describe("direct wallet payer proof", () => {
  test("verifies the EVM payer signature over the typed payment challenge", async () => {
    const payer = privateKeyToAccount(PAYER_KEY);
    const typedData = buildDirectWalletPayerProofTypedData({
      paymentId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000003",
      network: "base",
      chainId: 8453,
      payerAddress: payer.address,
      receiveAddress: "0x000000000000000000000000000000000000ba5e",
      tokenSymbol: "USDC",
      tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      expectedTokenUnits: 10_000_000n,
      nonce: "payer-proof-nonce-1",
      expiresAt: "2026-07-01T20:00:00.000Z",
    });

    const signature = await payer.signTypedData(
      toDirectWalletPayerProofSigningTypedData(typedData),
    );

    await expect(
      verifyDirectWalletPayerProof({
        network: "base",
        payerAddress: payer.address,
        typedData,
        signature,
      }),
    ).resolves.toBe(true);

    expect(typedData.primaryType).toBe("DirectWalletPayment");
    expect(typedData.message.paymentId).toBe("00000000-0000-4000-8000-000000000001");
    expect(typedData.message.payerAddress).toBe(payer.address);
    expect(typedData.message.amountUnits).toBe("10000000");
  });

  test("rejects a typed-data signature from a different wallet or binding", async () => {
    const payer = privateKeyToAccount(PAYER_KEY);
    const other = privateKeyToAccount(OTHER_KEY);
    const typedData = buildDirectWalletPayerProofTypedData({
      paymentId: "00000000-0000-4000-8000-000000000011",
      organizationId: "00000000-0000-4000-8000-000000000012",
      userId: "00000000-0000-4000-8000-000000000013",
      network: "bsc",
      chainId: 56,
      payerAddress: payer.address,
      receiveAddress: "0x0000000000000000000000000000000000000b5c",
      tokenSymbol: "USDT",
      tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
      expectedTokenUnits: "25000000000000000000",
      nonce: "payer-proof-nonce-2",
      expiresAt: "2026-07-01T20:00:00.000Z",
    });

    const otherSignature = await other.signTypedData(
      toDirectWalletPayerProofSigningTypedData(typedData),
    );
    const payerSignature = await payer.signTypedData(
      toDirectWalletPayerProofSigningTypedData(typedData),
    );

    await expect(
      verifyDirectWalletPayerProof({
        network: "bsc",
        payerAddress: payer.address,
        typedData,
        signature: otherSignature,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyDirectWalletPayerProof({
        network: "bsc",
        payerAddress: payer.address,
        typedData: {
          ...typedData,
          message: {
            ...typedData.message,
            amountUnits: "26000000000000000000",
          },
        },
        signature: payerSignature,
      }),
    ).resolves.toBe(false);
  });

  test("uses the supplied verifyEvmTypedData verifier so ERC-1271/6492 contract wallets can pass", async () => {
    const payer = privateKeyToAccount(PAYER_KEY);
    const typedData = buildDirectWalletPayerProofTypedData({
      paymentId: "00000000-0000-4000-8000-000000000031",
      organizationId: "00000000-0000-4000-8000-000000000032",
      userId: "00000000-0000-4000-8000-000000000033",
      network: "base",
      chainId: 8453,
      payerAddress: payer.address,
      receiveAddress: "0x000000000000000000000000000000000000ba5e",
      tokenSymbol: "USDC",
      tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      expectedTokenUnits: 10_000_000n,
      nonce: "payer-proof-nonce-4",
      expiresAt: "2026-07-01T20:00:00.000Z",
    });
    // A contract-wallet signature is opaque to ecrecover — the offline path
    // rejects it. A client-backed verifier (viem publicClient.verifyTypedData)
    // validates it via ERC-1271/6492 on chain; simulate that here.
    const contractWalletSignature = `0x${"77".repeat(65)}` as const;
    const calls: Array<{ address: string; signature: string; paymentId: string }> = [];

    await expect(
      verifyDirectWalletPayerProof({
        network: "base",
        payerAddress: payer.address,
        typedData,
        signature: contractWalletSignature,
        verifyEvmTypedData: async (params) => {
          calls.push({
            address: params.address,
            signature: params.signature,
            paymentId: params.message.paymentId,
          });
          return true;
        },
      }),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].address).toBe(payer.address.toLowerCase());
    expect(calls[0].signature).toBe(contractWalletSignature);
    expect(calls[0].paymentId).toBe("00000000-0000-4000-8000-000000000031");

    // Without the verifier the same signature fails offline ecrecover.
    await expect(
      verifyDirectWalletPayerProof({
        network: "base",
        payerAddress: payer.address,
        typedData,
        signature: contractWalletSignature,
      }),
    ).resolves.toBe(false);
  });

  test("fails closed when the verifyEvmTypedData verifier rejects or errors", async () => {
    const payer = privateKeyToAccount(PAYER_KEY);
    const typedData = buildDirectWalletPayerProofTypedData({
      paymentId: "00000000-0000-4000-8000-000000000041",
      organizationId: "00000000-0000-4000-8000-000000000042",
      userId: null,
      network: "bsc",
      chainId: 56,
      payerAddress: payer.address,
      receiveAddress: "0x0000000000000000000000000000000000000b5c",
      tokenSymbol: "BNB",
      expectedTokenUnits: "100000000000000000",
      nonce: "payer-proof-nonce-5",
      expiresAt: "2026-07-01T20:00:00.000Z",
    });
    const signature = await payer.signTypedData(
      toDirectWalletPayerProofSigningTypedData(typedData),
    );

    await expect(
      verifyDirectWalletPayerProof({
        network: "bsc",
        payerAddress: payer.address,
        typedData,
        signature,
        verifyEvmTypedData: async () => false,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyDirectWalletPayerProof({
        network: "bsc",
        payerAddress: payer.address,
        typedData,
        signature,
        verifyEvmTypedData: async () => {
          throw new Error("RPC unavailable");
        },
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
      nonce: "payer-proof-nonce-3",
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
