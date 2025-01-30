/**
 * Retrieves gas data (maxFeePerGas, maxPriorityFeePerGas, and nonce).
 * @param {JsonRpcProvider} provider - The Ethereum provider.
 * @returns {Promise<{ maxFeePerGas: string, maxPriorityFeePerGas: string, nonce: number }>} Gas data.
 */
export const getGasData = async (provider: any, pkpEthAddress: string) => {
  console.log(`Getting gas data...`);

  const gasData = await Lit.Actions.runOnce(
    { waitForResponse: true, name: 'gasPriceGetter' },
    async () => {
      const baseFeeHistory = await provider.send('eth_feeHistory', [
        '0x1',
        'latest',
        [],
      ]);
      const baseFee = ethers.BigNumber.from(baseFeeHistory.baseFeePerGas[0]);
      const nonce = await provider.getTransactionCount(pkpEthAddress);

      const priorityFee = baseFee.div(4);
      const maxFee = baseFee.mul(2);

      return JSON.stringify({
        maxFeePerGas: maxFee.toHexString(),
        maxPriorityFeePerGas: priorityFee.toHexString(),
        nonce,
      });
    }
  );

  console.log(`Gas data: ${gasData}`);

  return JSON.parse(gasData);
};
