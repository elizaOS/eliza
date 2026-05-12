import * as path from "node:path";
import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  ServiceType,
  type State,
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
  initRPCProviderManager,
  type RPCProviderName,
  validateRPCProviderConfig,
} from "../rpc-providers";
import {
  assertChainConfigured,
  assertDefined,
  EVMError,
  EVMErrorCode,
  PrivateKeySchema,
  type SupportedChain,
} from "../types";

export interface ChainRpcConfig {
  headers?: Record<string, string>;
  providerName?: RPCProviderName;
  rpcUrl: string;
}

function headersWithoutAuthorization(headersInit?: HeadersInit): Headers {
  const headers = new Headers(headersInit);
  headers.delete("authorization");
  headers.delete("Authorization");
  return headers;
}

function isRetryableManagedRpcStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

async function getManagedRpcFallbackReason(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const bodyText = await response.clone().text();
  let hasValidJsonBody = false;

  if (contentType.startsWith("application/json")) {
    try {
      JSON.parse(bodyText);
      hasValidJsonBody = true;
    } catch {
      hasValidJsonBody = false;
    }
  }

  if (response.ok) {
    if (!hasValidJsonBody) {
      return bodyText.trim()
        ? "received a non-JSON or malformed JSON response"
        : "received an empty response body";
    }
    return null;
  }

  if (isRetryableManagedRpcStatus(response.status)) {
    return `received HTTP ${response.status}`;
  }

  if (!hasValidJsonBody) {
    return `received HTTP ${response.status} with a non-JSON or malformed JSON body`;
  }

  return null;
}

export class WalletProvider {
  private readonly cacheKey = "evm/wallet";
  private _chains: Record<string, Chain>;
  private _account: PrivateKeyAccount;
  private readonly _runtime: IAgentRuntime;
  private readonly _rpcConfigs: Record<string, ChainRpcConfig>;

  constructor(
    accountOrPrivateKey: PrivateKeyAccount | `0x${string}`,
    runtime: IAgentRuntime,
    chains?: Record<string, Chain>,
    rpcConfigs: Record<string, ChainRpcConfig> = {}
  ) {
    this._runtime = runtime;
    this._chains = chains ?? {};
    this._account = this.initializeAccount(accountOrPrivateKey);
    this._rpcConfigs = rpcConfigs;
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
    const publicClientFactory = createPublicClient as (parameters: {
      chain: Chain;
      transport: HttpTransport;
    }) => PublicClient<HttpTransport, Chain, Account | undefined>;

    return publicClientFactory({
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
      logger.error(
        `Error getting wallet balance for ${chainName}:`,
        error instanceof Error ? error.message : String(error)
      );
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

    const managedRpc = this._rpcConfigs[chainName];
    if (managedRpc) {
      const fallbackRpcUrl =
        managedRpc.providerName === "elizacloud" ? chain.rpcUrls.default.http[0] : null;

      return http(managedRpc.rpcUrl, {
        fetchFn:
          managedRpc.providerName === "elizacloud" && fallbackRpcUrl
            ? async (input, init) => {
                try {
                  const response = await fetch(input, init);
                  const fallbackReason = await getManagedRpcFallbackReason(response);

                  if (!fallbackReason) {
                    return response;
                  }

                  logger.warn(
                    `[WalletProvider] Eliza Cloud RPC failed for ${chainName}: ${fallbackReason}. Falling back to ${fallbackRpcUrl}.`
                  );

                  return await fetch(fallbackRpcUrl, {
                    ...init,
                    headers: headersWithoutAuthorization(init?.headers),
                  });
                } catch (error) {
                  logger.warn(
                    `[WalletProvider] Eliza Cloud RPC request threw for ${chainName}. Falling back to ${fallbackRpcUrl}.`,
                    error instanceof Error ? error.message : String(error)
                  );

                  return await fetch(fallbackRpcUrl, {
                    ...init,
                    headers: headersWithoutAuthorization(init?.headers),
                  });
                }
              }
            : undefined,
        fetchOptions:
          managedRpc.headers && Object.keys(managedRpc.headers).length > 0
            ? { headers: managedRpc.headers }
            : undefined,
      });
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

function genChainsFromRuntime(runtime: IAgentRuntime): {
  chains: Record<string, Chain>;
  rpcConfigs: Record<string, ChainRpcConfig>;
} {
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
    configuredChains = settings.chains.evm.filter(
      (chain): chain is string => typeof chain === "string"
    );
  }

  const chainsToUse = configuredChains.length > 0 ? configuredChains : [...DEFAULT_CHAINS];

  // Validate RPC provider configuration
  const validation = validateRPCProviderConfig(runtime);
  for (const warning of validation.warnings) {
    logger.warn(warning);
  }
  if (validation.providers.length > 0) {
    logger.info(`EVM RPC providers available: ${validation.providers.join(", ")}`);
  }

  // Initialize the multi-provider RPC manager
  const rpcManager = initRPCProviderManager(runtime);

  const chains: Record<string, Chain> = {};
  const rpcConfigs: Record<string, ChainRpcConfig> = {};

  for (const chainName of chainsToUse) {
    if (!(chainName in viemChains)) {
      logger.warn(`Chain ${chainName} not found in viem chains, skipping`);
      continue;
    }

    // Resolve RPC URL through the provider manager (handles per-chain overrides,
    // provider priority, and fallbacks automatically)
    const resolved = rpcManager.resolveForChain(chainName);
    const rpcUrl = resolved?.rpcUrl ?? null;

    const chain = WalletProvider.genChainFromName(chainName, rpcUrl);
    chains[chainName] = chain;

    if (resolved) {
      rpcConfigs[chainName] = {
        providerName: resolved.providerName,
        rpcUrl: resolved.rpcUrl,
        headers: resolved.headers,
      };
      logger.log(`Configured chain: ${chainName} (via ${resolved.providerName})`);
    } else {
      logger.log(`Configured chain: ${chainName} (using viem default RPC)`);
    }
  }

  return { chains, rpcConfigs };
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
    logger.warn(
      "Could not persist EVM private key to database - key is only in memory",
      error instanceof Error ? error.message : String(error)
    );
  }

  return newPrivateKey;
}

export async function initWalletProvider(runtime: IAgentRuntime): Promise<WalletProvider> {
  const teeModeRaw = runtime.getSetting("TEE_MODE");
  const teeMode = typeof teeModeRaw === "string" ? teeModeRaw : "OFF";
  const { chains, rpcConfigs } = genChainsFromRuntime(runtime);

  if (teeMode !== "OFF") {
    const walletSecretSaltRaw = runtime.getSetting("WALLET_SECRET_SALT");
    if (!walletSecretSaltRaw || typeof walletSecretSaltRaw !== "string") {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        "WALLET_SECRET_SALT required when TEE_MODE is enabled"
      );
    }

    return new LazyTeeWalletProvider(runtime, walletSecretSaltRaw, chains, rpcConfigs);
  }

  const privateKeyRaw = runtime.getSetting("EVM_PRIVATE_KEY");
  let privateKey: string;
  if (!privateKeyRaw || typeof privateKeyRaw !== "string") {
    privateKey = await generateAndStorePrivateKey(runtime);
  } else {
    privateKey = privateKeyRaw;
  }

  const validatedKey = PrivateKeySchema.parse(privateKey);
  return new WalletProvider(validatedKey, runtime, chains, rpcConfigs);
}

class LazyTeeWalletProvider extends WalletProvider {
  private teeWallet: WalletProvider | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly walletSecretSalt: string;
  private readonly teeRpcConfigs: Record<string, ChainRpcConfig>;
  private readonly teeRuntime: IAgentRuntime;
  private readonly teeChains: Record<string, Chain>;

  constructor(
    runtime: IAgentRuntime,
    walletSecretSalt: string,
    chains: Record<string, Chain>,
    rpcConfigs: Record<string, ChainRpcConfig>
  ) {
    const dummyKey = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
    super(dummyKey, runtime, chains, rpcConfigs);
    this.walletSecretSalt = walletSecretSalt;
    this.teeRuntime = runtime;
    this.teeChains = chains;
    this.teeRpcConfigs = rpcConfigs;
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

    this.teeWallet = new WalletProvider(
      keypair,
      this.teeRuntime,
      this.teeChains,
      this.teeRpcConfigs
    );
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
const MAX_EVM_CHAIN_BALANCES = 20;

export const evmWalletProvider: Provider = {
  name: spec.name,
  description: "EVM wallet address and balances",
  descriptionCompressed: "EVM wallet address and balances.",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  dynamic: true,
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
      const chains = walletData.chains.slice(0, MAX_EVM_CHAIN_BALANCES);
      const balanceText = chains
        .map((chain) => `${chain.name}: ${chain.balance} ${chain.symbol}`)
        .join("\n");
      const truncationText =
        walletData.chains.length > chains.length
          ? `\n... and ${walletData.chains.length - chains.length} more chains`
          : "";

      return {
        text: `${agentName}'s EVM Wallet Address: ${walletData.address}\n\nBalances:\n${balanceText}${truncationText}`,
        data: {
          address: walletData.address,
          chains,
          chainCount: walletData.chains.length,
          displayedChainCount: chains.length,
        },
        values: {
          address: walletData.address,
          chains: `${balanceText}${truncationText}`,
        },
      };
    } catch (error) {
      logger.error(
        "Error in EVM wallet provider:",
        error instanceof Error ? error.message : String(error)
      );
      return {
        text: `EVM wallet data unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        data: {},
        values: {
          walletReady: false,
          walletError: error instanceof Error ? error.name : "EVMWalletProviderError",
        },
      };
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

  const allChainDetails = Object.entries(balances).map(([chainName, balance]) => {
    const chain = walletProvider.getChainConfigs(chainName as SupportedChain);
    return {
      chainName,
      balance,
      symbol: chain.nativeCurrency.symbol,
      chainId: chain.id,
      name: chain.name,
    };
  });
  const chainDetails = allChainDetails.slice(0, MAX_EVM_CHAIN_BALANCES);

  const balanceText = chainDetails
    .map((chain) => `${chain.name}: ${chain.balance} ${chain.symbol}`)
    .join("\n");
  const truncationText =
    allChainDetails.length > chainDetails.length
      ? `\n... and ${allChainDetails.length - chainDetails.length} more chains`
      : "";

  return {
    text: `${agentName}'s EVM Wallet Address: ${address}\n\nBalances:\n${balanceText}${truncationText}`,
    data: {
      address,
      chains: chainDetails,
      chainCount: allChainDetails.length,
      displayedChainCount: chainDetails.length,
    },
    values: {
      address: address as string,
      chains: `${balanceText}${truncationText}`,
    },
  };
}
