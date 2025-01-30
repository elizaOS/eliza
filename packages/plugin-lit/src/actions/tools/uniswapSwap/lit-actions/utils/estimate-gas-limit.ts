/**
 * Estimates the gas limit for a transaction.
 * @param {JsonRpcProvider} provider - The Ethereum provider.
 * @param {any} tokenInContract - The token contract instance.
 * @param {any} amount - The amount of tokens to swap.
 * @param {boolean} isApproval - Whether the transaction is an approval or a swap.
 * @param {Object} [swapParams] - Swap parameters (fee and amountOutMin).
 * @returns {Promise<any>} The estimated gas limit.
 */
export const estimateGasLimit = async (
  provider: any,
  pkpEthAddress: string,
  uniswapV3Router: any,
  tokenInContract: any,
  amount: any,
  isApproval: boolean,
  swapParams?: {
    fee: number;
    amountOutMin: any;
  }
) => {
  console.log(`Estimating gas limit...`);

  try {
    let estimatedGas;
    if (isApproval) {
      estimatedGas = await tokenInContract.estimateGas.approve(
        uniswapV3Router,
        amount,
        { from: pkpEthAddress }
      );
    } else if (swapParams) {
      const routerInterface = new ethers.utils.Interface([
        'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) external payable returns (uint256)',
      ]);

      const routerContract = new ethers.Contract(
        uniswapV3Router,
        routerInterface,
        provider
      );

      estimatedGas = await routerContract.estimateGas.exactInputSingle(
        [
          params.tokenIn,
          params.tokenOut,
          swapParams.fee,
          pkpEthAddress,
          amount,
          swapParams.amountOutMin,
          0,
        ],
        { from: pkpEthAddress }
      );
    } else {
      throw new Error('Missing swap parameters for gas estimation');
    }

    // Add 20% buffer
    const gasLimit = estimatedGas.mul(120).div(100);
    console.log(`Estimated gas limit: ${gasLimit.toString()}`);
    return gasLimit;
  } catch (error) {
    console.error('Error estimating gas:', error);
    // Use fallback gas limits
    const fallbackGas = isApproval ? '300000' : '500000';
    console.log(`Using fallback gas limit: ${fallbackGas}`);
    return ethers.BigNumber.from(fallbackGas);
  }
};
