import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { collectSigners } from "./sendTransaction.ts";

function messageRequiringPositionSigner(payer: Keypair, position: Keypair) {
  return new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: position.publicKey,
        lamports: 1,
        space: 0,
        programId: SystemProgram.programId,
      }),
    ],
  }).compileToV0Message();
}

describe("collectSigners", () => {
  it("leaves the new position account unsigned when only the fee payer signs", () => {
    const payer = Keypair.generate();
    const position = Keypair.generate();
    const transaction = new VersionedTransaction(messageRequiringPositionSigner(payer, position));
    transaction.sign(collectSigners(payer));
    expect(transaction.signatures).toHaveLength(2);
    expect(transaction.signatures[1].every((byte) => byte === 0)).toBe(true);
  });

  it("signs the new position account when that keypair is included", () => {
    const payer = Keypair.generate();
    const position = Keypair.generate();
    const transaction = new VersionedTransaction(messageRequiringPositionSigner(payer, position));
    transaction.sign(collectSigners(payer, [position]));
    expect(transaction.signatures[1].some((byte) => byte !== 0)).toBe(true);
  });
});
