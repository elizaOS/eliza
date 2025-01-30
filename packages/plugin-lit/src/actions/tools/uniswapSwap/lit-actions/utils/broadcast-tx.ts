/**
 * Broadcasts a signed transaction to the network.
 * @param {string} signedTx - The signed transaction.
 * @returns {Promise<string>} The transaction hash.
 */
export const broadcastTransaction = async (provider: any, signedTx: string) => {
  console.log('Broadcasting transaction...');
  const txHash = await Lit.Actions.runOnce(
    { waitForResponse: true, name: 'txnSender' },
    async () => {
      try {
        const receipt = await provider.sendTransaction(signedTx);
        console.log('Transaction sent:', receipt.hash);
        return receipt.hash;
      } catch (error) {
        console.error('Error broadcasting transaction:', error);
        throw error;
      }
    }
  );

  if (!ethers.utils.isHexString(txHash)) {
    throw new Error(`Invalid transaction hash: ${txHash}`);
  }

  return txHash;
};
