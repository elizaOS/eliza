import { elizaLogger } from '@elizaos/core';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction
} from '@solana-program/compute-budget';
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getComputeUnitEstimateForTransactionMessageFactory,
  IInstruction,
  KeyPairSigner,
  pipe,
  prependTransactionMessageInstructions,
  Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  SolanaRpcApi
} from '@solana/web3.js';

// For more information: https://orca-so.github.io/whirlpools/Whirlpools%20SDKs/Whirlpools/Send%20Transaction
export async function sendTransaction(rpc: Rpc<SolanaRpcApi>, instructions: IInstruction[], wallet: KeyPairSigner): Promise<string> {
  const latestBlockHash = await rpc.getLatestBlockhash().send();
  const transactionMessage = await pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayer(wallet.address, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockHash.value, tx),
    tx => appendTransactionMessageInstructions(instructions, tx)
  )
  const getComputeUnitEstimateForTransactionMessage =
    getComputeUnitEstimateForTransactionMessageFactory({
      rpc: rpc
    });
  const computeUnitEstimate = await getComputeUnitEstimateForTransactionMessage(transactionMessage)
  const safeComputeUnitEstimate = Math.max(computeUnitEstimate * 1.3, computeUnitEstimate + 100_000);
  const prioritizationFee = await rpc.getRecentPrioritizationFees()
    .send()
    .then(fees =>
      fees
        .map(fee => Number(fee.prioritizationFee))
        .sort((a, b) => a - b)
        [Math.ceil(0.95 * fees.length) - 1]
    );
  const transactionMessageWithComputeUnitInstructions = await prependTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units: safeComputeUnitEstimate }),
    getSetComputeUnitPriceInstruction({ microLamports: prioritizationFee })
  ], transactionMessage);
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessageWithComputeUnitInstructions)
  const base64EncodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);

  const timeoutMs = 90000;
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const transactionStartTime = Date.now();
    const signature = await rpc.sendTransaction(base64EncodedWireTransaction, {
      maxRetries: 0n,
      skipPreflight: true,
      encoding: 'base64'
    }).send();
    const statuses = await rpc.getSignatureStatuses([signature]).send();
    if (statuses.value[0]) {
      if (!statuses.value[0].err) {
        elizaLogger.log(`Transaction confirmed: ${signature}`);
        return signature
      } else {
        throw new Error(`Transaction failed: ${statuses.value[0].err.toString()}`);
      }
    }
    const elapsedTime = Date.now() - transactionStartTime;
    const remainingTime = Math.max(0, 1000 - elapsedTime);
    if (remainingTime > 0) {
      await new Promise(resolve => setTimeout(resolve, remainingTime));
    }
  }
  throw new Error('Transaction timeout');
}
