import type { IAgentRuntime, Memory, Provider } from '@elizaos/core';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';

// USDC contract on Base
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

// Minimal ERC-20 ABI for balance check
const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
] as const;

/**
 * BlockRun Wallet Provider - Provides wallet address and USDC balance on Base.
 *
 * This provider gives the agent context about its payment wallet,
 * including address and available USDC balance for x402 micropayments.
 */
export const blockrunWalletProvider: Provider = {
  name: 'BLOCKRUN_WALLET',
  get: async (runtime: IAgentRuntime, _message: Memory) => {
    try {
      // Get private key from settings
      const privateKey = runtime.getSetting('BASE_CHAIN_WALLET_KEY') ||
        runtime.getSetting('BLOCKRUN_WALLET_KEY') ||
        process.env.BASE_CHAIN_WALLET_KEY;

      if (!privateKey) {
        return {
          data: {
            configured: false,
          },
          values: {
            walletConfigured: 'false',
          },
          text: 'BlockRun wallet is not configured. Set BASE_CHAIN_WALLET_KEY to enable x402 micropayments.',
        };
      }

      // Derive address from private key
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const address = account.address;

      // Create public client for balance query
      const publicClient = createPublicClient({
        chain: base,
        transport: http(),
      });

      // Get USDC balance
      let usdcBalance = '0';
      let usdcBalanceRaw = BigInt(0);

      try {
        usdcBalanceRaw = await publicClient.readContract({
          address: USDC_BASE,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        });
        usdcBalance = formatUnits(usdcBalanceRaw, 6); // USDC has 6 decimals
      } catch {
        // Balance check failed, continue with 0
      }

      // Get ETH balance for gas
      let ethBalance = '0';
      try {
        const ethBalanceRaw = await publicClient.getBalance({ address });
        ethBalance = formatUnits(ethBalanceRaw, 18);
      } catch {
        // ETH balance check failed
      }

      return {
        data: {
          configured: true,
          address,
          usdcBalance: usdcBalanceRaw.toString(),
          ethBalance,
          chain: 'base',
          chainId: 8453,
        },
        values: {
          walletConfigured: 'true',
          walletAddress: address,
          usdcBalance: `${usdcBalance} USDC`,
          ethBalance: `${ethBalance} ETH`,
        },
        text: `BlockRun wallet is configured. Address: ${address}. USDC balance: ${usdcBalance} USDC on Base. This wallet is used for x402 micropayments when making AI API calls.`,
      };
    } catch (error) {
      return {
        data: {
          configured: false,
          error: error instanceof Error ? error.message : String(error),
        },
        values: {
          walletConfigured: 'false',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        text: 'Failed to get BlockRun wallet information.',
      };
    }
  },
};

export default blockrunWalletProvider;
