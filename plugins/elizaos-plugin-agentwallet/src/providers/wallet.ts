import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import type {
  AgentWalletSDK,
  TokenBalance,
  TransferParams,
  SwapParams,
  BridgeParams,
  X402PayParams,
  TransferResult,
  SwapResult,
  BridgeResult,
  X402PayResult,
} from '../types';

/**
 * WalletProvider — surfaces wallet state (address, balances, spend limit) into the
 * agent's context window so it can reason about its own funds before taking action.
 */
export const walletProvider: Provider = {
  get: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string> => {
    try {
      const sdk = await getSDK(runtime);
      if (!sdk) {
        return 'Wallet: not configured. Set AGENTWALLET_PRIVATE_KEY and AGENTWALLET_CHAIN in agent settings.';
      }

      const balances = await sdk.getBalances();
      const balanceLines = balances
        .map((b: TokenBalance) => `  ${b.symbol}: ${b.balance}${b.usdValue != null ? ` ($${b.usdValue.toFixed(2)})` : ''}`)
        .join('\n');

      return [
        `## Agent Wallet`,
        `Address: ${sdk.getAddress()}`,
        `Network: ${sdk.getNetwork()}`,
        `Balances:\n${balanceLines || '  (none)'}`,
        `Last updated: ${new Date().toISOString()}`,
      ]
        .filter(Boolean)
        .join('\n');
    } catch (err) {
      return `Wallet: error fetching state — ${(err as Error).message}`;
    }
  },
};

// ── SDK Factory ───────────────────────────────────────────────────────────────

/**
 * getSDK — builds a unified AgentWalletSDK wrapper from runtime settings.
 *
 * EVM settings:
 *   AGENTWALLET_PRIVATE_KEY      — 0x-prefixed hex private key
 *   AGENTWALLET_ACCOUNT_ADDRESS  — AgentAccountV2 contract address (0x...)
 *   AGENTWALLET_CHAIN            — 'base' | 'arbitrum' | 'ethereum' | 'polygon'
 *   AGENTWALLET_RPC_URL          — optional RPC override
 *
 * Note: Solana support requires SolanaWallet which is not available in the current
 * agentwallet-sdk release. EVM chains only.
 */
export async function getSDK(runtime: IAgentRuntime): Promise<AgentWalletSDK | null> {
  const evmPrivateKey = runtime.getSetting('AGENTWALLET_PRIVATE_KEY');

  if (!evmPrivateKey) return null;

  // Dynamic import so the plugin won't crash when SDK is absent (mocked in tests)
  const sdkModule = await import('agentwallet-sdk');

  let evmWalletObj: ReturnType<typeof sdkModule.createWallet> | null = null;
  let evmWalletClient: import('viem').WalletClient | null = null;

  // ── EVM wallet setup ──────────────────────────────────────────────────────
  const accountAddress = runtime.getSetting('AGENTWALLET_ACCOUNT_ADDRESS');
  const chain = (runtime.getSetting('AGENTWALLET_CHAIN') ?? 'base') as
    'base' | 'base-sepolia' | 'ethereum' | 'arbitrum' | 'polygon';
  const rpcUrl = runtime.getSetting('AGENTWALLET_RPC_URL') ?? undefined;

  if (accountAddress) {
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { base, baseSepolia, mainnet, arbitrum, polygon } = await import('viem/chains');

    const CHAINS: Record<string, import('viem').Chain> = {
      base,
      'base-sepolia': baseSepolia,
      ethereum: mainnet,
      arbitrum,
      polygon,
    };
    const viemChain = CHAINS[chain] ?? base;
    const account = privateKeyToAccount(evmPrivateKey as `0x${string}`);

    evmWalletClient = createWalletClient({
      account,
      chain: viemChain,
      transport: http(rpcUrl),
    });

    evmWalletObj = sdkModule.createWallet({
      accountAddress: accountAddress as `0x${string}`,
      chain,
      rpcUrl,
      walletClient: evmWalletClient,
    });
  }

  if (!evmWalletObj) return null;

  return buildSDKWrapper(sdkModule, evmWalletObj, evmWalletClient, runtime);
}

// ── SDK Wrapper Builder ───────────────────────────────────────────────────────

function buildSDKWrapper(
  sdkModule: typeof import('agentwallet-sdk'),
  evmWallet: ReturnType<typeof sdkModule.createWallet>,
  evmWalletClient: import('viem').WalletClient | null,
  runtime: IAgentRuntime
): AgentWalletSDK {
  return {
    evmWallet,
    solanaWallet: null,

    getAddress(): string {
      return evmWallet.address;
    },

    getNetwork(): string {
      return runtime.getSetting('AGENTWALLET_CHAIN') ?? 'base';
    },

    // ── Balances ─────────────────────────────────────────────────────────────
    async getBalances(): Promise<TokenBalance[]> {
      const balances: TokenBalance[] = [];

      try {
        const budget = await sdkModule.checkBudget(evmWallet, sdkModule.NATIVE_TOKEN);
        const ethBalance = Number(budget.remainingInPeriod) / 1e18;
        balances.push({
          symbol: 'ETH',
          address: sdkModule.NATIVE_TOKEN,
          balance: ethBalance.toFixed(6),
          decimals: 18,
        });
      } catch {
        balances.push({
          symbol: 'ETH',
          address: '0x0000000000000000000000000000000000000000',
          balance: '0',
          decimals: 18,
        });
      }

      return balances;
    },

    // ── Transfer ────────────────────────────────────────────────────────────
    async transfer(params: TransferParams): Promise<TransferResult> {
      const { encodeFunctionData, parseUnits, zeroAddress } = await import('viem');
      const isNative =
        params.token === 'ETH' ||
        params.token === zeroAddress ||
        params.token === '0x0000000000000000000000000000000000000000';

      let txData: `0x${string}` = '0x';
      let value = 0n;
      const to = isNative
        ? (params.toAddress as `0x${string}`)
        : (params.token as `0x${string}`);

      if (isNative) {
        value = parseUnits(params.amount, 18);
      } else {
        const erc20TransferAbi = [
          {
            name: 'transfer',
            type: 'function',
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ name: '', type: 'bool' }],
            stateMutability: 'nonpayable',
          },
        ] as const;
        txData = encodeFunctionData({
          abi: erc20TransferAbi,
          functionName: 'transfer',
          args: [params.toAddress as `0x${string}`, parseUnits(params.amount, 6)],
        });
      }

      const result = await sdkModule.agentExecute(evmWallet, { to, value, data: txData });
      return { txHash: result.txHash, success: true };
    },

    // ── Swap ─────────────────────────────────────────────────────────────────
    async swap(params: SwapParams): Promise<SwapResult> {
      const { SwapModule } = sdkModule;
      const { parseUnits } = await import('viem');

      const swapMod = new SwapModule(
        evmWallet.publicClient as any,
        evmWallet.walletClient as any,
        evmWallet.address
      );

      const fromDecimals = params.fromToken.toUpperCase() === 'USDC' ? 6 : 18;
      const amountIn = parseUnits(params.amount, fromDecimals);

      const result = await swapMod.swap(
        params.fromToken as `0x${string}`,
        params.toToken as `0x${string}`,
        amountIn,
        { slippageBps: params.slippageBps ?? 50 }
      );
      return {
        txHash: result.txHash,
        outputAmount: result.quote.amountOut.toString(),
      };
    },

    // ── Bridge ───────────────────────────────────────────────────────────────
    async bridge(params: BridgeParams): Promise<BridgeResult> {
      const { BridgeModule } = sdkModule;
      const { parseUnits } = await import('viem');

      if (!evmWalletClient) {
        throw new Error('EVM wallet client required for bridge operations');
      }

      const bridge = new BridgeModule(evmWalletClient, params.fromChain as any);
      const amountUsdc = parseUnits(params.amount, 6);

      const result = await bridge.bridge(amountUsdc, params.toChain as any, {
        destinationAddress: (params.toAddress ?? evmWallet.address) as `0x${string}`,
      });

      return {
        sourceTxHash: result.burnTxHash,
        trackingUrl: null,
      };
    },

    // ── x402 Pay ─────────────────────────────────────────────────────────────
    async x402Pay(params: X402PayParams): Promise<X402PayResult> {
      const { createX402Client } = sdkModule;

      const client = createX402Client(evmWallet);
      const response = await client.fetch(params.endpoint);
      const contentType = response.headers.get('content-type') ?? undefined;
      const amountPaid = response.headers.get('x-payment-amount') ?? params.maxAmountUsd;

      return {
        amountPaid,
        httpStatus: response.status,
        contentType,
      };
    },
  };
}
