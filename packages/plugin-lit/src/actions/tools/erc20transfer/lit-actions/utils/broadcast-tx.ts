/**
 * Broadcasts the signed transaction to the network.
 * @param {string} signedTx - The signed transaction.
 * @returns {Promise<string>} The transaction hash.
 */
export const broadcastTransaction = async (provider: any, signedTx: string) => {
  console.log('Broadcasting transfer...');
  return await Lit.Actions.runOnce(
    { waitForResponse: true, name: 'txnSender' },
    async () => {
      try {
        const tx = await provider.sendTransaction(signedTx);
        console.log('Transaction sent:', tx.hash);

        const receipt = await tx.wait(1);
        console.log('Transaction mined:', receipt.transactionHash);

        return receipt.transactionHash;
      } catch (err: any) {
        // Log the full error object for debugging
        console.error('Full error object:', JSON.stringify(err, null, 2));

        // Extract detailed error information
        const errorDetails = {
          message: err.message,
          code: err.code,
          reason: err.reason,
          error: err.error,
          ...(err.transaction && { transaction: err.transaction }),
          ...(err.receipt && { receipt: err.receipt }),
        };

        console.error('Error details:', JSON.stringify(errorDetails, null, 2));

        // Return stringified error response
        return JSON.stringify({
          error: true,
          message: err.reason || err.message || 'Transaction failed',
          details: errorDetails,
        });
      }
    }
  );
};
