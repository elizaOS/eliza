import assert from "node:assert";
import EventEmitter from "node:events";
import {
  encodeFunctionData,
  formatUnits,
  isHex,
  parseUnits,
  sha256,
  toHex,
} from "viem";
import {
  Content,
  Entity,
  type IAgentRuntime,
  logger,
  Service,
  ServiceType,
} from "@elizaos/core";
import { BrowserService } from "../browser";
import { LEVVA_SERVICE } from "../../constants/enum";
import { getActiveMarkets, PendleActiveMarkets } from "../../api/market/pendle";
import { CacheEntry } from "../../types/core";
import { ILevvaService } from "../../types/service";
import { CalldataWithDescription } from "../../types/tx";
import {
  extractTokenData,
  getAllowance,
  getBalanceOf,
  getChain,
  getClient,
  getTokenData,
  getToken as getTokenImpl,
  parseTokenInfo,
  TokenEntry,
  upsertToken,
} from "../../util";
import { delay, isRejected, isResolved, Mutex } from "../../util/async";
import { TokenData, TokenDataWithInfo } from "../../types/token";
import { ETH_NULL_ADDR } from "../../constants/eth";
import {
  getFeed,
  getFeedItemId,
  getLatestNews,
  isFeedItem,
  onFeedItem,
} from "./news";
import {
  LevvaPoolInterface,
  PoolConstants,
  Strategy,
  StrategyEntry,
  StrategyMapping,
  StrategyType,
  VaultConstants,
  getPoolConstants,
  getPoolVariables as getPoolVariablesImpl,
  getVaultConstants,
  strategyVaultMapping,
} from "./pool";
import {
  PendleInterface,
  getPendleParams as getPendleParamsImpl,
} from "./pendle";
import {
  BalanceEntry,
  getBalance,
  upsertBalance,
  WalletInterface,
} from "./wallet";
import { wrapEth } from "src/util/eth/weth";
import { getPendleSwap } from "src/api/swap/pendle";
import { bundlerEnter } from "./tx";
import poolAbi from "./abi/pool.abi";
import vaultAbi from "./abi/vault.abi";
import { getMessages } from "./messages";
import { getStrategies as getStrategiesApi } from "../../api/levva";
import { checkSecret } from "./secrets";

const REQUIRED_PLUGINS = ["levva"];

function checkPlugins(runtime: IAgentRuntime) {
  const set = new Set(runtime.plugins.map((plugin) => plugin.name));
  return REQUIRED_PLUGINS.every((plugin) => set.has(plugin));
}

async function series<T>(promises: Promise<T>[]) {}

// todo config
const MAX_WAIT_TIME = 15000; // time after which put promise in background

export class LevvaService
  extends Service
  implements ILevvaService, LevvaPoolInterface, PendleInterface, WalletInterface
{
  static serviceType = LEVVA_SERVICE.LEVVA_COMMON;
  capabilityDescription =
    "Levva service should analyze the user's portfolio, suggest earning strategies, swap crypto assets, etc.";

  private events = new EventEmitter();
  private background: { id?: string; promise: Promise<unknown> }[] = [];

  private handlerInterval: NodeJS.Timeout | null = null;

  private bgHandler = async () => {
    const unresolved: { id?: string; promise: Promise<unknown> }[] = [];

    for (const { id, promise } of this.background) {
      if (await isResolved(promise)) {
        if (id) {
          this.events.emit("background:resolved", { id, value: await promise });
        }
      } else if (await isRejected(promise)) {
        try {
          await promise;
        } catch (error) {
          logger.error(`Background promise rejected: ${id}`, error);
        }
      } else {
        unresolved.push({ id, promise });
      }
    }

    this.background = unresolved;
  };

  private inBackground = async <T>(
    fn: () => Promise<T>,
    id?: string,
    waitTime = MAX_WAIT_TIME
  ): Promise<T | undefined> => {
    const promise = fn();
    this.background.push({ id, promise });
    return Promise.race([promise, delay(waitTime, undefined)]);
  };

  private permanentCache = <P extends unknown[], V>(
    getData: (...params: P) => Promise<V>,
    getKey: (...params: P) => string
  ) => {
    return async (...params: P) => {
      const cacheKey = getKey(...params);
      const cached = await this.runtime.getCache<V>(cacheKey);

      if (cached) {
        return cached;
      }

      const result = await getData(...params);
      await this.runtime.setCache(cacheKey, result);
      return result;
    };
  };

  private timedCache = <P extends unknown[], V>(
    ttl: number,
    getData: (...params: P) => Promise<V>,
    getKey: (...params: P) => string
  ) => {
    return async (...params: P) => {
      const cacheKey = getKey(...params);
      const cached = await this.runtime.getCache<CacheEntry<V>>(cacheKey);
      const now = Date.now();

      if (cached?.timestamp && now - cached.timestamp < ttl) {
        return cached.value;
      }

      const result = await getData(...params);
      await this.runtime.setCache(cacheKey, { timestamp: now, value: result });
      return result;
    };
  };

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    assert(checkPlugins(runtime), "Required plugins not found");
    this.handlerInterval = setInterval(this.bgHandler, 500);

    this.events.on("background:resolved", (event) => {
      if (isFeedItem(event.id)) {
        // fixme handler invocations should have same call signature
        onFeedItem(this.runtime, event.id, event.value);
      } else if (this.isBalanceId(event.id)) {
        this.onUpdateBalance(event.id, event.value);
      } else {
        logger.warn(`Unknown event: ${event.id}`, JSON.stringify(event.value));
      }
    });
  }

  static async start(runtime: IAgentRuntime) {
    logger.info("*** Starting Levva service ***");
    const service = new LevvaService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    logger.info("*** Stopping Levva service ***");
    // get the service from the runtime
    const service = runtime.getService(LevvaService.serviceType);

    if (!service) {
      throw new Error("Levva service not found");
    }

    service.stop();
  }

  async stop() {
    logger.info("*** Stopping levva service instance ***");

    if (this.handlerInterval) {
      clearInterval(this.handlerInterval);
      this.handlerInterval = null;
    }
  }

  // do we need it? or better to use runtime.getMemoryById?
  getMessages = getMessages.bind(null, this.runtime);
  checkSecret = checkSecret.bind(null, this.runtime);

  /** @deprecated fix typing, maybe consider making private */
  getToken = getTokenImpl.bind(null, this.runtime) as (
    params: Parameters<typeof getTokenImpl>[1]
  ) => ReturnType<typeof getTokenImpl>;

  getTokenDataWithInfo = async ({
    chainId,
    symbolOrAddress,
  }: {
    chainId: number;
    symbolOrAddress?: string;
  }) => {
    const chain = getChain(chainId);
    let tokenData: TokenDataWithInfo | undefined;

    if (!isHex(symbolOrAddress)) {
      const symbol = symbolOrAddress;

      if (symbol?.toLowerCase() === chain.nativeCurrency.symbol.toLowerCase()) {
        logger.info("Using native currency as token value");
        tokenData = extractTokenData(chain.nativeCurrency);
      } else {
        const token = (await this.getToken({ chainId: chain.id, symbol }))[0];

        if (!token) {
          return;
        }

        tokenData = extractTokenData(token);
        /* @ts-expect-error fix typing */
        tokenData.info = parseTokenInfo(token.info);
      }
    } else {
      tokenData = await getTokenData(chain.id, symbolOrAddress);
      logger.info(`Saving ${symbolOrAddress} as ${tokenData.symbol}`);

      // todo now we can get market from adapter contract for base token, can be used
      await upsertToken(this.runtime, {
        ...(tokenData as Required<TokenData>),
        chainId: chain.id,
      });
    }

    return tokenData;
  };

  getWETH = async (chainId: number) => {
    const [weth] = await this.getToken({ chainId, symbol: "WETH" });

    if (!weth) {
      throw new Error(`WETH not found for chain ${chainId}`);
    }

    return weth;
  };

  private tokenMap = new Map<
    `${number}:0x${string}`,
    Omit<TokenEntry, "id"> | undefined
  >();

  private populateTokenMap = async (entries: Omit<TokenEntry, "id">[]) => {
    for (const entry of entries) {
      const key =
        `${entry.chainId}:${entry.address}` as `${number}:0x${string}`;

      if (!this.tokenMap.has(key)) {
        this.tokenMap.set(key, entry);
      }
    }
  };

  private getTokenFromMap = (params: {
    chainId: number;
    address: `0x${string}`;
  }) => {
    const key =
      `${params.chainId}:${params.address}` as `${number}:0x${string}`;

    return this.tokenMap.get(key);
  };

  async getAvailableTokens(params: { chainId: number }) {
    const chain = getChain(params.chainId);

    const tokens: /* fixme type */ Omit<TokenEntry, "id">[] =
      await this.getToken({
        chainId: params.chainId,
      });

    tokens.push({
      symbol: chain.nativeCurrency.symbol,
      name: chain.nativeCurrency.name,
      decimals: chain.nativeCurrency.decimals,
      address: ETH_NULL_ADDR,
      info: undefined,
      chainId: params.chainId,
    });

    this.populateTokenMap(tokens);
    return tokens;
  }

  formatToken(token: {
    symbol: string;
    name: string;
    address?: string;
    decimals: number;
    info?: unknown;
  }) {
    const isNative = !token.address || token.address === ETH_NULL_ADDR;
    return `${token.symbol}(${token.name}) - ${isNative ? "Native token" : `${token.address}`}. Decimals: ${token.decimals}.`;
  }

  // -- Wallet assets --
  private BALANCE_PREFIX = "balance:";

  private isBalanceId = (id: string) => {
    return id.startsWith(this.BALANCE_PREFIX);
  };

  private createBalanceId = (params: {
    address: `0x${string}`;
    chainId: number;
    token: `0x${string}` | undefined;
  }) => {
    return `${this.BALANCE_PREFIX}${params.address}:${params.chainId}:${params.token ?? "native"}`;
  };

  private onUpdateBalance = async (
    id: string,
    data: {
      amount: bigint;
      address: `0x${string}`;
      token: `0x${string}`;
      chainId: number;
      value: bigint;
    }
  ) => {
    await upsertBalance(this.runtime, data);
  };

  private getBalanceOf = (
    address: `0x${string}`,
    chainId: number,
    token: `0x${string}`
  ) => {
    // todo maybe always use 0x00..00 address for native token?
    const id = this.createBalanceId({
      address,
      chainId,
      token,
    });

    return this.inBackground(async () => {
      const amount = await getBalanceOf(chainId, address, token);

      // todo add prices
      const value = BigInt(0);

      return {
        amount,
        address,
        token,
        chainId,
        value,
      };
    }, id);
  };

  // fixme update balances in db in another method
  async getWalletAssets(params: { address: `0x${string}`; chainId: number }) {
    const ttl = 900000; // update balance if older than 15 minutes
    const now = new Date();

    const [balances, tokens] = await Promise.all([
      getBalance(this.runtime, {
        address: params.address,
        chainId: params.chainId,
        ttl,
      }),
      this.getAvailableTokens({ chainId: params.chainId }),
    ]);

    const withBalance = new Set<string>(balances.map(({ token }) => token));

    const outdated = await Promise.all(
      tokens
        .filter(({ address }) => !withBalance.has(address ?? ETH_NULL_ADDR))
        .map(({ address }) => {
          // fixme no type casting
          const token = (address ?? ETH_NULL_ADDR) as `0x${string}`;
          return this.getBalanceOf(params.address, params.chainId, token);
        })
    );

    const result = outdated.reduce<Omit<BalanceEntry, "id">[]>((acc, data) => {
      if (typeof data?.amount !== "bigint") {
        return acc;
      }

      const entry: Omit<BalanceEntry, "id"> = {
        ...data,
        type: data.token && data.token !== ETH_NULL_ADDR ? "erc20" : "native",
        updatedAt: now,
      };

      return [...acc, entry];
    }, balances);

    return result;
  }

  formatWalletAssets(
    _assets: Omit<BalanceEntry, "id">[],
    hideZero?: boolean
  ): string {
    const assets = hideZero ? _assets.filter((a) => a.amount > 0) : _assets;

    return assets
      .map((asset) => {
        const isNative = !asset.token || asset.token === ETH_NULL_ADDR;

        const token = this.getTokenFromMap({
          chainId: asset.chainId,
          address: (asset.token ?? ETH_NULL_ADDR) as `0x${string}`,
        });

        const decimals = token?.decimals ?? 18;
        const symbol = token?.symbol ?? "ETH";

        // fixme add prices
        return `${symbol} - ${isNative ? "Native token" : asset.token}. Balance: ${formatUnits(asset.amount, decimals)}.`;
      })
      .join("\n");
  }

  // -- End of Wallet Assets --
  // -- Crypto news --

  // todo config
  private RSS_FEEDS = ["https://cryptopanic.com/news/rss/"];

  private mutex = new Mutex();
  private fetchFeed = async (url: string) => {
    const browser = await this.runtime.getService<BrowserService>(
      ServiceType.BROWSER
    );

    if (!browser) {
      throw new Error("Browser service not found");
    }

    try {
      logger.info(`Fetching feed: ${url}`);
      const items = await getFeed(this.runtime, url);

      await Promise.all(
        items.map((item, i) => {
          const id = getFeedItemId(item.link);

          return this.inBackground(
            async () =>
              // todo put mutex in browser
              this.mutex.runExclusive(() =>
                browser.getPageContent(item.link, this.runtime, 1000)
              ),
            id
          );
        })
      );
    } catch (error) {
      logger.error("Failed to fetch feed", error);
    }
  };

  async getCryptoNews(limit?: number) {
    await Promise.allSettled(this.RSS_FEEDS.map(this.fetchFeed));
    return getLatestNews(this.runtime, limit);
  }
  // -- End of Crypto news --
  private getPendleMarketsCacheKey = (
    chainId: number,
    {
      baseToken,
      quoteToken,
    }: { baseToken: `0x${string}`; quoteToken: `0x${string}` }
  ) => `pendle-markets:${chainId}:${baseToken}:${quoteToken}`;

  getPendleParams = this.permanentCache(
    getPendleParamsImpl,
    this.getPendleMarketsCacheKey
  );

  async getPendleMarkets(params: { chainId: number }) {
    const ttl = 3600000;
    const cacheKey = `pendle-markets:${params.chainId}`;

    const cached =
      await this.runtime.getCache<CacheEntry<PendleActiveMarkets>>(cacheKey);

    if (cached?.timestamp && Date.now() - cached.timestamp < ttl) {
      return cached.value;
    }

    const markets = await getActiveMarkets(params.chainId);

    if (!markets.success) {
      console.error("Failed to get pendle markets", markets.error);
      throw new Error("Failed to get pendle markets");
    }

    const value = markets.data.markets;

    await this.runtime.setCache(cacheKey, {
      timestamp: Date.now(),
      value,
    });

    return value;
  }

  async createCalldata(
    calls: CalldataWithDescription[]
  ): Promise<`0x${string}`> {
    const hash = await sha256(toHex(JSON.stringify(calls)));

    if (!(await this.runtime.setCache(`calldata:${hash}`, calls))) {
      throw new Error("Failed to save calldata in cache");
    }

    return hash;
  }

  async getCalldata(hash: `0x${string}`): Promise<CalldataWithDescription[]> {
    const cached = await this.runtime.getCache<CalldataWithDescription[]>(
      `calldata:${hash}`
    );

    if (!cached) {
      throw new Error("Calldata not found in cache");
    }

    return cached;
  }

  private getPoolConstantsCacheKey = (
    chainId: number,
    address: `0x${string}`
  ) => `pool-constants:${chainId}:${address}`;

  getPoolConstants = this.permanentCache(
    getPoolConstants,
    this.getPoolConstantsCacheKey
  );

  private getPoolVariablesCacheKey = (
    chainId: number,
    address: `0x${string}`
  ) => `pool-variables:${chainId}:${address}`;

  invalidatePoolVariablesCache = (chainId: number, address: `0x${string}`) =>
    this.runtime.deleteCache(this.getPoolVariablesCacheKey(chainId, address));

  getPoolVariables = this.timedCache(
    300000,
    getPoolVariablesImpl,
    this.getPoolVariablesCacheKey
  );

  private getVaultConstantsCacheKey = (
    chainId: number,
    address: `0x${string}`
  ) => `vault-constants:${chainId}:${address}`;

  getVaultConstants = this.permanentCache(
    getVaultConstants,
    this.getVaultConstantsCacheKey
  );

  private getStrategiesKey = (chainId: number = 1) => `strategies:${chainId}`;

  getStrategies = this.permanentCache(async (chainId: number = 1) => {
    /*const result = (
      Object.entries(strategyVaultMapping) as [Strategy, StrategyMapping[]][]
    ).reduce((acc, [strategy, mappings]) => {
      const filtered = mappings
        .filter(({ vaultChainId }) => vaultChainId === chainId)
        .map((mapping) => ({
          ...mapping,
          strategy,
        }));

      return [...acc, ...filtered];
    }, [] as StrategyEntry[]);
    */

    const result = await getStrategiesApi(chainId);

    if (!result.success) {
      logger.error("Failed to get strategies", result.error);
      throw new Error("Failed to get strategies");
    }

    return result.data.map((x) => {
      const type: StrategyType = "vault";
      const strategy: Strategy =
        x.type === "UltraSafe"
          ? "ultra-safe"
          : x.type === "Safe"
            ? "safe"
            : x.type === "Brave" ? "brave" : "custom";

      const contractAddress = x.vault?.address;

      if (!isHex(contractAddress)) {
        throw new Error(`Invalid contract address: ${contractAddress}`);
      }

      return {
        type,
        vaultChainId: x.vault?.publicChainId ?? 1,
        contractAddress: contractAddress as `0x${string}`,
        strategy,
        description: x.description,
      };
    });
  }, this.getStrategiesKey);

  formatStrategy(strategy: StrategyEntry) {
    return `${strategy.strategy} - Contract: ${strategy.contractAddress}.Type: "${strategy.type}". ${strategy.description} `;
  }

  async getStrategyData(
    strategy: StrategyEntry
  ): Promise<
    | { type: "vault"; data: VaultConstants }
    | { type: "pool"; data: PoolConstants }
  > {
    if (strategy.type === "vault") {
      return {
        type: "vault",
        data: await this.getVaultConstants(
          strategy.vaultChainId,
          strategy.contractAddress
        ),
      };
    }

    return {
      type: "pool",
      data: await this.getPoolConstants(
        strategy.vaultChainId,
        strategy.contractAddress
      ),
    };
  }

  async handlePoolStrategy(
    strategy: StrategyEntry,
    receiver: `0x${string}`,
    tokenSymbolOrAddress: string,
    amount: string,
    _leverage?: number
  ) {
    if (!_leverage) {
      logger.warn("No leverage provided, using default(x5)");
    }

    const leverage = _leverage ?? 5;
    const {
      type,
      vaultChainId: chainId,
      contractAddress: address,
      bundler,
    } = strategy;

    if (type !== "pool") {
      throw new Error(`Strategy ${address} is not a pool`);
    }

    const pool = await this.getPoolConstants(chainId, address);

    const calls: CalldataWithDescription[] = [];

    let tokenIn = await this.getTokenDataWithInfo({
      chainId,
      symbolOrAddress: tokenSymbolOrAddress,
    });

    let amountIn = parseUnits(amount, tokenIn?.decimals ?? 18);

    const balance = await this.getBalanceOf(
      receiver,
      chainId,
      tokenIn?.address ?? ETH_NULL_ADDR // todo fix native token
    );

    if ((balance?.amount ?? BigInt(0)) < amountIn) {
      throw new Error("Insufficient balance");
    }

    if (!tokenIn?.address) {
      logger.warn(`using WETH`);
      const weth = await this.getWETH(chainId);

      tokenIn = await this.getTokenDataWithInfo({
        chainId,
        symbolOrAddress: weth.symbol,
      });

      calls.push(wrapEth(amountIn, weth));
      amountIn = parseUnits(amount, weth.decimals);
    }

    const client = getClient(getChain(chainId));

    const basePriceX96 = await client.readContract({
      address,
      abi: poolAbi,
      functionName: "getLiquidationPrice",
    });

    const limitPriceX96 = (basePriceX96.inner * BigInt(100)) / BigInt(95); // 5% slippage tolerance

    if (bundler && tokenIn?.address !== pool.baseToken) {
      // handling tokens other than base token if supported
      // fixme make method
      const pendle = await this.getPendleParams(chainId, {
        baseToken: pool.baseToken,
        quoteToken: pool.quoteToken,
      });

      const market = pendle?.market;

      if (!market) {
        throw new Error(
          `Market not found for ${pool.baseToken} and ${pool.quoteToken}`
        );
      }

      if (!tokenIn?.address) {
        throw new Error("weth error");
      }

      const swap = await getPendleSwap({
        chainId: chainId.toString() as `${number}`,
        market,
        receiver,
        slippage: "0.05" as `${number}`,
        enableAggregator: "true",
        tokenIn: tokenIn.address,
        tokenOut: pool.baseToken,
        amountIn: amountIn.toString() as `${number}`,
      });

      if (!swap) {
        throw new Error(
          `Failed to swap ${amountIn.toString()} ${tokenIn?.symbol} to ${pool.baseToken}`
        );
      }

      logger.debug(`Swap: ${JSON.stringify(swap, null, 2)}`);

      if (leverage < 1) {
        throw new Error("Leverage must be greater than 1");
      }

      const longAmount = BigInt(swap.data.amountOut) * BigInt(leverage - 1);

      const { approve } = await getAllowance({
        sender: receiver,
        spender: bundler,
        token: tokenIn.address,
        amount: amountIn,
        client,
        decimals: tokenIn.decimals,
        symbol: tokenIn.symbol,
      });

      if (approve) {
        calls.push(approve);
      }

      const calldata = bundlerEnter(swap, {
        pool: address,
        longAmount,
        limitPriceX96,
      });

      calls.push({
        to: bundler,
        data: calldata,
        title: `Deposit ${amount} ${tokenIn.symbol}`,
        description: `Entering pool ${address} with ${amountIn.toString()} ${tokenIn?.symbol} and x${leverage} leverage`,
      });

      return calls;
    }

    if (tokenIn?.address === pool.baseToken) {
      if (leverage < 1) {
        throw new Error("Leverage must be greater than 1");
      }

      const longAmount = BigInt(amountIn) * BigInt(leverage - 1);

      const { approve } = await getAllowance({
        sender: receiver,
        spender: address,
        token: tokenIn.address,
        amount: amountIn,
        client,
        decimals: tokenIn.decimals,
        symbol: tokenIn.symbol,
      });

      if (approve) {
        calls.push(approve);
      }

      const defaultSwapCalldata = await client.readContract({
        abi: poolAbi,
        address,
        functionName: "defaultSwapCallData",
      });

      const calldata = encodeFunctionData({
        abi: poolAbi,
        functionName: "execute",
        args: [
          0 /* DEPOSIT_BASE */,
          amountIn,
          longAmount,
          limitPriceX96,
          false,
          ETH_NULL_ADDR,
          BigInt(defaultSwapCalldata),
        ],
      });

      calls.push({
        to: address,
        data: calldata,
        title: `Deposit ${amount} ${tokenIn.symbol}`,
        description: `Depositing ${amountIn.toString()} ${tokenIn.symbol} to pool ${address} with x${leverage} leverage`,
      });

      return calls;
    }

    throw new Error(
      `deposit of token ${tokenIn?.symbol} to pool ${address} is not supported, please swap into ${pool.baseToken} first or use bundler`
    );
  }

  async handleVaultStrategy(
    strategy: StrategyEntry,
    sender: `0x${string}`,
    amount: string,
    wrap?: boolean
  ) {
    const { type, vaultChainId: chainId, contractAddress: address } = strategy;

    if (type !== "vault") {
      throw new Error(`Strategy ${address} is not a vault`);
    }

    const vault = await this.getVaultConstants(chainId, address);
    const calls: CalldataWithDescription[] = [];

    const tokenIn = await this.getTokenDataWithInfo({
      chainId,
      symbolOrAddress: vault.asset,
    });

    if (!tokenIn?.address) {
      throw new Error(`Token ${vault.asset} not found`);
    }

    let amountIn = parseUnits(amount, tokenIn.decimals);

    const balance = await this.getBalanceOf(sender, chainId, tokenIn.address);

    if (wrap) {
      const weth = await this.getWETH(chainId);

      if (weth.address !== vault.asset) {
        throw new Error(`Vault ${address} is not a WETH vault`);
      }

      calls.push(wrapEth(amountIn, weth));
      amountIn = parseUnits(amount, weth.decimals);
    }

    if ((balance?.amount ?? BigInt(0)) < amountIn) {
      throw new Error(
        `Insufficient balance, consider swapping to ${tokenIn.symbol} first`
      );
    }

    const client = getClient(getChain(chainId));

    const { approve } = await getAllowance({
      sender,
      spender: address,
      token: tokenIn.address,
      amount: amountIn,
      client,
      decimals: tokenIn.decimals,
      symbol: tokenIn.symbol,
    });

    if (approve) {
      calls.push(approve);
    }

    const calldata = encodeFunctionData({
      abi: vaultAbi,
      functionName: "deposit",
      args: [amountIn, sender],
    });

    calls.push({
      to: address,
      data: calldata,
      title: `Deposit ${amount} ${tokenIn.symbol}`,
      description: `Depositing ${amountIn.toString()} ${tokenIn.symbol} to vault ${address}`,
    });

    return calls;
  }

  async checkEligibility(entity?: Entity | null): Promise<{ result: boolean; reason?: Content }> {
    if (!entity) {
      const content: Content = {
        type: "text",
        text: "No entity found",
      };

      return { result: false, reason: content };
    }

    const address = (
      entity.metadata?.eth as { address: `0x${string}` } | undefined
    )?.address;

    if (!address) {
      const content: Content = {
        type: "text",
        text: "No address found",
      };

      return { result: false, reason: content };
    }

    // fixme use cache+invalidate?
    const balance = await this.getBalanceOf(address, 1, ETH_NULL_ADDR);

    if ((balance?.amount ?? 0n) > 0n) {
      return { result: true };
    }

    const content: Content = {
      type: "text",
      text: "No balance found",
    };

    return { result: false, reason: content };
  }
}
