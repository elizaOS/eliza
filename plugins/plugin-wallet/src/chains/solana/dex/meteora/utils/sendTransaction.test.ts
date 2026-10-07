import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { collectSigners, sendTransaction } from "./sendTransaction.ts";

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

function setComputeUnitLimitCount(transaction: VersionedTransaction): number {
  const keys = transaction.message.staticAccountKeys;
  let count = 0;
  for (const instruction of transaction.message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (program?.equals(ComputeBudgetProgram.programId) && instruction.data[0] === 2) count += 1;
  }
  return count;
}

describe("sendTransaction", () => {
  it("keeps one compute-unit limit when the caller already supplied one", async () => {
    const payer = Keypair.generate();
    const position = Keypair.generate();
    const sent: VersionedTransaction[] = [];
    const connection = {
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1,
      }),
      simulateTransaction: async () => ({ value: { unitsConsumed: 200_000 } }),
      getRecentPrioritizationFees: async () => [{ prioritizationFee: 1 }],
      sendTransaction: async (transaction: VersionedTransaction) => {
        sent.push(transaction);
        return "sig";
      },
      getSignatureStatuses: async () => ({ value: [{ err: null }] }),
    };

    await sendTransaction(
      connection as never,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: position.publicKey,
          lamports: 1,
          space: 0,
          programId: SystemProgram.programId,
        }),
      ],
      payer,
      [position]
    );

    expect(sent).toHaveLength(1);
    expect(setComputeUnitLimitCount(sent[0])).toBe(1);
    expect(sent[0].signatures[1].some((byte) => byte !== 0)).toBe(true);
  });
});
