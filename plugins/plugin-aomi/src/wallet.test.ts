/**
 * Checks exact human previews and fail-closed batch classification at the wallet boundary.
 */
import type { WalletRequest } from "@aomi-labs/client";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { EVM_REQUEST } from "./__tests__/test-helpers.js";
import { walletRequestPreview, walletRequestSupportError } from "./wallet.js";

describe("Aomi wallet previews", () => {
  it("shows the exact EVM chain, target, value, and call count", () => {
    const preview = walletRequestPreview(EVM_REQUEST);
    expect(preview).toContain("Chain: 8453");
    expect(preview).toContain(
      "Target: 0x000000000000000000000000000000000000dEaD",
    );
    expect(preview).toContain("Value (wei): 1000");
    expect(preview).toContain("Gas limit: automatic");
    expect(preview).toContain("Calldata: 0x");
    expect(preview).toContain("Calls: 1");
  });

  it("rejects multi-call EVM envelopes before any partial execution", () => {
    const batch: WalletRequest = {
      ...EVM_REQUEST,
      payload: {
        ...EVM_REQUEST.payload,
        calls: [
          {
            txId: 7,
            chainId: 8453,
            to: "0x0000000000000000000000000000000000000001",
          },
          {
            txId: 8,
            chainId: 8453,
            to: "0x0000000000000000000000000000000000000002",
          },
        ],
      },
    };
    expect(walletRequestSupportError(batch)).toContain("Atomic EVM batches");
  });

  it("distinguishes sign-only from sign-and-send Solana requests", () => {
    const signer = Keypair.generate();
    const transaction = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
    }).add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    const sign: WalletRequest = {
      id: "sol-1",
      kind: "solana_sign",
      timestamp: 1,
      payload: {
        unsignedTx: transaction
          .serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          })
          .toString("base64"),
        cluster: "solana:devnet",
        description: "Sign a devnet transaction",
      },
    };
    const submit: WalletRequest = {
      ...sign,
      kind: "solana_sign_and_send",
    };
    expect(walletRequestPreview(sign)).toContain("Reply yes to sign,");
    expect(walletRequestPreview(sign)).toContain(
      `Fee payer: ${signer.publicKey.toBase58()}`,
    );
    expect(walletRequestPreview(sign)).toContain("Instructions: 1");
    expect(walletRequestPreview(sign)).toContain("sha256:");
    expect(walletRequestPreview(submit)).toContain("sign and submit");
  });

  it("rejects malformed base64 before a Solana confirmation can be shown", () => {
    const request: WalletRequest = {
      id: "sol-invalid",
      kind: "solana_sign",
      timestamp: 1,
      payload: { unsignedTx: "not base64 !!!" },
    };
    expect(() => walletRequestPreview(request)).toThrow(/valid base64/i);
  });

  it("shows the exact EIP-712 domain and message before signing", () => {
    const request: WalletRequest = {
      id: "eip712-1",
      kind: "eip712_sign",
      timestamp: 1,
      payload: {
        typed_data: {
          domain: { name: "Permit", chainId: 8453 },
          primaryType: "Permit",
          message: { spender: "0x000000000000000000000000000000000000dEaD" },
        },
      },
    };
    const preview = walletRequestPreview(request);
    expect(preview).toContain('"name":"Permit"');
    expect(preview).toContain(
      '"spender":"0x000000000000000000000000000000000000dEaD"',
    );
  });
});
