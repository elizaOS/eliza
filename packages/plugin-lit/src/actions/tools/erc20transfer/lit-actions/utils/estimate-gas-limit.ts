/**
 * Estimates the gas limit for the transaction.
 * @param {any} provider - The Ethereum provider.
 * @param {any} amount - The amount to transfer.
 * @returns {Promise<any>} Estimated gas limit.
 */
export const estimateGasLimit = async (
  provider: any,
  amount: any,
  pkpEthAddress: string
) => {
  console.log(`Estimating gas limit...`);

  const tokenInterface = new ethers.utils.Interface([
    'function transfer(address to, uint256 amount) external returns (bool)',
  ]);

  const tokenContract = new ethers.Contract(
    params.tokenIn,
    tokenInterface,
    provider
  );

  try {
    const estimatedGas = await tokenContract.estimateGas.transfer(
      params.recipientAddress,
      amount,
      { from: pkpEthAddress }
    );
    console.log('Estimated gas limit:', estimatedGas.toString());
    return estimatedGas.mul(120).div(100);
  } catch (error) {
    console.error(
      'Could not estimate gas. Using fallback gas limit of 100000.',
      error
    );
    return ethers.BigNumber.from('100000');
  }
};
