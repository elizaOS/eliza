/**
 * Retrieves token information (decimals, balance, and parsed amount).
 * @param {any} provider - The Ethereum provider.
 * @returns {Promise<{ decimals: BigNumber, balance: BigNumber, amount: BigNumber }>} Token information.
 */
export async function getTokenInfo(
  provider: any,
  tokenIn: string,
  pkpEthAddress: string
) {
  console.log('Getting token info for:', tokenIn);

  // Validate token address
  try {
    console.log('Validating token address...');
    ethers.utils.getAddress(params.tokenIn);
  } catch (error) {
    throw new Error(`Invalid token address: ${params.tokenIn}`);
  }

  // Check if contract exists
  console.log('Checking if contract exists...');
  const code = await provider.getCode(tokenIn);
  if (code === '0x') {
    throw new Error(`No contract found at address: ${tokenIn}`);
  }

  const tokenInterface = new ethers.utils.Interface([
    'function decimals() view returns (uint8)',
    'function balanceOf(address account) view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)',
  ]);

  console.log('Creating token contract instance...');
  const tokenContract = new ethers.Contract(
    params.tokenIn,
    tokenInterface,
    provider
  );

  console.log('Fetching token decimals and balance...');
  try {
    const decimals = await tokenContract.decimals();
    console.log('Token decimals:', decimals);

    const amount = ethers.utils.parseUnits(params.amountIn, decimals);
    console.log('Amount to send:', amount.toString());

    const pkpBalance = await tokenContract.balanceOf(pkpEthAddress);
    console.log('PKP balance:', pkpBalance.toString());

    if (amount.gt(pkpBalance)) {
      throw new Error(
        `Insufficient balance. PKP balance: ${ethers.utils.formatUnits(
          pkpBalance,
          decimals
        )}. Required: ${ethers.utils.formatUnits(amount, decimals)}`
      );
    }

    return { decimals, pkpBalance, amount };
  } catch (error) {
    console.error('Error getting token info:', error);
    throw new Error(
      `Failed to interact with token contract at ${params.tokenIn}. Make sure this is a valid ERC20 token contract.`
    );
  }
}
