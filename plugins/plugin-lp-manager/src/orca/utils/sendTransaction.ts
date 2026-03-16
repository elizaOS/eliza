import { logger } from '@elizaos/core';
import {
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  Connection,
  ComputeBudgetProgram,
  Keypair,
} from '@solana/web3.js';

// For more information: https://orca-so.github.io/whirlpools/Whirlpools%20SDKs/Whirlpools/Send%20Transaction
export async function sendTransaction(
  connection: Connection,
  instructions: Array<any>,
  wallet: Keypair
): Promise<string> {
  const latestBlockhash = await connection.getLatestBlockhash();

  // Create a new TransactionMessage with the instructions
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message();

  // Estimate compute units
  const simulatedTx = new VersionedTransaction(messageV0);
  simulatedTx.sign([wallet]);
  const simulation = await connection.simulateTransaction(simulatedTx);
  const computeUnits = simulation.value.unitsConsumed || 200_000;
  const safeComputeUnits = Math.ceil(Math.max(computeUnits * 1.3, computeUnits + 100_000));

  // Get prioritization fee
  const recentPrioritizationFees = await connection.getRecentPrioritizationFees();
  const prioritizationFee = recentPrioritizationFees
    .map((fee) => fee.prioritizationFee)
    .sort((a, b) => a - b)[Math.ceil(0.95 * recentPrioritizationFees.length) - 1];

  // Add compute budget instructions
  const computeBudgetInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: safeComputeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: prioritizationFee }),
  ];

  // Create final transaction
  const finalMessage = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [...computeBudgetInstructions, ...instructions],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(finalMessage);
  transaction.sign([wallet]);

  // Send and confirm transaction
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

  throw new Error('Transaction timeout');
}
