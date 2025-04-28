import * as path from 'node:path';
import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  elizaLogger,
} from '@elizaos/core';
import { PhalaDeriveKeyProvider, TEEMode } from '@elizaos/plugin-tee';
import type {
  Account,
  Address,
  Chain,
  HttpTransport,
  PrivateKeyAccount,
  PublicClient,
  TestClient,
  WalletClient,
} from 'viem';
import {
  http,
  createPublicClient,
  createTestClient,
  createWalletClient,
  formatUnits,
  publicActions,
  walletActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as viemChains from 'viem/chains';

import { EVM_SERVICE_NAME } from '../constants';
import type { EVMService } from '../service';
import type { SupportedChain, WalletBalance } from '../types';

export class WalletProvider {
  private cacheKey = 'evm/wallet';
  chains: Record<string, Chain> = { ...viemChains };
  account: PrivateKeyAccount;
  runtime: IAgentRuntime;
  constructor(
    accountOrPrivateKey: PrivateKeyAccount | `0x${string}`,
    runtime: IAgentRuntime,
    chains?: Record<string, Chain>
  ) {
    this.setAccount(accountOrPrivateKey);
    this.addChains(chains);
    this.runtime = runtime;
  }

  getAddress(): Address {
    return this.account.address;
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
    const chain = this.chains[chainName];

    if (!chain?.id) {
      throw new Error(`Invalid chain name: ${chainName}`);
    }

    return chain;
  }

  getSupportedChains(): SupportedChain[] {
    return Object.keys(this.chains) as SupportedChain[];
  }

  async getWalletBalances(): Promise<Record<SupportedChain, string>> {
    const cacheKey = path.join(this.cacheKey, 'walletBalances');
    const cachedData = await this.runtime.getCache<Record<SupportedChain, string>>(cacheKey);
    if (cachedData) {
      elizaLogger.log(`Returning cached wallet balances`);
      return cachedData;
    }

    const balances = {} as Record<SupportedChain, string>;
    const chainNames = this.getSupportedChains();

    await Promise.all(
      chainNames.map(async (chainName) => {
        try {
          const balance = await this.getWalletBalanceForChain(chainName);
          if (balance !== null) {
            balances[chainName] = balance;
          }
        } catch (error) {
          elizaLogger.error(`Error getting balance for ${chainName}:`, error);
        }
      })
    );

    await this.runtime.setCache(cacheKey, balances);
    elizaLogger.log('Wallet balances cached');
    return balances;
  }

  async getWalletBalanceForChain(chainName: SupportedChain): Promise<string | null> {
    try {
      const client = this.getPublicClient(chainName);
      const balance = await client.getBalance({
        address: this.account.address,
      });
      return formatUnits(balance, 18);
    } catch (error) {
      console.error(`Error getting wallet balance for ${chainName}:`, error);
      return null;
    }
  }

  addChain(chain: Record<string, Chain>) {
    this.addChains(chain);
  }

  private setAccount = (accountOrPrivateKey: PrivateKeyAccount | `0x${string}`) => {
    if (typeof accountOrPrivateKey === 'string') {
      this.account = privateKeyToAccount(accountOrPrivateKey);
    } else {
      this.account = accountOrPrivateKey;
    }
  };

  private addChains = (chains?: Record<string, Chain>) => {
    if (!chains) {
      return;
    }
    for (const chain of Object.keys(chains)) {
      this.chains[chain] = chains[chain];
    }
  };

  private createHttpTransport = (chainName: SupportedChain) => {
    const chain = this.chains[chainName];
    if (!chain) {
      throw new Error(`Chain not found: ${chainName}`);
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

const genChainsFromRuntime = (runtime: IAgentRuntime): Record<string, Chain> => {
  // Get chains from settings or use default supported chains
  const configuredChains = (runtime.character.settings.chains?.evm as SupportedChain[]) || [];

  // Default chains to include if not specified in settings
  const defaultChains = ['mainnet', 'polygon', 'arbitrum', 'base', 'optimism', 'linea'];

  // Combine configured chains with defaults, removing duplicates
  const chainNames = [...new Set([...configuredChains, ...defaultChains])];
  const chains: Record<string, Chain> = {};

  for (const chainName of chainNames) {
    try {
      // Try to get RPC URL from settings using different formats
      let rpcUrl = runtime.getSetting(`ETHEREUM_PROVIDER_${chainName.toUpperCase()}`);

      if (!rpcUrl) {
        rpcUrl = runtime.getSetting(`EVM_PROVIDER_${chainName.toUpperCase()}`);
      }

      // Skip chains that don't exist in viem
      if (!viemChains[chainName]) {
        elizaLogger.warn(`Chain ${chainName} not found in viem chains, skipping`);
        continue;
      }

      const chain = WalletProvider.genChainFromName(chainName, rpcUrl);
      chains[chainName] = chain;
    } catch (error) {
      elizaLogger.error(`Error configuring chain ${chainName}:`, error);
    }
  }

  return chains;
};

export const initWalletProvider = async (runtime: IAgentRuntime) => {
  const teeMode = runtime.getSetting('TEE_MODE') || TEEMode.OFF;

  const chains = genChainsFromRuntime(runtime);

  if (teeMode !== TEEMode.OFF) {
    const walletSecretSalt = runtime.getSetting('WALLET_SECRET_SALT');
    if (!walletSecretSalt) {
      throw new Error('WALLET_SECRET_SALT required when TEE_MODE is enabled');
    }

    const deriveKeyProvider = new PhalaDeriveKeyProvider(teeMode);
    const deriveKeyResult = await deriveKeyProvider.deriveEcdsaKeypair(
      walletSecretSalt,
      'evm',
      runtime.agentId
    );
    return new WalletProvider(deriveKeyResult.keypair, runtime, chains);
  }
  const privateKey = runtime.getSetting('EVM_PRIVATE_KEY') as `0x${string}`;
  if (!privateKey) {
    throw new Error('EVM_PRIVATE_KEY is missing');
  }
  return new WalletProvider(privateKey, runtime, chains);
};

export const evmWalletProvider: Provider = {
  name: 'EVMWalletProvider',
  async get(runtime: IAgentRuntime, _message: Memory, state?: State): Promise<ProviderResult> {
    try {
      // Get the EVM service
      const evmService = runtime.getService(EVM_SERVICE_NAME);

      // If service is not available, fall back to direct fetching
      if (!evmService) {
        elizaLogger.warn('EVM service not found, falling back to direct fetching');
        return await directFetchWalletData(runtime, state);
      }

      // Get wallet data from the service
      const walletData = await (evmService as any).getCachedData();
      if (!walletData) {
        elizaLogger.warn('No cached wallet data available, falling back to direct fetching');
        return await directFetchWalletData(runtime, state);
      }

      const agentName = state?.agentName || 'The agent';

      // Create a text representation of all chain balances
      const balanceText = walletData.chains
        .map((chain) => `${chain.name}: ${chain.balance} ${chain.symbol}`)
        .join('\n');

      return {
        text: `${agentName}'s EVM Wallet Address: ${walletData.address}\n\nBalances:\n${balanceText}`,
        data: {
          address: walletData.address,
          chains: walletData.chains,
        },
        values: {
          address: walletData.address,
          chains: JSON.stringify(walletData.chains),
        },
      };
    } catch (error) {
      console.error('Error in EVM wallet provider:', error);
      return {
        text: 'Error getting EVM wallet provider',
        data: {},
        values: {},
      };
    }
  },
};

// Fallback function to fetch wallet data directly
async function directFetchWalletData(
  runtime: IAgentRuntime,
  state?: State
): Promise<ProviderResult> {
  try {
    const walletProvider = await initWalletProvider(runtime);
    const address = walletProvider.getAddress();
    const balances = await walletProvider.getWalletBalances();
    const agentName = state?.agentName || 'The agent';

    // Format balances for all chains
    const chainDetails = Object.entries(balances).map(([chainName, balance]) => {
      const chain = walletProvider.getChainConfigs(chainName as SupportedChain);
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
      text: `${agentName}'s EVM Wallet Address: ${address}\n\nBalances:\n${balanceText}`,
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
    console.error('Error fetching wallet data directly:', error);
    return {
      text: 'Error getting EVM wallet provider',
      data: {},
      values: {},
    };
  }
}
