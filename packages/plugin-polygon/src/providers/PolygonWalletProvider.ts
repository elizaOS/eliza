import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  formatUnits,
  http,
  publicActions,
  walletActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  type IAgentRuntime,
  type Provider,
  type Memory,
  type State,
  elizaLogger,
  type ProviderResult,
} from '@elizaos/core';
import type {
  Address,
  WalletClient,
  PublicClient,
  Chain,
  HttpTransport,
  Account,
  PrivateKeyAccount,
  TestClient,
} from 'viem';
import * as viemChains from 'viem/chains';
import { PhalaDeriveKeyProvider } from '@elizaos/plugin-tee';
import NodeCache from 'node-cache';
import * as path from 'node:path';

import type { SupportedChain } from '../types';

const ETH_MAINNET_KEY = 'ethereum';

export class WalletProvider {
  private cache: NodeCache;
  private cacheKey = 'polygon/wallet';
  private currentChain: SupportedChain = ETH_MAINNET_KEY as SupportedChain;
  private CACHE_EXPIRY_SEC = 5;
  chains: Record<string, Chain> = {};
  account: PrivateKeyAccount;
  runtime: IAgentRuntime;

  constructor(
    accountOrPrivateKey: PrivateKeyAccount | `0x${string}`,
    runtime: IAgentRuntime,
    chains?: Record<string, Chain>
  ) {
    this.setAccount(accountOrPrivateKey);
    this.setChains(chains);
    this.runtime = runtime;

    if (chains && Object.keys(chains).length > 0) {
      this.setCurrentChain(Object.keys(chains)[0] as SupportedChain);
    }

    this.cache = new NodeCache({ stdTTL: this.CACHE_EXPIRY_SEC });
  }

  getAddress(): Address {
    return this.account.address;
  }

  hasChain = (name: string) => Boolean(this.chains[name]);

  getCurrentChain(): Chain {
    return this.chains[this.currentChain];
  }

  getPublicClient(
    chainName: SupportedChain
  ): PublicClient<HttpTransport, Chain, Account | undefined> {
    const transport = this.createHttpTransport(chainName);

    const publicClient = createPublicClient({
      chain: this.chains[chainName],
      transport,
    });
    return publicClient;
  }

  getWalletClient(chainName: SupportedChain): WalletClient {
    const transport = this.createHttpTransport(chainName);

    const walletClient = createWalletClient({
      chain: this.chains[chainName],
      transport,
      account: this.account,
    });

    return walletClient;
  }

  getTestClient(): TestClient {
    return createTestClient({
      chain: viemChains.hardhat,
      mode: 'hardhat',
      transport: http(),
    })
      .extend(publicActions)
      .extend(walletActions);
  }

  getChainConfigs(chainName: SupportedChain): Chain {
    const key = chainName === ETH_MAINNET_KEY ? 'mainnet' : chainName;
    const chain = viemChains[key];

    if (!chain?.id) {
      throw new Error('Invalid chain name');
    }

    return chain;
  }

  async getWalletBalance(): Promise<string | null> {
    try {
      const client = this.getPublicClient(this.currentChain);
      const balance = await client.getBalance({
        address: this.account.address,
      });
      const balanceFormatted = formatUnits(balance, 18);
      elizaLogger.log('Wallet balance cached for chain: ', this.currentChain);
      return balanceFormatted;
    } catch (error) {
      console.error('Error getting wallet balance:', error);
      return null;
    }
  }

  async getWalletBalanceForChain(chainName: SupportedChain): Promise<string | null> {
    try {
      const client = this.getPublicClient(chainName);
      const balance = await client.getBalance({
        address: this.account.address,
      });
      return formatUnits(balance, 18);
    } catch (error) {
      console.error('Error getting wallet balance:', error);
      return null;
    }
  }

  addChain(chain: Record<string, Chain>) {
    this.setChains(chain);
  }

  getActiveWalletClient(): WalletClient {
    return this.getWalletClient(this.currentChain);
  }

  switchChain(chainName: SupportedChain, customRpcUrl?: string) {
    if (!this.chains[chainName]) {
      const chain = WalletProvider.genChainFromName(chainName, customRpcUrl);
      this.addChain({ [chainName]: chain });
    }
    this.setCurrentChain(chainName);
  }
  async switchChainById(chainId: number): Promise<WalletClient> {
    const entry = Object.entries(this.chains).find(([, c]) => c.id === chainId);
    if (!entry) throw new Error(`Unsupported chainId ${chainId}`);
    const [name] = entry as [SupportedChain, Chain];
    this.setCurrentChain(name);
    return this.getActiveWalletClient();
  }

  private setAccount = (accountOrPrivateKey: PrivateKeyAccount | `0x${string}`) => {
    if (typeof accountOrPrivateKey === 'string') {
      this.account = privateKeyToAccount(accountOrPrivateKey);
    } else {
      this.account = accountOrPrivateKey;
    }
  };

  private setChains = (chains?: Record<string, Chain>) => {
    if (!chains) {
      return;
    }
    for (const chain of Object.keys(chains)) {
      this.chains[chain] = chains[chain];
    }
  };

  private setCurrentChain = (chain: SupportedChain) => {
    this.currentChain = chain;
  };

  private createHttpTransport = (chainName: SupportedChain) => {
    const chain = this.chains[chainName];

    if (!chain) {
      throw new Error(
        `Unsupported chain "${chainName}". Available: ${Object.keys(this.chains).join(', ')}`
      );
    }

    if (chain.rpcUrls.custom) {
      return http(chain.rpcUrls.custom.http[0]);
    }
    return http(chain.rpcUrls.default.http[0]);
  };

  static genChainFromName(chainName: string, customRpcUrl?: string | null): Chain {
    const baseChain = viemChains[chainName];

    if (!baseChain?.id) {
      throw new Error('Invalid chain name');
    }

    const viemChain: Chain = customRpcUrl
      ? {
          ...baseChain,
          rpcUrls: {
            ...baseChain.rpcUrls,
            custom: {
              http: [customRpcUrl],
            },
          },
        }
      : baseChain;

    return viemChain;
  }
}

// --- Adjusted Chain Configuration Logic --- //

const genChainsFromRuntime = (runtime: IAgentRuntime): Record<string, Chain> => {
  const chains: Record<string, Chain> = {};

  // 1. Get L2 Polygon RPC URL
  const polygonRpcUrl = runtime.getSetting('POLYGON_RPC_URL');
  if (polygonRpcUrl) {
    // Attempt to determine if it's mainnet or testnet (Mumbai)
    // Simple check for now, could be more robust
    const isMainnet = !/mumbai/i.test(polygonRpcUrl);
    const polygonChainName = isMainnet ? 'polygon' : 'polygonMumbai';
    try {
      const chain = WalletProvider.genChainFromName(polygonChainName, polygonRpcUrl);
      chains[polygonChainName] = chain;
      elizaLogger.info(`Configured Polygon chain: ${polygonChainName}`);
    } catch (error) {
      elizaLogger.error(`Error configuring Polygon chain (${polygonChainName}):`, error);
    }
  } else {
    elizaLogger.warn('POLYGON_RPC_URL setting not found.');
  }

  // 2. Get L1 Ethereum RPC URL
  const ethRpcUrl = runtime.getSetting('ETHEREUM_RPC_URL');
  if (ethRpcUrl) {
    // Attempt to determine if it's mainnet or testnet (e.g., Sepolia)
    const isEthMainnet = !/(sepolia|goerli|ropsten|kovan)/i.test(ethRpcUrl);
    const viemKeyForEth = isEthMainnet ? 'mainnet' : 'sepolia';
    const storageKeyForEth = isEthMainnet ? ETH_MAINNET_KEY : 'sepolia'; // ETH_MAINNET_KEY is "ethereum"
    try {
      const chain = WalletProvider.genChainFromName(viemKeyForEth, ethRpcUrl);
      chains[storageKeyForEth] = chain;
      elizaLogger.info(
        `Configured Ethereum L1 chain: ${storageKeyForEth} (using viem key: ${viemKeyForEth})`
      );
    } catch (error) {
      elizaLogger.error(
        `Error configuring Ethereum L1 chain (${storageKeyForEth} with viem key ${viemKeyForEth}):`,
        error
      );
    }
  } else {
    elizaLogger.warn('ETHEREUM_RPC_URL setting not found.');
  }

  if (Object.keys(chains).length === 0) {
    elizaLogger.error('No chains could be configured. WalletProvider may not function correctly.');
  }

  return chains;
};

export const initWalletProvider = async (
  runtime: IAgentRuntime
): Promise<WalletProvider | null> => {
  // TEE Mode handling (optional, keep if needed, ensure settings are correct)
  const teeMode = runtime.getSetting('TEE_MODE') || 'OFF'; // Use correct setting if TEE is used

  const chains = genChainsFromRuntime(runtime);
  if (Object.keys(chains).length === 0) {
    elizaLogger.error('Cannot initialize WalletProvider: No chains configured.');
    return null; // Return null or throw error if no chains are essential
  }

  if (teeMode !== 'OFF') {
    const walletSecretSalt = runtime.getSetting('WALLET_SECRET_SALT'); // Use correct TEE setting key if needed
    if (!walletSecretSalt) {
      throw new Error('WALLET_SECRET_SALT required when TEE_MODE is enabled');
    }

    try {
      const deriveKeyProvider = new PhalaDeriveKeyProvider(teeMode);
      const deriveKeyResult = await deriveKeyProvider.deriveEcdsaKeypair(
        walletSecretSalt,
        'polygon', // Use a unique context for polygon
        runtime.agentId
      );
      elizaLogger.info('Initialized WalletProvider using TEE derived key.');
      return new WalletProvider(
        deriveKeyResult.keypair as unknown as PrivateKeyAccount,
        runtime,
        chains
      );
    } catch (error) {
      elizaLogger.error('Failed to initialize WalletProvider with TEE:', error);
      throw error; // Rethrow TEE initialization error
    }
  } else {
    // Use PRIVATE_KEY defined in this plugin's config
    const rawPrivateKey = runtime.getSetting('PRIVATE_KEY');
    elizaLogger.info('PRIVATE_KEY setting retrieved (not showing actual key for security)');

    if (!rawPrivateKey) {
      elizaLogger.error(
        'PRIVATE_KEY setting is missing or not loaded. Cannot initialize WalletProvider.'
      );
      throw new Error('PRIVATE_KEY setting is missing for WalletProvider initialization');
    }

    try {
      // Format the private key correctly with 0x prefix if missing
      const privateKey = rawPrivateKey.startsWith('0x')
        ? (rawPrivateKey as `0x${string}`)
        : (`0x${rawPrivateKey}` as `0x${string}`);

      const provider = new WalletProvider(privateKey, runtime, chains);
      elizaLogger.info('Initialized WalletProvider using PRIVATE_KEY setting.');
      return provider;
    } catch (error) {
      elizaLogger.error('Failed to initialize WalletProvider with private key:', error);
      throw error; // Rethrow wallet initialization error
    }
  }
};

// Fallback function to fetch wallet data directly
async function directFetchWalletData(
  runtime: IAgentRuntime,
  state?: State
): Promise<ProviderResult> {
  try {
    const walletProvider = await initWalletProvider(runtime);
    if (!walletProvider) {
      throw new Error('Failed to initialize wallet provider');
    }

    const address = walletProvider.getAddress();

    // Get balance for each configured chain
    const chainBalances: Record<string, string> = {};
    for (const chainName of Object.keys(walletProvider.chains)) {
      try {
        const balance = await walletProvider.getWalletBalanceForChain(chainName as SupportedChain);
        if (balance) {
          chainBalances[chainName] = balance;
        }
      } catch (error) {
        elizaLogger.error(`Error getting balance for chain ${chainName}:`, error);
      }
    }

    const agentName = state?.agentName || 'The agent';

    // Format balances for all chains
    const chainDetails = Object.entries(chainBalances).map(([chainName, balance]) => {
      const chain = walletProvider.chains[chainName];
      return {
        chainName,
        balance,
        symbol: chain.nativeCurrency.symbol,
        chainId: chain.id,
        name: chain.name,
      };
    });

    // Create a text representation of all chain balances
    const balanceText = chainDetails
      .map((chain) => `${chain.name}: ${chain.balance} ${chain.symbol}`)
      .join('\n');

    return {
      text: `${agentName}'s Polygon Wallet Address: ${address}\n\nBalances:\n${balanceText}`,
      data: {
        address,
        chains: chainDetails,
      },
      values: {
        address: address as string,
        chains: JSON.stringify(chainDetails),
      },
    };
  } catch (error) {
    elizaLogger.error('Error fetching wallet data directly:', error);
    return {
      text: `Error getting Polygon wallet provider: ${error instanceof Error ? error.message : String(error)}`,
      data: { error: error instanceof Error ? error.message : String(error) },
      values: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export const polygonWalletProvider: Provider = {
  name: 'PolygonWalletProvider',
  async get(runtime: IAgentRuntime, _message: Memory, state?: State): Promise<ProviderResult> {
    try {
      // Always use the direct fetch method for consistency
      return await directFetchWalletData(runtime, state);
    } catch (error) {
      elizaLogger.error('Error in Polygon wallet provider:', error);
      const errorText = error instanceof Error ? error.message : String(error);
      return {
        text: `Error in Polygon wallet provider: ${errorText}`,
        data: { error: errorText },
        values: { error: errorText },
      };
    }
  },
};
