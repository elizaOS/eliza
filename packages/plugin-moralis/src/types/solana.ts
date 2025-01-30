// Common types
export interface TimeFrameStats {
    "5min": number;
    "1h": number;
    "4h": number;
    "24h": number;
}

export interface TokenInfo {
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    tokenLogo: string | null;
    tokenDecimals: string;
    pairTokenType?: string;
    liquidityUsd?: number;
}

// Token Pairs Response Types
export interface TokenPair {
    exchangeAddress: string;
    exchangeName: string;
    exchangeLogo: string;
    pairAddress: string;
    pairLabel: string;
    usdPrice: number;
    usdPrice24hrPercentChange: number;
    usdPrice24hrUsdChange: number;
    volume24hrNative: number;
    volume24hrUsd: number;
    liquidityUsd: number;
    inactivePair: boolean;
    baseToken: string;
    quoteToken: string;
    pair: [TokenInfo, TokenInfo];
}

export interface TokenPairsResponse {
    page: number;
    pageSize: number;
    cursor: string;
    pairs: TokenPair[];
}

// Pair Stats Response Types
export interface PairStats {
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    tokenLogo: string | null;
    pairCreated: string | null;
    pairLabel: string;
    pairAddress: string;
    exchange: string;
    exchangeAddress: string;
    exchangeLogo: string;
    exchangeUrl: string | null;
    currentUsdPrice: string;
    currentNativePrice: string;
    totalLiquidityUsd: string;
    pricePercentChange: TimeFrameStats;
    liquidityPercentChange: TimeFrameStats;
    buys: TimeFrameStats;
    sells: TimeFrameStats;
    totalVolume: TimeFrameStats;
    buyVolume: TimeFrameStats;
    sellVolume: TimeFrameStats;
    buyers: TimeFrameStats;
    sellers: TimeFrameStats;
}

// OHLCV Response Types
export interface OHLCVCandle {
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    trades: number;
}

export interface OHLCVResponse {
    cursor: string;
    page: number;
    pairAddress: string;
    tokenAddress: string;
    timeframe: string;
    currency: string;
    result: OHLCVCandle[];
}

// API Parameters Types
export interface OHLCVParams {
    timeframe: string;
    currency: string;
    fromDate: string;
    toDate: string;
    limit?: number;
}

export interface PairStatsContent {
    pairAddress: string;
}

export interface TokenPairsContent {
    tokenAddress: string;
}

// Token Stats Response Types
export interface TokenStatsContent {
    tokenAddress: string;
}

export interface TokenStats {
    totalLiquidityUsd: number;
    totalActivePairs: number;
    totalActiveDexes: number;
    totalSwaps: TimeFrameStats;
    totalVolume: TimeFrameStats;
    totalBuyVolume: TimeFrameStats;
    totalSellVolume: TimeFrameStats;
    totalBuyers: TimeFrameStats;
    totalSellers: TimeFrameStats;
}

export interface TokenPriceContent {
    tokenAddress: string;
}

export interface NativePrice {
    value: string;
    symbol: string;
    name: string;
    decimals: number;
}

export interface TokenPrice {
    exchangeName: string;
    exchangeAddress: string;
    nativePrice: NativePrice;
    usdPrice: number;
}

export interface TokenMetadataContent {
    tokenAddress: string;
}

export interface MetaplexMetadata {
    metadataUri: string;
    masterEdition: boolean;
    isMutable: boolean;
    primarySaleHappened: number;
    sellerFeeBasisPoints: number;
    updateAuthority: string;
}

export interface TokenMetadata {
    mint: string;
    standard: string;
    name: string;
    symbol: string;
    logo: string | null;
    decimals: string;
    totalSupply: string;
    totalSupplyFormatted: string;
    fullyDilutedValue: string;
    metaplex: MetaplexMetadata;
}
