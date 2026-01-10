/**
 * @elizaos/plugin-evm Wallet Provider
 *
 * Provides wallet functionality for EVM chains including key management,
 * client creation, and balance querying.
 */

import * as path from "node:path";
import {
  elizaLogger,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  ServiceType,
  type State,
  TEEMode,
} from "@elizaos/core";
import type {
  Account,
  Chain,
  HttpTransport,
  PrivateKeyAccount,
  PublicClient,
  TestClient,
  WalletClient,
  Address,
} from "viem";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  formatUnits,
  http,
  publicActions,
  walletActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";

import { EVM_SERVICE_NAME, DEFAULT_CHAINS } from "../constants";
import {
  type SupportedChain,
  EVMError,
  EVMErrorCode,
  assertDefined,
  assertChainConfigured,
  PrivateKeySchema,
} from "../types";

/**
 * Wallet provider for EVM chains
 *
 * Manages wallet access, chain configuration, and balance queries.
 * Supports both standard private keys and TEE-derived keys.
 */
export class WalletProvider {
  private readonly cacheKey = "evm/wallet";
  private _chains: Record<string, Chain>;
  private _account: PrivateKeyAccount;
  private readonly _runtime: IAgentRuntime;

  constructor(
    accountOrPrivateKey: PrivateKeyAccount | `0x${string}`,
    runtime: IAgentRuntime,
    chains?: Record<string, Chain>
  ) {
    this._runtime = runtime;
    this._chains = chains ?? {};
    this._account = this.initializeAccount(accountOrPrivateKey);
  }

  /**
   * Get the account's address
   */
  getAddress(): Address {
    return this._account.address;
  }

  /**
   * Get the configured chains
   */
  get chains(): Record<string, Chain> {
    return this._chains;
  }

  /**
   * Get the account
   */
  get account(): PrivateKeyAccount {
    return this._account;
  }

  /**
   * Get a public client for a specific chain
   * @throws EVMError if chain is not configured
   */
  getPublicClient(
    chainName: SupportedChain
  ): PublicClient<HttpTransport, Chain, Account | undefined> {
    assertChainConfigured(this._chains, chainName);
    const transport = this.createHttpTransport(chainName);

    return createPublicClient({
      chain: this._chains[chainName],
      transport,
    });
  }

  /**
   * Get a wallet client for a specific chain
   * @throws EVMError if chain is not configured
   */
  getWalletClient(chainName: SupportedChain): WalletClient {
    assertChainConfigured(this._chains, chainName);
    const transport = this.createHttpTransport(chainName);

    return createWalletClient({
      chain: this._chains[chainName],
      transport,
      account: this._account,
    });
  }

  /**
   * Get a test client for Hardhat
   */
  getTestClient(): TestClient {
    return createTestClient({
      chain: viemChains.hardhat,
      mode: "hardhat",
      transport: http(),
    })
      .extend(publicActions)
      .extend(walletActions);
  }

  /**
   * Get chain configuration by name
   * @throws EVMError if chain is not configured
   */
  getChainConfigs(chainName: SupportedChain): Chain {
    const chain = this._chains[chainName];
    if (!chain?.id) {
      throw new EVMError(
        EVMErrorCode.CHAIN_NOT_CONFIGURED,
        `Invalid chain name: ${chainName}`
      );
    }
    return chain;
  }

  /**
   * Get all supported chain names
   */
  getSupportedChains(): SupportedChain[] {
    return Object.keys(this._chains) as SupportedChain[];
  }

  /**
   * Get wallet balances for all configured chains
   */
  async getWalletBalances(): Promise<Record<SupportedChain, string>> {
    const cacheKey = path.join(this.cacheKey, "walletBalances");
    const cachedData =
      await this._runtime.getCache<Record<SupportedChain, string>>(cacheKey);

    if (cachedData) {
      elizaLogger.log(`Returning cached wallet balances`);
      return cachedData;
    }

    const balances = {} as Record<SupportedChain, string>;
    const chainNames = this.getSupportedChains();

    const results = await Promise.allSettled(
      chainNames.map(async (chainName) => {
        const balance = await this.getWalletBalanceForChain(chainName);
        return { chainName, balance };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.balance !== null) {
        balances[result.value.chainName] = result.value.balance;
      } else if (result.status === "rejected") {
        elizaLogger.error(`Error getting balance:`, result.reason);
      }
    }

    await this._runtime.setCache(cacheKey, balances);
    elizaLogger.log("Wallet balances cached");
    return balances;
  }

  /**
   * Get wallet balance for a specific chain
   */
  async getWalletBalanceForChain(
    chainName: SupportedChain
  ): Promise<string | null> {
    try {
      const client = this.getPublicClient(chainName);
      const balance = await client.getBalance({
        address: this._account.address,
      });
      return formatUnits(balance, 18);
    } catch (error) {
      elizaLogger.error(`Error getting wallet balance for ${chainName}:`, error);
      return null;
    }
  }

  /**
   * Add a chain to the configuration
   */
  addChain(chain: Record<string, Chain>): void {
    this._chains = { ...this._chains, ...chain };
  }

  /**
   * Initialize account from private key or existing account
   */
  private initializeAccount(
    accountOrPrivateKey: PrivateKeyAccount | `0x${string}`
  ): PrivateKeyAccount {
    if (typeof accountOrPrivateKey === "string") {
      // Validate the private key format
      const result = PrivateKeySchema.safeParse(accountOrPrivateKey);
      if (!result.success) {
        throw new EVMError(
          EVMErrorCode.INVALID_PARAMS,
          `Invalid private key format: ${result.error.message}`
        );
      }
      return privateKeyToAccount(result.data);
    }
    return accountOrPrivateKey;
  }

  /**
   * Create HTTP transport for a chain
   */
  private createHttpTransport(chainName: SupportedChain) {
    const chain = this._chains[chainName];
    if (!chain) {
      throw new EVMError(
        EVMErrorCode.CHAIN_NOT_CONFIGURED,
        `Chain not found: ${chainName}`
      );
    }

    // Check for custom RPC URL
    const customRpc = chain.rpcUrls.custom;
    if (customRpc) {
      return http(customRpc.http[0]);
    }
    return http(chain.rpcUrls.default.http[0]);
  }

  /**
   * Generate a chain configuration from name with optional custom RPC
   * @throws EVMError if chain name is invalid
   */
  static genChainFromName(
    chainName: string,
    customRpcUrl?: string | null
  ): Chain {
    const baseChain = (viemChains as Record<string, Chain | undefined>)[
      chainName
    ];

    if (!baseChain?.id) {
      throw new EVMError(
        EVMErrorCode.CHAIN_NOT_CONFIGURED,
        `Invalid chain name: ${chainName}`
      );
    }

    if (customRpcUrl) {
      return {
        ...baseChain,
        rpcUrls: {
          ...baseChain.rpcUrls,
          custom: {
            http: [customRpcUrl],
          },
        },
      };
    }

    return baseChain;
  }
}

/**
 * Generate chain configurations from runtime settings
 */
function genChainsFromRuntime(runtime: IAgentRuntime): Record<string, Chain> {
  const settings = runtime.character?.settings;

  // Extract configured chains from settings
  let configuredChains: string[] = [];
  if (
    typeof settings === "object" &&
    settings !== null &&
    "chains" in settings &&
    typeof settings.chains === "object" &&
    settings.chains !== null &&
    "evm" in settings.chains &&
    Array.isArray(settings.chains.evm)
  ) {
    configuredChains = settings.chains.evm;
  }

  // Use defaults if no chains configured
  const chainsToUse =
    configuredChains.length > 0 ? configuredChains : [...DEFAULT_CHAINS];

  if (!configuredChains.length) {
    elizaLogger.warn(
      "No EVM chains configured in settings, defaulting to mainnet and base"
    );
  }

  const chains: Record<string, Chain> = {};

  for (const chainName of chainsToUse) {
    try {
      // Try to get RPC URL from settings
      let rpcUrl = runtime.getSetting(
        `ETHEREUM_PROVIDER_${chainName.toUpperCase()}`
      );
      if (!rpcUrl) {
        rpcUrl = runtime.getSetting(`EVM_PROVIDER_${chainName.toUpperCase()}`);
      }

      // Skip chains that don't exist in viem
      if (!(chainName in viemChains)) {
        elizaLogger.warn(
          `Chain ${chainName} not found in viem chains, skipping`
        );
        continue;
      }

      const chain = WalletProvider.genChainFromName(
        chainName,
        rpcUrl ?? null
      );
      chains[chainName] = chain;
      elizaLogger.log(`Configured chain: ${chainName}`);
    } catch (error) {
      elizaLogger.error(`Error configuring chain ${chainName}:`, error);
    }
  }

  return chains;
}

/**
 * Initialize a wallet provider from runtime configuration
 * @throws EVMError if required configuration is missing
 */
export async function initWalletProvider(
  runtime: IAgentRuntime
): Promise<WalletProvider> {
  const teeMode = runtime.getSetting("TEE_MODE") ?? TEEMode.OFF;
  const chains = genChainsFromRuntime(runtime);

  if (teeMode !== TEEMode.OFF) {
    const walletSecretSalt = runtime.getSetting("WALLET_SECRET_SALT");
    if (!walletSecretSalt) {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        "WALLET_SECRET_SALT required when TEE_MODE is enabled"
      );
    }

    return new LazyTeeWalletProvider(runtime, walletSecretSalt, chains);
  }

  const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
  if (!privateKey) {
    throw new EVMError(
      EVMErrorCode.WALLET_NOT_INITIALIZED,
      "EVM_PRIVATE_KEY is missing"
    );
  }

  // Validate the private key format
  const validatedKey = PrivateKeySchema.parse(privateKey);
  return new WalletProvider(validatedKey, runtime, chains);
}

/**
 * Lazy TEE wallet provider that initializes the TEE wallet on first use
 */
class LazyTeeWalletProvider extends WalletProvider {
  private teeWallet: WalletProvider | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly walletSecretSalt: string;
  private readonly teeRuntime: IAgentRuntime;
  private readonly teeChains: Record<string, Chain>;

  constructor(
    runtime: IAgentRuntime,
    walletSecretSalt: string,
    chains: Record<string, Chain>
  ) {
    // Initialize with a dummy account that will be replaced
    const dummyKey =
      "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
    super(dummyKey, runtime, chains);
    this.walletSecretSalt = walletSecretSalt;
    this.teeRuntime = runtime;
    this.teeChains = chains;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.teeWallet) return;

    if (!this.initPromise) {
      this.initPromise = this.initializeTeeWallet();
    }

    await this.initPromise;
  }

  private async initializeTeeWallet(): Promise<void> {
    const teeService = this.teeRuntime.getService(ServiceType.TEE);

    if (!teeService) {
      throw new EVMError(
        EVMErrorCode.WALLET_NOT_INITIALIZED,
        "TEE service not found - ensure TEE plugin is registered"
      );
    }

    // Type assertion for TEE service method
    const teeWithDerive = teeService as {
      deriveEcdsaKeypair?: (
        salt: string,
        path: string,
        agentId: string
      ) => Promise<{ keypair: `0x${string}`; attestation: unknown }>;
    };

    if (typeof teeWithDerive.deriveEcdsaKeypair !== "function") {
      throw new EVMError(
        EVMErrorCode.WALLET_NOT_INITIALIZED,
        "TEE service does not implement deriveEcdsaKeypair method"
      );
    }

    const { keypair } = await teeWithDerive.deriveEcdsaKeypair(
      this.walletSecretSalt,
      "evm",
      this.teeRuntime.agentId
    );

    this.teeWallet = new WalletProvider(keypair, this.teeRuntime, this.teeChains);
  }

  override getAddress(): Address {
    if (!this.teeWallet) {
      throw new EVMError(
        EVMErrorCode.WALLET_NOT_INITIALIZED,
        "TEE wallet not initialized yet. Ensure async operations complete first."
      );
    }
    return this.teeWallet.getAddress();
  }

  override getPublicClient(
    chainName: SupportedChain
  ): PublicClient<HttpTransport, Chain, Account | undefined> {
    if (!this.teeWallet) {
      // Public client doesn't need the account
      return super.getPublicClient(chainName);
    }
    return this.teeWallet.getPublicClient(chainName);
  }

  override getWalletClient(chainName: SupportedChain): WalletClient {
    if (!this.teeWallet) {
      throw new EVMError(
        EVMErrorCode.WALLET_NOT_INITIALIZED,
        "TEE wallet not initialized yet. Ensure async operations complete first."
      );
    }
    return this.teeWallet.getWalletClient(chainName);
  }

  override async getWalletBalances(): Promise<Record<SupportedChain, string>> {
    await this.ensureInitialized();
    assertDefined(this.teeWallet, "TEE wallet failed to initialize");
    return this.teeWallet.getWalletBalances();
  }

  override async getWalletBalanceForChain(
    chainName: SupportedChain
  ): Promise<string | null> {
    await this.ensureInitialized();
    assertDefined(this.teeWallet, "TEE wallet failed to initialize");
    return this.teeWallet.getWalletBalanceForChain(chainName);
  }
}

/**
 * EVM Wallet Provider for agent context
 */
export const evmWalletProvider: Provider = {
  name: "EVMWalletProvider",
  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State
  ): Promise<ProviderResult> {
    try {
      const evmService = runtime.getService(EVM_SERVICE_NAME);

      if (!evmService) {
        elizaLogger.warn(
          "EVM service not found, falling back to direct fetching"
        );
        return await directFetchWalletData(runtime, state);
      }

      // Type assertion for service method
      const serviceWithCache = evmService as {
        getCachedData?: () => Promise<{
          address: string;
          chains: Array<{
            name: string;
            balance: string;
            symbol: string;
          }>;
        } | undefined>;
      };

      if (typeof serviceWithCache.getCachedData !== "function") {
        elizaLogger.warn(
          "EVM service missing getCachedData, falling back to direct fetching"
        );
        return await directFetchWalletData(runtime, state);
      }

      const walletData = await serviceWithCache.getCachedData();
      if (!walletData) {
        elizaLogger.warn(
          "No cached wallet data available, falling back to direct fetching"
        );
        return await directFetchWalletData(runtime, state);
      }

      const agentName = state?.agentName ?? "The agent";
      const balanceText = walletData.chains
        .map((chain) => `${chain.name}: ${chain.balance} ${chain.symbol}`)
        .join("\n");

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
      elizaLogger.error("Error in EVM wallet provider:", error);
      throw error; // Fail fast - don't swallow errors
    }
  },
};

/**
 * Direct wallet data fetching fallback
 */
async function directFetchWalletData(
  runtime: IAgentRuntime,
  state?: State
): Promise<ProviderResult> {
  const walletProvider = await initWalletProvider(runtime);
  const address = walletProvider.getAddress();
  const balances = await walletProvider.getWalletBalances();
  const agentName = state?.agentName ?? "The agent";

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

  const balanceText = chainDetails
    .map((chain) => `${chain.name}: ${chain.balance} ${chain.symbol}`)
    .join("\n");

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
}
