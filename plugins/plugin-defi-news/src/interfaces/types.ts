import type { IAgentRuntime, Memory, State } from '@elizaos/core';

/**
 * DeFi News data types
 */

// ============================================
// CoinGecko DeFi Market Data Types
// ============================================

export interface GlobalDefiData {
    defi_market_cap: string;
    eth_market_cap: string;
    defi_to_eth_ratio: string;
    trading_volume_24h: string;
    defi_dominance: string;
    top_coin_name: string;
    top_coin_defi_dominance: number;
}

export interface GlobalCryptoData {
    active_cryptocurrencies: number;
    upcoming_icos: number;
    ongoing_icos: number;
    ended_icos: number;
    markets: number;
    total_market_cap: Record<string, number>;
    total_volume: Record<string, number>;
    market_cap_percentage: Record<string, number>;
    market_cap_change_percentage_24h_usd: number;
    updated_at: number;
}

export interface TokenNewsData {
    tokenId: string;
    tokenName: string;
    symbol: string;
    description?: string;
    market_data?: {
        current_price?: Record<string, number>;
        market_cap?: Record<string, number>;
        total_volume?: Record<string, number>;
        price_change_percentage_24h?: number;
        price_change_percentage_7d?: number;
        price_change_percentage_30d?: number;
    };
    community_data?: {
        twitter_followers?: number;
        reddit_subscribers?: number;
        telegram_channel_user_count?: number;
    };
    developer_data?: {
        forks?: number;
        stars?: number;
        subscribers?: number;
        total_issues?: number;
        closed_issues?: number;
        pull_requests_merged?: number;
        pull_request_contributors?: number;
    };
    last_updated?: string;
}

export interface DexPairData {
    base: string;
    target: string;
    market: {
        name: string;
        identifier: string;
        has_trading_incentive: boolean;
    };
    last: number;
    volume: number;
    converted_last: Record<string, number>;
    converted_volume: Record<string, number>;
    trust_score: string;
    bid_ask_spread_percentage: number;
    timestamp: string;
    last_traded_at: string;
    last_fetch_at: string;
    is_anomaly: boolean;
    is_stale: boolean;
    trade_url: string;
    token_info_url: string | null;
    coin_id: string;
    target_coin_id?: string;
}

export interface OHLCVData {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

// ============================================
// NewsData.io Real World Events Types
// ============================================

export interface RealWorldNewsArticle {
    article_id: string;
    title: string;
    link: string;
    keywords?: string[];
    creator?: string[];
    video_url?: string | null;
    description?: string;
    content?: string;
    pubDate: string;
    image_url?: string;
    source_id: string;
    source_priority: number;
    source_url?: string;
    source_icon?: string;
    language: string;
    country?: string[];
    category?: string[];
    ai_tag?: string;
    sentiment?: string;
    sentiment_stats?: string;
    ai_region?: string;
}

export interface RealWorldNewsResponse {
    status: string;
    totalResults: number;
    results: RealWorldNewsArticle[];
    nextPage?: string;
}

// ============================================
// Request/Response Types
// ============================================

export interface DefiNewsRequest {
    tokenId?: string;
    tokenAddress?: string;
    chain?: string;
    includeMarketData?: boolean;
    includeCommunityData?: boolean;
    includeDeveloperData?: boolean;
    includeRealWorldNews?: boolean;
    newsQuery?: string;
    newsLanguage?: string;
    newsCategory?: string;
}

export interface DexLiquidityRequest {
    tokenId: string;
    includePairs?: boolean;
    includeOHLCV?: boolean;
    ohlcvDays?: number;
    timeframe?: '1h' | '4h' | '1d' | '1w';
}

export interface GlobalDefiRequest {
    includeCryptoData?: boolean;
}

export interface DefiNewsResponse {
    success: boolean;
    data: {
        tokenNews?: TokenNewsData;
        globalDefi?: GlobalDefiData;
        globalCrypto?: GlobalCryptoData;
        dexPairs?: DexPairData[];
        ohlcvData?: OHLCVData[];
        realWorldNews?: RealWorldNewsArticle[];
    };
    timestamp: number;
    error?: string;
}

// ============================================
// Service Interfaces
// ============================================

export interface DefiNewsService {
    // CoinGecko DeFi Data
    getGlobalDefiData(): Promise<GlobalDefiData>;
    getGlobalCryptoData(): Promise<GlobalCryptoData>;
    getTokenData(tokenId: string, options?: {
        includeMarketData?: boolean;
        includeCommunityData?: boolean;
        includeDeveloperData?: boolean;
    }): Promise<TokenNewsData>;
    getDexPairs(tokenId: string): Promise<DexPairData[]>;
    getOHLCVData(tokenId: string, days: number): Promise<OHLCVData[]>;
    
    // Real World News
    getRealWorldNews(query: string, options?: {
        language?: string;
        category?: string;
        limit?: number;
    }): Promise<RealWorldNewsArticle[]>;
}

// ============================================
// Action Types
// ============================================

export interface ActionRequest {
    runtime: IAgentRuntime;
    message: Memory;
    state?: State;
}

export interface ActionResponse {
    success: boolean;
    text: string;
    data?: any;
    error?: string;
}

