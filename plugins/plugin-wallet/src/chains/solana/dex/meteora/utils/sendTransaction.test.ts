import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionMessage,
  TransactionInstruction,
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
    const simulated: VersionedTransaction[] = [];
    const connection = {
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1,
      }),
      simulateTransaction: async (transaction: VersionedTransaction) => {
        simulated.push(transaction);
        return { value: { err: null, unitsConsumed: 200_000 } };
      },
      getRecentPrioritizationFees: async () => [{ prioritizationFee: 1 }],
      sendTransaction: async (transaction: VersionedTransaction) => {
        sent.push(transaction);
        return "sig";
      },
      getSignatureStatuses: async () => ({ value: [{ err: null }] }),
    };

    const heap = ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 });
    const dataBudget = new TransactionInstruction({
      programId: ComputeBudgetProgram.programId,
      keys: [],
      data: Buffer.from([4, 0, 0, 16, 0]),
    });
    await sendTransaction(
      connection as never,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 99 }),
        heap,
        dataBudget,
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

    expect(simulated).toHaveLength(1);
    const budgets = (tx: VersionedTransaction) =>
      TransactionMessage.decompile(tx.message).instructions.filter((instruction) =>
        instruction.programId.equals(ComputeBudgetProgram.programId)
      );
    expect(budgets(simulated[0]).map((instruction) => [...instruction.data])).toEqual([
      [...ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }).data],
      [...ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 99 }).data],
      [...heap.data],
      [...dataBudget.data],
    ]);
    expect(simulated[0].signatures[1].some((byte) => byte !== 0)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(budgets(sent[0]).map((instruction) => [...instruction.data])).toEqual([
      [...ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }).data],
      [...ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }).data],
      [...heap.data],
      [...dataBudget.data],
    ]);
    expect(setComputeUnitLimitCount(sent[0])).toBe(1);
    expect(sent[0].signatures[1].some((byte) => byte !== 0)).toBe(true);
  });
});

it("rejects a failed simulation before fees or broadcast", async () => {
  const payer = Keypair.generate();
  let sent = 0,
    feeReads = 0;
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58() }),
    simulateTransaction: async () => ({
      value: {
        err: { InstructionError: [0, "ComputationalBudgetExceeded"] },
        unitsConsumed: 200_000,
      },
    }),
    getRecentPrioritizationFees: async () => {
      feeReads++;
      return [];
    },
    sendTransaction: async () => {
      sent++;
      return "unexpected";
    },
  };
  await expect(
    sendTransaction(
      connection as never,
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 0,
        }),
      ],
      payer
    )
  ).rejects.toMatchObject({ code: "METEORA_SIMULATION_FAILED" });
  expect(sent).toBe(0);
  expect(feeReads).toBe(0);
});
