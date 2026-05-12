import {
  type IAgentRuntime,
  type ILpService,
  type LpPositionDetails,
  logger,
  type PoolInfo,
  Service,
  type TokenBalance,
  type TransactionResult,
} from "@elizaos/core";
import type { Address } from "viem";
import type {
  AddLiquidityConfig,
  EvmAddLiquidityParams,
  EvmPoolInfo,
  EvmRemoveLiquidityParams,
  IEvmLpService,
  RemoveLiquidityConfig,
} from "../types.ts";

export const LP_MANAGEMENT_SERVICE_TYPE = "lp-management";

export type LpProtocolChain = "solana" | "evm";

export interface LpProtocolRequest {
  chain?: LpProtocolChain | string;
  dex?: string;
  chainId?: number;
}

export interface LpListPoolsParams extends LpProtocolRequest {
  tokenA?: string;
  tokenB?: string;
  feeTier?: number;
}

export interface LpPositionOperationParams extends LpProtocolRequest {
  userVault?: object;
  wallet?: { address: Address; privateKey: `0x${string}` };
  owner?: string;
  pool?: string | PoolInfo | EvmPoolInfo;
  position?: string;
  tokenId?: string | bigint;
  amount?:
    | string
    | number
    | bigint
    | {
        value?: string | number | bigint;
        tokenA?: string | number | bigint;
        tokenB?: string | number | bigint;
        lpToken?: string | number | bigint;
        percentage?: number;
      };
  amounts?: {
    tokenA?: string | number | bigint;
    tokenB?: string | number | bigint;
    lpToken?: string | number | bigint;
  };
  range?: {
    tickLower?: number;
    tickUpper?: number;
    tickLowerIndex?: number;
    tickUpperIndex?: number;
    priceLower?: number;
    priceUpper?: number;
  };
  slippageBps?: number;
  deadline?: bigint;
}

export interface LpProtocolProvider {
  id: string;
  chain: LpProtocolChain;
  dex: string;
  label?: string;
  service?: unknown;
  supportedChainIds?: number[];
  supportsRequest?: (request: LpProtocolRequest) => boolean;
  listPools(params: LpListPoolsParams): Promise<PoolInfo[]>;
  openPosition(params: LpPositionOperationParams): Promise<TransactionResult>;
  closePosition(params: LpPositionOperationParams): Promise<TransactionResult>;
  repositionPosition?(
    params: LpPositionOperationParams,
  ): Promise<TransactionResult>;
  getPosition?(
    params: LpPositionOperationParams,
  ): Promise<LpPositionDetails | null>;
  listPositions?(
    params: LpPositionOperationParams,
  ): Promise<LpPositionDetails[]>;
  getMarketData?(poolIds: string[]): Promise<Record<string, Partial<PoolInfo>>>;
}

type SolanaLpServiceAdapter = Partial<ILpService> & {
  repositionPosition?(
    params: LpPositionOperationParams,
  ): Promise<TransactionResult>;
};

export class NoMatchingLpProtocolError extends Error {
  public readonly code = "NO_MATCHING_LP_PROTOCOL";

  constructor(request: LpProtocolRequest) {
    const details = [
      request.chain ? `chain=${request.chain}` : undefined,
      request.dex ? `dex=${request.dex}` : undefined,
      request.chainId ? `chainId=${request.chainId}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    super(`No registered LP protocol matches ${details || "the request"}`);
    this.name = "NoMatchingLpProtocolError";
  }
}

function normalizeDex(dex?: string): string | undefined {
  return dex?.trim().toLowerCase();
}

function normalizeRequiredDex(dex: string): string {
  return dex.trim().toLowerCase();
}

function normalizeChain(chain?: string): string | undefined {
  return chain?.trim().toLowerCase();
}

function protocolKey(chain: string, dex: string): string {
  return `${normalizeChain(chain)}:${normalizeDex(dex)}`;
}

function poolId(pool?: string | PoolInfo | EvmPoolInfo): string | undefined {
  if (!pool) return undefined;
  if (typeof pool === "string") return pool;
  return (
    (pool as EvmPoolInfo).poolAddress ||
    (pool as PoolInfo).id ||
    (pool as { address?: string }).address
  );
}

function amountValue(
  params: LpPositionOperationParams,
  key: "tokenA" | "tokenB" | "lpToken" | "value",
  fallback: string,
): string {
  const amount = params.amount;
  if (
    key === "value" &&
    ["string", "number", "bigint"].includes(typeof amount)
  ) {
    return String(amount);
  }
  if (amount && typeof amount === "object" && key in amount) {
    const value = amount[key];
    if (value !== undefined && value !== null) return String(value);
  }
  const nested = params.amounts?.[key as keyof typeof params.amounts];
  if (nested !== undefined && nested !== null) return String(nested);
  return fallback;
}

function optionalAmountValue(
  params: LpPositionOperationParams,
  key: "tokenA" | "tokenB" | "lpToken" | "value",
  fallback?: string,
): string | undefined {
  const amount = params.amount;
  if (
    key === "value" &&
    ["string", "number", "bigint"].includes(typeof amount)
  ) {
    return String(amount);
  }
  if (amount && typeof amount === "object" && key in amount) {
    const value = amount[key];
    if (value !== undefined && value !== null) return String(value);
  }
  const nested = params.amounts?.[key as keyof typeof params.amounts];
  if (nested !== undefined && nested !== null) return String(nested);
  return fallback;
}

function bigintAmount(value: unknown, fallback = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim()) {
    return BigInt(value.trim());
  }
  return fallback;
}

function optionalBigintAmount(value: unknown): bigint | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return bigintAmount(value);
}

function unsupported(
  protocol: LpProtocolProvider,
  operation: string,
): TransactionResult {
  return {
    success: false,
    error: `${operation} is not implemented for ${protocol.dex} on ${protocol.chain}`,
  };
}

export class LpManagementService extends Service implements ILpService {
  public static override readonly serviceType = LP_MANAGEMENT_SERVICE_TYPE;
  public readonly capabilityDescription =
    "Provides standardized access to DEX liquidity pools.";

  private protocols = new Map<string, LpProtocolProvider>();

  static async start(runtime: IAgentRuntime): Promise<LpManagementService> {
    const service = new LpManagementService(runtime);
    logger.info("[LpManagementService] started");
    return service;
  }

  async stop(): Promise<void> {
    this.protocols.clear();
    logger.info("[LpManagementService] stopped");
  }

  getDexName(): string {
    return "lp-management";
  }

  registerProtocol(provider: LpProtocolProvider): void {
    const key = protocolKey(provider.chain, provider.dex);
    const normalizedProvider: LpProtocolProvider = {
      ...provider,
      id: provider.id || key,
      chain: normalizeChain(provider.chain) as LpProtocolChain,
      dex: normalizeRequiredDex(provider.dex),
    };
    if (this.protocols.has(key)) {
      logger.warn(
        `[LpManagementService] Replacing LP protocol provider ${key}`,
      );
    }
    this.protocols.set(key, normalizedProvider);
  }

  unregisterProtocol(request: LpProtocolRequest): boolean {
    if (!request.chain || !request.dex) return false;
    return this.protocols.delete(protocolKey(request.chain, request.dex));
  }

  listProtocols(request: LpProtocolRequest = {}): LpProtocolProvider[] {
    return this.matchingProtocols(request);
  }

  async listPools(params: LpListPoolsParams = {}): Promise<PoolInfo[]> {
    const requireMatch = Boolean(params.chain || params.dex || params.chainId);
    const protocols = this.matchingProtocols(params);
    if (protocols.length === 0) {
      if (requireMatch) throw new NoMatchingLpProtocolError(params);
      return [];
    }

    const poolLists = await Promise.all(
      protocols.map(async (protocol) => {
        try {
          return await protocol.listPools(params);
        } catch (error) {
          logger.warn(
            `[LpManagementService] Failed to list pools for ${protocol.chain}:${protocol.dex}`,
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      }),
    );

    return poolLists.flat();
  }

  async openPosition(
    params: LpPositionOperationParams,
  ): Promise<TransactionResult> {
    const protocol = this.resolveProtocol(params);
    return protocol.openPosition(params);
  }

  async closePosition(
    params: LpPositionOperationParams,
  ): Promise<TransactionResult> {
    const protocol = this.resolveProtocol(params);
    return protocol.closePosition(params);
  }

  async repositionPosition(
    params: LpPositionOperationParams,
  ): Promise<TransactionResult> {
    const protocol = this.resolveProtocol(params);
    if (!protocol.repositionPosition) {
      return unsupported(protocol, "reposition");
    }
    return protocol.repositionPosition(params);
  }

  async getPosition(
    params: LpPositionOperationParams,
  ): Promise<LpPositionDetails | null> {
    const protocol = this.resolveProtocol(params);
    return protocol.getPosition?.(params) ?? null;
  }

  async listPositions(
    params: LpPositionOperationParams = {},
  ): Promise<LpPositionDetails[]> {
    const protocols = this.matchingProtocols(params);
    const positionLists = await Promise.all(
      protocols.map((protocol) => protocol.listPositions?.(params) ?? []),
    );
    return positionLists.flat();
  }

  async getPools(
    tokenAMint?: string,
    tokenBMint?: string,
  ): Promise<PoolInfo[]> {
    return this.listPools({ tokenA: tokenAMint, tokenB: tokenBMint });
  }

  async addLiquidity(
    params: AddLiquidityConfig & { chain?: string },
  ): Promise<TransactionResult & { lpTokensReceived?: TokenBalance }> {
    return this.openPosition({
      chain: params.chain || "solana",
      dex: params.dexName,
      userVault: params.userVault,
      pool: params.poolId,
      amount: {
        tokenA: params.tokenAAmountLamports,
        tokenB: params.tokenBAmountLamports,
      },
      range: {
        tickLowerIndex: params.tickLowerIndex,
        tickUpperIndex: params.tickUpperIndex,
      },
      slippageBps: params.slippageBps,
    });
  }

  async removeLiquidity(
    params: RemoveLiquidityConfig & { chain?: string },
  ): Promise<TransactionResult & { tokensReceived?: TokenBalance[] }> {
    return this.closePosition({
      chain: params.chain || "solana",
      dex: params.dexName,
      userVault: params.userVault,
      pool: params.poolId,
      amount: { lpToken: params.lpTokenAmountLamports },
      slippageBps: params.slippageBps,
    });
  }

  async getLpPositionDetails(
    userAccountPublicKey: string,
    poolOrPositionIdentifier: string,
  ): Promise<LpPositionDetails | null> {
    for (const protocol of this.protocols.values()) {
      if (!protocol.getPosition) continue;
      const position = await protocol.getPosition({
        owner: userAccountPublicKey,
        pool: poolOrPositionIdentifier,
        position: poolOrPositionIdentifier,
      });
      if (position) return position;
    }
    return null;
  }

  async getMarketDataForPools(
    poolIds: string[],
  ): Promise<Record<string, Partial<PoolInfo>>> {
    const marketData = await Promise.all(
      Array.from(this.protocols.values()).map(
        (protocol) => protocol.getMarketData?.(poolIds) ?? {},
      ),
    );
    return Object.assign({}, ...marketData);
  }

  private matchingProtocols(request: LpProtocolRequest): LpProtocolProvider[] {
    const requestedChain = normalizeChain(request.chain);
    const requestedDex = normalizeDex(request.dex);
    return Array.from(this.protocols.values()).filter((protocol) => {
      if (requestedChain && protocol.chain !== requestedChain) return false;
      if (requestedDex && protocol.dex !== requestedDex) return false;
      if (
        request.chainId !== undefined &&
        protocol.supportedChainIds?.length &&
        !protocol.supportedChainIds.includes(request.chainId)
      ) {
        return false;
      }
      return protocol.supportsRequest?.(request) ?? true;
    });
  }

  private resolveProtocol(request: LpProtocolRequest): LpProtocolProvider {
    const matches = this.matchingProtocols(request);
    if (matches.length === 0) {
      throw new NoMatchingLpProtocolError(request);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple LP protocols match this request (${matches
          .map((protocol) => `${protocol.chain}:${protocol.dex}`)
          .join(", ")}). Specify chain and dex.`,
      );
    }
    return matches[0];
  }
}

export async function getLpManagementService(
  runtime: IAgentRuntime,
): Promise<LpManagementService | null> {
  const existing = runtime.getService<LpManagementService>(
    LP_MANAGEMENT_SERVICE_TYPE,
  );
  if (existing) return existing;

  if (typeof runtime.getServiceLoadPromise === "function") {
    const loaded = await runtime.getServiceLoadPromise(
      LP_MANAGEMENT_SERVICE_TYPE,
    );
    return (loaded as LpManagementService) ?? null;
  }

  return null;
}

export async function registerLpProtocolProvider(
  runtime: IAgentRuntime,
  provider: LpProtocolProvider,
): Promise<void> {
  const registry = await getLpManagementService(runtime);
  if (!registry) {
    logger.warn(
      `[LpManagementService] Cannot register ${provider.chain}:${provider.dex}; registry service is unavailable`,
    );
    return;
  }
  registry.registerProtocol(provider);
}

export function createSolanaLpProtocolProvider({
  dex,
  label,
  service,
}: {
  dex: string;
  label?: string;
  service: SolanaLpServiceAdapter;
}): LpProtocolProvider {
  const normalizedDex = normalizeRequiredDex(dex);
  const provider: LpProtocolProvider = {
    id: `solana:${normalizedDex}`,
    chain: "solana",
    dex: normalizedDex,
    label,
    service,
    supportsRequest: (request) =>
      (!request.chain || normalizeChain(request.chain) === "solana") &&
      (!request.dex || normalizeDex(request.dex) === normalizedDex),
    listPools: async (params) => {
      if (typeof service.getPools !== "function") return [];
      return service.getPools(params.tokenA, params.tokenB);
    },
    openPosition: async (params) => {
      if (typeof service.addLiquidity !== "function") {
        return unsupported(provider, "open");
      }
      if (!params.userVault) {
        return { success: false, error: "User vault is required" };
      }
      const id = poolId(params.pool);
      if (!id) return { success: false, error: "Pool is required" };
      return service.addLiquidity({
        userVault: params.userVault,
        poolId: id,
        tokenAAmountLamports: amountValue(
          params,
          "tokenA",
          amountValue(params, "value", "0"),
        ),
        tokenBAmountLamports: optionalAmountValue(params, "tokenB"),
        slippageBps: params.slippageBps ?? 50,
        tickLowerIndex: params.range?.tickLowerIndex ?? params.range?.tickLower,
        tickUpperIndex: params.range?.tickUpperIndex ?? params.range?.tickUpper,
      });
    },
    closePosition: async (params) => {
      if (typeof service.removeLiquidity !== "function") {
        return unsupported(provider, "close");
      }
      if (!params.userVault) {
        return { success: false, error: "User vault is required" };
      }
      const id = poolId(params.pool) || params.position;
      if (!id) return { success: false, error: "Pool or position is required" };
      return service.removeLiquidity({
        userVault: params.userVault,
        poolId: id,
        lpTokenAmountLamports: amountValue(
          params,
          "lpToken",
          amountValue(params, "value", "0"),
        ),
        slippageBps: params.slippageBps ?? 50,
      });
    },
    getPosition: async (params) => {
      if (typeof service.getLpPositionDetails !== "function") return null;
      const identifier = params.position || poolId(params.pool);
      if (!params.owner || !identifier) return null;
      return service.getLpPositionDetails(params.owner, identifier);
    },
    getMarketData: async (poolIds) => {
      if (typeof service.getMarketDataForPools !== "function") return {};
      return service.getMarketDataForPools(poolIds);
    },
  };

  const repositionPosition = service.repositionPosition;
  if (typeof repositionPosition === "function") {
    provider.repositionPosition = (params) => repositionPosition(params);
  }

  return provider;
}

export function createEvmLpProtocolProvider({
  dex,
  label,
  service,
}: {
  dex: string;
  label?: string;
  service: IEvmLpService;
}): LpProtocolProvider {
  const supportedChainIds =
    typeof service.getSupportedChainIds === "function"
      ? service.getSupportedChainIds()
      : [];
  const normalizedDex = normalizeRequiredDex(dex);
  const provider: LpProtocolProvider = {
    id: `evm:${normalizedDex}`,
    chain: "evm",
    dex: normalizedDex,
    label,
    service,
    supportedChainIds,
    supportsRequest: (request) => {
      if (request.chain && normalizeChain(request.chain) !== "evm") {
        return false;
      }
      if (request.dex && normalizeDex(request.dex) !== normalizedDex) {
        return false;
      }
      if (request.chainId !== undefined && supportedChainIds.length > 0) {
        return supportedChainIds.includes(request.chainId);
      }
      return true;
    },
    listPools: async (params) => {
      const chainIds = params.chainId ? [params.chainId] : supportedChainIds;
      const pools = await Promise.all(
        chainIds.map((chainId) =>
          service.getPools(
            chainId,
            params.tokenA as Address | undefined,
            params.tokenB as Address | undefined,
            params.feeTier,
          ),
        ),
      );
      return pools.flat();
    },
    openPosition: async (params) => {
      if (!params.wallet)
        return { success: false, error: "EVM wallet is required" };
      if (!params.chainId)
        return { success: false, error: "EVM chainId is required" };
      const id = poolId(params.pool);
      if (!id) return { success: false, error: "Pool address is required" };
      const evmParams: EvmAddLiquidityParams = {
        wallet: params.wallet,
        chainId: params.chainId,
        poolAddress: id as Address,
        tokenAAmount: bigintAmount(
          amountValue(params, "tokenA", amountValue(params, "value", "0")),
        ),
        tokenBAmount: optionalBigintAmount(
          optionalAmountValue(params, "tokenB"),
        ),
        slippageBps: params.slippageBps ?? 50,
        tickLower: params.range?.tickLower ?? params.range?.tickLowerIndex,
        tickUpper: params.range?.tickUpper ?? params.range?.tickUpperIndex,
        deadline: params.deadline,
      };
      return service.addLiquidity(evmParams);
    },
    closePosition: async (params) => {
      if (!params.wallet)
        return { success: false, error: "EVM wallet is required" };
      if (!params.chainId)
        return { success: false, error: "EVM chainId is required" };
      const id = poolId(params.pool);
      if (!id) return { success: false, error: "Pool address is required" };
      const evmParams: EvmRemoveLiquidityParams = {
        wallet: params.wallet,
        chainId: params.chainId,
        poolAddress: id as Address,
        tokenId:
          params.tokenId !== undefined
            ? bigintAmount(params.tokenId)
            : params.position
              ? bigintAmount(params.position)
              : undefined,
        lpTokenAmount: optionalBigintAmount(
          optionalAmountValue(
            params,
            "lpToken",
            optionalAmountValue(params, "value"),
          ),
        ),
        percentageToRemove:
          typeof params.amount === "object"
            ? params.amount?.percentage
            : undefined,
        slippageBps: params.slippageBps ?? 50,
        deadline: params.deadline,
      };
      return service.removeLiquidity(evmParams);
    },
    getPosition: async (params) => {
      if (!params.owner || !params.chainId) return null;
      const id = poolId(params.pool);
      if (!id) return null;
      return service.getPositionDetails(
        params.chainId,
        params.owner as Address,
        id as Address,
        params.tokenId !== undefined
          ? bigintAmount(params.tokenId)
          : params.position
            ? bigintAmount(params.position)
            : undefined,
      );
    },
    listPositions: async (params) => {
      if (!params.owner || !params.chainId) return [];
      return service.getAllPositions(params.chainId, params.owner as Address);
    },
    getMarketData: async (poolIds) => {
      if (typeof service.getMarketData !== "function") return {};
      return service.getMarketData(poolIds as Address[]);
    },
  };

  return provider;
}
