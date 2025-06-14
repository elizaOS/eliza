import { ethers } from 'ethers';
import { logger } from '@elizaos/core';

// Constants for Polygon USDC and Polymarket contracts
export const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
export const CLOB_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
export const USDC_DECIMALS = 6;

// Standard ERC-20 ABI (minimal required functions)
export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export interface UsdcApprovalResult {
  success: boolean;
  balance: string;
  allowance: string;
  requiredAmount: string;
  approvalNeeded: boolean;
  approvalTxHash?: string;
  error?: string;
  gasCost?: string;
}

/**
 * Check and handle USDC approval for Polymarket orders
 * @param wallet - Ethers wallet instance for signing transactions
 * @param provider - RPC provider for Polygon network
 * @param orderValue - Total order value in USDC (price * size)
 * @param approveMax - Whether to approve maximum amount (more gas efficient for frequent trading)
 * @returns Promise<UsdcApprovalResult>
 */
export async function checkAndApproveUSDC(
  wallet: ethers.Wallet,
  provider: ethers.Provider,
  orderValue: number,
  approveMax: boolean = false
): Promise<UsdcApprovalResult> {
  logger.info(`[usdcApproval] Checking USDC approval for order value: $${orderValue}`);

  try {
    // Connect wallet to provider
    const connectedWallet = wallet.connect(provider);

    // Create USDC contract instance
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, connectedWallet);

    // Check current USDC balance
    const balance = await usdcContract.balanceOf(wallet.address);
    const balanceFormatted = ethers.formatUnits(balance, USDC_DECIMALS);

    logger.info(`[usdcApproval] USDC balance: ${balanceFormatted} USDC`);

    // Check current allowance for CLOB contract
    const allowance = await usdcContract.allowance(wallet.address, CLOB_CONTRACT);
    const allowanceFormatted = ethers.formatUnits(allowance, USDC_DECIMALS);

    logger.info(`[usdcApproval] Current allowance: ${allowanceFormatted} USDC`);

    // Calculate required amount
    const requiredAmount = ethers.parseUnits(orderValue.toString(), USDC_DECIMALS);
    const requiredFormatted = ethers.formatUnits(requiredAmount, USDC_DECIMALS);

    // Check if we have sufficient balance
    if (balance < requiredAmount) {
      const shortfall = ethers.formatUnits(requiredAmount - balance, USDC_DECIMALS);
      return {
        success: false,
        balance: balanceFormatted,
        allowance: allowanceFormatted,
        requiredAmount: requiredFormatted,
        approvalNeeded: false,
        error: `Insufficient USDC balance. Required: ${requiredFormatted} USDC, Available: ${balanceFormatted} USDC, Shortfall: ${shortfall} USDC`,
      };
    }

    // Check if approval is needed
    const approvalNeeded = allowance < requiredAmount;

    if (!approvalNeeded) {
      logger.info(`[usdcApproval] Sufficient allowance available, no approval needed`);
      return {
        success: true,
        balance: balanceFormatted,
        allowance: allowanceFormatted,
        requiredAmount: requiredFormatted,
        approvalNeeded: false,
      };
    }

    // Approval is needed
    logger.info(`[usdcApproval] Insufficient allowance, approval required`);

    // Determine approval amount
    const approvalAmount = approveMax ? ethers.MaxUint256 : requiredAmount;
    const approvalAmountFormatted = approveMax
      ? 'unlimited'
      : ethers.formatUnits(approvalAmount, USDC_DECIMALS);

    logger.info(`[usdcApproval] Approving ${approvalAmountFormatted} USDC for CLOB contract`);

    // Execute approval transaction
    const approveTx = await usdcContract.approve(CLOB_CONTRACT, approvalAmount);
    logger.info(`[usdcApproval] Approval transaction submitted: ${approveTx.hash}`);

    // Wait for confirmation
    const receipt = await approveTx.wait();
    logger.info(`[usdcApproval] Approval confirmed in block ${receipt.blockNumber}`);

    // Calculate gas cost
    const gasCostWei = receipt.gasUsed * receipt.gasPrice;
    const gasCostMatic = ethers.formatEther(gasCostWei);

    return {
      success: true,
      balance: balanceFormatted,
      allowance: allowanceFormatted,
      requiredAmount: requiredFormatted,
      approvalNeeded: true,
      approvalTxHash: approveTx.hash,
      gasCost: gasCostMatic,
    };
  } catch (error) {
    logger.error(`[usdcApproval] Error during USDC approval process:`, error);

    let errorMessage = 'Unknown error during USDC approval';
    if (error instanceof Error) {
      if (error.message.includes('insufficient funds')) {
        errorMessage = 'Insufficient MATIC for gas fees';
      } else if (error.message.includes('user rejected')) {
        errorMessage = 'Transaction rejected by user';
      } else if (error.message.includes('nonce')) {
        errorMessage = 'Transaction nonce error, please retry';
      } else {
        errorMessage = error.message;
      }
    }

    return {
      success: false,
      balance: '0',
      allowance: '0',
      requiredAmount: orderValue.toString(),
      approvalNeeded: true,
      error: errorMessage,
    };
  }
}

/**
 * Get USDC balance and allowance information
 * @param walletAddress - Wallet address to check
 * @param provider - RPC provider for Polygon network
 * @returns Promise with balance and allowance info
 */
export async function getUsdcInfo(
  walletAddress: string,
  provider: ethers.Provider
): Promise<{
  balance: string;
  allowance: string;
  symbol: string;
  decimals: number;
}> {
  try {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

    const [balance, allowance, symbol, decimals] = await Promise.all([
      usdcContract.balanceOf(walletAddress),
      usdcContract.allowance(walletAddress, CLOB_CONTRACT),
      usdcContract.symbol(),
      usdcContract.decimals(),
    ]);

    return {
      balance: ethers.formatUnits(balance, decimals),
      allowance: ethers.formatUnits(allowance, decimals),
      symbol,
      decimals: Number(decimals),
    };
  } catch (error) {
    logger.error(`[usdcApproval] Error getting USDC info:`, error);
    throw error;
  }
}

/**
 * Format approval result for user-friendly display
 * @param result - UsdcApprovalResult to format
 * @returns Formatted string for display
 */
export function formatApprovalResult(result: UsdcApprovalResult): string {
  if (!result.success) {
    return `❌ **USDC Approval Failed**: ${result.error}`;
  }

  if (!result.approvalNeeded) {
    return `✅ **USDC Ready**: Sufficient allowance (${result.allowance} USDC) for order value ${result.requiredAmount} USDC`;
  }

  return `✅ **USDC Approved**: Transaction ${result.approvalTxHash} 
• **Gas Cost**: ${result.gasCost} MATIC
• **Balance**: ${result.balance} USDC
• **New Allowance**: Approved for trading`;
}
