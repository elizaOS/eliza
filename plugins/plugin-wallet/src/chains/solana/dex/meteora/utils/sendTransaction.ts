/**
 * Builds, simulates, prioritizes, and submits a versioned Solana transaction
 * for the Meteora DEX adapters, retrying send + status polling until
 * confirmed or a 90s timeout. Compute unit limit is derived from simulation
 * (with a 30% safety margin) and the priority fee from the 95th-percentile
 * recent prioritization fee, both added as compute-budget instructions ahead
 * of the caller's instructions. Adapted from the pattern documented at
 * https://orca-so.github.io/whirlpools/Whirlpools%20SDKs/Whirlpools/Send%20Transaction.
 */
import { elizaLogger } from "@elizaos/core";
import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

export async function sendTransaction(
  connection: Connection,
  instructions: TransactionInstruction[],
  wallet: Keypair
): Promise<string> {
  const latestBlockhash = await connection.getLatestBlockhash();

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message();

  const simulatedTx = new VersionedTransaction(messageV0);
  simulatedTx.sign([wallet]);
  const simulation = await connection.simulateTransaction(simulatedTx);
  const computeUnits = simulation.value.unitsConsumed || 200_000;
  const safeComputeUnits = Math.ceil(Math.max(computeUnits * 1.3, computeUnits + 100_000));

  const recentPrioritizationFees = await connection.getRecentPrioritizationFees();
  const prioritizationFee =
    recentPrioritizationFees.map((fee) => fee.prioritizationFee).sort((a, b) => a - b)[
      Math.ceil(0.95 * recentPrioritizationFees.length) - 1
    ] ?? 0;

  const computeBudgetInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: safeComputeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: prioritizationFee,
    }),
  ];

  const finalMessage = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [...computeBudgetInstructions, ...instructions],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(finalMessage);
  transaction.sign([wallet]);

  const timeoutMs = 90000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const transactionStartTime = Date.now();

    const signature = await connection.sendTransaction(transaction, {
      maxRetries: 0,
      skipPreflight: true,
    });

    const statuses = await connection.getSignatureStatuses([signature]);
    if (statuses.value[0]) {
      if (!statuses.value[0].err) {
        elizaLogger.log(`Transaction confirmed: ${signature}`);
        return signature;
      } else {
        throw new Error(`Transaction failed: ${statuses.value[0].err.toString()}`);
      }
    }

    const elapsedTime = Date.now() - transactionStartTime;
    const remainingTime = Math.max(0, 1000 - elapsedTime);
    if (remainingTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingTime));
    }
  }

  throw new Error("Transaction timeout");
}
