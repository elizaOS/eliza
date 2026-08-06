export const IMPERIAL_DEFAULT_API_BASE_URL = 'https://api.imperial.space/api/v1';
export const IMPERIAL_DEFAULT_WS_URL = 'wss://api.imperial.space/ws';
export const IMPERIAL_DEFAULT_MARKET_WS_URL = 'wss://api.imperial.space/ws/market';

export enum ImperialUnderwriter {
  Jupiter = 0,
  FlashTrade = 1,
  Phoenix = 2,
  GMTrade = 3,
  FlashTradeV2 = 4,
}

export enum ImperialOrderSide {
  Long = 0,
  Short = 1,
}

export enum ImperialOrderAction {
  Increase = 0,
  Decrease = 1,
}

export enum ImperialOrderType {
  Market = 0,
  Limit = 1,
  StopLimit = 2,
  LandMine = 3,
  Ratchet = 4,
  RatchetEntry = 6,
  Dca = 9,
  FibRatchet = 10,
  FibRatchetEntry = 11,
  DcaClose = 12,
  DcaTimeClose = 13,
  DcaRatchetClose = 14,
  DcaTime = 15,
  DcaRatchet = 16,
}

export interface ImperialConfig {
  enabled: boolean;
  live: boolean;
  apiBaseUrl: string;
  wsUrl: string;
  marketWsUrl: string;
  wallet: string;
  jwt: string;
  profileIndex: number;
  profileIndexConfigured: boolean;
  defaultUnderwriter: ImperialUnderwriter;
  preferPhoenix: boolean;
  allowedSymbols: string[];
  maxNotionalUsd: number;
  maxLeverage: number;
}

export interface TradingGateState {
  liveTrading: boolean;
  operatorConfirmed: boolean;
  perpsSimOnly: boolean;
}

export interface ImperialOrderRequest {
  wallet: string;
  profileIndex: number;
  symbol: string;
  underwriter: ImperialUnderwriter;
  side: ImperialOrderSide;
  action: ImperialOrderAction;
  orderType: ImperialOrderType;
  sizeUsd: number;
  leverage: number;
  marketPrice: number;
  triggerPrice?: number;
  phoenixNative?: boolean;
  extraData?: Record<string, unknown>;
}

export interface ImperialOrderResponse {
  success?: boolean;
  signature?: string;
  orderPda?: string;
  error?: string;
  [key: string]: unknown;
}

export interface ImperialMobileConnectRequest {
  wallet: string;
  message: string;
  signature: string;
}

export interface ImperialMobileConnectResponse {
  code?: string;
  [key: string]: unknown;
}

export interface ImperialMobileExchangeResponse {
  jwt?: string;
  expires_at?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

export interface ImperialRegisterPhoenixResponse {
  profilePda: string;
  activated: boolean;
  message: string;
}

type EnvLike = Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function envValue(env: EnvLike, key: string): string {
  return env[key]?.trim() ?? '';
}

function parseBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseUnderwriter(value: string | undefined): ImperialUnderwriter {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return ImperialUnderwriter.Phoenix;
  if (normalized === 'phoenix') return ImperialUnderwriter.Phoenix;
  if (normalized === 'jupiter') return ImperialUnderwriter.Jupiter;
  if (normalized === 'flash' || normalized === 'flashtrade' || normalized === 'flash-trade') return ImperialUnderwriter.FlashTrade;
  if (normalized === 'gmtrade' || normalized === 'gm-trade') return ImperialUnderwriter.GMTrade;
  if (normalized === 'flashv2' || normalized === 'flash-v2' || normalized === 'flashtradev2') return ImperialUnderwriter.FlashTradeV2;

  const parsed = Number.parseInt(normalized, 10);
  if (Object.values(ImperialUnderwriter).includes(parsed)) return parsed as ImperialUnderwriter;
  return ImperialUnderwriter.Phoenix;
}

function parseSymbols(value: string | undefined): string[] {
  const symbols = (value || 'SOL,ETH,BTC')
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  return symbols.length ? [...new Set(symbols)] : ['SOL', 'ETH', 'BTC'];
}

export function getTradingGateState(env: EnvLike = process.env): TradingGateState {
  return {
    liveTrading: env.LIVE_TRADING === 'true',
    operatorConfirmed: env.OPERATOR_CONFIRMED === 'true',
    perpsSimOnly: env.PERPS_SIM_ONLY !== 'false',
  };
}

export function getImperialConfig(env: EnvLike = process.env): ImperialConfig {
  const wallet = envValue(env, 'IMPERIAL_WALLET');
  const jwt = envValue(env, 'IMPERIAL_JWT') || envValue(env, 'IMPERIAL_API_KEY');
  const live = parseBool(env.IMPERIAL_LIVE, false);
  const enabled = parseBool(env.IMPERIAL_ENABLED, Boolean(wallet || jwt || live));
  const profileRaw = env.IMPERIAL_PROFILE_INDEX;

  return {
    enabled,
    live,
    apiBaseUrl: envValue(env, 'IMPERIAL_API_BASE_URL') || IMPERIAL_DEFAULT_API_BASE_URL,
    wsUrl: envValue(env, 'IMPERIAL_WS_URL') || IMPERIAL_DEFAULT_WS_URL,
    marketWsUrl: envValue(env, 'IMPERIAL_MARKET_WS_URL') || IMPERIAL_DEFAULT_MARKET_WS_URL,
    wallet,
    jwt,
    profileIndex: parseInteger(profileRaw, 0),
    profileIndexConfigured: profileRaw !== undefined && profileRaw.trim() !== '',
    defaultUnderwriter: parseUnderwriter(env.IMPERIAL_DEFAULT_UNDERWRITER),
    preferPhoenix: parseBool(env.IMPERIAL_PREFER_PHOENIX, true),
    allowedSymbols: parseSymbols(env.IMPERIAL_ALLOWED_SYMBOLS || env.PERPS_ALLOWED_SYMBOLS),
    maxNotionalUsd: parseNumber(env.IMPERIAL_MAX_NOTIONAL_USD || env.PERPS_MAX_NOTIONAL_USD, 250),
    maxLeverage: parseNumber(env.IMPERIAL_MAX_LEVERAGE || env.PERPS_MAX_LEVERAGE, 3),
  };
}

export function imperialUnderwriterLabel(underwriter: ImperialUnderwriter): string {
  switch (underwriter) {
    case ImperialUnderwriter.Jupiter:
      return 'Jupiter';
    case ImperialUnderwriter.FlashTrade:
      return 'Flash Trade';
    case ImperialUnderwriter.Phoenix:
      return 'Phoenix';
    case ImperialUnderwriter.GMTrade:
      return 'GMTrade';
    case ImperialUnderwriter.FlashTradeV2:
      return 'Flash Trade V2';
  }
}

export function maskImperialCredential(value: string): string {
  if (!value) return '(unset)';
  if (value.length <= 12) return `${value.slice(0, 2)}...`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function encodeOraclePrice(priceUsd: number): number {
  return Math.round(priceUsd * 1_000_000_000);
}

export function encodeImperialMarketPrice(
  priceUsd: number,
  underwriter: ImperialUnderwriter,
  flashPriceExponent = -8,
): number {
  switch (underwriter) {
    case ImperialUnderwriter.Jupiter:
    case ImperialUnderwriter.Phoenix:
      return Math.round(priceUsd * 1_000_000);
    case ImperialUnderwriter.FlashTrade:
      return Math.round(priceUsd * 10 ** Math.abs(flashPriceExponent));
    case ImperialUnderwriter.GMTrade:
      return encodeOraclePrice(priceUsd);
    case ImperialUnderwriter.FlashTradeV2:
      return 0;
  }
}

export function buildImperialMarketOrder(params: {
  config: ImperialConfig;
  symbol: string;
  side: ImperialOrderSide;
  action?: ImperialOrderAction;
  notionalUsd: number;
  leverage?: number;
  marketPriceUsd: number;
  underwriter?: ImperialUnderwriter;
}): ImperialOrderRequest {
  const underwriter = params.underwriter ?? params.config.defaultUnderwriter;
  return {
    wallet: params.config.wallet,
    profileIndex: params.config.profileIndex,
    symbol: params.symbol.toUpperCase(),
    underwriter,
    side: params.side,
    action: params.action ?? ImperialOrderAction.Increase,
    orderType: ImperialOrderType.Market,
    sizeUsd: Math.round(params.notionalUsd * 1_000_000),
    leverage: params.leverage ?? Math.min(2, params.config.maxLeverage),
    marketPrice: encodeImperialMarketPrice(params.marketPriceUsd, underwriter),
  };
}

export function buildImperialConnectMessage(wallet: string, nonce: string): string {
  return `imperial:mobile-connect:${wallet}:${nonce}`;
}

export function validateImperialOrderIntent(params: {
  config: ImperialConfig;
  symbol: string;
  notionalUsd: number;
  leverage: number;
}): string[] {
  const reasons: string[] = [];
  const symbol = params.symbol.toUpperCase();
  if (!params.config.allowedSymbols.includes(symbol)) {
    reasons.push(`${symbol} is not in IMPERIAL_ALLOWED_SYMBOLS/PERPS_ALLOWED_SYMBOLS`);
  }
  if (params.notionalUsd <= 0) {
    reasons.push('notional must be greater than 0');
  }
  if (params.notionalUsd > params.config.maxNotionalUsd) {
    reasons.push(`notional $${params.notionalUsd} exceeds $${params.config.maxNotionalUsd} cap`);
  }
  if (params.leverage <= 0) {
    reasons.push('leverage must be greater than 0');
  }
  if (params.leverage > params.config.maxLeverage) {
    reasons.push(`leverage ${params.leverage}x exceeds ${params.config.maxLeverage}x cap`);
  }
  if (params.config.profileIndex < 0 || params.config.profileIndex > 5) {
    reasons.push('IMPERIAL_PROFILE_INDEX must be between 0 and 5');
  }
  return reasons;
}

export function getImperialLiveReadiness(config: ImperialConfig, gates: TradingGateState): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!config.live) reasons.push('IMPERIAL_LIVE=true is not set');
  if (!gates.liveTrading) reasons.push('LIVE_TRADING=true is not set');
  if (!gates.operatorConfirmed) reasons.push('OPERATOR_CONFIRMED=true is not set');
  if (gates.perpsSimOnly) reasons.push('PERPS_SIM_ONLY=false is not set');
  if (!config.wallet) reasons.push('IMPERIAL_WALLET is not set');
  if (!config.jwt) reasons.push('IMPERIAL_JWT/IMPERIAL_API_KEY is not set');
  if (config.profileIndex < 0 || config.profileIndex > 5) {
    reasons.push('IMPERIAL_PROFILE_INDEX must be between 0 and 5');
  }
  return { ok: reasons.length === 0, reasons };
}

function authHeaders(config: ImperialConfig, needsAuth: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (needsAuth && config.jwt) headers.Authorization = `Bearer ${config.jwt}`;
  return headers;
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export class ImperialClient {
  constructor(
    private readonly config: ImperialConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async getFundingRates(): Promise<unknown> {
    return this.request('/funding-rates');
  }

  async getMarkPrices(): Promise<unknown> {
    return this.request('/mark-prices');
  }

  async getRoute(params: { asset: string; side: 'long' | 'short'; notionalUsd: number }): Promise<unknown> {
    const query = new URLSearchParams({
      asset: params.asset.toUpperCase(),
      side: params.side,
      notional: String(params.notionalUsd),
    });
    return this.request(`/route?${query.toString()}`);
  }

  async getBalances(): Promise<unknown> {
    const query = new URLSearchParams({
      wallet: this.config.wallet,
      profileIndex: String(this.config.profileIndex),
    });
    return this.request(`/mobile/balances?${query.toString()}`, {}, true);
  }

  async getPositions(): Promise<unknown> {
    const query = new URLSearchParams({ walletAddress: this.config.wallet });
    return this.request(`/positions?${query.toString()}`);
  }

  async getOrders(): Promise<unknown> {
    const query = new URLSearchParams({ walletAddress: this.config.wallet });
    return this.request(`/orders?${query.toString()}`);
  }

  async submitOrder(order: ImperialOrderRequest): Promise<ImperialOrderResponse> {
    return this.request<ImperialOrderResponse>('/mobile/orders', {
      method: 'POST',
      body: JSON.stringify(order),
    }, true);
  }

  async connectMobile(request: ImperialMobileConnectRequest): Promise<ImperialMobileConnectResponse> {
    return this.request<ImperialMobileConnectResponse>('/mobile/connect', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async exchangeMobileCode(code: string): Promise<ImperialMobileExchangeResponse> {
    return this.request<ImperialMobileExchangeResponse>('/mobile/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  async revokeMobileSession(): Promise<unknown> {
    return this.request('/mobile/revoke', {
      method: 'POST',
      body: JSON.stringify({ wallet: this.config.wallet }),
    }, true);
  }

  async registerPhoenix(params?: { wallet?: string; profileIndex?: number }): Promise<ImperialRegisterPhoenixResponse> {
    return this.request<ImperialRegisterPhoenixResponse>('/phoenix/register', {
      method: 'POST',
      body: JSON.stringify({
        wallet: params?.wallet ?? this.config.wallet,
        profileIndex: params?.profileIndex ?? this.config.profileIndex,
      }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, needsAuth = false): Promise<T> {
    const headers = {
      ...authHeaders(this.config, needsAuth),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };
    const response = await this.fetchImpl(endpoint(this.config.apiBaseUrl, path), {
      ...init,
      headers,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) as T : ({} as T);
    if (!response.ok) {
      const detail = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : response.statusText;
      throw new Error(`Imperial API ${response.status}: ${detail}`);
    }
    return data;
  }
}

function flattenObjects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenObjects(item, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  out.push(obj);
  for (const child of Object.values(obj)) {
    if (child && typeof child === 'object') flattenObjects(child, out);
  }
  return out;
}

function venueMatches(row: Record<string, unknown>, underwriter: ImperialUnderwriter): boolean {
  const venue = String(row.venue ?? row.underwriter ?? row.source ?? '').toLowerCase();
  if (!venue) return true;
  if (underwriter === ImperialUnderwriter.Phoenix) return venue.includes('phoenix') || venue === '2';
  if (underwriter === ImperialUnderwriter.Jupiter) return venue.includes('jupiter') || venue === '0';
  if (underwriter === ImperialUnderwriter.FlashTrade) return venue.includes('flash') || venue === '1';
  if (underwriter === ImperialUnderwriter.GMTrade) return venue.includes('gm') || venue === '3';
  if (underwriter === ImperialUnderwriter.FlashTradeV2) return venue.includes('v2') || venue === '4';
  return false;
}

export function extractImperialMarkPrice(
  payload: unknown,
  symbol: string,
  underwriter: ImperialUnderwriter,
): number | undefined {
  const wanted = symbol.toUpperCase();
  for (const row of flattenObjects(payload)) {
    const rowSymbol = String(row.symbol ?? row.asset ?? row.market ?? '').toUpperCase();
    if (rowSymbol && rowSymbol !== wanted) continue;
    if (!venueMatches(row, underwriter)) continue;
    const raw = row.price ?? row.markPrice ?? row.mark_price ?? row.value;
    const price = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(price) && price > 0) return price;
  }
  return undefined;
}
