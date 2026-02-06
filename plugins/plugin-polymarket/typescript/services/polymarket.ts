import { type IAgentRuntime, Service } from "@elizaos/core";
import { Wallet } from "@ethersproject/wallet";
import type { ApiKeysResponse as ClobApiKeysResponse } from "@polymarket/clob-client";
import { AssetType, ClobClient } from "@polymarket/clob-client";
import WebSocket, { type RawData } from "ws";
import {
  ACCOUNT_STATE_TTL_MS,
  ACTIVITY_HISTORY_MAX_ITEMS,
  CACHE_REFRESH_INTERVAL_MS,
  DEFAULT_CLOB_API_URL,
  DEFAULT_CLOB_WS_URL,
  POLYGON_CHAIN_ID,
  POLYMARKET_ACCOUNT_STATE_CACHE_KEY,
  POLYMARKET_ACTIVITY_CONTEXT_CACHE_KEY,
  POLYMARKET_API_CREDENTIALS_CACHE_KEY,
  POLYMARKET_SERVICE_NAME,
  POLYMARKET_WALLET_DATA_CACHE_KEY,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_PING_INTERVAL_MS,
  WS_RECONNECT_DELAY_MS,
} from "../constants";
import {
  type AccountBalances,
  type ActivityContext,
  type ActivityCursor,
  type ActivityData,
  type ActivityType,
  type ApiKey,
  type ApiKeyCreds,
  type AreOrdersScoringResponse,
  type AuthenticationStatus,
  type BalanceAllowance,
  type CachedAccountState,
  type OpenOrder,
  OrderSide,
  type Position,
  type TradeEntry,
} from "../types";

export interface PolymarketWalletData {
  readonly address: string;
  readonly chainId: number;
  readonly usdcBalance: string;
  readonly timestamp: number;
}

type ClobClientSigner = ConstructorParameters<typeof ClobClient>[2];

function createClobClientSigner(privateKey: `0x${string}`): ClobClientSigner {
  return new Wallet(privateKey);
}

function normalizeSetting(value: string | number | boolean | null | undefined): string | undefined {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return undefined;
  return trimmed;
}

function parseSignatureType(
  value: string | number | boolean | null | undefined,
): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBooleanSetting(value: string | boolean | null | undefined): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

// =============================================================================
// Proxy Wallet Detection Helpers
// =============================================================================

/**
 * Tries to detect the user's Polymarket proxy wallet address by checking
 * multiple API endpoints that may return proxy wallet info.
 *
 * @param eoaAddress - The user's EOA address
 * @param logger - Optional logger for debugging
 * @returns The proxy wallet address if found, or empty string
 */
async function tryDetectProxyWallet(
  eoaAddress: string,
  fetchFn?: typeof fetch,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<string> {
  const doFetch = fetchFn ?? fetch;
  const loweredEoa = eoaAddress.toLowerCase();

  // Helper to extract proxy address from response data
  const extractProxy = (data: Record<string, unknown>): string | null => {
    // Check various field names that might contain proxy wallet
    const candidates = [
      data.proxyWallet,
      data.proxy_wallet,
      data.proxy,
      data.funder,
      data.funder_address,
      data.funderAddress,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.startsWith("0x") && candidate.length === 42) {
        // Make sure it's different from the EOA
        if (candidate.toLowerCase() !== loweredEoa) {
          return candidate;
        }
      }
    }
    return null;
  };

  // 1. Try Gamma API public-profile endpoint (documented endpoint)
  try {
    const gammaProfileUrl = `https://gamma-api.polymarket.com/public-profile?address=${eoaAddress}`;
    logger?.info(`[ProxyDetect] Trying gamma public-profile: ${gammaProfileUrl}`);
    const response = await doFetch(gammaProfileUrl);

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      logger?.info(`[ProxyDetect] Gamma profile response: ${JSON.stringify(data).slice(0, 300)}`);

      const proxy = extractProxy(data);
      if (proxy) {
        logger?.info(`[ProxyDetect] Found proxy wallet from gamma profile: ${proxy}`);
        return proxy;
      }
    } else {
      logger?.info(`[ProxyDetect] Gamma profile returned ${response.status}`);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger?.info(`[ProxyDetect] Gamma profile failed: ${errMsg}`);
  }

  // 2. Try Data API positions endpoint - returns proxyWallet in position data
  try {
    const dataApiUrl = `https://data-api.polymarket.com/positions?user=${eoaAddress}&limit=1`;
    logger?.info(`[ProxyDetect] Trying data-api positions: ${dataApiUrl}`);
    const response = await doFetch(dataApiUrl);

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>[];
      logger?.info(`[ProxyDetect] Data API response: ${JSON.stringify(data).slice(0, 300)}`);

      // Positions array - each position has proxyWallet field
      if (Array.isArray(data) && data.length > 0) {
        const firstPosition = data[0];
        const proxy = extractProxy(firstPosition);
        if (proxy) {
          logger?.info(`[ProxyDetect] Found proxy wallet from data-api positions: ${proxy}`);
          return proxy;
        }
      }
    } else {
      logger?.info(`[ProxyDetect] Data API returned ${response.status}`);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger?.info(`[ProxyDetect] Data API failed: ${errMsg}`);
  }

  return "";
}

// =============================================================================
// Position Calculation Helpers
// =============================================================================

interface PositionAccumulator {
  assetId: string;
  market: string;
  size: number;
  averagePrice: number;
  realizedPnl: number;
}

function safeNumber(value: string | number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function updatePositionForTrade(
  position: PositionAccumulator,
  side: "BUY" | "SELL",
  price: number,
  quantity: number,
): void {
  if (quantity <= 0 || price <= 0) {
    return;
  }

  if (side === "BUY") {
    if (position.size >= 0) {
      const newSize = position.size + quantity;
      position.averagePrice =
        newSize === 0 ? 0 : (position.averagePrice * position.size + price * quantity) / newSize;
      position.size = newSize;
      return;
    }

    const shortSize = Math.abs(position.size);
    const closeSize = Math.min(shortSize, quantity);
    position.realizedPnl += (position.averagePrice - price) * closeSize;
    const remainingBuy = quantity - closeSize;
    if (remainingBuy > 0) {
      position.size = remainingBuy;
      position.averagePrice = price;
    } else {
      position.size += quantity;
    }
    return;
  }

  if (position.size <= 0) {
    const newShort = Math.abs(position.size) + quantity;
    position.averagePrice =
      newShort === 0
        ? 0
        : (position.averagePrice * Math.abs(position.size) + price * quantity) / newShort;
    position.size = -newShort;
    return;
  }

  const closeSize = Math.min(position.size, quantity);
  position.realizedPnl += (price - position.averagePrice) * closeSize;
  const remainingSell = quantity - closeSize;
  if (remainingSell > 0) {
    position.size = -remainingSell;
    position.averagePrice = price;
  } else {
    position.size -= quantity;
  }
}

function calculatePositionsFromTrades(trades: TradeEntry[]): Position[] {
  const positionsMap = new Map<string, PositionAccumulator>();

  for (const trade of trades) {
    const assetId = trade.asset_id;
    const market = trade.market;
    const side = trade.side;
    const price = safeNumber(trade.price);
    const quantity = safeNumber(trade.size);

    const existing = positionsMap.get(assetId);
    const position: PositionAccumulator = existing ?? {
      assetId,
      market,
      size: 0,
      averagePrice: 0,
      realizedPnl: 0,
    };

    updatePositionForTrade(position, side, price, quantity);
    positionsMap.set(assetId, position);
  }

  return [...positionsMap.values()]
    .filter((pos) => pos.size !== 0)
    .map((pos) => ({
      market: pos.market,
      asset_id: pos.assetId,
      size: pos.size.toFixed(6),
      average_price: pos.averagePrice.toFixed(6),
      realized_pnl: pos.realizedPnl.toFixed(6),
      unrealized_pnl: "0.000000", // Unrealized PnL requires current market price
    }));
}

type WebsocketStatus = "disconnected" | "connecting" | "connected" | "error";
type WebsocketSubscriptionStatus = "active" | "pending" | "error";
type WebsocketChannel = "book" | "price" | "trade" | "ticker" | "user";

interface WebsocketSetupOptions {
  readonly url?: string;
  readonly channels?: string[];
  readonly assetIds?: string[];
  readonly authenticated?: boolean;
}

interface WebsocketSetupResult {
  readonly config: {
    readonly url: string;
    readonly channels: WebsocketChannel[];
    readonly assetIds: string[];
    readonly authenticated: boolean;
    readonly status: WebsocketStatus;
  };
  readonly statusSnapshot: WebsocketStatusSnapshot;
  readonly hasCredentials: boolean;
}

interface WebsocketSubscription {
  readonly channel: WebsocketChannel;
  readonly assetIds: string[];
  readonly authenticated: boolean;
  readonly status: WebsocketSubscriptionStatus;
  readonly lastUpdatedAt: number;
}

interface WebsocketStatusSnapshot {
  readonly status: WebsocketStatus;
  readonly url: string;
  readonly subscriptions: WebsocketSubscription[];
  readonly reconnectAttempts: number;
  readonly lastError?: string;
}

interface WebsocketConfig {
  readonly url?: string;
  readonly channels: WebsocketChannel[];
  readonly assetIds: string[];
  readonly authenticated: boolean;
}

type WebsocketOutboundMessage =
  | {
      readonly type: "subscribe";
      readonly channel: WebsocketChannel;
      readonly assets_ids: string[];
    }
  | {
      readonly type: "unsubscribe";
      readonly channel: WebsocketChannel;
      readonly assets_ids?: string[];
    };

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface WebsocketInboundMessage {
  readonly type?: string;
  readonly channel?: string;
  readonly data?: JsonValue;
  readonly error?: string;
}

interface CachedApiCredentials {
  readonly creds: ApiKeyCreds;
  readonly source: "env" | "derived" | "created";
  readonly cachedAt: number;
}

interface ClobTradesPaginatedResponse {
  readonly trades: ReadonlyArray<{
    readonly id: string;
    readonly taker_order_id: string;
    readonly market: string;
    readonly asset_id: string;
    readonly side: string;
    readonly size: string;
    readonly fee_rate_bps: string;
    readonly price: string;
    readonly status: string;
    readonly match_time: string;
    readonly last_update: string;
    readonly outcome: string;
    readonly bucket_index: number;
    readonly owner: string;
    readonly maker_address: string;
    readonly transaction_hash: string;
    readonly trader_side: string;
  }>;
  readonly next_cursor?: string;
}

const RECENT_TRADES_LIMIT = 50;
const CONDITIONAL_BALANCE_LIMIT = 25;

export class PolymarketService extends Service {
  static serviceType: string = POLYMARKET_SERVICE_NAME;
  capabilityDescription = "Polymarket prediction markets access and trading";

  private clobClient: ClobClient | null = null;
  private authenticatedClient: ClobClient | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private websocket: WebSocket | null = null;
  private websocketStatus: WebsocketStatus = "disconnected";
  private websocketUrl: string | null = null;
  private wsPingInterval: ReturnType<typeof setInterval> | null = null;
  private wsReconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private wsReconnectAttempts = 0;
  private wsLastError: string | null = null;
  private wsShouldReconnect = true;
  private wsSubscriptions = new Map<string, WebsocketSubscription>();
  private wsPendingMessages: WebsocketOutboundMessage[] = [];
  protected polymarketRuntime: IAgentRuntime;
  private walletAddress: string | null = null;
  private cachedApiCredentials: CachedApiCredentials | null = null;
  private apiCredentialsPromise: Promise<ApiKeyCreds | null> | null = null;
  private cachedAccountState: CachedAccountState | null = null;
  private accountStateRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private accountStatePromise: Promise<CachedAccountState | null> | null = null;
  private cachedActivityContext: ActivityContext | null = null;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.polymarketRuntime = runtime;
  }

  static async start(runtime: IAgentRuntime): Promise<PolymarketService> {
    const service = new PolymarketService(runtime);

    await service.initializeClobClient();
    await service.initializeAuthenticatedClient();

    if (service.refreshInterval) {
      clearInterval(service.refreshInterval);
    }

    service.refreshInterval = setInterval(
      () => service.refreshWalletData(),
      CACHE_REFRESH_INTERVAL_MS,
    );

    // Initialize account state on startup
    await service.refreshAccountState();

    // If balance is 0 but we have trades, try to detect proxy from trade history
    await service.tryDetectProxyFromTrades();

    // Set up periodic refresh for account state (every 5 minutes to check TTL)
    if (service.accountStateRefreshInterval) {
      clearInterval(service.accountStateRefreshInterval);
    }
    service.accountStateRefreshInterval = setInterval(
      () => service.refreshAccountStateIfNeeded(),
      CACHE_REFRESH_INTERVAL_MS,
    );

    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(POLYMARKET_SERVICE_NAME);
    if (!service) {
      return;
    }

    const polymarketService = service as PolymarketService;
    await polymarketService.stop();
  }

  async stop(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.accountStateRefreshInterval) {
      clearInterval(this.accountStateRefreshInterval);
      this.accountStateRefreshInterval = null;
    }
    await this.stopWebsocket();
  }

  private getPrivateKey(): `0x${string}` {
    const privateKeySetting =
      this.polymarketRuntime.getSetting("POLYMARKET_PRIVATE_KEY") ||
      this.polymarketRuntime.getSetting("EVM_PRIVATE_KEY") ||
      this.polymarketRuntime.getSetting("WALLET_PRIVATE_KEY");

    if (!privateKeySetting) {
      throw new Error(
        "No private key found. Please set POLYMARKET_PRIVATE_KEY, EVM_PRIVATE_KEY, or WALLET_PRIVATE_KEY",
      );
    }

    const privateKey = String(privateKeySetting);
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return key as `0x${string}`;
  }

  private async initializeClobClient(): Promise<void> {
    const clobApiUrlSetting =
      this.polymarketRuntime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
    const clobApiUrl = String(clobApiUrlSetting);

    const privateKey = this.getPrivateKey();
    const signer = createClobClientSigner(privateKey);
    const wallet = signer instanceof Wallet ? signer : null;
    this.walletAddress = wallet ? wallet.address : await signer.getAddress();

    const signatureTypeSetting =
      this.polymarketRuntime.getSetting("POLYMARKET_SIGNATURE_TYPE") ||
      this.polymarketRuntime.getSetting("CLOB_SIGNATURE_TYPE");
    const funderSetting =
      this.polymarketRuntime.getSetting("POLYMARKET_FUNDER_ADDRESS") ||
      this.polymarketRuntime.getSetting("POLYMARKET_FUNDER") ||
      this.polymarketRuntime.getSetting("CLOB_FUNDER_ADDRESS");
    const signatureType = parseSignatureType(signatureTypeSetting);
    const funderAddress = normalizeSetting(funderSetting);

    this.clobClient = new ClobClient(
      clobApiUrl,
      POLYGON_CHAIN_ID,
      signer,
      undefined,
      signatureType,
      funderAddress,
    );
  }

  private async initializeAuthenticatedClient(): Promise<void> {
    const clobApiUrlSetting =
      this.polymarketRuntime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
    const clobApiUrl = String(clobApiUrlSetting);

    const privateKey = this.getPrivateKey();
    const signer = createClobClientSigner(privateKey);

    const signatureTypeSetting =
      this.polymarketRuntime.getSetting("POLYMARKET_SIGNATURE_TYPE") ||
      this.polymarketRuntime.getSetting("CLOB_SIGNATURE_TYPE");

    const funderSetting =
      this.polymarketRuntime.getSetting("POLYMARKET_FUNDER_ADDRESS") ||
      this.polymarketRuntime.getSetting("POLYMARKET_FUNDER") ||
      this.polymarketRuntime.getSetting("CLOB_FUNDER_ADDRESS");
    const signatureType = parseSignatureType(signatureTypeSetting);
    let funderAddress = normalizeSetting(funderSetting);

    // Log wallet address for debugging
    this.polymarketRuntime.logger.info(
      `[PolymarketService] EOA Wallet address: ${this.walletAddress}`,
    );

    // Store the original signature type for later logic
    let effectiveSignatureType = signatureType;

    // Try to detect proxy wallet if funder not set
    if (!funderAddress && this.walletAddress) {
      this.polymarketRuntime.logger.info(
        `[PolymarketService] Attempting to detect proxy wallet...`,
      );

      const detectedProxy = await tryDetectProxyWallet(
        this.walletAddress,
        this.polymarketRuntime.fetch?.bind(this.polymarketRuntime),
        {
          info: (msg: string) => this.polymarketRuntime.logger.info(msg),
          warn: (msg: string) => this.polymarketRuntime.logger.warn(msg),
        },
      );

      if (detectedProxy) {
        this.polymarketRuntime.logger.info(
          `[PolymarketService] Detected proxy wallet: ${detectedProxy}`,
        );

        // Auto-use the detected proxy wallet
        // Set signature type to 2 (POLY_GNOSIS_SAFE) if not already set
        if (effectiveSignatureType === undefined || effectiveSignatureType === 0) {
          this.polymarketRuntime.logger.info(
            `[PolymarketService] Auto-setting signatureType=2 for proxy wallet`,
          );
          effectiveSignatureType = 2;
        }

        this.polymarketRuntime.logger.info(
          `[PolymarketService] Auto-using detected proxy wallet as funder`,
        );
        funderAddress = detectedProxy;
      } else {
        this.polymarketRuntime.logger.info(
          `[PolymarketService] No proxy wallet detected via API. If your balance shows 0 but you have funds on Polymarket:\n` +
            `  1. Find your proxy wallet address on Polymarket.com or Polygonscan\n` +
            `  2. Add to .env: POLYMARKET_SIGNATURE_TYPE=2\n` +
            `  3. Add to .env: POLYMARKET_FUNDER_ADDRESS=<your-proxy-wallet>`,
        );
      }
    }

    const allowCreate = this.getAllowCreateApiKey();

    // Log final configuration
    this.polymarketRuntime.logger.info(
      `[PolymarketService] Auth config: signatureType=${effectiveSignatureType ?? "default(0)"}, ` +
        `funderAddress=${funderAddress ?? "none (using EOA)"}`,
    );

    this.polymarketRuntime.logger.info(
      `[PolymarketService] Initializing authenticated client (allowCreate: ${allowCreate})`,
    );

    const creds = await this.ensureApiCredentials({ allowCreate });
    if (!creds) {
      this.polymarketRuntime.logger.warn(
        "[PolymarketService] No API credentials available; authenticated client disabled.",
      );
      this.authenticatedClient = null;
      return;
    }

    this.polymarketRuntime.logger.info(
      `[PolymarketService] API credentials obtained (key: ${creds.key.substring(0, 8)}...)`,
    );

    this.authenticatedClient = new ClobClient(
      clobApiUrl,
      POLYGON_CHAIN_ID,
      signer,
      creds,
      effectiveSignatureType,
      funderAddress,
    );
    this.polymarketRuntime.logger.info(
      "[PolymarketService] Authenticated client initialized successfully",
    );
  }

  getClobClient(): ClobClient {
    if (!this.clobClient) {
      throw new Error("CLOB client not initialized");
    }
    return this.clobClient;
  }

  getAuthenticatedClient(): ClobClient {
    if (!this.authenticatedClient) {
      throw new Error(
        "Authenticated CLOB client not initialized. Please configure API credentials.",
      );
    }
    return this.authenticatedClient;
  }

  async ensureApiCredentials(options?: { allowCreate?: boolean }): Promise<ApiKeyCreds | null> {
    if (this.apiCredentialsPromise) {
      return this.apiCredentialsPromise;
    }

    this.apiCredentialsPromise = this.doEnsureApiCredentials(options);

    try {
      return await this.apiCredentialsPromise;
    } finally {
      this.apiCredentialsPromise = null;
    }
  }

  private async doEnsureApiCredentials(options?: {
    allowCreate?: boolean;
  }): Promise<ApiKeyCreds | null> {
    const cached = await this.getCachedApiCredentials();
    if (cached) {
      this.polymarketRuntime.logger.info(
        `[PolymarketService] Using cached API credentials (source: ${cached.source})`,
      );
      return cached.creds;
    }

    const apiKey = normalizeSetting(this.polymarketRuntime.getSetting("CLOB_API_KEY"));
    const apiSecret =
      normalizeSetting(this.polymarketRuntime.getSetting("CLOB_API_SECRET")) ||
      normalizeSetting(this.polymarketRuntime.getSetting("CLOB_SECRET"));
    const apiPassphrase =
      normalizeSetting(this.polymarketRuntime.getSetting("CLOB_API_PASSPHRASE")) ||
      normalizeSetting(this.polymarketRuntime.getSetting("CLOB_PASS_PHRASE"));

    if (apiKey && apiSecret && apiPassphrase) {
      this.polymarketRuntime.logger.info(
        "[PolymarketService] Using API credentials from environment",
      );
      const creds: ApiKeyCreds = {
        key: apiKey,
        secret: apiSecret,
        passphrase: apiPassphrase,
      };
      await this.cacheApiCredentials(creds, "env");
      return creds;
    }

    const client = this.getClobClient();
    this.polymarketRuntime.logger.info(
      "[PolymarketService] Attempting to derive API key from wallet...",
    );

    try {
      const derived = (await client.deriveApiKey()) as ApiKeyCreds & { apiKey?: string };
      const key = (derived as { key?: string }).key ?? derived.apiKey;
      if (!key) {
        throw new Error("Derived API credentials missing key field.");
      }
      this.polymarketRuntime.logger.info("[PolymarketService] Successfully derived API key");
      const creds: ApiKeyCreds = {
        key,
        secret: derived.secret,
        passphrase: derived.passphrase,
      };
      await this.cacheApiCredentials(creds, "derived");
      this.persistApiCredentials(creds);
      return creds;
    } catch (deriveError) {
      const deriveMessage =
        deriveError instanceof Error ? deriveError.message : String(deriveError);
      this.polymarketRuntime.logger.warn(
        `[PolymarketService] Failed to derive API key: ${deriveMessage}`,
      );

      if (!options?.allowCreate) {
        this.polymarketRuntime.logger.warn(
          "[PolymarketService] Creation disabled; returning null credentials",
        );
        return null;
      }

      this.polymarketRuntime.logger.info("[PolymarketService] Attempting to create new API key...");
      try {
        const created = (await client.createApiKey()) as ApiKeyCreds & { apiKey?: string };
        const key = (created as { key?: string }).key ?? created.apiKey;
        if (!key) {
          throw new Error("Created API credentials missing key field.");
        }
        this.polymarketRuntime.logger.info("[PolymarketService] Successfully created new API key");
        const creds: ApiKeyCreds = {
          key,
          secret: created.secret,
          passphrase: created.passphrase,
        };
        await this.cacheApiCredentials(creds, "created");
        this.persistApiCredentials(creds);
        return creds;
      } catch (createError) {
        const createMessage =
          createError instanceof Error ? createError.message : String(createError);
        this.polymarketRuntime.logger.error(
          `[PolymarketService] Failed to create API key: ${createMessage}`,
        );
        return null;
      }
    }
  }

  async revokeApiCredentials(): Promise<void> {
    const client = this.getAuthenticatedClient();
    if (typeof client.deleteApiKey !== "function") {
      throw new Error("CLOB client does not support API key revocation.");
    }
    await client.deleteApiKey();
    await this.clearApiCredentialsCache();
    this.polymarketRuntime.setSetting("CLOB_API_KEY", null);
    this.polymarketRuntime.setSetting("CLOB_API_SECRET", null, true);
    this.polymarketRuntime.setSetting("CLOB_API_PASSPHRASE", null, true);
  }

  private async getCachedApiCredentials(): Promise<CachedApiCredentials | null> {
    if (this.cachedApiCredentials) {
      return this.cachedApiCredentials;
    }
    const cached = await this.polymarketRuntime.getCache<CachedApiCredentials>(
      POLYMARKET_API_CREDENTIALS_CACHE_KEY,
    );
    if (!cached) {
      return null;
    }
    this.cachedApiCredentials = cached;
    return cached;
  }

  private async cacheApiCredentials(
    creds: ApiKeyCreds,
    source: CachedApiCredentials["source"],
  ): Promise<void> {
    const cached: CachedApiCredentials = {
      creds,
      source,
      cachedAt: Date.now(),
    };
    this.cachedApiCredentials = cached;
    await this.polymarketRuntime.setCache(POLYMARKET_API_CREDENTIALS_CACHE_KEY, cached);
  }

  private async clearApiCredentialsCache(): Promise<void> {
    this.cachedApiCredentials = null;
    await this.polymarketRuntime.deleteCache(POLYMARKET_API_CREDENTIALS_CACHE_KEY);
  }

  private persistApiCredentials(creds: ApiKeyCreds): void {
    this.polymarketRuntime.setSetting("CLOB_API_KEY", creds.key, false);
    this.polymarketRuntime.setSetting("CLOB_API_SECRET", creds.secret, true);
    this.polymarketRuntime.setSetting("CLOB_API_PASSPHRASE", creds.passphrase, true);
  }

  getWalletAddress(): string {
    if (!this.walletAddress) {
      throw new Error("Wallet not initialized");
    }
    return this.walletAddress;
  }

  async refreshWalletData(): Promise<void> {
    if (!this.authenticatedClient || !this.walletAddress) {
      return;
    }

    try {
      const balance = await this.authenticatedClient.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });

      const walletData: PolymarketWalletData = {
        address: this.walletAddress,
        chainId: POLYGON_CHAIN_ID,
        usdcBalance: balance?.balance ? String(balance.balance) : "0",
        timestamp: Date.now(),
      };

      await this.polymarketRuntime.setCache(POLYMARKET_WALLET_DATA_CACHE_KEY, walletData);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.polymarketRuntime.logger.error("Error refreshing wallet data:", errorMsg);
    }
  }

  async getCachedData(): Promise<PolymarketWalletData | undefined> {
    return this.polymarketRuntime.getCache<PolymarketWalletData>(POLYMARKET_WALLET_DATA_CACHE_KEY);
  }

  hasAuthenticatedClient(): boolean {
    return this.authenticatedClient !== null;
  }

  /**
   * Returns the current authentication status including wallet and API credential state.
   * Use this to check what capabilities are available (read-only vs full trading).
   */
  getAuthenticationStatus(): AuthenticationStatus {
    const privateKeySetting =
      this.polymarketRuntime.getSetting("POLYMARKET_PRIVATE_KEY") ||
      this.polymarketRuntime.getSetting("EVM_PRIVATE_KEY") ||
      this.polymarketRuntime.getSetting("WALLET_PRIVATE_KEY");
    const clobApiKey = this.polymarketRuntime.getSetting("CLOB_API_KEY");
    const clobApiSecret =
      this.polymarketRuntime.getSetting("CLOB_API_SECRET") ||
      this.polymarketRuntime.getSetting("CLOB_SECRET");
    const clobApiPassphrase =
      this.polymarketRuntime.getSetting("CLOB_API_PASSPHRASE") ||
      this.polymarketRuntime.getSetting("CLOB_PASS_PHRASE");
    const clobApiUrl = this.polymarketRuntime.getSetting("CLOB_API_URL");

    const hasPrivateKey = Boolean(privateKeySetting);
    const hasApiKey = Boolean(clobApiKey);
    const hasApiSecret = Boolean(clobApiSecret);
    const hasApiPassphrase = Boolean(clobApiPassphrase);

    return {
      hasPrivateKey,
      hasApiKey,
      hasApiSecret,
      hasApiPassphrase,
      walletAddress: this.walletAddress ?? undefined,
      isFullyAuthenticated: hasPrivateKey && hasApiKey && hasApiSecret && hasApiPassphrase,
      canReadMarkets: Boolean(clobApiUrl),
      canTrade: hasPrivateKey && hasApiKey && hasApiSecret && hasApiPassphrase,
    };
  }

  // =============================================================================
  // Account State Management
  // =============================================================================

  /**
   * Get the cached account state. Returns null if not initialized or expired.
   * Use getAccountState() for guaranteed fresh data.
   */
  getCachedAccountState(): CachedAccountState | null {
    if (!this.cachedAccountState) {
      return null;
    }
    if (Date.now() > this.cachedAccountState.expiresAt) {
      return null;
    }
    return this.cachedAccountState;
  }

  /**
   * Get account state, refreshing if needed. This is the primary method for
   * providers to get account context data.
   */
  async getAccountState(): Promise<CachedAccountState | null> {
    const cached = this.getCachedAccountState();
    if (cached) {
      return cached;
    }
    return this.refreshAccountState();
  }

  /**
   * Refresh account state if the TTL has expired. Called periodically.
   */
  private async refreshAccountStateIfNeeded(): Promise<void> {
    const cached = this.getCachedAccountState();
    if (!cached) {
      await this.refreshAccountState();
    }
  }

  /**
   * Force refresh of all account state data. Called on startup and when
   * significant changes occur (like placing orders).
   */
  async refreshAccountState(): Promise<CachedAccountState | null> {
    // Prevent concurrent refreshes
    if (this.accountStatePromise) {
      return this.accountStatePromise;
    }

    this.accountStatePromise = this.doRefreshAccountState();

    try {
      return await this.accountStatePromise;
    } finally {
      this.accountStatePromise = null;
    }
  }

  private async doRefreshAccountState(): Promise<CachedAccountState | null> {
    if (!this.authenticatedClient || !this.walletAddress) {
      this.polymarketRuntime.logger.warn(
        "[PolymarketService] Cannot refresh account state: no authenticated client",
      );
      return null;
    }

    const now = Date.now();
    this.polymarketRuntime.logger.info("[PolymarketService] Refreshing account state...");

    try {
      // Fetch all account data in parallel
      const [balancesResult, ordersResult, tradesResult, apiKeysResult] = await Promise.allSettled([
        this.fetchAccountBalances(),
        this.fetchActiveOrders(),
        this.fetchRecentTrades(),
        this.fetchApiKeys(),
      ]);

      const balances: AccountBalances =
        balancesResult.status === "fulfilled"
          ? balancesResult.value
          : { collateral: null, conditionalTokens: {} };

      if (balancesResult.status === "rejected") {
        this.polymarketRuntime.logger.warn(
          `[PolymarketService] Balance fetch failed: ${balancesResult.reason}`,
        );
      } else {
        this.polymarketRuntime.logger.info(
          `[PolymarketService] Balance fetch result: collateral=${balances.collateral?.balance ?? "null"}`,
        );
      }

      const activeOrders: OpenOrder[] =
        ordersResult.status === "fulfilled" ? ordersResult.value : [];

      const recentTrades: TradeEntry[] =
        tradesResult.status === "fulfilled" ? tradesResult.value : [];

      const apiKeysData =
        apiKeysResult.status === "fulfilled"
          ? apiKeysResult.value
          : { apiKeys: [], certRequired: null };

      // Calculate positions from trade history
      const positions = calculatePositionsFromTrades(recentTrades);

      // Fetch order scoring status for active orders
      let orderScoringStatus: Record<string, boolean> = {};
      if (activeOrders.length > 0) {
        orderScoringStatus = await this.fetchOrderScoringStatus(activeOrders.map((o) => o.id));
      }

      const accountState: CachedAccountState = {
        walletAddress: this.walletAddress,
        balances,
        activeOrders,
        recentTrades,
        positions,
        orderScoringStatus,
        apiKeys: apiKeysData.apiKeys,
        certRequired: apiKeysData.certRequired,
        lastUpdatedAt: now,
        expiresAt: now + ACCOUNT_STATE_TTL_MS,
      };

      this.cachedAccountState = accountState;
      await this.polymarketRuntime.setCache(POLYMARKET_ACCOUNT_STATE_CACHE_KEY, accountState);

      const scoringCount = Object.values(orderScoringStatus).filter((v) => v).length;
      this.polymarketRuntime.logger.info(
        `[PolymarketService] Account state refreshed: ${activeOrders.length} orders (${scoringCount} scoring), ${recentTrades.length} trades, ${positions.length} positions`,
      );

      return accountState;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.polymarketRuntime.logger.error(
        `[PolymarketService] Failed to refresh account state: ${errorMsg}`,
      );
      return null;
    }
  }

  private async fetchAccountBalances(): Promise<AccountBalances> {
    if (!this.authenticatedClient) {
      this.polymarketRuntime.logger.warn(
        "[PolymarketService] Cannot fetch balances: authenticated client not initialized",
      );
      return { collateral: null, conditionalTokens: {} };
    }

    // Update balance allowance first to ensure fresh data
    // This is required per Polymarket API documentation
    try {
      await this.authenticatedClient.updateBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
    } catch (updateError) {
      this.polymarketRuntime.logger.warn(
        `[PolymarketService] Failed to update balance allowance: ${
          updateError instanceof Error ? updateError.message : String(updateError)
        }`,
      );
      // Continue anyway - getBalanceAllowance might still work
    }

    // Fetch collateral (USDC) balance
    const collateralResponse = await this.authenticatedClient.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    this.polymarketRuntime.logger.info(
      `[PolymarketService] Raw balance response: ${JSON.stringify(collateralResponse)}`,
    );

    // The CLOB API returns balance in atomic units (USDC has 6 decimals)
    // However, some versions may return it already formatted - check if value is small
    const USDC_DECIMALS = 6;
    const formatBalance = (rawBalance: string | number | null | undefined): string => {
      if (rawBalance === null || rawBalance === undefined) return "0";
      const numValue = typeof rawBalance === "string" ? parseFloat(rawBalance) : rawBalance;
      if (!Number.isFinite(numValue)) return "0";

      // If the value looks like it's already in decimal form (e.g., 9.5 not 9500000)
      // then don't divide by 10^6
      if (numValue > 0 && numValue < 1000) {
        // Likely already formatted, return as-is with proper decimal places
        return numValue.toFixed(6);
      }

      // Otherwise assume atomic units and convert
      return (numValue / 10 ** USDC_DECIMALS).toFixed(6);
    };

    const collateral: BalanceAllowance | null = collateralResponse
      ? {
          balance: formatBalance(collateralResponse.balance),
          allowance: formatBalance(collateralResponse.allowance),
        }
      : null;

    this.polymarketRuntime.logger.info(
      `[PolymarketService] Formatted collateral balance: ${collateral?.balance ?? "null"}`,
    );

    // Get unique asset IDs from active orders and recent trades to fetch conditional balances
    const _assetIds = new Set<string>();

    // We'll populate this from orders/trades after they're fetched
    // For now, return just collateral - conditional balances will be updated after trades/orders
    return {
      collateral,
      conditionalTokens: {},
    };
  }

  private async fetchActiveOrders(): Promise<OpenOrder[]> {
    if (!this.authenticatedClient) {
      return [];
    }

    const orders = (await this.authenticatedClient.getOpenOrders()) as OpenOrder[];
    return orders ?? [];
  }

  private async fetchRecentTrades(): Promise<TradeEntry[]> {
    if (!this.authenticatedClient) {
      return [];
    }

    const tradesResponse = (await this.authenticatedClient.getTradesPaginated(
      {},
    )) as ClobTradesPaginatedResponse;
    const rawTrades = tradesResponse.trades ?? [];

    const trades: TradeEntry[] = rawTrades.slice(0, RECENT_TRADES_LIMIT).map((trade) => ({
      id: trade.id,
      taker_order_id: trade.taker_order_id,
      market: trade.market,
      asset_id: trade.asset_id,
      side: trade.side === "SELL" ? OrderSide.SELL : OrderSide.BUY,
      size: trade.size,
      fee_rate_bps: trade.fee_rate_bps,
      price: trade.price,
      status: trade.status,
      match_time: trade.match_time,
      last_update: trade.last_update,
      outcome: trade.outcome,
      bucket_index: trade.bucket_index,
      owner: trade.owner,
      maker_address: trade.maker_address,
      transaction_hash: trade.transaction_hash,
      trader_side: trade.trader_side === "MAKER" ? "MAKER" : "TAKER",
    }));

    return trades;
  }

  private async fetchApiKeys(): Promise<{ apiKeys: ApiKey[]; certRequired: boolean | null }> {
    if (!this.authenticatedClient) {
      return { apiKeys: [], certRequired: null };
    }

    try {
      const response = (await this.authenticatedClient.getApiKeys()) as ClobApiKeysResponse;
      const creds = response.apiKeys ?? [];

      const apiKeys: ApiKey[] = creds.map((cred, idx) => ({
        key_id: cred.key,
        label: `API Key ${idx + 1}`,
        type: "read_write" as const,
        status: "active" as const,
        created_at: new Date().toISOString(),
        last_used_at: null,
        is_cert_whitelisted: false,
      }));

      return { apiKeys, certRequired: null };
    } catch (error) {
      this.polymarketRuntime.logger.warn(
        "[PolymarketService] Failed to fetch API keys:",
        error instanceof Error ? error.message : String(error),
      );
      return { apiKeys: [], certRequired: null };
    }
  }

  private async fetchOrderScoringStatus(orderIds: string[]): Promise<Record<string, boolean>> {
    if (!this.authenticatedClient || orderIds.length === 0) {
      return {};
    }

    try {
      const scoringResponse = (await this.authenticatedClient.areOrdersScoring({
        orderIds,
      })) as AreOrdersScoringResponse;
      return scoringResponse ?? {};
    } catch (error) {
      this.polymarketRuntime.logger.warn(
        "[PolymarketService] Failed to fetch order scoring status:",
        error instanceof Error ? error.message : String(error),
      );
      return {};
    }
  }

  /**
   * Update conditional token balances based on known asset IDs from orders/trades.
   * Call this after fetching orders and trades to get relevant token balances.
   */
  async updateConditionalBalances(assetIds: string[]): Promise<void> {
    if (!this.authenticatedClient || !this.cachedAccountState) {
      return;
    }

    const uniqueIds = [...new Set(assetIds)].slice(0, CONDITIONAL_BALANCE_LIMIT);
    const conditionalTokens: Record<string, BalanceAllowance> = {};

    await Promise.all(
      uniqueIds.map(async (assetId) => {
        try {
          const balance = await this.authenticatedClient?.getBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: assetId,
          });
          conditionalTokens[assetId] = {
            balance: String(balance?.balance ?? "0"),
            allowance: String(balance?.allowance ?? "0"),
          };
        } catch (_error) {
          // Ignore individual token balance errors
        }
      }),
    );

    // Update the cached state with new conditional balances
    this.cachedAccountState = {
      ...this.cachedAccountState,
      balances: {
        ...this.cachedAccountState.balances,
        conditionalTokens: {
          ...this.cachedAccountState.balances.conditionalTokens,
          ...conditionalTokens,
        },
      },
    };

    await this.polymarketRuntime.setCache(
      POLYMARKET_ACCOUNT_STATE_CACHE_KEY,
      this.cachedAccountState,
    );
  }

  /**
   * Invalidate account state cache, forcing a refresh on next access.
   * Call this after placing orders or other state-changing operations.
   */
  invalidateAccountState(): void {
    this.cachedAccountState = null;
  }

  /**
   * Attempt to detect proxy wallet from trade history if balance shows 0 but
   * we have trades. This is a fallback when API-based detection fails.
   */
  private async tryDetectProxyFromTrades(): Promise<void> {
    const state = this.cachedAccountState;
    if (!state) return;

    // Check if balance is 0 but we have trades
    const balance = parseFloat(state.balances?.collateral?.balance ?? "0");
    const hasZeroBalance = balance === 0 || !Number.isFinite(balance);
    const hasTrades = state.recentTrades.length > 0;

    if (!hasZeroBalance || !hasTrades) {
      return;
    }

    this.polymarketRuntime.logger.info(
      `[PolymarketService] Balance is 0 but have ${state.recentTrades.length} trades - checking for proxy wallet`,
    );

    // Get unique owner addresses from trades
    const ownerAddresses = new Set<string>();
    for (const trade of state.recentTrades) {
      if (trade.owner?.startsWith("0x")) {
        ownerAddresses.add(trade.owner.toLowerCase());
      }
    }

    // Find owner that's different from our EOA
    const eoaLower = this.walletAddress?.toLowerCase();
    let proxyAddress: string | null = null;

    for (const owner of ownerAddresses) {
      if (owner !== eoaLower) {
        proxyAddress = owner;
        break;
      }
    }

    if (!proxyAddress) {
      this.polymarketRuntime.logger.info(
        `[PolymarketService] No proxy wallet found in trades (owners match EOA)`,
      );
      return;
    }

    this.polymarketRuntime.logger.info(
      `[PolymarketService] Found potential proxy wallet from trades: ${proxyAddress}`,
    );
    this.polymarketRuntime.logger.info(
      `[PolymarketService] Reinitializing client with detected proxy wallet...`,
    );

    // Reinitialize the authenticated client with the detected proxy
    await this.reinitializeWithProxy(proxyAddress);
  }

  /**
   * Reinitialize the authenticated client with a proxy wallet address.
   */
  private async reinitializeWithProxy(proxyAddress: string): Promise<void> {
    const clobApiUrlSetting =
      this.polymarketRuntime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
    const clobApiUrl = String(clobApiUrlSetting);

    const privateKey = this.getPrivateKey();
    const signer = createClobClientSigner(privateKey);

    // Use signature type 2 for proxy wallet
    const signatureType = 2;
    const funderAddress = proxyAddress;

    this.polymarketRuntime.logger.info(
      `[PolymarketService] Reinitializing with signatureType=${signatureType}, funderAddress=${funderAddress}`,
    );

    // Get existing or new credentials
    const creds = await this.ensureApiCredentials({ allowCreate: this.getAllowCreateApiKey() });
    if (!creds) {
      this.polymarketRuntime.logger.warn(
        "[PolymarketService] Cannot reinitialize: no API credentials",
      );
      return;
    }

    this.authenticatedClient = new ClobClient(
      clobApiUrl,
      POLYGON_CHAIN_ID,
      signer,
      creds,
      signatureType,
      funderAddress,
    );

    this.polymarketRuntime.logger.info(
      "[PolymarketService] Client reinitialized with proxy wallet - refreshing account state",
    );

    // Clear and refresh account state with new client
    this.invalidateAccountState();
    await this.refreshAccountState();
  }

  // =============================================================================
  // Activity Context Management
  // =============================================================================

  /**
   * Record an activity to the activity context.
   * This tracks what the agent was last doing for context continuity.
   */
  async recordActivity(data: ActivityData): Promise<void> {
    const now = Date.now();
    const cursor: ActivityCursor = {
      timestamp: now,
      data,
    };

    // Get existing context or create new
    let context = await this.getActivityContext();
    if (!context) {
      context = {
        lastActivities: {},
        recentHistory: [],
        lastUpdatedAt: now,
      };
    }

    // Update last activity for this type
    context.lastActivities[data.type] = cursor;

    // Add to recent history (most recent first)
    context.recentHistory.unshift(cursor);

    // Trim history to max items
    if (context.recentHistory.length > ACTIVITY_HISTORY_MAX_ITEMS) {
      context.recentHistory = context.recentHistory.slice(0, ACTIVITY_HISTORY_MAX_ITEMS);
    }

    context.lastUpdatedAt = now;

    // Cache the context
    this.cachedActivityContext = context;
    await this.polymarketRuntime.setCache(POLYMARKET_ACTIVITY_CONTEXT_CACHE_KEY, context);

    this.polymarketRuntime.logger.debug(`[PolymarketService] Recorded activity: ${data.type}`);
  }

  /**
   * Get cached activity context synchronously (memory only).
   * Use this in providers to avoid blocking.
   */
  getCachedActivityContext(): ActivityContext | null {
    return this.cachedActivityContext ?? null;
  }

  /**
   * Get the current activity context.
   * Returns null if no activities have been recorded.
   */
  async getActivityContext(): Promise<ActivityContext | null> {
    if (this.cachedActivityContext) {
      return this.cachedActivityContext;
    }

    const cached = await this.polymarketRuntime.getCache<ActivityContext>(
      POLYMARKET_ACTIVITY_CONTEXT_CACHE_KEY,
    );

    if (cached) {
      this.cachedActivityContext = cached;
    }

    return cached ?? null;
  }

  /**
   * Get the most recent activity of a specific type.
   */
  async getLastActivity(type: ActivityType): Promise<ActivityCursor | null> {
    const context = await this.getActivityContext();
    return context?.lastActivities[type] ?? null;
  }

  /**
   * Clear the activity context.
   */
  async clearActivityContext(): Promise<void> {
    this.cachedActivityContext = null;
    await this.polymarketRuntime.deleteCache(POLYMARKET_ACTIVITY_CONTEXT_CACHE_KEY);
  }

  private normalizeChannel(channel: string): WebsocketChannel | null {
    const normalized = channel.trim().toLowerCase();
    switch (normalized) {
      case "book":
      case "price":
      case "trade":
      case "ticker":
      case "user":
        return normalized;
      default:
        return null;
    }
  }

  private normalizeChannels(channels?: string[]): WebsocketChannel[] {
    const defaults: WebsocketChannel[] = ["book", "price"];
    if (!channels || channels.length === 0) {
      return defaults;
    }
    const parsed: WebsocketChannel[] = [];
    channels.forEach((channel) => {
      const normalized = this.normalizeChannel(channel);
      if (normalized) {
        parsed.push(normalized);
      }
    });
    return parsed.length > 0 ? parsed : defaults;
  }

  private resolveWebsocketUrl(): string {
    const wsSetting =
      this.polymarketRuntime.getSetting("CLOB_WS_URL") ||
      this.polymarketRuntime.getSetting("CLOB_API_URL") ||
      DEFAULT_CLOB_WS_URL;
    const wsUrl = String(wsSetting);

    if (wsUrl.startsWith("ws://") || wsUrl.startsWith("wss://")) {
      return wsUrl;
    }
    if (wsUrl.startsWith("http://")) {
      return wsUrl.replace("http://", "ws://");
    }
    if (wsUrl.startsWith("https://")) {
      return wsUrl.replace("https://", "wss://");
    }
    return `wss://${wsUrl}`;
  }

  private getSubscriptionKey(
    channel: WebsocketChannel,
    assetIds: string[],
    authenticated: boolean,
  ): string {
    const sortedAssets = [...assetIds].sort();
    return `${channel}:${authenticated ? "auth" : "public"}:${sortedAssets.join(",")}`;
  }

  private normalizeRawData(data: RawData): string {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof Buffer) {
      return data.toString("utf8");
    }
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }
    return data.map((chunk) => chunk.toString("utf8")).join("");
  }

  private recordSubscription(
    channel: WebsocketChannel,
    assetIds: string[],
    authenticated: boolean,
    status: WebsocketSubscriptionStatus,
  ): void {
    const key = this.getSubscriptionKey(channel, assetIds, authenticated);
    this.wsSubscriptions.set(key, {
      channel,
      assetIds,
      authenticated,
      status,
      lastUpdatedAt: Date.now(),
    });
  }

  private hasWebsocketCredentials(): boolean {
    return Boolean(
      this.polymarketRuntime.getSetting("CLOB_API_KEY") &&
        (this.polymarketRuntime.getSetting("CLOB_API_SECRET") ||
          this.polymarketRuntime.getSetting("CLOB_SECRET")) &&
        (this.polymarketRuntime.getSetting("CLOB_API_PASSPHRASE") ||
          this.polymarketRuntime.getSetting("CLOB_PASS_PHRASE")),
    );
  }

  private sendWebsocketMessage(message: WebsocketOutboundMessage): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      this.wsPendingMessages.push(message);
      return;
    }
    this.websocket.send(JSON.stringify(message));
  }

  private startPing(): void {
    if (this.wsPingInterval) {
      clearInterval(this.wsPingInterval);
    }
    this.wsPingInterval = setInterval(() => {
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        this.websocket.ping();
      }
    }, WS_PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.wsPingInterval) {
      clearInterval(this.wsPingInterval);
      this.wsPingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.wsShouldReconnect) {
      return;
    }
    if (this.wsReconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
      this.websocketStatus = "error";
      return;
    }
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
    }
    this.wsReconnectAttempts += 1;
    this.wsReconnectTimeout = setTimeout(() => {
      void this.connectWebsocket();
    }, WS_RECONNECT_DELAY_MS);
  }

  private setupWebsocketHandlers(socket: WebSocket): void {
    socket.on("open", () => {
      this.websocketStatus = "connected";
      this.wsReconnectAttempts = 0;
      this.wsLastError = null;
      this.startPing();

      const pending = [...this.wsPendingMessages];
      this.wsPendingMessages = [];
      const pendingKeys = new Set<string>(
        pending.map((message) =>
          this.getSubscriptionKey(message.channel, message.assets_ids ?? [], false),
        ),
      );
      for (const message of pending) {
        this.sendWebsocketMessage(message);
      }

      this.wsSubscriptions.forEach((subscription) => {
        const key = this.getSubscriptionKey(
          subscription.channel,
          subscription.assetIds,
          subscription.authenticated,
        );
        if (!pendingKeys.has(key)) {
          this.sendWebsocketMessage({
            type: "subscribe",
            channel: subscription.channel,
            assets_ids: subscription.assetIds,
          });
        }
      });
    });

    socket.on("message", (data) => {
      const text = this.normalizeRawData(data);
      try {
        const parsed = JSON.parse(text) as WebsocketInboundMessage;
        if (parsed?.error) {
          this.wsLastError = parsed.error;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown parse error";
        this.polymarketRuntime.logger.warn("Failed to parse websocket message:", errorMessage);
      }
    });

    socket.on("close", () => {
      this.websocketStatus = "disconnected";
      this.stopPing();
      this.scheduleReconnect();
    });

    socket.on("error", (error: Error) => {
      this.websocketStatus = "error";
      this.wsLastError = error.message;
      this.polymarketRuntime.logger.error("WebSocket error:", error.message);
      this.scheduleReconnect();
    });
  }

  private async connectWebsocket(): Promise<void> {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.websocket && this.websocket.readyState === WebSocket.CONNECTING) {
      return;
    }

    const url = this.websocketUrl ?? this.resolveWebsocketUrl();
    this.websocketUrl = url;
    this.websocketStatus = "connecting";
    this.wsShouldReconnect = true;

    if (this.websocket) {
      this.websocket.removeAllListeners();
      this.websocket.terminate();
      this.websocket = null;
    }

    const socket = new WebSocket(url);
    this.websocket = socket;
    this.setupWebsocketHandlers(socket);
  }

  private resubscribeAll(): void {
    this.wsSubscriptions.forEach((subscription) => {
      if (subscription.status === "active" || subscription.status === "pending") {
        this.sendWebsocketMessage({
          type: "subscribe",
          channel: subscription.channel,
          assets_ids: subscription.assetIds,
        });
      }
    });
  }

  async startWebsocket(config: WebsocketConfig): Promise<WebsocketStatusSnapshot> {
    this.websocketUrl = config.url ?? this.resolveWebsocketUrl();
    await this.connectWebsocket();

    config.channels.forEach((channel) => {
      if (config.assetIds.length > 0) {
        this.recordSubscription(channel, config.assetIds, config.authenticated, "pending");
      }
    });

    if (this.websocketStatus === "connected") {
      this.resubscribeAll();
    } else {
      config.channels.forEach((channel) => {
        if (config.assetIds.length > 0) {
          this.wsPendingMessages.push({
            type: "subscribe",
            channel,
            assets_ids: config.assetIds,
          });
        }
      });
    }

    return this.getWebsocketStatusSnapshot();
  }

  async stopWebsocket(): Promise<void> {
    this.wsShouldReconnect = false;
    this.stopPing();
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
      this.wsReconnectTimeout = null;
    }
    if (this.websocket) {
      this.websocket.removeAllListeners();
      this.websocket.close();
      this.websocket = null;
    }
    this.websocketStatus = "disconnected";
  }

  async subscribeWebsocket(
    channel: WebsocketChannel,
    assetIds: string[],
    authenticated: boolean,
  ): Promise<void> {
    if (authenticated && !this.hasWebsocketCredentials()) {
      throw new Error("Authenticated websocket requires CLOB API credentials.");
    }
    if (assetIds.length === 0) {
      throw new Error("At least one asset ID is required for subscription.");
    }

    await this.connectWebsocket();
    this.recordSubscription(channel, assetIds, authenticated, "pending");
    this.sendWebsocketMessage({ type: "subscribe", channel, assets_ids: assetIds });
  }

  async unsubscribeWebsocket(channel: WebsocketChannel, assetIds: string[]): Promise<void> {
    await this.connectWebsocket();
    const keysToDelete: string[] = [];
    this.wsSubscriptions.forEach((subscription, key) => {
      const sameChannel = subscription.channel === channel;
      const sameAssets =
        assetIds.length === 0 ||
        (subscription.assetIds.length === assetIds.length &&
          [...subscription.assetIds].sort().join(",") === [...assetIds].sort().join(","));
      if (sameChannel && sameAssets) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      this.wsSubscriptions.delete(key);
    }
    this.sendWebsocketMessage({
      type: "unsubscribe",
      channel,
      assets_ids: assetIds.length > 0 ? assetIds : undefined,
    });
  }

  getWebsocketStatusSnapshot(): WebsocketStatusSnapshot {
    return {
      status: this.websocketStatus,
      url: this.websocketUrl ?? this.resolveWebsocketUrl(),
      subscriptions: [...this.wsSubscriptions.values()],
      reconnectAttempts: this.wsReconnectAttempts,
      lastError: this.wsLastError ?? undefined,
    };
  }

  async setupWebsocket(options: WebsocketSetupOptions): Promise<WebsocketSetupResult> {
    const channels = this.normalizeChannels(options.channels);
    const assetIds = options.assetIds ?? [];
    let hasCredentials = this.hasWebsocketCredentials();
    if (options.authenticated && !hasCredentials) {
      const creds = await this.ensureApiCredentials({
        allowCreate: this.getAllowCreateApiKey(),
      });
      hasCredentials = Boolean(creds);
    }
    const enableAuthenticated = Boolean(options.authenticated) && hasCredentials;

    const statusSnapshot = await this.startWebsocket({
      url: options.url,
      channels,
      assetIds,
      authenticated: enableAuthenticated,
    });

    return {
      config: {
        url: statusSnapshot.url,
        channels,
        assetIds,
        authenticated: enableAuthenticated,
        status: statusSnapshot.status,
      },
      statusSnapshot,
      hasCredentials,
    };
  }

  private getAllowCreateApiKey(): boolean {
    return parseBooleanSetting(
      normalizeSetting(this.polymarketRuntime.getSetting("POLYMARKET_ALLOW_CREATE_API_KEY")) ??
        "true",
    );
  }
}
