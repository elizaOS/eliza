import * as path from "node:path";
import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  ServiceType,
  type State,
  TEEMode,
} from "@elizaos/core";
import type {
  Account,
  Address,
  Chain,
  HttpTransport,
  PrivateKeyAccount,
  PublicClient,
  TestClient,
  WalletClient,
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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";

import { DEFAULT_CHAINS, EVM_SERVICE_NAME } from "../constants";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import {
  assertChainConfigured,
  assertDefined,
  EVMError,
  EVMErrorCode,
  PrivateKeySchema,
  type SupportedChain,
} from "../types";

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

  getAddress(): Address {
    return this._account.address;
  }

  get chains(): Record<string, Chain> {
    return this._chains;
  }

  get account(): PrivateKeyAccount {
    return this._account;
  }

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

  getWalletClient(chainName: SupportedChain): WalletClient {
    assertChainConfigured(this._chains, chainName);
    const transport = this.createHttpTransport(chainName);

    return createWalletClient({
      chain: this._chains[chainName],
      transport,
      account: this._account,
    });
  }

  getTestClient(): TestClient {
    return createTestClient({
      chain: viemChains.hardhat,
      mode: "hardhat",
      transport: http(),
    })
      .extend(publicActions)
      .extend(walletActions);
  }

  getChainConfigs(chainName: SupportedChain): Chain {
    const chain = this._chains[chainName];
    if (!chain?.id) {
      throw new EVMError(EVMErrorCode.CHAIN_NOT_CONFIGURED, `Invalid chain name: ${chainName}`);
    }
    return chain;
  }

  getSupportedChains(): SupportedChain[] {
    return Object.keys(this._chains) as SupportedChain[];
  }

  async getWalletBalances(): Promise<Record<SupportedChain, string>> {
    const cacheKey = path.join(this.cacheKey, "walletBalances");
    const cachedData = await this._runtime.getCache<Record<SupportedChain, string>>(cacheKey);

    if (cachedData) {
      logger.log(`Returning cached wallet balances`);
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
        logger.error(`Error getting balance:`, result.reason);
      }
    }

    await this._runtime.setCache(cacheKey, balances);
    logger.log("Wallet balances cached");
    return balances;
  }

  async getWalletBalanceForChain(chainName: SupportedChain): Promise<string | null> {
    try {
      const client = this.getPublicClient(chainName);
      const balance = await client.getBalance({
        address: this._account.address,
      });
      return formatUnits(balance, 18);
    } catch (error) {
      logger.error(`Error getting wallet balance for ${chainName}:`, error);
      return null;
    }
  }

  addChain(chain: Record<string, Chain>): void {
    this._chains = { ...this._chains, ...chain };
  }

  private initializeAccount(
    accountOrPrivateKey: PrivateKeyAccount | `0x${string}`
  ): PrivateKeyAccount {
    if (typeof accountOrPrivateKey === "string") {
      const result = PrivateKeySchema.safeParse(accountOrPrivateKey);
      if (!result.success) {
        const zodError = result.error as {
          errors?: Array<{ message?: string }>;
          issues?: Array<{ message?: string }>;
        };
        const errorList = zodError.errors ?? zodError.issues ?? [];
        const firstError = Array.isArray(errorList) ? errorList[0] : undefined;
        const errorMessage = firstError?.message ?? "Validation failed";
        throw new EVMError(
          EVMErrorCode.INVALID_PARAMS,
          `Invalid private key format: ${errorMessage}`
        );
      }
      return privateKeyToAccount(result.data);
    }
    return accountOrPrivateKey;
  }

  private createHttpTransport(chainName: SupportedChain) {
    const chain = this._chains[chainName];
    if (!chain) {
      throw new EVMError(EVMErrorCode.CHAIN_NOT_CONFIGURED, `Chain not found: ${chainName}`);
    }

    const customRpc = chain.rpcUrls.custom;
    if (customRpc) {
      return http(customRpc.http[0]);
    }
    return http(chain.rpcUrls.default.http[0]);
  }

  static genChainFromName(chainName: string, customRpcUrl?: string | null): Chain {
    const baseChain = (viemChains as Record<string, Chain | undefined>)[chainName];

    if (!baseChain?.id) {
      throw new EVMError(EVMErrorCode.CHAIN_NOT_CONFIGURED, `Invalid chain name: ${chainName}`);
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

function genChainsFromRuntime(runtime: IAgentRuntime): Record<string, Chain> {
  const settings = runtime.character?.settings;
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

  const chainsToUse = configuredChains.length > 0 ? configuredChains : [...DEFAULT_CHAINS];

  if (!configuredChains.length) {
    logger.warn("No EVM chains configured in settings, defaulting to mainnet and base");
  }

  const chains: Record<string, Chain> = {};

  for (const chainName of chainsToUse) {
    try {
      const rpcUrlRaw =
        runtime.getSetting(`ETHEREUM_PROVIDER_${chainName.toUpperCase()}`) ??
        runtime.getSetting(`EVM_PROVIDER_${chainName.toUpperCase()}`);

      const rpcUrl = typeof rpcUrlRaw === "string" ? rpcUrlRaw : null;

      if (!(chainName in viemChains)) {
        logger.warn(`Chain ${chainName} not found in viem chains, skipping`);
        continue;
      }

      const chain = WalletProvider.genChainFromName(chainName, rpcUrl);
      chains[chainName] = chain;
      logger.log(`Configured chain: ${chainName}`);
    } catch (error) {
      logger.error(`Error configuring chain ${chainName}:`, error);
    }
  }

  return chains;
}

async function generateAndStorePrivateKey(runtime: IAgentRuntime): Promise<`0x${string}`> {
  const newPrivateKey = generatePrivateKey();
  const account = privateKeyToAccount(newPrivateKey);

  logger.warn("═══════════════════════════════════════════════════════════════════");
  logger.warn("⚠️  EVM_PRIVATE_KEY not found - generating new wallet");
  logger.warn(`📍 New wallet address: ${account.address}`);
  logger.warn("💾 Private key will be stored in agent secrets automatically");
  logger.warn("⚠️  IMPORTANT: Back up your private key for production use!");
  logger.warn("═══════════════════════════════════════════════════════════════════");

  runtime.setSetting("EVM_PRIVATE_KEY", newPrivateKey, true);

  try {
    await runtime.updateAgent(runtime.agentId, {
      settings: {
        ...runtime.character.settings,
        secrets: {
          ...((runtime.character.settings?.secrets as Record<string, string>) || {}),
          EVM_PRIVATE_KEY: newPrivateKey,
        },
      },
    });
    logger.log("EVM private key persisted to agent settings");
  } catch (error) {
    logger.warn("Could not persist EVM private key to database - key is only in memory", error);
  }

  return newPrivateKey;
}

export async function initWalletProvider(runtime: IAgentRuntime): Promise<WalletProvider> {
  const teeModeRaw = runtime.getSetting("TEE_MODE");
  const teeMode = typeof teeModeRaw === "string" ? teeModeRaw : TEEMode.OFF;
  const chains = genChainsFromRuntime(runtime);

  if (teeMode !== TEEMode.OFF) {
    const walletSecretSaltRaw = runtime.getSetting("WALLET_SECRET_SALT");
    if (!walletSecretSaltRaw || typeof walletSecretSaltRaw !== "string") {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        "WALLET_SECRET_SALT required when TEE_MODE is enabled"
      );
    }

    return new LazyTeeWalletProvider(runtime, walletSecretSaltRaw, chains);
  }

  const privateKeyRaw = runtime.getSetting("EVM_PRIVATE_KEY");
  let privateKey: string;
  if (!privateKeyRaw || typeof privateKeyRaw !== "string") {
    privateKey = await generateAndStorePrivateKey(runtime);
  } else {
    privateKey = privateKeyRaw;
  }

  const validatedKey = PrivateKeySchema.parse(privateKey);
  return new WalletProvider(validatedKey, runtime, chains);
}

class LazyTeeWalletProvider extends WalletProvider {
  private teeWallet: WalletProvider | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly walletSecretSalt: string;
  private readonly teeRuntime: IAgentRuntime;
  private readonly teeChains: Record<string, Chain>;

  constructor(runtime: IAgentRuntime, walletSecretSalt: string, chains: Record<string, Chain>) {
    const dummyKey = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
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

  override async getWalletBalanceForChain(chainName: SupportedChain): Promise<string | null> {
    await this.ensureInitialized();
    assertDefined(this.teeWallet, "TEE wallet failed to initialize");
    return this.teeWallet.getWalletBalanceForChain(chainName);
  }
}

const spec = requireProviderSpec("wallet");

export const evmWalletProvider: Provider = {
  name: spec.name,
  async get(runtime: IAgentRuntime, _message: Memory, state?: State): Promise<ProviderResult> {
    try {
      const evmService = runtime.getService(EVM_SERVICE_NAME);

      if (!evmService) {
        logger.warn("EVM service not found, falling back to direct fetching");
        return await directFetchWalletData(runtime, state);
      }

      const serviceWithCache = evmService as {
        getCachedData?: () => Promise<
          | {
              address: string;
              chains: Array<{
                name: string;
                balance: string;
                symbol: string;
              }>;
            }
          | undefined
        >;
      };

      if (typeof serviceWithCache.getCachedData !== "function") {
        logger.warn("EVM service missing getCachedData, falling back to direct fetching");
        return await directFetchWalletData(runtime, state);
      }

      const walletData = await serviceWithCache.getCachedData();
      if (!walletData) {
        logger.warn("No cached wallet data available, falling back to direct fetching");
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
      logger.error("Error in EVM wallet provider:", error);
      throw error;
    }
  },
};

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
